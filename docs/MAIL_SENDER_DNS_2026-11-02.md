# DKIM/SPF DNS rollout for owned brands — 2 Nov 2026

STATUS: DNS publication pending. DKIM keys are securely staged, not active in SMTP signing directory.

Current SMTP source IP: 13.140.162.14 (mail.social-browser.com); DKIM selector mail1. DigitalOcean is authoritative for both zones. Both use wildcard CNAME records that may make unconfigured mail1._domainkey names resolve to the apex. Add explicit DKIM TXT records at the names below; keep all existing unrelated records.

## egytag.com

DNS TXT name: mail1._domainkey.egytag.com
DNS TXT value: v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmk1ttcbwEY0BF5JVteX3rsmS5CBzNdwJQmGpPdCD+4wFXNfEerOW3/En7gsKcqJ1npT0RrcZ5QyeK3k9u18A5gI1wiZkcHHkLhFUVOY5vEGrSoKoB+Wj9kABFMy8WFG+zxr7+hcQRqj0HqU5+7Q15dzsOBdJWIZXYZZA6axQrhkqgj6t2gCPJ5k//8alYn4QfrtjaEyHXxs2RPb8bin4lMuCWS+mWB4QT5rLRgk/eEIkt+Ik3CJ7NYmB8SrO3px2VA8jgKuUvfO1PGmLO/ZMWhp3Aail/GtyWMG28iCVhue5CEjheuY+ZPXZPudRzbmElHvG91JjSytaiXfWbqyC1wIDAQAB

Staged private key path: /etc/mail/dkim-staging/egytag.com/mail1.private (DO NOT publish, copy into repositories, or include in an email). On confirmed DNS matching, securely install at /etc/mail/dkim/egytag.com/mail1.private with mode 600, then verify email sender preflight.

## kids-browser.com

DNS TXT name: mail1._domainkey.kids-browser.com
DNS TXT value: v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxqaM9W/vf1/+4pqe51OqaDwZ1j30CzJwPmQ2GA5okPwJ0rK6ANh4K7W3jSGSMMpX4bxIylpytyYnvUJe+/vOWX1nqeg2vTDC1GDP0QwgCpW3V6QGtP7KomjdCEGGA2PT+2Hamm0BOl0c+koWqzeX7PfQTeHHKyl+25eKcUDB1m701jmm78naP8UeaNg0385PnffEueZTY/pMGyPyfS27l5ofTsovM5UDrEDsMZ1Az0xPUb6056YwqcO33G79Q1m8XY14KJLnp5MrpgEMQSdR8o1s/B9SXYN9Erwher2pypUqiCM+Tb1T7K6fYHWdPK9CvuY+j/ifQ647Yy9UwjCi7QIDAQAB

Staged private key path: /etc/mail/dkim-staging/kids-browser.com/mail1.private (DO NOT publish, copy into repositories, or include in an email). On confirmed DNS matching, securely install at /etc/mail/dkim/kids-browser.com/mail1.private with mode 600, then verify email sender preflight.

## SPF required to authorize this sending IP
egytag.com (existing 169.58.4.25 must remain authorized): v=spf1 ip4:169.58.4.25 ip4:13.140.162.14 -all
kids-browser.com: v=spf1 ip4:13.140.162.14 -all (if this server is the approved Kids Browser sender)

## DMARC
Existing Egytag DMARC p=quarantine: keep unchanged.
Kids Browser: TXT _dmarc.kids-browser.com value v=DMARC1; p=none for initial observation; tighten after valid SPF/DKIM alignment tests.

Do not change official sender identity, publish partner emails, or send before DKIM, SPF and DMARC alignment verification. This doc contains only PUBLIC key material.
