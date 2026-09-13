# Backup, DR and Storage Operations Release

This release completes the previously deferred backup/disk-management roadmap item and adds operational improvements around it.

## Delivered

- Persistent automatic/manual file backups.
- SHA-256 manifest validation.
- Restore dry-run with create/overwrite/remove counts.
- Short-lived confirmation tokens for destructive restore/cleanup operations.
- Mandatory pre-restore safety backup.
- Restart-required state after restore.
- Disk quota and filesystem-free-space monitoring.
- Warning, critical, emergency and hard-stop storage states.
- Retention by age for messages, audit, tracking and completed/cancelled schedules.
- VIP/protected-message retention exemption.
- Emergency low-space cleanup.
- Inbound SMTP temporary refusal when persistence is unsafe.
- Backup pruning by age and keep-count.
- Storage usage by category and estimated mail domain.
- Persistent storage-history samples.
- Operational alert history and optional external webhook forwarding.
- Admin **Backup & Storage** workspace with policy controls, backup validate/restore, cleanup preview/execute, storage history and alerts.
- MCP backup, restore, storage, cleanup, maintenance, alert and history tools.
- Focused backup/DR/disk regression tests.

See `BACKUP_DISASTER_RECOVERY.md` for operating procedures and recovery instructions.

## Still intentionally deferred

- Real Gmail/Outlook/Yahoo/iCloud provider-side delivery testing and account setup.
- Final Security Hardening project.
