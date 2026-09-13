# Operations, Live Inbox and Growth Release

This release implements the requested development items 1, 2, 3, 4, 7, 9 and 10 from the production roadmap.

## 1. Admin Scheduled Emails

The Admin Console now includes a Scheduled Emails workspace with scheduler status, filtering, create/edit, send now, cancel and retry actions. Scheduled messages remain persisted by the existing JSON scheduler and use the same outbound policies, rate limits and deliverability checks as immediate sends.

## 2. Deliverability Dashboard and Suppressions

The Admin Console now exposes provider/domain health, current pacing and daily/hourly limits, warm-up state, bounce/complaint/failure rates, circuit-breaker status, deliverability settings and the persistent suppression list.

## 3. Unsubscribe and Feedback/FBL

Single-recipient outbound messages can include RFC-style List-Unsubscribe and List-Unsubscribe-Post headers with an HMAC-signed one-click URL. The public unsubscribe route writes directly to the deliverability suppression list.

Inbound DSN failures and ARF complaint reports are parsed by the deliverability engine. A token-protected normalized feedback webhook is also available at `/api/emails/feedback` when `EMAIL_FEEDBACK_TOKEN` is configured. The endpoint accepts complaint, hard/soft bounce, unsubscribe and delivered feedback, including common aliases.

Provider account enrollment, credentials, and external provider-side configuration are intentionally not performed by this release because real provider setup/testing was excluded from the requested scope.

## 4. Production Health and Monitoring

Public minimal endpoints:

- `/health`
- `/ready`

The Admin Health workspace exposes HTTP/SMTP/MCP/Scheduler component states, memory, event-loop lag, SMTP accept/reject counts, incoming/outgoing counters, SSE activity, feedback/unsubscribe activity, scheduler queue state and recent runtime errors.

## 7. SSE Live Inbox

The public inbox uses Server-Sent Events first. It subscribes to the currently saved temporary inboxes and receives lightweight new-message events without exposing message bodies in the stream. If SSE is unavailable or disconnects, the frontend automatically falls back to polling and periodically retries SSE. A 60-second reconciliation poll remains active while SSE is healthy.

## 9. Load and Failure Harness

Commands:

```bash
npm run test:load
npm run test:load:full
```

The full harness exercises 100,000 in-memory stored message records, a 10,000-task persistent scheduler directory, 1,000 concurrent mailbox-status clients and scheduler crash recovery from an interrupted `sending` state. It uses a mock transport and sends no real external email.

## 10. SEO and Growth Pages

Added canonical landing pages:

- `/temporary-email`
- `/disposable-email`
- `/verification-code-email`
- `/temp-email-for-testing`
- `/multiple-temporary-inboxes`
- `/developer-temp-mail`

Each page has a unique title/description, canonical URL, Open Graph metadata, WebApplication structured data and internal related-page links. `sitemap.xml` and `robots.txt` now expose the public pages to crawlers. The homepage has canonical/hreflang metadata and links to these guides.

## Explicitly deferred

Per the request, this release does not implement roadmap items:

- 5: Backup/restore and disk-management expansion was completed in the subsequent Backup/DR release documented in `BACKUP_DISASTER_RECOVERY.md`.
- 6: Real Gmail/Outlook/Yahoo/iCloud delivery tests or provider-account setup
- 8: Final security-hardening project

Existing functionality in those areas remains unchanged.
