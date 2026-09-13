# Email .env / SMTP / DKIM Hotfix — 2026-09-05

## Root cause
Node.js does not automatically load a project `.env` file. The live outbound path therefore fell back to the OS hostname (`vmi3361642`) and treated DKIM as disabled even though the requested SMTP/DKIM values existed in `.env`.

## Fix
- Added zero-dependency `apps/emails/core/env-loader.js`.
- SMTP outbound loads project `.env` before resolving transport settings.
- Supports explicit `EMAIL_ENV_FILE`, current working directory `.env`, and project-root `.env`.
- Existing process environment wins over `.env` values.
- All outbound paths share the same transport: HTTP/API, MCP, bulk, scheduler, reply/forward and MCP stdio.
- SMTP startup logs non-secret effective settings: hostname, port, DKIM enabled/required, selector and key base path.
- Multi-domain DKIM still derives the signing domain from the RFC5322 From address.
- Multi-server identity remains server-specific through `SMTP_HOSTNAME` and `DKIM_SELECTOR`.

## Validation
- Full project test suite passes.
- Added `tests/env-loader-smtp-config.js`.
- Existing multi-domain SMTP/DKIM regression passes.
