# Pro-only mailboxes

Mailboxes generated with `client=vip-temp-mail-pro` / `proOnly=true` are persisted with `proOnly: true` and a SHA-256 ownership-token hash.

Public/free access to `/api/emails/all` for these addresses receives exactly one virtual notice message. `/api/emails/view` returns the same notice unless the correct `ownerToken` is supplied. Web view, EML and attachment paths are protected as well.

The real messages remain stored normally and are only returned to requests carrying the valid per-mailbox owner token.
