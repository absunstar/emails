# Social Browser Email Server

SMTP + temporary-mail website + MCP email service for Social Browser and related sites.

## Storage model

The email runtime is **file-first and JSON-only**. There are no email collections and no database connection in `server.js` or `apps/emails/`.

Canonical storage:

```text
localStorage/
  vip-email-list.json
  email-files/
    meta.json
    messages/
      00..ff/
        <sha256-guid>.json
    tracking/
      00..ff/
        <sha256-mailbox>.json
    audit/
      YYYY-MM-DD/
        <event-id>.json
```

Each email is an independent JSON file. Writes use a temporary JSON file followed by rename/replace, and mutations are serialized in-process to avoid overlapping writes.

## Temporary-mail access

Normal temporary-mail addresses are public: receiving, mailbox search, message listing, and message viewing do not require an account.

VIP/company addresses remain protected. Their list is stored in `localStorage/vip-email-list.json`. The existing trusted Social Browser IDs continue to unlock VIP mail, and administrator access also unlocks it. `/viewEmail` now enforces the same VIP protection as the JSON API so the message body cannot bypass the VIP check.

## Deletion policy

Manual deletion is an administrator operation. This applies to single delete and bulk delete APIs.

Automatic retention cleanup is separate: the file store starts removing the **oldest non-VIP messages only after the stored message count exceeds 10,000** (configurable with `EMAIL_MAX_MESSAGES`). VIP/company mail is protected from this automatic cleanup.

## MCP

The MCP is a full administrator/manager interface over the same JSON-file EmailService and AbusePolicy used by the website and SMTP server. It does not call `/api/emails/*`.

The manager path is fixed in this build:

```text
http://127.0.0.1:60026/mcp/SOCIALBROWERMANAGER
```

It starts automatically on `127.0.0.1:60026` by default. `EMAIL_MCP_HOST`, `EMAIL_MCP_PORT`, and optional `EMAIL_MCP_BEARER_TOKEN` remain configurable; `EMAIL_MCP_SECRET` is no longer required. Because the fixed path has full manager authority, keep the listener on localhost and use an additional trusted HTTPS/reverse-proxy security layer before remote production exposure.

The MCP currently exposes 43 tools covering global/domain search, pagination/sorting, complete reads, mailbox status, stats, send/bulk send, persistent scheduled sending, reply, forward, favorites, folders, bulk updates, attachments, EML export, remote-image/tracking-pixel analysis, VIP management, deletion, and complete Security & Policies control including rules, limits, tests and live activity.

See `MCP_SETUP.md` for the complete tool inventory and deployment details.

## Tests

```bash
npm test
```

The tests cover JSON persistence, public Temp Mail access, VIP blocking, VIP-safe automatic cleanup, administrator-only manual deletion, bulk sending, and MCP protocol/tool behavior.


## Runtime domain model

The application has no configured mail-domain list. The default mail domain is derived from the current Host at runtime and subdomains collapse to the root mail domain:

- Browser UI: `xxx.yyyy.domain.com` becomes `@domain.com`
- Website API: an explicit email in the request wins over Host; otherwise Host is reduced to the root mail domain
- MCP Manager: global administrator scope by default; `email_search` and `email_stats` can optionally narrow to a specific mail domain.

A single Node/iSite process can therefore serve multiple DNS names on the same host without per-domain configuration. Public website/API requests remain scoped by their current hostname/email rules. The private MCP Manager is intentionally cross-domain administrator access and is not limited by HTTP Host. Reverse proxies should still preserve the original `Host` header for normal website behavior.

## Browser-local temp-mail address book

The public page now keeps created temp-mail addresses in browser `localStorage`. Guest UI supports 10 saved addresses. A request carrying the `x-browser` header receives a transient `isSocialBrowser` page signal and the UI supports 100 saved addresses plus local address removal. No quota or address-book state is stored on the server. See `LOCAL_ADDRESS_BOOK.md`.

## x-browser-only login

Website browser login is local to this server and uses only the current request `x-browser` header. A non-empty header means logged in; a missing header means guest. There is no external authentication website, callback, remote verification, or browser-login database. The header identity may be mirrored into `req.session.user` for local iSite compatibility, but authorization always checks the current header. See `BROWSER_LOGIN.md`.

## Production abuse controls

The running server creates `localStorage/email-abuse-policy.json`. Authorized administrators can edit it from `/admin` using **Security & Policies**. The policy controls sender/recipient/domain/IP/content allow/block rules, outgoing-mail restrictions, SMTP connection limits, HTTP/API/inbox/admin rate limits, request/message/attachment sizes, and Send/Reply/Forward hourly limits.

For reverse-proxy deployments that need real client IP rules, set `EMAIL_TRUST_PROXY=true` only when the proxy is trusted and direct client access cannot spoof `X-Forwarded-For`.

Environment variables such as `EMAIL_BLOCK_FROM`, `EMAIL_ALLOW_TO`, `EMAIL_BLOCK_IPS` and related policy variables are treated as first-run defaults. After the policy JSON exists, the Admin policy file is the runtime source of truth.
