# Delivery Feedback Integration

## One-click unsubscribe

Set the public origin if the service is hosted elsewhere:

```bash
EMAIL_PUBLIC_ORIGIN=https://emails.social-browser.com
```

The unsubscribe signing secret is generated once under `localStorage/email-unsubscribe/secret.key` unless `EMAIL_UNSUBSCRIBE_SECRET` is explicitly configured.

## Feedback webhook

The webhook is disabled by default. Enable it with a long random secret:

```bash
EMAIL_FEEDBACK_TOKEN=<long-random-token>
```

Endpoint:

```text
POST /api/emails/feedback
X-Email-Feedback-Token: <token>
Content-Type: application/json
```

Single normalized event:

```json
{
  "email": "recipient@example.com",
  "type": "complaint",
  "reason": "Provider feedback loop",
  "source": "provider-name"
}
```

Batch input may use an `events` array with up to 500 items. Supported canonical event types are `complaint`, `hard_bounce`, `soft_bounce`, `unsubscribe` and `delivered`. Common aliases such as `spam`, `abuse`, `bounce`, `opt_out` and `delivery` are normalized by the endpoint.

Hard bounces, complaints and unsubscribes enter the persistent suppression list. Soft bounces and delivery events update reputation metrics without permanent suppression.

## Inbound reports

The SMTP ingestion path also analyzes delivery reports already arriving as email:

- DSN hard failures such as `Status: 5.x.x`
- ARF complaint reports containing `Feedback-Type: abuse` and a recipient marker

This provides a provider-neutral integration point. Provider enrollment, credentials, DNS changes and live provider-side testing are outside this release.
