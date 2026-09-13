# SMTP Force IPv4 Hotfix — 2026-09-05

Outbound SMTP now defaults to IPv4 so the sending connection uses the provisioned IPv4 SPF/PTR/fcrDNS identity.

## Default

`SMTP_OUTBOUND_IP_FAMILY` defaults to `4`. No .env change is required on the current server.

## Optional per-server override

- `SMTP_OUTBOUND_IP_FAMILY=4` — force IPv4 (default)
- `SMTP_OUTBOUND_IP_FAMILY=6` — force IPv6 on servers where IPv6 SPF + PTR + forward AAAA are provisioned
- `SMTP_OUTBOUND_IP_FAMILY=0` — let the OS choose IPv4/IPv6

The setting is server-specific and does not affect multi-domain DKIM selection. DKIM domain continues to come from the RFC5322 From address; DKIM selector remains server-specific.
