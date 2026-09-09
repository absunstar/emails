# Developer notes

Open SMTP port when required by the deployment firewall:

```bash
ufw allow 25
```

The runtime persistence contract is JSON-files-only. Do not add collection/ORM/database calls back into the email path. New website and MCP operations should go through `apps/emails/core/email-service.js`; persistence changes belong in `apps/emails/core/json-store.js`.

Manual deletion must call the shared service with an authenticated administrator context. Automatic cleanup is owned by the file store and only runs when the message count exceeds `EMAIL_MAX_MESSAGES` (default 100,000), skipping VIP/company mail.
