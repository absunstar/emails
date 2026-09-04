# Admin Gmail-like UX update — 2026-09-04

- Removed horizontal scrolling from the admin messages table using a fixed, responsive table layout.
- Message rows now open the email when clicking anywhere on the non-interactive area of the row.
- Added Gmail-style right-click context menu for Open, Mark read/unread, Star/unstar, Move to folder, Download EML, and Delete.
- Existing folders are available directly from the context submenu, with an Other folder option.
- Improved row hover/action behavior and responsive column reduction on smaller widths.
- Enlarged the message reader to a centered Gmail-like reading workspace while keeping existing reply, forward, attachments, privacy and folder controls.
- Added regression test: tests/admin-gmail-interactions.js.
