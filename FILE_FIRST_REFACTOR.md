# File-first email refactor

## Implemented

- Removed all email runtime collection/database usage from `server.js` and `apps/emails/`.
- One shared JSON-backed email core is now used by SMTP, website APIs, and MCP.
- MCP never calls website API routes.
- One JSON file per message, sharded by SHA-256 prefix.
- JSON-only VIP list, mailbox access tracking, metadata, and audit logs.
- Public Temp Mail read/search behavior remains open for normal addresses.
- VIP/company mail remains protected on list, API view, and direct `/viewEmail` body view.
- Fixed the old **Set as Normal** frontend route bug.
- Manual single/bulk deletion requires administrator context.
- MCP secret is the administrator credential for MCP destructive tools.
- Automatic cleanup starts only above the configured threshold (10,000 by default) and removes oldest non-VIP mail first.
- Bulk MCP operations include multi-read, multi-send, explicit multi-delete, filtered preview/confirmed delete, and multi-message read-state changes.

## Primary modules

- `apps/emails/core/json-store.js`
- `apps/emails/core/email-service.js`
- `apps/emails/core/access.js`
- `apps/emails/app.js`
- `apps/emails/mcp-service.js`
- `apps/emails/mcp-server.js`
- `server.js`

## Verification

Run:

```bash
npm test
```

Expected:

```text
File-first email service tests passed
MCP protocol smoke tests passed
```


## Attachments

Attachment binaries are stored separately under `localStorage/email-files/attachments/`. Message JSON contains metadata only. Attachment directories are removed with their parent message during manual deletion or automatic cleanup.
