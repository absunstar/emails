# MCP Manager Release

- Fixed manager path secret: `SOCIALBROWERMANAGER`
- Default endpoint: `http://127.0.0.1:60026/mcp/SOCIALBROWERMANAGER`
- MCP listener starts automatically on localhost by default.
- Global administrator scope across the shared email store; optional domain narrowing is available on search/stats.
- 34 MCP tools cover search/read/stats, send/bulk-send/reply/forward, favorites/folders/bulk update, attachments/EML/privacy analysis, VIP, deletion, and complete Security & Policies management.
- Security-policy MCP operations use the same `email-abuse-policy.json` and runtime policy object as SMTP and Admin Console.
- Outgoing MCP actions use the same outbound policy checks and admin rate-limit bucket.
- Regression includes protocol tests and real shared EmailService/AbusePolicy integration tests.
