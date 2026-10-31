# Local Temp-Mail Address Book

The public temp-mail address manager is browser-local by design.

## Rules

- The server does not store user address-book membership or quota state.
- The browser stores the address book in `localStorage`.
- Guest UI limit: 10 saved addresses.
- Social Browser UI limit: 100 saved addresses.
- Guest and Social Browser users can remove locally saved addresses after an explicit confirmation.
- When all slots are full, choosing New Email or opening a new typed address presents a replacement picker; the user selects which saved address to replace and confirms before it is removed.
- Unread inboxes remain selectable but clearly show their unread count in the picker.
- Removing an address from the browser does **not** delete mail messages from server storage.
- Switching a saved address loads that mailbox from the existing email API.
- The active address and last-known message count are persisted locally.

## Social Browser detection

The page never detects Social Browser from `window.SOCIALBROWSER` or User-Agent for this feature.

The server reads the request header:

```text
x-browser: <non-empty value>
```

and exposes only a transient page capability signal through:

```text
POST /api/emails/client-context
```

Response:

```json
{
  "done": true,
  "isSocialBrowser": true
}
```

No account, IP quota, device registration, session quota, or server-side address list is created by this endpoint.

## Storage key

The address book uses a root-mail-domain scoped key:

```text
social-temp-mail.address-book.v1.<root-mail-domain>
```

The key is still subject to normal browser origin/localStorage isolation.
## Manual mailbox entry

The free page address field is editable. A user may type a full mailbox address directly or type only a local name, in which case the current site's mail domain is appended. A full address keeps its explicit domain. The typed mailbox is not counted merely because it was entered; when the user chooses View Messages, the mailbox is added to the local address book if it is not already present. The same browser-side quota applies to this automatic addition: 10 saved addresses for a guest and 100 in Social Browser. If the quota is full, the user may first replace an existing locally saved address (with confirmation), then open the typed mailbox.



## Live multi-inbox fields

Each local address may additionally keep `unreadCount`, `lastMessageAt`, `lastMessageSubject`, and `lastMessageFrom`. These values are browser-local UI state. The server does not own the 10/100 address quota.

The free page batches up to 100 saved addresses into `/api/emails/inboxes/status` for live counts and latest-message metadata.
