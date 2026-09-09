# Pro mailbox ownership and delete

New `/generate-new-email` responses include `ownerToken`. Existing clients safely ignore the extra field. The server persists only a SHA-256 hash in `localStorage/email-mailbox-ownership.json`.

`POST /api/emails/pro/delete` requires `guid`, `email`, and `ownerToken`. The message must belong to the owned mailbox and current mail domain. VIP/protected messages are rejected.

Deletion behavior:
- single-recipient message: underlying JSON message is deleted and a mailbox tombstone is recorded;
- multi-recipient message: only a mailbox tombstone is recorded, so other recipients do not lose their message.

`/api/emails/all` filters tombstoned messages for the requested mailbox and GUID-based `/api/emails/view` returns not found for that mailbox.
