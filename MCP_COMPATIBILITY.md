# MCP Compatibility Matrix

## Remote transports

| Transport | Endpoint | Sessions | Status |
| --- | --- | --- | --- |
| MCP 2026-07-28 Streamable HTTP | `/mcp/SOCIALBROWERMANAGER` | Stateless | Supported |
| 2025-era Streamable HTTP | `/mcp/SOCIALBROWERMANAGER` | `Mcp-Session-Id` supported | Supported |
| Streamable HTTP SSE response | `/mcp/SOCIALBROWERMANAGER` | Both eras | Supported |
| Legacy HTTP + SSE | `/mcp/SOCIALBROWERMANAGER/sse` | SSE session | Supported |
| Legacy SSE message POST | `/mcp/SOCIALBROWERMANAGER/message` | SSE session | Supported |

## Local transport

| Transport | Command | Status |
| --- | --- | --- |
| STDIO | `npm run mcp:stdio` | Supported |

## Lifecycle and utility methods

- `initialize`
- `notifications/initialized`
- `server/discover`
- `ping`
- `notifications/cancelled`
- `notifications/progress`
- `logging/setLevel`
- `subscriptions/listen`

## Server features

- 43 email/admin/security/scheduling tools
- Native MCP resources and resource templates, including scheduled-email queue resources
- Native MCP prompts
- Argument completion
- Text and binary resource contents
- Modern tool annotations and structured content
- Modern cache hints
- Modern header validation (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` where applicable)
- Legacy session GET streams and DELETE session termination
- Legacy SSE endpoint discovery
- CORS OPTIONS support
- SSE keepalives and Nginx buffering compatibility

## Interoperability principle

Use the standards-based transport a client already supports. Current clients should use the main Streamable HTTP URL. Older clients can fall back to the `/sse` endpoint. Desktop/local clients that require a child-process transport can use STDIO.
