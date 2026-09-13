# Email Deliverability Engine

Social Browser Email now applies a persistent deliverability safety layer to every real outbound EmailService send, including Website/API/Admin/MCP send, reply, forward, bulk and scheduled delivery.

## Safe defaults

- Global: 500 recipient deliveries/hour, 10,000/day maximum.
- Warm-up: starts at 250/day, grows 25% per completed day, capped by the configured 10,000/day maximum.
- Default recipient domain: 30/hour, 200/day, minimum 5 seconds between messages.
- Google consumer domains: 100/hour, 1,000/day, 3-second pacing.
- Microsoft consumer domains: 60/hour, 500/day, 5-second pacing.
- Yahoo/AOL consumer domains: 60/hour, 500/day, 5-second pacing.
- Apple consumer domains: 40/hour, 300/day, 8-second pacing.

These are Social Browser conservative internal defaults, not claims about official provider sending quotas. They are adjustable through the MCP deliverability configuration.

## Suppression

Persistent per-address suppression is stored under:

`localStorage/email-deliverability/suppressions/`

Blocked suppression types:

- unsubscribe
- complaint
- hard_bounce
- manual

Permanent SMTP-style hard failures are classified conservatively and automatically suppress the address. Common inbound DSN messages from MAILER-DAEMON/postmaster are also inspected for explicit Final-Recipient/Original-Recipient and Status fields.

## Circuit breaker

Default automatic pause thresholds require at least 50 daily attempts in the affected scope. Sending pauses for 120 minutes when any threshold is met:

- hard bounce rate: 5%
- complaint rate: 0.3%
- overall failure rate: 20%

Circuit breakers are evaluated globally, per destination domain, and per recognized provider group.

## Scheduler interaction

Scheduled jobs are rechecked at execution time. A temporary deliverability throttle or open circuit does not consume a scheduler retry; the task stays `scheduled` and gets a new `nextAttemptAt`. A permanent suppression fails the task instead of repeatedly retrying an address that must not be sent to.

## MCP tools

- `email_deliverability_status`
- `email_deliverability_preflight`
- `email_deliverability_config_get`
- `email_deliverability_config_update`
- `email_suppressions_list`
- `email_suppression_add`
- `email_suppression_remove`
- `email_delivery_feedback_report`

The server now exposes 51 MCP tools in total.

## Agent scheduling behavior

`email_send` is described as immediate-only. `email_schedule` explicitly instructs agents to use it for future/relative requests such as tomorrow, tonight, after two hours, or a named future date/time. `sendAt` is the preferred field and should be an explicit ISO-8601 timestamp containing a timezone offset or `Z`.

If a user's timezone cannot be determined reliably, the agent should ask rather than guess.
