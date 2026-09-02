# Abuse Protection & Policy Manager

The email project stores its live abuse/security policy in:

`localStorage/email-abuse-policy.json`

The file is created automatically on first run and can be edited from **Admin → Security & Policies**. Changes are applied immediately to the running process and persist across restarts.

## Rule lists

Block lists always win. An enabled Allow list with at least one entry acts as a whitelist for that field.

Supported rule groups:

- Incoming sender: Block/Allow From address patterns and domains.
- Incoming recipient: Block/Allow To address patterns and domains.
- Network: Block/Allow IP addresses, wildcard IPs, and IPv4 CIDR ranges.
- Content: Block Subject, Ignore From, Ignore Subject.
- Outgoing mail: Block/Allow From, To, and recipient domains for Send/Reply/Forward/MCP send operations.

Patterns support `*`, for example `*@example.com` or `203.0.113.*`. IPv4 CIDR such as `10.0.0.0/8` is supported for IP lists.

## Runtime limits

The same admin screen controls:

- SMTP connections per minute per IP.
- Concurrent SMTP connections per IP.
- Maximum SMTP message size.
- Maximum individual attachment size.
- Maximum attachment count per message.
- General HTTP API requests per minute per IP.
- Inbox polling requests per minute per IP.
- Admin requests per minute.
- Expensive/global searches per minute.
- Maximum HTTP request body size.
- Social Browser Send/Reply/Forward operations per hour (safe default: 60).
- Admin Send/Reply/Forward operations per hour (safe default: 500).
- MCP actual sends per hour, including scheduled deliveries (safe default: 500).
- Legacy/API sends per hour (safe default: 120).
- Maximum messages in one bulk MCP request (safe default: 100).

## Attachment path safety

Attachment filenames are metadata only. Attachment disk paths are derived from SHA-256 hashes of message GUIDs and attachment IDs. User-supplied filenames are never used as filesystem paths.

## Reverse proxies and IP rules

By default IP policy uses the direct connection address. When the application is behind a trusted reverse proxy, set:

`EMAIL_TRUST_PROXY=true`

Then the first `X-Forwarded-For` value is used. Do not enable this when clients can connect directly and spoof that header.

## Admin recovery

Authorized Admin API requests bypass the public IP allow/block policy so an administrator cannot permanently lock the console by accidentally blocking the current IP. Admin rate limits still apply.

## Import / Export

The Security & Policies screen can export the entire policy to JSON and import it on another installation. Imported settings are not applied until **Save changes** is clicked.


## MCP bulk and scheduled-send accounting

MCP bulk requests do not count as one send. Every actual message consumes one MCP outbound-rate slot. Scheduled jobs consume their slot when they execute, not when they are created. If a scheduled job reaches the hourly limit, it remains persisted and is deferred until the limiter allows another attempt.
