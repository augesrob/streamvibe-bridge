// StreamVibe TikTok Bridge — Multi-User Hosted Server
// Deploy on Railway. Each client connects via WebSocket and sends:
//   { type: "connect_tiktok", username: "yourname" }

const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT || '8082', 10);

// In-memory log buffer (last 200 lines)
const logs = [];
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 200) logs.shift();
}

// Track sessions: ws -> { username, conn, retryTimer }
const sessions = new Map();

// ── HTTP server ─────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    // Console viewer page
    if (req.url === '/console' || req.url === '/logs') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html>
<head>
<title>StreamVibe Bridge Console</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d0d0d; color:#00f2ea; font-family:monospace; padding:16px; }
  h2 { color:#fff; }
  .stats { color:#aaa; margin-bottom:16px; }
  pre { background:#111; padding:12px; border-radius:8px; white-space:pre-wrap; word-break:break-all; font-size:13px; line-height:1.6; }
  .ts { color:#555; }
</style>
</head>
<body>
<h2>🌐 StreamVibe Bridge Console</h2>
<div class="stats">
  Active sessions: <b>${sessions.size}</b> &nbsp;|&nbsp;
  Uptime: <b>${Math.floor(process.uptime())}s</b> &nbsp;|&nbsp;
  <span style="color:#555">Auto-refreshes every 5s</span>
</div>
<pre>${logs.map(l => {
    const ts = l.match(/\[(.*?)\]/)?.[1] || '';
    const msg = l.replace(/\[.*?\]\s*/, '');
    return `<span class="ts">${ts}</span> ${msg}`;
}).join('\n')}</pre>
</body>
</html>`);
        return;
    }

    // JSON status endpoint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        sessions: sessions.size,
        uptime: Math.floor(process.uptime()),
        users: [...sessions.values()].map(s => s.username),
    }));
});

// ── WebSocket server ────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    log(`[+] Client connected from ${ip} (active: ${wss.clients.size})`);
    send(ws, { type: 'bridge_connected', message: 'Connected to StreamVibe Bridge' });

    ws.on('message', (raw) => {
        try { handleMessage(ws, JSON.parse(raw.toString())); }
        catch (e) { log(`Bad message: ${e.message}`); }
    });
    ws.on('close', () => {
        log(`[-] Client disconnected (active: ${wss.clients.size - 1})`);
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
    cleanupSession(ws, false);
    log(`[~] @${username} connecting...`);
    send(ws, { type: 'connecting', username });

    const conn = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
    });

    const session = { username, conn, retryTimer: null };
    sessions.set(ws, session);

    conn.on('connected', (state) => {
        log(`[✓] @${username} LIVE roomId:${state.roomId}`);
        send(ws, { type: 'tiktok_connected', username, roomId: String(state.roomId) });
    });

    conn.on('disconnected', () => {
        log(`[~] @${username} stream ended`);
        if (isOpen(ws)) {
            send(ws, { type: 'tiktok_disconnected', username, reason: 'stream_ended' });
            scheduleRetry(ws, username);
        }
    });

    conn.on('chat',     (d) => send(ws, { type:'comment',   username: d.uniqueId||d.nickname||'unknown', message: d.comment||'', timestamp: Date.now() }));
    conn.on('gift',     (d) => { log(`[🎁] @${username} gift:${d.giftName} x${d.repeatCount} (${d.diamondCount} coins)`); send(ws, { type:'gift', username:d.uniqueId||d.nickname||'unknown', giftName:d.giftName||'Gift', giftId:d.giftId||0, coins:d.diamondCount||0, repeatCount:d.repeatCount||1, repeatEnd:d.repeatEnd||false, timestamp:Date.now() }); });
    conn.on('follow',   (d) => { log(`[❤️] @${username} follow from ${d.uniqueId}`); send(ws, { type:'follow',   username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }); });
    conn.on('share',    (d) => send(ws, { type:'share',    username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));
    conn.on('like',     (d) => send(ws, { type:'like',     username:d.uniqueId||d.nickname||'unknown', likeCount:d.likeCount||1, totalLikes:d.totalLikeCount||0, timestamp:Date.now() }));
    conn.on('member',   (d) => send(ws, { type:'join',     username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));
    conn.on('roomUser', (d) => send(ws, { type:'viewers',  count:d.viewerCount||0, timestamp:Date.now() }));
    conn.on('subscribe',(d) => send(ws, { type:'subscribe',username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));
    conn.on('error',    (e) => { log(`[!] @${username} error: ${e.message}`); if (isOpen(ws)) send(ws, { type:'error', message:e.message }); });

    conn.connect().catch((err) => {
        log(`[!] @${username} not live: ${err.message}`);
        if (isOpen(ws)) {
            send(ws, { type: 'not_live', username, message: err.message });
            scheduleRetry(ws, username);
        }
    });
}

function scheduleRetry(ws, username) {
    const session = sessions.get(ws);
    if (!session || !isOpen(ws)) return;
    if (session.retryTimer) clearTimeout(session.retryTimer);
    log(`[↺] @${username} will retry in 30s`);
    session.retryTimer = setTimeout(() => {
        if (isOpen(ws)) startSession(ws, username);
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

function send(ws, data) { if (isOpen(ws)) ws.send(JSON.stringify(data)); }
function isOpen(ws) { return ws.readyState === WebSocket.OPEN; }

httpServer.listen(PORT, () => {
    log(`StreamVibe Bridge running on port ${PORT}`);
    log(`Console: http://localhost:${PORT}/console`);
});

process.on('SIGTERM', () => {
    sessions.forEach((_, ws) => cleanupSession(ws));
    process.exit(0);
});
