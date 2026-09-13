# MCP Manager Release 4.1

- Fixed manager credential: `SOCIALBROWERMANAGER`.
- Primary remote endpoint: `http://127.0.0.1:60026/mcp/SOCIALBROWERMANAGER`.
- Modern `2026-07-28` stateless Streamable HTTP support.
- Backward-compatible initialize/session Streamable HTTP for 2025 and older protocol revisions.
- Legacy HTTP + SSE transport at `/mcp/SOCIALBROWERMANAGER/sse` with `/message` POST channel.
- Optional STDIO transport with `npm run mcp:stdio`.
- HTTP POST, GET, DELETE, OPTIONS and HEAD handling.
- 43 MCP tools with full manager/admin scope, including persistent scheduled sending.
- Native resources, resource templates, prompts and completion support.
- `subscriptions/listen` SSE support for the 2026 protocol generation.
- Resources subscribe/unsubscribe, logging level, ping and common lifecycle notifications for older clients.
- Security-policy operations use the same `email-abuse-policy.json` and shared runtime policy as SMTP and Admin Console.
- Outgoing MCP actions use a dedicated MCP outbound bucket. The safe default is 500 actual sends/hour, and every message inside a bulk send counts individually.
- Regression covers modern Streamable HTTP, stateful HTTP, legacy SSE, SSE responses, STDIO, resources, prompts, completions and the full shared EmailService integration.

## Scheduled email

- Persistent JSON queue under `localStorage/email-schedules/tasks`.
- One-time send at an explicit ISO-8601 instant or `date` + `time` + `timezoneOffset`.
- Bulk scheduling with optional spacing.
- List/get/update/cancel/send-now/retry/status tools.
- Jobs survive restarts.
- Rate-limited jobs defer automatically.
- SMTP failures use bounded retries.
- Interrupted `sending` jobs recover as `failed` with delivery state marked unknown, preventing blind duplicate retries.
