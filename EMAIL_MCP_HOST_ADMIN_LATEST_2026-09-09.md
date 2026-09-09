# Email MCP Host Admin — latest baseline integration

Baseline used:
`temp-mail-server-2026-09-09-pro-any-app-access.zip`

This package preserves the complete latest baseline and adds only:
- `apps/emails/mcp-host-admin.js`
- registration/dispatch hooks in `apps/emails/mcp-server.js`

No rollback of SMTP, Pro access, mailbox, storage, UI, or deliverability features.

Managed Egytag defaults:
- public IP: 169.58.4.25
- domain: egytag.com
- SMTP hostname: mail.egytag.com
- DKIM selector: default
- DKIM root: /etc/mail/dkim
- EMAIL_PUBLIC_ORIGIN: https://emails.egytag.com
