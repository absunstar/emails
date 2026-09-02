# MCP Agent Scheduling + Deliverability Release

- MCP server version: 4.2.0
- MCP tools: 51
- Preferred scheduling field: `sendAt`
- Persistent scheduler retained across restart
- New persistent Deliverability Engine
- Per-domain and recognized-provider throttling
- Warm-up/ramp-up default 250/day -> +25%/day -> max 10,000/day
- Bounce, unsubscribe, complaint and manual suppression
- Conservative automatic hard-bounce classification
- Conservative inbound DSN detection
- Global/domain/provider circuit breakers
- Scheduled messages automatically defer on temporary deliverability throttles
- Suppressed destinations fail permanently rather than retrying
- New deliverability status/preflight/config/suppression/feedback MCP tools
