# 100,000 Stored Messages + MCP Runtime Control

- Default automatic stored-message cap is now **100,000** (`EMAIL_MAX_MESSAGES` can still set the startup value).
- Existing count-based cleanup still protects VIP/company messages.
- At large limits (>=10,000), cleanup keeps a small reserve (1% capped at 1,000) so the server does not scan ~100k messages for every single new delivery once the cap is full.
- MCP now exposes:
  - `email_storage_message_limit_get`
  - `email_storage_message_limit_set`
- MCP changes are persisted in `email-files/meta.json` and survive restarts.
- MCP can set 1..1,000,000 messages. Lowering below the current stored count requires `confirm=true`; `cleanupNow=true` performs the protected cleanup immediately.
- Disk quota / low-space protection remains active independently of the count cap, so the server can still protect itself if attachments consume excessive disk space.
