// StreamVibe TikTok Bridge — Multi-User Hosted Server
// Deploy on Railway / Render / Fly.io
// Each client sends { type:"connect_tiktok", username:"..." }
// and gets their own dedicated tiktok-live-connector session.

const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT || '8082', 10);

// Track sessions: ws -> { username, conn, retryTimer }
const sessions = new Map();

// HTTP server (Railway needs this for health checks)
const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        sessions: sessions.size,
        uptime: Math.floor(process.uptime()),
    }));
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    console.log(`[+] Client connected from ${ip} (active: ${wss.clients.size})`);

    send(ws, { type: 'bridge_connected', message: 'Connected to StreamVibe Bridge' });

    ws.on('message', (raw) => {
        try { handleMessage(ws, JSON.parse(raw.toString())); }
        catch (e) { console.error('Bad msg:', e.message); }
    });

    ws.on('close', () => {
        console.log(`[-] Client disconnected (active: ${wss.clients.size - 1})`);
        cleanupSession(ws);
    });

    ws.on('error', () => cleanupSession(ws));
});

function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'connect_tiktok':
            if (!msg.username) { send(ws, { type: 'error', message: 'username required' }); return; }
            startSession(ws, msg.username.replace('@', '').trim());
            break;
        case 'disconnect_tiktok':
            cleanupSession(ws);
            send(ws, { type: 'tiktok_disconnected', reason: 'user_requested' });
            break;
        case 'get_status': {
            const s = sessions.get(ws);
            send(ws, { type: 'status', connected: !!s?.conn, username: s?.username || '' });
            break;
        }
    }
}

function startSession(ws, username) {
    // Clean up existing session for this client
    cleanupSession(ws, false);

    console.log(`[~] @${username} connecting...`);
    send(ws, { type: 'connecting', username });

    const conn = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
        sessionId: '',
    });

    const session = { username, conn, retryTimer: null };
    sessions.set(ws, session);

    // Connected to live room
    conn.on('connected', (state) => {
        console.log(`[✓] @${username} LIVE (roomId: ${state.roomId})`);
        send(ws, { type: 'tiktok_connected', username, roomId: String(state.roomId) });
    });

    // Stream ended / disconnected
    conn.on('disconnected', () => {
        console.log(`[~] @${username} disconnected`);
        if (isOpen(ws)) {
            send(ws, { type: 'tiktok_disconnected', username, reason: 'stream_ended' });
            scheduleRetry(ws, username);
        }
    });

    conn.on('chat', (d) => send(ws, {
        type: 'comment',
        username: d.uniqueId || d.nickname || 'unknown',
        message: d.comment || '',
        timestamp: Date.now(),
    }));

    conn.on('gift', (d) => send(ws, {
        type: 'gift',
        username: d.uniqueId || d.nickname || 'unknown',
        giftName: d.giftName || 'Gift',
        giftId: d.giftId || 0,
        coins: d.diamondCount || 0,
        repeatCount: d.repeatCount || 1,
        repeatEnd: d.repeatEnd || false,
        timestamp: Date.now(),
    }));

    conn.on('follow', (d) => send(ws, {
        type: 'follow',
        username: d.uniqueId || d.nickname || 'unknown',
        timestamp: Date.now(),
    }));

    conn.on('share', (d) => send(ws, {
        type: 'share',
        username: d.uniqueId || d.nickname || 'unknown',
        timestamp: Date.now(),
    }));

    conn.on('like', (d) => send(ws, {
        type: 'like',
        username: d.uniqueId || d.nickname || 'unknown',
        likeCount: d.likeCount || 1,
        totalLikes: d.totalLikeCount || 0,
        timestamp: Date.now(),
    }));

    conn.on('member', (d) => send(ws, {
        type: 'join',
        username: d.uniqueId || d.nickname || 'unknown',
        timestamp: Date.now(),
    }));

    conn.on('roomUser', (d) => send(ws, {
        type: 'viewers',
        count: d.viewerCount || 0,
        timestamp: Date.now(),
    }));

    conn.on('subscribe', (d) => send(ws, {
        type: 'subscribe',
        username: d.uniqueId || d.nickname || 'unknown',
        timestamp: Date.now(),
    }));

    conn.on('error', (err) => {
        console.error(`[!] @${username} error: ${err.message}`);
        if (isOpen(ws)) send(ws, { type: 'error', message: err.message });
    });

    // Connect
    conn.connect().catch((err) => {
        const msg = err.message || 'Connection failed';
        console.log(`[!] @${username} not live or error: ${msg}`);
        if (isOpen(ws)) {
            send(ws, { type: 'not_live', username, message: msg });
            scheduleRetry(ws, username);
        }
    });
}

// Auto-retry every 30s when not live
function scheduleRetry(ws, username) {
    const session = sessions.get(ws);
    if (!session || !isOpen(ws)) return;
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = setTimeout(() => {
        if (isOpen(ws)) {
            console.log(`[↺] Retrying @${username}...`);
            startSession(ws, username);
        }
    }, 30_000);
}

function cleanupSession(ws, sendDisconnect = false) {
    const session = sessions.get(ws);
    if (!session) return;
    if (session.retryTimer) clearTimeout(session.retryTimer);
    try { session.conn?.disconnect(); } catch (_) {}
    sessions.delete(ws);
    if (sendDisconnect && isOpen(ws)) send(ws, { type: 'tiktok_disconnected' });
}

function send(ws, data) {
    if (isOpen(ws)) ws.send(JSON.stringify(data));
}

function isOpen(ws) {
    return ws.readyState === WebSocket.OPEN;
}

httpServer.listen(PORT, () => {
    console.log(`StreamVibe Bridge running on port ${PORT}`);
    console.log(`WebSocket: ws://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
    sessions.forEach((_, ws) => cleanupSession(ws));
    process.exit(0);
});
