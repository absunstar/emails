# Multi-domain DKIM — production setup

This build selects the DKIM signing identity from the actual RFC5322 `From:` address.
It is designed for deployments where the email application runs on multiple servers and serves multiple domains.

## Identity rule

Examples:

- `From: info@social-browser.com` -> `d=social-browser.com`
- `From: support@egytag.com` -> `d=egytag.com`
- `From: admin@mama-services.net` -> `d=mama-services.net`

The physical SMTP server identity is separate from the author identity. `SMTP_HOSTNAME` must describe the server/PTR hostname; DKIM `d=` is derived from `From:`.

## Recommended environment for 13.140.162.14

```bash
SMTP_HOSTNAME=mail.social-browser.com
LOCAL_MAIL_DOMAINS=social-browser.com,egytag.com,mama-services.net,kids-browser.com

DKIM_ENABLED=true
DKIM_REQUIRE_SIGNING=true
DKIM_SELECTOR=mail
DKIM_BASE_PATH=/etc/mail/dkim
SENDMAIL_PATH=/usr/sbin/sendmail
```

`DKIM_REQUIRE_SIGNING=true` is recommended before bulk outreach. A local From domain with a missing key will be rejected instead of being silently sent unsigned.

## Private-key layout

With `DKIM_SELECTOR=mail`:

```text
/etc/mail/dkim/social-browser.com/mail.private
/etc/mail/dkim/egytag.com/mail.private
/etc/mail/dkim/mama-services.net/mail.private
/etc/mail/dkim/kids-browser.com/mail.private
```

Generate one key per domain:

```bash
DOMAIN=social-browser.com
SELECTOR=mail
sudo mkdir -p /etc/mail/dkim/$DOMAIN
sudo openssl genrsa -out /etc/mail/dkim/$DOMAIN/$SELECTOR.private 2048
sudo chmod 600 /etc/mail/dkim/$DOMAIN/$SELECTOR.private
sudo openssl rsa -in /etc/mail/dkim/$DOMAIN/$SELECTOR.private -pubout -outform DER 2>/dev/null | openssl base64 -A
```

Publish the returned public key in DNS:

```text
Host/Name: mail._domainkey.social-browser.com
Type: TXT
Value: v=DKIM1; k=rsa; p=<PUBLIC_KEY>
```

Repeat for each domain used in `From:`.

## Multiple sending servers

Prefer a different selector per server, for example:

```text
Server A: DKIM_SELECTOR=mail1
Server B: DKIM_SELECTOR=mail2
```

Publish both selectors for every domain that can send from both servers. This avoids sharing one private key between servers and allows independent key rotation/revocation.

A domain may also use a selector override on one server:

```bash
DKIM_SELECTOR=mail1
DKIM_SELECTOR_MAP='{"social-browser.com":"mail1","egytag.com":"bulk1"}'
```

Private-key paths can be overridden too:

```bash
DKIM_KEY_PATH_MAP='{"social-browser.com":"/secure/social-browser.private"}'
```

## DNS / deliverability gate before bulk sending

For every sending server/domain pair verify:

1. SPF authorizes the real sending IP.
2. PTR resolves the sending IP to the SMTP hostname.
3. Forward DNS resolves that hostname back to the same IP.
4. SMTP HELO/EHLO uses the PTR hostname.
5. DKIM passes and `d=` aligns with the visible From domain.
6. DMARC passes through aligned SPF and/or aligned DKIM.

Confirmed for the current Social Browser server before this change:

```text
Sending IP: 13.140.162.14
PTR: mail.social-browser.com
Forward A: mail.social-browser.com -> 13.140.162.14
SPF: PASS
DKIM: previously NONE (this build adds signing support)
```

The Node application cannot force the hostname used by a separately configured system MTA in all environments. Ensure the local MTA on `13.140.162.14` is also configured to announce `mail.social-browser.com` if it overrides the application hostname.
