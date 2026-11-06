# Social Mail self-hosting and white-label instances

Social Mail supports a persistent instance identity at `localStorage/email-instance/config.json`. A new installation creates this file automatically and generates a unique instance id and MCP access secret. Environment variables override persisted values at runtime.

## Core deployment variables

- `EMAIL_PUBLIC_ORIGIN` — public HTTPS origin, e.g. `https://mail.example.com`
- `SMTP_HOSTNAME` — SMTP hostname advertised by the server
- `EMAIL_MAIL_DOMAINS` — comma-separated domains managed by the instance
- `EMAIL_INSTANCE_NAME` — deployment/instance name
- `EMAIL_PRODUCT_NAME`, `EMAIL_COMPANY_NAME`, `EMAIL_BRAND_WEBSITE`, `EMAIL_SUPPORT_URL`, `EMAIL_BRAND_LOGO` — branding overrides
- `EMAIL_ADMIN_USERNAME` — local dashboard username, default `admin`
- `EMAIL_ADMIN_PASSWORD` — enables local browser-based administrator login
- `EMAIL_MCP_NAME`, `EMAIL_MCP_TITLE`, `EMAIL_MCP_HOST`, `EMAIL_MCP_PORT` — MCP identity and endpoint
- `EMAIL_MCP_SECRET`, `EMAIL_MCP_BEARER_TOKEN` — MCP credentials; environment values take precedence over persisted instance values

## Authentication

Social Browser login remains available for the Social Browser deployment. Self-hosted customers can use local admin login by setting `EMAIL_ADMIN_PASSWORD`. Admin API bearer/header authentication remains supported.

## Instance management

Admin API:
- `POST /api/emails/admin/instance/get`
- `POST /api/emails/admin/instance/update`

Mail MCP:
- `email_instance_get`
- `email_instance_update`

Instance updates report whether a restart is required. Network identity, SMTP hostname and MCP identity should be treated as restart-required settings.

## Portability rule

Customer-specific domains, brand identity, MCP names/endpoints, credentials and public origins belong in instance configuration or environment variables, not in project source code.

## Runtime branding

The HTML renderer and shared UI load the active instance branding at runtime. Product/company name, logo, public origin, Social Browser login visibility, website/download links and canonical/alternate URLs are instance-aware. `robots.txt` and `sitemap.xml` are also rewritten to the active public origin when served.

The Mail Admin console includes **Instance Settings** for network identity, managed mail domains, branding and MCP identity. Network/SMTP/MCP identity changes are persisted immediately but should be followed by a service restart.

## Organizations, domains and sender identities

The instance includes a persistent tenant registry at `localStorage/email-tenants/registry.json`. A default organization is created automatically for backwards compatibility. Additional organizations can own independent mail domains and sender identities. Use the Mail Admin **Domains & Senders** screen or the Mail MCP organization/domain/sender tools to manage the registry.
