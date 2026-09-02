# Competitive Temp Mail Feature Pack

This update is isolated to the email project. No Social Browser website, desktop browser, mobile application, or other project is modified.

## Free inbox experience

- Live multi-inbox polling for every locally saved address in one batched request.
- Unread counters in the address sidebar.
- Automatic refresh of the active inbox when new mail arrives.
- Browser notification opt-in and optional local notification sound.
- Search and sort saved addresses by recent activity, unread count, or creation date.
- Import and export the local address book as JSON/TXT-compatible data.
- Last checked, last message time, sender, and subject metadata remain browser-local.
- Manual mailbox entry remains supported and is added only when messages are viewed.
- Existing browser-local limits remain 10 Guest / 100 Social Browser.

## Message reading

- Verification/OTP code detection.
- Verification and confirmation link detection.
- External images are blocked by default.
- Possible tracking pixels are counted and reported.
- Users can explicitly load remote images for one open message.
- Attachments are saved outside message JSON and can be downloaded individually.
- Full messages can be downloaded as `.eml` with attachments.
- QR transfer is generated locally by the email server without a third-party QR service.

## Outbound actions

Reply and Forward are exposed only when the email site detects Social Browser. The email server applies an in-memory hourly send limit (`EMAIL_BROWSER_SEND_LIMIT_PER_HOUR`, default 20) and requires the From address to be a recipient of the original message. These actions do not change the public incoming-mail model.

## Storage

Message metadata remains JSON-file based. Attachment binaries are stored under:

```text
localStorage/email-files/attachments/
```

Deleting or automatically cleaning a message also removes its attachment directory.

## New local API surfaces

- `POST /api/emails/inboxes/status`
- `GET /api/emails/attachment`
- `GET /api/emails/eml`
- `GET /api/emails/qr`
- `POST /api/emails/reply`
- `POST /api/emails/forward`

All are implemented in this email project only.

## UI clarity update — 2026-09-02

The public Temp Mail workspace was reorganized for average users without changing other projects:

- Import and Export are now grouped under one **Backup & Restore** control.
- The Backup & Restore modal explains what each action does before the user runs it.
- JSON backup restore preserves saved-address metadata and the active address when possible; text-list import remains supported.
- Saved-address usage now has a visual progress bar and near-limit state.
- Notifications and Sound are clearer two-state controls with icons.
- The main workspace now explains that users may type any email and that it is saved when messages are viewed.
- The Google Play callout is visually secondary to the email workflow.
- Inbox empty state and message cards have clearer hierarchy and icons.
- Live polling uses a subtle pulse; cards and buttons use restrained motion with `prefers-reduced-motion` support.
- Responsive layout was refined for tablet and mobile widths.


## Homepage and sign-in clarity update

- The homepage now contains a complete feature catalog grouped into Inbox Management, Verification & Alerts, Privacy & Message Inspection, and Transfer & Productivity.
- Social Browser-only actions are labeled explicitly instead of being presented as universally available.
- The homepage calls out Live Multi-Inbox, automatic refresh, unread counters, search/sort, manual address entry, 10/100 saved inbox limits, OTP detection, verification links, notifications, sound alerts, Tracking Pixel Scan, remote-image protection, attachments, EML download, QR transfer, Backup & Restore, Reply, Forward, browser-local address-book state, and saved-address removal.
- The Social Browser sign-in page was rebuilt as a two-panel guided flow with three steps, a clear download CTA, benefits, and a direct route back to Temp Mail.
