# Backup, Disaster Recovery and Disk Management

Social Temp Mail stores its operational state in JSON/files under `localStorage/`. This release adds a first-class operations manager for verified backups, recovery previews, retention cleanup, storage quotas, low-disk handling and operational history.

## What is backed up

Automatic/manual snapshots include the data needed to recover the email service:

```text
localStorage/
  email-files/
  email-schedules/
  email-deliverability/
  email-unsubscribe/
  email-abuse-policy.json
  vip-email-list.json
  email-storage/config.json
```

The backup store itself, transient runtime state and operations history are not recursively copied into each snapshot.

Default backup location:

```text
localStorage/email-backups/<backup-id>/
  manifest.json
  data/...
```

`EMAIL_BACKUP_DIR` can move snapshots to another mounted disk or backup volume. `EMAIL_STORAGE_CONTROL_DIR` can move the operations-control files when required by the deployment layout.

## Verified snapshots

Every snapshot receives a manifest containing:

- backup ID and creation time
- reason/label
- file count and total bytes
- relative path, size and SHA-256 for every file

When `backup.verifyAfterCreate` is enabled, the service validates the completed snapshot immediately. A backup can also be validated later from Admin or MCP before recovery.

Default backup policy:

```text
Automatic backup: enabled
Interval: 24 hours
Keep latest: 14
Maximum age: 30 days
Verify after creation: enabled
```

The Operations workspace in `/admin` can change these values without restarting the service.

## Restore workflow

Restore is deliberately two-stage:

1. Select a backup and run Restore Preview.
2. The service validates the SHA-256 manifest.
3. It calculates files that will be created, overwritten or removed.
4. It checks that enough free disk is available for a mandatory safety snapshot.
5. The preview returns a short-lived confirmation token.
6. Execute Restore with that token.
7. A pre-restore safety backup is created automatically.
8. Managed live data is replaced from the selected snapshot.
9. The service marks `restartRequired=true`.

Restart the Node email service after a successful restore before resuming normal traffic. This avoids keeping stale in-memory indexes or scheduler state after the filesystem has been replaced.

A corrupt snapshot is rejected before live files are changed.

## Disaster recovery procedure

For an incident where the primary data set is damaged or accidentally changed:

1. Stop or drain normal email traffic if possible.
2. Open `/admin` → **Backup & Storage**.
3. Validate the intended recovery point.
4. Run Restore Preview and inspect create/overwrite/remove counts.
5. Confirm Restore. The system creates a safety snapshot first.
6. Restart the email service.
7. Check `/ready`, `/health`, Scheduler status, storage status and a sample of recovered inboxes.
8. Keep the safety backup until recovery is verified.

For a total host loss, restore the application plus the selected backup directory onto a replacement host, then copy the snapshot `data/` tree back into the expected `localStorage/` roots before starting the service. Preserve file permissions appropriate for the Node service account.

## Storage reporting

The manager reports:

- total managed bytes and configured quota percentage
- filesystem total/free bytes when `statfs` is supported
- messages, attachments, tracking, audit, schedules, deliverability, unsubscribe, backups and operations usage
- message/attachment usage estimates grouped by mail domain
- recent storage history samples
- backup count and latest backup

The Admin Operations workspace displays current storage state, recent history and alerts. MCP provides the same data for agents.

## Storage thresholds

Default managed-data quota:

```text
20 GB
```

Default thresholds:

```text
Warning:   80%
Critical:  90%
Emergency: 95%
Hard stop: 98%
Minimum free filesystem space: 512 MB
```

Levels are evaluated against managed quota and available filesystem space. Warning/critical/emergency status degrades health information but does not by itself take `/ready` offline. A `blocked` storage state makes readiness fail and inbound SMTP can return a temporary `452` response rather than accepting data that cannot be safely persisted.

The storage report is cached briefly for hot-path protection; the manager still performs a fresh filesystem-free-space check when deciding whether new inbound mail can be accepted.

## Retention

Normal defaults:

```text
Messages:             30 days
Audit records:        30 days
Tracking records:     30 days
Completed schedules:  30 days
Cancelled schedules:   7 days
```

VIP/protected messages are excluded from retention deletion.

The existing file-store message-count cap still exists as a separate last-resort safeguard. Age/space retention and the count cap serve different purposes.

Cleanup is preview-first in Admin and MCP. A preview lists candidate counts and estimated reclaimable bytes and returns a short-lived confirmation token. Manual execution must provide that token and explicit confirmation.

## Emergency low-space mode

When the service reaches emergency storage pressure and `emergency.autoCleanup` is enabled, maintenance applies shorter emergency retention windows to reclaim old non-protected data. Pending/sending schedules are never removed by schedule retention.

At very high pressure the manager avoids creating a normal automatic backup first, because duplicating the live data could make the outage worse. At the hard-stop state it can temporarily reject new inbound SMTP until space is recovered.

## Maintenance

The operations manager runs periodically; default interval is 15 minutes. Each maintenance cycle can:

- sample storage and append history
- determine whether a scheduled backup is due
- prune expired backups according to keep-count/age rules
- apply emergency cleanup when necessary
- update storage-block state
- emit deduplicated operational alerts

Admin can run maintenance immediately. MCP exposes the same operation.

## Alerts

Important backup, restore, cleanup and disk-pressure events are persisted in the Operations alert list.

Optional external forwarding:

```bash
EMAIL_OPS_ALERT_WEBHOOK=https://your-monitor.example/email-alerts
```

When configured, alerts are sent as JSON with the source `social-temp-mail`. Webhook delivery is best effort and does not block mail operations.

## MCP operations tools

The manager MCP includes:

```text
email_operations_status
email_backup_create
email_backups_list
email_backup_validate
email_restore_preview
email_restore_execute
email_storage_report
email_storage_config_get
email_storage_config_update
email_storage_cleanup_preview
email_storage_cleanup_execute
email_storage_maintenance_run
email_operations_alerts
email_operations_history
```

Agents should always use preview before cleanup or restore. Restore and cleanup execution require the corresponding confirmation token.

## Environment variables

```bash
EMAIL_BACKUP_DIR=
EMAIL_STORAGE_CONTROL_DIR=
EMAIL_OPS_ALERT_WEBHOOK=
```

If these are unset, the service uses directories under `localStorage/` and stores alerts locally only.

## Tests

Focused backup/storage tests:

```bash
npm run test:storage
```

Full regression:

```bash
npm test
```

Load/failure harness:

```bash
npm run test:load
npm run test:load:full
```

The backup/storage test validates SHA-256 snapshots, restore preview/confirmation, automatic safety backup, actual recovery into a freshly loaded EmailService, retention cleanup, VIP preservation, corrupt-backup rejection and MCP operations access.

## Scope intentionally not changed

This work does not perform the separate Final Security Hardening project. It also does not claim real delivery-provider testing/configuration with Gmail, Outlook, Yahoo or iCloud.
