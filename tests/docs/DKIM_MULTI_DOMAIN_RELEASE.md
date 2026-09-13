# Email Site — Multi-domain DKIM update — 2026-09-05

Full-site build based on the latest email-site archive found in the Library (`emails-2026-09-04-admin-gmail-like-row-context-no-horizontal-scroll.zip`).

Changes in this build:
- DKIM signing identity is selected from the actual visible `From:` address.
- Supports multiple email domains on one application deployment.
- Supports different DKIM selectors on different sending servers.
- Optional per-domain selector and key-path maps.
- Optional fail-closed mode with `DKIM_REQUIRE_SIGNING=true`.
- SMTP server greeting name is configurable using `SMTP_HOSTNAME` and defaults to `mail.social-browser.com`.
- Existing Email MCP, scheduler, deliverability engine, abuse policy, unsubscribe handling, admin UI, backup/DR and disk-management functionality are preserved.
- Complete project regression suite passes after the update.
