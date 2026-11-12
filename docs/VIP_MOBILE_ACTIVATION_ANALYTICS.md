# VIP Temp Mails — opt-in activation diagnostics (2026-11-12)

## Scope and privacy

This change instruments the Android app activation funnel, not mailbox content or user accounts.
The app does not send diagnostics unless the user enables "Anonymous usage diagnostics"
in the drawer. This setting defaults to OFF.

Allowed events:
- app_open: an app launch after opt-in (including when the toggle is enabled)
- mailbox_create_success / mailbox_create_failure: account generation outcome
- mailbox_open: inbox screen opened
- inbox_load_success / inbox_load_failure: first success/failure per app run
- first_message_seen: first non-empty inbox after opt-in, one time
- message_open: message details successfully displayed

The payload is limited to a whitelisted event name and a random installation ID.
Never transmit addresses, message data, ownership tokens, purchase tokens or geolocation.

The backend stores an HMAC-SHA256 pseudonym using a server-secret key with mode 0600,
not the raw installation ID or IP in the diagnostic records. Standard web access logs
have separate policies. Data older than 90 days is purged. Disabling tracking stops
new reporting and deletes installation-level history; if offline, deletion is retried
at the next app launch. Anonymous aggregate counters persist for up to 90 days.

## API

POST /api/mobile/analytics/event: event, installationId
POST /api/mobile/analytics/delete: installationId
POST /api/mobile/analytics/admin/summary: days

The summary endpoint requires an authenticated super_admin principal. All routes
are protected by the existing HTTP abuse/rate guard.

## Interpretation

D1 and D7 rates show UTC next-day and day-7 returns among consenting installations
in their first observed cohorts. They are not Google Play installs, all-user
retention or population-wide conversion. Always report denominator and sample size.

The event first_message_seen means a message was visible in the app inbox, not that
this is the first message that SMTP delivered to the mailbox.

## Validation / release

1. Run node tests/mobile-analytics.js and the full npm test suite.
2. Report with node scripts/mobile-analytics-summary.js.
3. Unauthenticated admin summary request must return 403.
4. Deploy the backend before the Android app.
5. Require flutter analyze, flutter test, flutter build appbundle --release,
   signing verification, and real-device smoke tests before a Play rollout.
6. Update Google Play Data safety and the privacy notice for opt-in pseudonymous
   diagnostic data before a public Android release.
