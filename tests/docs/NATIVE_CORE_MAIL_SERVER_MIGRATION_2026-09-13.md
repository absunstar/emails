# Native Core Mail Server Migration — 2026-09-13

## Runtime
- Replaced the external `../isite` runtime with the bundled `vendor/social-browser-core` package.
- Bundled Core version: 6.10.3.
- Native Core is authoritative; `compatibility: 'isite'` is not enabled.
- The existing HTML directive parser is imported as a focused parser module from the bundled Core only, so existing UI templates remain compatible without loading iSite runtime.
- Email application registration is explicit: `require('./apps/emails/app')(site)`.
- Static assets are served through Native Core `site.static()`.

## Memory/OOM correction
- The JSON store no longer holds full message `text` and `html` bodies in RAM.
- Startup builds a metadata-only index; full message bodies remain on disk and are hydrated only for reads or body-search candidates.
- Search returns metadata by default and hydrates only the requested page when `includeBody` is enabled.
- Numeric legacy message-id lookup hydrates only matching messages.
- The 8 GB Node heap workaround was removed from the start command.

## HTTP/UI
- `/` is registered explicitly through the email app under Native Core, removing the `Base Route / Not Set` failure mode caused by missing iSite app auto-loading.
- Existing `x-import`, language tokens, host feature filters, and word tokens are rendered by a project bridge using the parser bundled with Core.
- Existing browser/OTP API contracts remain unchanged.

## Security/operations
- Existing SMTP message and attachment size limits remain active.
- `/health` and `/ready` remain available and runtime monitoring already includes RSS/heap/external memory metrics.
- MCP, scheduler, deliverability, abuse policy, backup and storage manager remain attached to the same email service authority.

## Verification
- Native bundled Core runtime test: PASS.
- Bounded-memory store regression: PASS.
- Frontend zero-dependency guard: PASS after removing the stale unused export vendor bundle.
- Existing functional tests through admin/abuse/MCP/scheduler/deliverability/backup: PASS in the available environment.
- Nodemailer-dependent SMTP signing test could not run in this build environment because dependency installation is unavailable; deployment must run `npm install` or `npm ci` before start.
