# Nodemailer DKIM Finalizer - 2026-09-05

## Purpose
Replaces the custom DKIM serializer used by the live outbound path with Nodemailer's production DKIM/MIME pipeline while preserving the project's direct-to-recipient-MX SMTP delivery.

## Multi-domain / multi-server model
- RFC5322 `From:` determines the DKIM signing domain (`d=`).
- `DKIM_SELECTOR` identifies the current sending server's selector (`s=`), e.g. `mail1`, `mail2`.
- Private key path remains `/etc/mail/dkim/<from-domain>/<selector>.private`.
- `SMTP_HOSTNAME` remains the current server's EHLO/HELO identity and Message-ID host.
- Recipient domain still determines MX routing.

## Outbound flow
1. Resolve the signing domain from `From:`.
2. Load the matching private key for the current selector.
3. Nodemailer builds the complete MIME message and performs DKIM signing.
4. The exact generated RFC5322 byte stream is passed to the existing direct-MX SMTP client.
5. SMTP dot-stuffing is applied only as a wire protocol operation; no header/body mutation is performed after signing.

## Deployment
Run `npm install` after deployment. `nodemailer@8.0.10` is now an explicit direct dependency.

No DNS or `.env` changes are required from the previous `mail1` setup.
