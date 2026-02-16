# Web Monitoring Interface

A production-grade Bloomberg Terminal-inspired web dashboard for real-time monitoring of the Polymarket copy trading bot.

## Features

- **Real-time Updates**: Server-Sent Events (SSE) for live data streaming
- **Bloomberg Terminal Theme**: Professional dark theme with green monospace text
- **Performance Metrics**: Trade queue, latency tracking, success rates
- **Risk Monitoring**: Circuit breaker status, exposure limits, failure tracking
- **Operations Log**: Live feed of all trading operations
- **Responsive Design**: Works on desktop, tablet, and mobile

## Quick Start

### Enable Web Interface

Add to your `.env` file:

```bash
WEB_ENABLED=true
WEB_PORT=3000
WEB_HOST=localhost
```

### Start Bot with Web Interface

```bash
pnpm dev start
```

Or with environment variables:

```bash
WEB_ENABLED=true pnpm dev start
```

### Access Dashboard

Open your browser to: **http://localhost:3000**

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_ENABLED` | `false` | Enable web interface |
| `WEB_PORT` | `3000` | Port for web server |
| `WEB_HOST` | `localhost` | Host to bind to (use `0.0.0.0` for external access) |
| `WEB_AUTH_TOKEN` | - | Optional: Bearer token for API authentication |
| `WEB_RATE_LIMIT_PER_MIN` | `60` | Max requests per minute per IP |

### Example Configuration

**Development (localhost only):**
```bash
WEB_ENABLED=true
WEB_PORT=3000
WEB_HOST=localhost
```

**Production (external access with auth):**
```bash
WEB_ENABLED=true
WEB_PORT=3000
WEB_HOST=0.0.0.0
WEB_AUTH_TOKEN=your-secret-token-here
WEB_RATE_LIMIT_PER_MIN=120
```

## API Endpoints

### `GET /`
Dashboard HTML page

**Response**: HTML

---

### `GET /api/status`
Current bot status snapshot

**Response**: `BotStatusResponse`

```json
{
  "timestamp": 1708123456789,
  "bot": {
    "isRunning": true,
    "uptime": 3600000
  },
  "balance": {
    "total": 100.50,
    "available": 80.25,
    "inPositions": 20.25
  },
  "positions": {
    "user": {
      "count": 3,
      "totalValue": 20.25,
      "positions": [...]
    },
    "target": {
      "count": 5,
      "totalValue": 2025.00,
      "positions": [...]
    }
  },
  "risk": {
    "circuitBreaker": {
      "isTripped": false,
      "consecutiveFailures": 0,
      "cooldownEndsAt": null
    },
    "tradingAllowed": true,
    "exposure": 0.2015
  },
  "monitoring": {
    "isActive": true,
    "websocketConnected": true,
    "pollingActive": false,
    "targetAddress": "0xe00740..."
  },
  "performance": {
    "queue": {
      "length": 2,
      "processing": 1,
      "maxSize": 100
    },
    "metrics": {
      "tradesQueued": 45,
      "tradesProcessed": 42,
      "tradesSkipped": 1,
      "tradesFailed": 2,
      "successRate": 0.9545
    },
    "latency": {
      "min": 245,
      "max": 1823,
      "avg": 487
    }
  }
}
```

---

### `GET /api/trades/recent?limit=50`
Recent trading operations

**Query Parameters:**
- `limit` (optional): Number of trades to return (1-1000, default: 50)

**Response**: `RecentTradesResponse`

```json
{
  "trades": [
    {
      "id": "trade-123",
      "timestamp": 1708123456789,
      "type": "copy_executed",
      "market": "Will Bitcoin reach $100k by 2024?",
      "side": "BUY",
      "size": 10.5,
      "price": 0.65,
      "value": 6.825,
      "orderId": "order-456",
      "latencyMs": 487
    },
    {
      "id": "trade-124",
      "timestamp": 1708123457890,
      "type": "target_detected",
      "market": "Will Bitcoin reach $100k by 2024?",
      "side": "SELL",
      "size": 5.0,
      "price": 0.68,
      "value": 3.4
    },
    {
      "id": "trade-125",
      "timestamp": 1708123458901,
      "type": "copy_failed",
      "market": "Will Bitcoin reach $100k by 2024?",
      "side": "BUY",
      "size": 10.0,
      "price": 0.70,
      "value": 7.0,
      "error": "Insufficient balance",
      "latencyMs": 234
    }
  ]
}
```

**Trade Types:**
- `target_detected`: Target trader made a trade (queued for copying)
- `copy_executed`: Successfully copied the trade
- `copy_failed`: Failed to copy the trade

---

### `GET /api/events`
Server-Sent Events (SSE) stream for real-time updates

**Response**: `text/event-stream`

**Event Types:**
- `connected`: Initial connection established
- `status_update`: Bot status changed
- `trade_detected`: Target trade detected
- `trade_executed`: Copy trade executed
- `trade_failed`: Copy trade failed
- `circuit_breaker`: Circuit breaker triggered/reset

**Example Event:**
```
event: trade_executed
data: {"orderId":"order-123","size":10.5,"price":0.65,"latencyMs":487}

event: circuit_breaker
data: {"isTripped":true,"reason":"Max consecutive failures"}
```

---

### `GET /health`
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600000
}
```

## Authentication

Optional Bearer token authentication for API endpoints (dashboard is always public).

**Setup:**
```bash
WEB_AUTH_TOKEN=your-secret-token
```

**Usage:**
```bash
curl -H "Authorization: Bearer your-secret-token" \
  http://localhost:3000/api/status
```

**Note**: Authentication is NOT required for:
- `/` (dashboard HTML)
- `/static/*` (CSS, JS files)
- `/views/*` (HTML views)

## Dashboard UI

### Bloomberg Terminal Theme

The dashboard uses a professional financial terminal aesthetic:

- **Background**: Dark blue-black (`#0a0e14`)
- **Primary Text**: Bright green (`#00ff00`)
- **Secondary Text**: Muted green (`#00cc00`)
- **Warnings**: Amber (`#ffb000`)
- **Errors**: Red (`#ff0000`)
- **Info**: Cyan (`#00ccff`)
- **Font**: Monospace (Consolas, Monaco, Courier New)
- **Effects**: Subtle scanline animation, box-drawing characters

### Sections

1. **Header**
   - Bot name and live indicator
   - Connection status (Real-time SSE or Polling fallback)
   - Last update timestamp
   - Uptime

2. **Metrics Grid** (6 cards)
   - **Balance**: Total, Available, In Positions
   - **Positions**: User and Target position counts/values
   - **Risk Management**: Circuit breaker, failures, exposure
   - **Monitoring**: WebSocket/Polling status, target address
   - **Performance**: Trades processed/failed, success rate, latency
   - **Queue Status**: Queue length, processing, utilization

3. **Operations Log**
   - Live scrolling feed of recent operations
   - Shows last 50 trades
   - Color-coded by type (detected/executed/failed)
   - Includes timestamps, market, side, size, price, value
   - Displays errors for failed trades
   - Shows latency for executed trades

### Real-time Updates

The dashboard automatically updates via SSE:
- Status metrics refresh on `status_update` events
- New trades appear instantly in operations log
- Circuit breaker changes trigger immediate UI update
- Auto-reconnects if SSE connection drops
- Fallback polling every 30 seconds if SSE unavailable

## Architecture

### Server Stack
- **Fastify**: High-performance web framework
- **@fastify/cors**: CORS support
- **@fastify/rate-limit**: Rate limiting per IP
- **lit-html**: Lightweight reactive templating

### Client Stack
- **lit-html**: Reactive DOM rendering (no virtual DOM overhead)
- **EventSource**: Native browser SSE support
- **Fetch API**: REST API calls

### Data Flow

```
┌─────────────┐
│ Orchestrator│
│   (Bot)     │
└─────┬───────┘
      │
      │ Events (trade detected/executed/failed)
      ▼
┌─────────────┐
│ SSE Manager │
│  (Broadcast)│
└─────┬───────┘
      │
      │ Server-Sent Events
      ▼
┌─────────────┐
│  Dashboard  │
│  (Browser)  │
└─────────────┘
```

### Trade History Tracking

The `Orchestrator` maintains a circular buffer of trade history:
- **Capacity**: 1000 entries (FIFO)
- **Entries**: All detected/executed/failed trades
- **Storage**: In-memory only (resets on restart)
- **Purpose**: Provides recent operations for dashboard

## Performance

- **SSE Latency**: < 50ms for event broadcast
- **API Response**: < 10ms for status endpoint
- **Memory**: ~10KB per trade entry × 1000 = ~10MB max
- **Rate Limiting**: 60 requests/min per IP (configurable)
- **Concurrent Connections**: Unlimited SSE clients

## Security Considerations

### Production Deployment

1. **Enable Authentication**:
   ```bash
   WEB_AUTH_TOKEN=$(openssl rand -hex 32)
   ```

2. **Use HTTPS**: Deploy behind reverse proxy (nginx, Caddy)

3. **Restrict Host**: Use firewall or `WEB_HOST=127.0.0.1` for localhost-only

4. **Rate Limiting**: Adjust `WEB_RATE_LIMIT_PER_MIN` based on load

5. **Monitor Access**: Check Fastify logs for suspicious activity

### Example nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        chunked_transfer_encoding off;
    }
}
```

## Development

### Testing Locally

```bash
# Start with web enabled
WEB_ENABLED=true WEB_PORT=3001 pnpm dev start

# In another terminal, test endpoints
curl http://localhost:3001/health
curl http://localhost:3001/api/status
curl http://localhost:3001/api/trades/recent?limit=10

# Test SSE stream
curl http://localhost:3001/api/events
```

### Modifying the UI

**Edit CSS (Bloomberg theme):**
```bash
vim src/web/static/dashboard.css
```

**Edit JavaScript (lit-html templates):**
```bash
vim src/web/static/dashboard.js
```

**Edit HTML shell:**
```bash
vim src/web/views/dashboard.html
```

**Rebuild:**
```bash
pnpm build
```

### Adding New API Endpoints

1. Add route in `src/web/server.ts`:
   ```typescript
   this.server.get('/api/new-endpoint', async (request, reply) => {
     // Handle request
   });
   ```

2. Add type in `src/web/types/api.ts`
3. Update documentation

### Adding New SSE Events

1. Define event type in `src/web/types/api.ts`:
   ```typescript
   export type SSEEventType = 'status_update' | 'trade_detected' | 'new_event';
   ```

2. Broadcast from Orchestrator:
   ```typescript
   const sseManager = this.webServer?.getSSEManager();
   if (sseManager) {
     sseManager.broadcast({
       type: 'new_event',
       timestamp: Date.now(),
       data: { ... }
     });
   }
   ```

3. Handle in dashboard.js:
   ```javascript
   eventSource.addEventListener('new_event', (event) => {
     const data = JSON.parse(event.data);
     // Update UI
   });
   ```

## Troubleshooting

### Dashboard Not Loading

**Check if web is enabled:**
```bash
grep WEB_ENABLED .env
```

**Check server logs:**
```bash
WEB_ENABLED=true LOG_LEVEL=debug pnpm dev start
```

**Verify port is available:**
```bash
lsof -i :3000
```

### SSE Connection Failing

**Check browser console** for errors

**Verify SSE endpoint:**
```bash
curl -N http://localhost:3000/api/events
```

**Expected output:**
```
event: connected
data: {"status":"ok"}
```

### API Returning 401 Unauthorized

**Check if auth token is set:**
```bash
grep WEB_AUTH_TOKEN .env
```

**Test with token:**
```bash
curl -H "Authorization: Bearer your-token" \
  http://localhost:3000/api/status
```

### Rate Limit Errors (429)

**Increase limit:**
```bash
WEB_RATE_LIMIT_PER_MIN=120
```

**Or disable for testing:**
```typescript
// Comment out in src/web/server.ts
// this.server.register(rateLimit, { ... });
```

## License

MIT
