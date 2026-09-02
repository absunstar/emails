# MCP Persistent Email Scheduler

This release adds durable scheduled sending to the Universal Email Manager MCP.

## Tools

- `email_schedule`
- `email_schedule_bulk`
- `email_schedules_list`
- `email_schedule_get`
- `email_schedule_update`
- `email_schedule_cancel`
- `email_schedule_send_now`
- `email_schedule_retry`
- `email_scheduler_status`

## Persistence

Each job is stored as a separate JSON document under `localStorage/email-schedules/tasks`. Jobs therefore survive application and machine restarts.

## Time handling

Use an ISO-8601 timestamp with an explicit UTC offset, such as `2026-09-03T14:30:00+03:00`, or provide `date`, `time`, and `timezoneOffset` separately. The scheduler stores the requested representation plus normalized UTC.

## Delivery safety

Scheduled delivery uses the same shared EmailService and outbound policy rules as immediate MCP sending. The MCP safe default is 500 actual deliveries per hour. Every message inside bulk sending counts separately. Scheduled messages consume the rate slot only when they execute. If the hourly limit is exhausted, the job is persisted and deferred automatically.

SMTP failures use bounded persisted retries. A process interruption while a job is in `sending` state recovers the task as `failed` with an explicit unknown-delivery warning rather than blindly resending it and risking a duplicate.
