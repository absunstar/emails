# Runtime mail-domain rules

The email application does not use a configured mail-domain list.

## Website and MCP

The default mail domain is derived from the URL/HTTP Host at runtime, but subdomains are collapsed to the root/registrable mail domain:

- `domain.com` -> `@domain.com`
- `mail.domain.com` -> `@domain.com`
- `xxx.yyyy.domain.com` -> `@domain.com`
- `mail.domain.co.uk` -> `@domain.co.uk`
- `x.domain.com.eg` -> `@domain.com.eg`

The browser derives this from `location.hostname`. The server and MCP derive it from the HTTP `Host` header. Reverse proxies must preserve the original Host, e.g. nginx `proxy_set_header Host $host;`.

There is no configured domain and no domain allow-list.

## API compatibility: explicit email wins

Legacy integrations and mobile applications may call the API through a host that is different from the mailbox domain. Therefore API routes use this precedence:

1. If the API payload contains an explicit email address in the route's mailbox field (`email`, `to`, or `from` as appropriate), the domain inside that email address is authoritative.
2. If no explicit email address is supplied, the API falls back to the root mail domain derived from HTTP Host.

Example:

```text
Host: api.legacy-app.com
where.to: customer@domain.com
```

The operation is scoped to `domain.com`, not `legacy-app.com`.

A client-supplied standalone `domain` field is intentionally ignored. Compatibility is based on the full explicit email address so the mailbox identity is unambiguous.

## Storage

Multiple domains may share the same server and JSON store. Domain scoping is applied per operation. VIP rules remain address-based and stored in JSON.
