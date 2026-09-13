# SMTP Multi-Domain / Multi-Server Outbound Hotfix — 2026-09-05

## Purpose
Removes the runtime dependency on `/usr/sbin/sendmail` and sends mail directly to recipient MX servers over SMTP.

## Multi-domain behavior
- DKIM signing domain is derived from the actual RFC5322 `From:` address.
- Each From domain uses its own private key under:
  `/etc/mail/dkim/<from-domain>/<selector>.private`
- `DKIM_ALLOWED_DOMAINS` can restrict which From domains may be signed.
- `DKIM_REQUIRE_SIGNING=true` fails closed if a required key is missing.

## Multi-server behavior
- Each physical sending server has its own `SMTP_HOSTNAME` and may use its own `DKIM_SELECTOR`.
- PTR/HELO identity is server-specific and is intentionally not derived from the From domain.
- Recommended selectors: `mail1`, `mail2`, `mail3`, etc. per sending server.

## Example server 1
```env
SMTP_HOSTNAME=mail.social-browser.com
DKIM_ENABLED=true
DKIM_REQUIRE_SIGNING=true
DKIM_SELECTOR=mail1
DKIM_BASE_PATH=/etc/mail/dkim
```

## Optional domain restriction
```env
DKIM_ALLOWED_DOMAINS=social-browser.com,egytag.com,mama-services.net,kids-browser.com
```

## SMTP transport
- Direct MX lookup through Node DNS.
- Direct SMTP delivery on port 25.
- Opportunistic STARTTLS when offered.
- Optional `SMTP_REQUIRE_TLS=true`.
- Optional `SMTP_TLS_VERIFY=true`.
- Delivery is grouped by recipient domain so one message can target recipients on different MX infrastructures.
- No Postfix/Sendmail daemon is required by the application.

## Validation
- Full existing `npm test` suite passes.
- New multi-domain DKIM regression test passes for different From domains and rejects unauthorized signing domains.
