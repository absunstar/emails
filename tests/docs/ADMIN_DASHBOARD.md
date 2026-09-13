# Social Temp Mail Admin Dashboard

The `/admin` interface is a dedicated full-control mail workspace.

## Access

The page is rendered only when the current request comes from Social Browser and the `x-browser` value matches one of the default admin patterns:

- `*test*`
- `*admin*`
- `*dev*`

The default patterns can be overridden with `EMAIL_ADMIN_BROWSER_IDS`.

The HTML route is server-gated. Unauthorized requests receive HTTP 403 before the dashboard is rendered.

## Dashboard capabilities

- Cross-domain view of all messages stored by this email server.
- Global search across sender, recipient, subject and message content.
- Filters for sender, recipient, subject, folder, read state, transport status, dates, favorites and attachments.
- Folder navigation and custom folder assignment.
- Favorites/starred messages.
- Read/unread state management.
- Bulk mark read/unread.
- Bulk favorite/unfavorite.
- Bulk move to folder.
- Bulk permanent deletion.
- Full message viewer.
- Tracking-pixel, remote-image and external-link diagnostics.
- Remote images blocked by default with an explicit Show Images action.
- Attachment listing and download.
- Complete EML download.
- Send Mail composer.
- Reply from the received mailbox.
- Forward messages.
- VIP mailbox enable/disable.
- Storage usage and folder/message statistics.
- Responsive desktop/tablet/mobile layout.
- Toast feedback for successful and failed admin operations.

## Persistence

Message favorites and folder assignments are persisted in the same JSON message documents. No database is introduced.

## Admin APIs

The dashboard uses dedicated guarded endpoints under `/api/emails/admin/` for summary, listing, message reads, updates, bulk operations, send, reply, forward, delete and VIP operations. Public and legacy APIs remain separate.

## 10,000-message scale contract

The admin console treats 10,000 stored messages as a normal operating size.

- The browser never receives all stored messages at once.
- `/api/emails/admin/list` performs filtering, sorting and pagination on the server and returns at most 250 rows per request.
- Admin list scans use in-memory message references directly instead of deep-cloning the entire store before filtering.
- Sorting is server-side for date, id, sender, recipient, subject, folder and status.
- Auto refresh is optional and refreshes the visible list every 15 seconds; summary counters refresh less frequently.
- The store's automatic cleanup selects only the oldest required non-protected messages instead of sorting all 10,000 messages every time the limit is exceeded.
- VIP/protected messages remain excluded from automatic cleanup candidates.

## Admin workspace controls

- Clickable summary cards for All, Unread, Favorites, Attachments and Failed sends.
- Persistent custom folders with a New Folder action.
- Server-side search, advanced filters and sortable table headers.
- Column visibility preferences stored in localStorage.
- Optional 15-second auto refresh stored in localStorage.
- Bulk actions appear only after selecting one or more rows.
- Pagination is hidden when the current result set fits on one page.
- Message details open as a right-side drawer on desktop and a modal on smaller screens.

## Security & Policies

The dashboard includes a full Security & Policies manager for SMTP/public API abuse protection. It controls email/domain/IP/content allow/block lists, outgoing-mail policy, SMTP/HTTP/outbound rate limits, size limits, import/export, rule testing, and runtime protection activity. The persisted source is `localStorage/email-abuse-policy.json`.
