# Social Browser Email Manager MCP

The MCP is a full administrator/manager protocol surface over the same JSON-file email core used by SMTP, Temp Mail, and `/admin`. It does not call website API routes; it uses `core/email-service.js` and the shared abuse-policy service directly.

## Fixed manager endpoint

The MCP manager secret is fixed in this build:

```text
SOCIALBROWERMANAGER
```

Default listener:

```text
http://127.0.0.1:60026/mcp/SOCIALBROWERMANAGER
```

The listener starts automatically. `EMAIL_MCP_SECRET` is no longer required or read by `server.js`.

Optional runtime settings:

```bash
EMAIL_MCP_HOST=127.0.0.1
EMAIL_MCP_PORT=60026
EMAIL_MCP_BEARER_TOKEN=
```

Keep `EMAIL_MCP_HOST=127.0.0.1` unless you intentionally need direct network exposure. Because the path credential is fixed and the MCP has administrator capabilities, production Internet exposure should use an additional trusted reverse-proxy security layer and HTTPS. `EMAIL_MCP_BEARER_TOKEN` remains available for MCP clients/proxies that can provide a static Bearer header.

## Manager scope

This MCP is intentionally **global administrator access**. It is not restricted to the HTTP Host domain. `email_search` and `email_stats` accept an optional `domain` argument when the AI should narrow work to one mail domain; omitting `domain` searches/manages the full shared server store.

VIP mail is available to the MCP manager. Manual delete operations use administrator context.

## Capabilities and tools

The build exposes 34 tools.

### Discovery, search and reading

- `email_capabilities` — describe manager scope and capability groups.
- `email_search` — server-side global/domain search, pagination, sorting, status, folders, favorites, read state, attachments, dates and text/body filters.
- `email_read` — read a complete message.
- `email_read_many` — read up to 100 complete messages.
- `email_mailbox_statuses` — live counts/latest metadata for up to 100 mailbox addresses.
- `email_stats` — global/domain totals, unread, favorites, attachments, failed sends, VIP and folder counts.

### Sending and message actions

- `email_send`
- `email_send_bulk`
- `email_reply`
- `email_forward`
- `email_update` — read/favorite/folder/status plus administrator body/subject editing.
- `email_update_bulk` — bulk read/favorite/folder/status changes for explicit guids.
- `email_set_read`

All outgoing actions pass through the same outbound policy checks and abuse limits as the product.

### Attachments, EML and privacy inspection

- `email_attachment_read` — returns attachment metadata and base64 bytes with a bounded response size.
- `email_eml_export` — returns complete EML as base64.
- `email_analyze` — remote-image count/URLs, tracking-pixel estimate, external links and attachment metadata without loading remote assets.

`email_read` already returns the original text/HTML body, so the MCP can inspect HTML while remote images remain unrequested unless another client explicitly loads those URLs.

### VIP and folders

- `email_vip_list`
- `email_vip_set`
- `email_folders_list`
- `email_folder_create`

Favorites and moving messages between folders are handled by `email_update` / `email_update_bulk`.

### Deletion

- `email_delete`
- `email_delete_bulk`
- `email_delete_matching`

`email_delete_matching` supports preview mode. Use `confirm=false` first, then `confirm=true` only after the intended candidate set is verified.

### Security & Policies

- `email_policy_get` — current configuration, defaults, path and activity.
- `email_policy_export` — export current Security & Policies config as structured JSON.
- `email_policy_import` — import complete/partial policy JSON through the same sanitizer as Admin.
- `email_policy_status` — live counters, active SMTP connections, limiter buckets and recent protection events.
- `email_policy_update` — partial or full config update.
- `email_policy_reset` — reset to defaults; requires `confirm=true`.
- `email_policy_test` — test From, To, IP, Subject, Ignore or Outbound decisions without changing settings.
- `email_policy_rule_add`
- `email_policy_rule_remove`
- `email_policy_list_set_enabled`
- `email_policy_limit_set`

These manipulate the same `localStorage/email-abuse-policy.json` used by `/admin`. Supported lists include From/To email and domain allow/block lists, IP allow/block lists, subject/ignore lists, and outbound sender/recipient/domain lists. IP rules support exact values, wildcards and IPv4 CIDR where supported by the shared policy engine.

## Shared persistence

```text
localStorage/
  vip-email-list.json
  email-abuse-policy.json
  email-files/
    meta.json
    messages/00..ff/*.json
    attachments/...
    tracking/...
    audit/YYYY-MM-DD/*.json
```

There is no email database fallback. The JSON files are the durable source of truth.

## Nginx example

Expose only through HTTPS when remote MCP access is needed:

```nginx
location /mcp/ {
    proxy_pass http://127.0.0.1:60026;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

Remote URL:

```text
https://mail.example.com/mcp/SOCIALBROWERMANAGER
```

## Quick local test

```bash
npm test
```

Or run only MCP regression:

```bash
node tests/mcp-smoke.js
```

The MCP smoke test verifies the fixed manager path, modern/legacy handshakes, discovery, tool listing, advanced search, favorite/folder update, policy rule management, limit management, destructive confirmation and protocol headers.
