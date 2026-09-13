# DKIM Port25 interoperability hotfix — 2026-09-05

This build keeps the existing Multi-Domain / Multi-Server SMTP architecture and hardens DKIM interoperability.

Changes:
- DKIM signing domain still comes from the actual RFC5322 `From:` address.
- SMTP server identity still comes from `SMTP_HOSTNAME`.
- Selector remains server-specific through `DKIM_SELECTOR`.
- Private key path remains `/etc/mail/dkim/<from-domain>/<selector>.private`.
- DKIM header signing is limited to stable message/MIME headers; operational List-Unsubscribe headers remain present but are not cryptographically signed.
- Added `q=dns/txt` to the DKIM signature.
- DKIM-Signature is folded into short physical lines for wider verifier/MTA interoperability.
- RSA-SHA256 signing explicitly uses PKCS#1 v1.5 padding.
- Added cryptographic unit verification that recalculates the body hash and verifies the generated DKIM RSA signature against the matching public key.

No DNS, .env, selector, domain or private-key path changes are required from the previous deployment.
