# StreamVibe Bridge

Multi-user TikTok Live WebSocket bridge for StreamVibe Mobile.

## Deploy to Railway (free)

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Push this folder to a GitHub repo
3. Railway auto-detects Node.js and runs `npm start`
4. Copy the generated domain (e.g. `streamvibe-bridge.up.railway.app`)
5. In StreamVibe Mobile → Settings → Bridge URL: `wss://streamvibe-bridge.up.railway.app`

## How it works

Each Android client connects via WebSocket and sends:
```json
{ "type": "connect_tiktok", "username": "yourname" }
```

The server creates a dedicated `tiktok-live-connector` instance per client.
When the user is not live, it retries every 30 seconds automatically.
When they go live, it connects and streams events back to the client.

## Events sent to client

| type | fields |
|------|--------|
| `bridge_connected` | Connected to this server |
| `connecting` | Attempting TikTok connection |
| `tiktok_connected` | `username`, `roomId` |
| `tiktok_disconnected` | `reason` |
| `not_live` | User not currently live (will retry) |
| `comment` | `username`, `message` |
| `gift` | `username`, `giftName`, `coins`, `repeatCount` |
| `follow` | `username` |
| `share` | `username` |
| `like` | `username`, `likeCount` |
| `join` | `username` |
| `viewers` | `count` |
| `subscribe` | `username` |
