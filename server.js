// StreamVibe TikTok Bridge — Multi-User Hosted Server
// Deploy on Railway. Each client connects via WebSocket and sends:
//   { type: "connect_tiktok", username: "yourname" }

const { WebcastPushConnection } = require('tiktok-live-connector');
const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT || '8082', 10);

// In-memory log buffer (last 300 lines)
const logs = [];
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logs.push(line);
    if (logs.length > 300) logs.shift();
}

// Track sessions by clientId: Map<ws, { username, conn, retryTimer, id }>
const sessions = new Map();
let clientIdCounter = 0;

// ── HTTP server ─────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    if (req.url === '/console' || req.url === '/logs') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head>
<title>StreamVibe Bridge Console</title>
<meta http-equiv="refresh" content="5">
<style>
  body { background:#0d0d0d; color:#00f2ea; font-family:monospace; padding:16px; margin:0; }
  h2 { color:#fff; margin:0 0 8px; }
  .stats { color:#aaa; margin-bottom:12px; font-size:13px; }
  .stats b { color:#00f2ea; }
  pre { background:#111; padding:12px; border-radius:8px; white-space:pre-wrap;
        word-break:break-all; font-size:12px; line-height:1.7; max-height:80vh; overflow:auto; }
  .ts { color:#444; }
  .ok { color:#00f2ea; }
  .err { color:#ff6b6b; }
  .conn { color:#ffd700; }
  .retry { color:#aaa; }
</style>
</head>
<body>
<h2>🌐 StreamVibe Bridge Console</h2>
<div class="stats">
  Active sessions: <b>${sessions.size}</b> &nbsp;|&nbsp;
  Active users: <b>${[...new Set([...sessions.values()].map(s=>s.username))].join(', ') || 'none'}</b> &nbsp;|&nbsp;
  Uptime: <b>${Math.floor(process.uptime())}s</b> &nbsp;|&nbsp;
  <span style="color:#555">Auto-refreshes every 5s</span>
</div>
<pre>${logs.map(l => {
    const ts = l.match(/\[(.*?)\]/)?.[1]?.replace('T',' ').replace('Z','') || '';
    const msg = l.replace(/\[.*?\]\s*/, '');
    let cls = 'retry';
    if (msg.includes('[✓]') || msg.includes('LIVE')) cls = 'ok';
    else if (msg.includes('[!]') || msg.includes('error')) cls = 'err';
    else if (msg.includes('[+]') || msg.includes('[-]') || msg.includes('[~]')) cls = 'conn';
    return `<span class="ts">${ts}</span> <span class="${cls}">${msg}</span>`;
}).join('\n')}</pre>
</body>
</html>`);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const users = [...new Set([...sessions.values()].map(s => s.username))];
    res.end(JSON.stringify({ status: 'running', sessions: sessions.size, uptime: Math.floor(process.uptime()), users }));
});

// ── WebSocket server ────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const id = ++clientIdCounter;
    ws._clientId = id;
    log(`[+] Client #${id} connected from ${ip} (total: ${wss.clients.size})`);
    send(ws, { type: 'bridge_connected', message: 'Connected to StreamVibe Bridge' });

    ws.on('message', (raw) => {
        try { handleMessage(ws, JSON.parse(raw.toString())); }
        catch (e) { log(`[!] Bad message from #${id}: ${e.message}`); }
    });
    ws.on('close', () => {
        log(`[-] Client #${id} disconnected (total: ${wss.clients.size - 1})`);
        cleanupSession(ws);
    });
    ws.on('error', (e) => {
        log(`[!] WS error for #${id}: ${e.message}`);
        cleanupSession(ws);
    });
});

function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'connect_tiktok':
            if (!msg.username) { send(ws, { type: 'error', message: 'username required' }); return; }
            startSession(ws, msg.username.replace('@', '').trim().toLowerCase());
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
    log(`[~] @${username} connecting... (client #${ws._clientId})`);
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
        const roomId = String(state.roomId || state.room_id || '');
        log(`[✓] @${username} LIVE! roomId: ${roomId}`);
        send(ws, { type: 'tiktok_connected', username, roomId });
    });

    conn.on('disconnected', () => {
        log(`[~] @${username} stream ended`);
        if (isOpen(ws)) {
            send(ws, { type: 'tiktok_disconnected', username, reason: 'stream_ended' });
            scheduleRetry(ws, username);
        }
    });

    conn.on('chat',      (d) => send(ws, { type:'comment',   username: d.uniqueId||d.nickname||'unknown', message: d.comment||'', timestamp: Date.now() }));
    conn.on('gift',      (d) => { log(`[🎁] @${username} <- gift from ${d.uniqueId}: ${d.giftName} x${d.repeatCount}`); send(ws, { type:'gift', username:d.uniqueId||d.nickname||'unknown', giftName:d.giftName||'Gift', giftId:d.giftId||0, coins:d.diamondCount||0, repeatCount:d.repeatCount||1, repeatEnd:d.repeatEnd||false, timestamp:Date.now() }); });
    conn.on('follow',    (d) => { log(`[❤] @${username} <- follow from ${d.uniqueId}`); send(ws, { type:'follow',   username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }); });
    conn.on('share',     (d) => send(ws, { type:'share',    username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));
    conn.on('like',      (d) => send(ws, { type:'like',     username:d.uniqueId||d.nickname||'unknown', likeCount:d.likeCount||1, totalLikes:d.totalLikeCount||0, timestamp:Date.now() }));
    conn.on('member',    (d) => send(ws, { type:'join',     username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));
    conn.on('roomUser',  (d) => send(ws, { type:'viewers',  count:d.viewerCount||0, timestamp:Date.now() }));
    conn.on('subscribe', (d) => send(ws, { type:'subscribe',username:d.uniqueId||d.nickname||'unknown', timestamp:Date.now() }));

    conn.on('error', (err) => {
        // err may be a string, Error object, or anything else
        const msg = (err && (err.message || err.toString())) || 'Unknown error';
        log(`[!] @${username} tiktok error: ${msg}`);
        if (isOpen(ws)) send(ws, { type: 'error', message: msg });
    });

    conn.connect().catch((err) => {
        const msg = (err && (err.message || err.toString())) || 'Not live or unreachable';
        log(`[!] @${username} not live: ${msg}`);
        if (isOpen(ws)) {
            send(ws, { type: 'not_live', username, message: msg });
            scheduleRetry(ws, username);
        }
    });
}

// Auto-retry every 30s when not live — but only if no existing retry pending
function scheduleRetry(ws, username) {
    const session = sessions.get(ws);
    if (!session || !isOpen(ws)) return;
    if (session.retryTimer) return; // already scheduled
    log(`[↺] @${username} will retry in 30s`);
    session.retryTimer = setTimeout(() => {
        if (isOpen(ws)) startSession(ws, username);
    }, 30_000);
}

function cleanupSession(ws, sendMsg = false) {
    const session = sessions.get(ws);
    if (!session) return;
    if (session.retryTimer) { clearTimeout(session.retryTimer); session.retryTimer = null; }
    try { session.conn?.disconnect(); } catch (_) {}
    sessions.delete(ws);
    if (sendMsg && isOpen(ws)) send(ws, { type: 'tiktok_disconnected' });
}

function send(ws, data) { if (isOpen(ws)) try { ws.send(JSON.stringify(data)); } catch(_) {} }
function isOpen(ws) { return ws && ws.readyState === WebSocket.OPEN; }

httpServer.listen(PORT, () => {
    log(`StreamVibe Bridge started on port ${PORT}`);
    log(`Console: /console`);
});

process.on('SIGTERM', () => {
    log('Shutting down...');
    sessions.forEach((_, ws) => cleanupSession(ws));
    process.exit(0);
});
