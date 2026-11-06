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

## Tenant isolation

Organizations are enforced as data scopes, not only UI filters. When `organizationId` is supplied, message search/read/update/delete/stats are restricted to domains owned by that organization. An organization with no domains is fail-closed and sees no messages.

Schedules persist `organizationId` and list/get/update/cancel/send-now/retry enforce the same owner scope. Suppressions are namespaced by organization, so an unsubscribe, complaint, hard bounce, or manual suppression in one organization does not suppress the same recipient in another organization. Campaign ID operations and reports validate campaign ownership when an organization scope is present.

Outbound messages with an `organizationId` must use a From domain owned by that organization. Campaigns, schedules and MCP sends propagate the organization scope to the final Email Service guard.

Mail Admin has an Organization scope selector. Instance Settings, Security & Policies, Backup/Restore/Storage configuration, and global deliverability configuration remain instance-wide Super Admin controls and are unavailable while the Admin workspace is scoped to one organization. Tenant-scoped deliverability views expose only owned-domain counters.

## Tenant-bound identity and RBAC

Tenant isolation is enforced at the identity layer with organization-bound access keys. Access-key secrets are returned once when created and only a SHA-256 hash is persisted in the tenant registry.

Roles:

- `organization_admin`: read/write mail operations, campaigns, schedules, deliverability, domains, senders, sender pools, and access-key management for one organization. It cannot change instance-wide configuration.
- `operator`: mail/campaign/schedule operations plus tenant/sender/deliverability read access. It cannot manage tenant identities, access keys, or instance-wide settings.
- `viewer`: read-only mail, campaign, schedule, deliverability, sender, and tenant views.
- `super_admin`: instance-wide role used by trusted local admin, trusted Social Browser admin access, configured admin secrets, and the legacy trusted MCP endpoint.

HTTP API clients can authenticate with either:

- `Authorization: Bearer <tenant-access-key>`
- `X-Email-Api-Key: <tenant-access-key>`

When a tenant access key is used, its `organizationId` is authoritative. Request bodies cannot switch to another organization, and resource IDs such as domains, sender identities, sender pools, campaigns, schedules, and messages are ownership-checked.

### Tenant MCP endpoint

Tenant agents should use the dedicated Streamable HTTP endpoint:

`/mcp/access`

This endpoint always requires a valid tenant access key (or an explicitly configured super-admin bearer token). The legacy secret MCP path remains reserved for trusted super-admin integrations. Tenant MCP sessions are bound to the principal that initialized them, and tools/resources/prompts are filtered by role. Direct calls to hidden write tools are still rejected server-side.

Revoking an access key takes effect immediately for new HTTP and MCP requests.

## Organization members and Social Browser identity

Organizations can contain human members in addition to API/MCP access keys. A member is bound to an external identity (`authProvider` + `subject`) and has one of the tenant roles: `organization_admin`, `operator`, or `viewer`.

The built-in Social Browser provider uses the detected `x-browser` identity as the member subject. Trusted instance-admin browser IDs remain super admins for backward compatibility. Other Social Browser sessions receive admin access only when an active tenant membership exists.

### Invitations

Organization admins create one-time invitations from **Domains & Sender Manager → Members**. The invitation token is returned once; only its SHA-256 hash is persisted. The generated link uses:

`/join?token=<one-time-invitation-secret>`

The recipient opens the link in Social Browser, signs in if needed, and accepts the invitation. Acceptance binds that Social Browser identity to the organization and role, marks the invitation accepted, and makes that organization the active workspace.

Invitation expiry is configurable through the API/MCP `expiresAt` field; the UI uses the secure default expiry when no value is supplied. Pending invitations can be revoked before acceptance.

### Multiple organization memberships

A Social Browser identity may belong to multiple organizations. The Admin organization selector becomes a workspace switcher for tenant members. The selected organization is stored in the server session and all subsequent mail, campaign, schedule, sender, deliverability, member, and tenant operations use that organization principal.

Signing out clears the active organization session. Removing or disabling a membership removes access to that organization immediately on subsequent requests.
