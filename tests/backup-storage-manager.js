'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailScheduler } = require('../apps/emails/core/email-scheduler');
const { createEmailBackupStorageManager } = require('../apps/emails/core/backup-storage-manager');
const { createEmailMcpService } = require('../apps/emails/mcp-service');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-backup-storage-'));
    const localStorage = path.join(root, 'localStorage');
    fs.mkdirSync(localStorage, { recursive: true });
    try {
        const service = createEmailService({
            dataDir: path.join(localStorage, 'email-files'),
            vipPath: path.join(localStorage, 'vip-email-list.json'),
            maxMessages: 10000,
            sendmail(message, callback) { callback(null, '250 accepted'); },
        });
        const scheduler = createEmailScheduler({ emailService: service, baseDir: path.join(localStorage, 'email-schedules'), intervalMs: 1000 });
        await service.ingestIncoming({ guid: 'old-normal', from: 'a@example.net', to: 'normal@example.com', subject: 'old', text: 'old', date: '2025-01-01T00:00:00Z', attachments: [{ filename: 'a.txt', content: Buffer.from('abc') }] });
        await service.ingestIncoming({ guid: 'old-vip', from: 'b@example.net', to: 'vip@example.com', subject: 'protected', text: 'vip', date: '2025-01-01T00:00:00Z' });
        await service.store.setVip({ email: 'vip@example.com', vip: true });
        await service.ingestIncoming({ guid: 'current', from: 'c@example.net', to: 'box@example.org', subject: 'current', text: 'current' });
        const scheduled = await scheduler.schedule({ from: 'sender@example.com', to: 'future@example.com', subject: 'future', text: 'future', sendAt: new Date(Date.now() + 3600000).toISOString() }, { client: 'test' });
        assert.equal(scheduled.status, 'scheduled');
        fs.writeFileSync(path.join(localStorage, 'email-abuse-policy.json'), JSON.stringify({ enabled: true }));
        fs.mkdirSync(path.join(localStorage, 'email-deliverability'), { recursive: true });
        fs.writeFileSync(path.join(localStorage, 'email-deliverability', 'config.json'), JSON.stringify({ enabled: true }));

        const manager = createEmailBackupStorageManager({ emailService: service, scheduler, rootDir: localStorage });
        const report = manager.storageReport();
        assert.ok(report.managedBytes > 0);
        assert.ok(report.categories.messages.files >= 3);
        assert.ok(report.domains['example.com'].messages >= 2);

        const created = await manager.createBackup({ reason: 'test-backup' });
        assert.equal(created.validation.valid, true);
        assert.ok(created.backup.fileCount > 0);
        assert.equal(manager.listBackups().count, 1);
        assert.equal((await manager.validateBackup(created.backup.id)).valid, true);
        const mcp = createEmailMcpService({ emailService: service, scheduler, operationsManager: manager });
        assert.ok((await mcp.operationsStatus({ client: 'test' })).storage.managedBytes > 0);
        assert.equal((await mcp.backupsList({ client: 'test' })).count, 1);
        assert.equal((await mcp.backupValidate({ id: created.backup.id }, { client: 'test' })).valid, true);
        assert.ok((await mcp.storageReport({ client: 'test' })).categories.messages.files >= 3);
        assert.ok(Array.isArray((await mcp.operationsHistory({ limit: 10 }, { client: 'test' })).history));

        await service.store.deleteMessage('current');
        await service.ingestIncoming({ guid: 'after-backup', from: 'd@example.net', to: 'new@example.com', subject: 'new', text: 'new' });
        assert.equal(await service.store.getMessage('current'), null);

        const restorePreview = await manager.restorePreview(created.backup.id);
        assert.equal(restorePreview.dryRun, true);
        assert.ok(restorePreview.confirmToken);
        const restored = await manager.restore(created.backup.id, { confirm: true, confirmToken: restorePreview.confirmToken });
        assert.equal(restored.restored, true);
        assert.equal(restored.restartRequired, true);
        assert.ok(restored.safetyBackup.id);

        const reloadedService = createEmailService({
            dataDir: path.join(localStorage, 'email-files'),
            vipPath: path.join(localStorage, 'vip-email-list.json'),
            maxMessages: 10000,
            sendmail(message, callback) { callback(null, '250 accepted'); },
        });
        assert.ok(await reloadedService.store.getMessage('current'));
        assert.equal(await reloadedService.store.getMessage('after-backup'), null);

        manager.updateConfig({ retention: { messagesDays: 1, auditDays: 1, trackingDays: 1, completedSchedulesDays: 1, cancelledSchedulesDays: 1 } });
        const cleanup = manager.cleanupPreview({ emergency: false });
        assert.ok(cleanup.candidates.messages >= 1);
        assert.ok(cleanup.confirmToken);
        const cleaned = await manager.cleanupExecute({ confirm: true, confirmToken: cleanup.confirmToken });
        assert.ok(cleaned.messages.deleted.includes('old-normal'));
        assert.ok(await reloadedService.store.getMessage('old-vip'));

        const validationBackup = await manager.createBackup({ reason: 'tamper-check' });
        const manifest = JSON.parse(fs.readFileSync(path.join(validationBackup.backup.path, 'manifest.json'), 'utf8'));
        const target = path.join(validationBackup.backup.path, 'data', manifest.files[0].path);
        fs.appendFileSync(target, 'tampered');
        const invalid = await manager.validateBackup(validationBackup.backup.id);
        assert.equal(invalid.valid, false);
        assert.ok(invalid.changed.length >= 1);

        const status = manager.status();
        assert.ok(status.storage);
        assert.ok(status.config.backup.intervalHours >= 1);
        assert.ok(Array.isArray(status.history));

        console.log('Backup, disaster recovery and disk management tests passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
