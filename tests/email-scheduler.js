'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailAbusePolicy } = require('../apps/emails/core/abuse-policy');
const { createEmailScheduler, parseWhen } = require('../apps/emails/core/email-scheduler');
const { createEmailMcpService } = require('../apps/emails/mcp-service');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-scheduler-'));
    let delivered = 0;
    try {
        const policy = createEmailAbusePolicy({ filePath: path.join(root, 'policy.json') });
        const config = policy.getConfig();
        config.limits.outbound.mcpPerHour = 20;
        config.limits.outbound.bulkMaxMessages = 5;
        policy.update(config);
        const emailService = createEmailService({
            dataDir: path.join(root, 'data'),
            vipPath: path.join(root, 'vip.json'),
            abusePolicy: policy,
            sendmail(message, callback) { delivered += 1; callback(null, '250 scheduled accepted'); },
        });
        const schedulerDir = path.join(root, 'schedules');
        const scheduler = createEmailScheduler({ emailService, abusePolicy: policy, baseDir: schedulerDir, intervalMs: 1000 });
        const mcp = createEmailMcpService({ emailService, abusePolicy: policy, scheduler });
        const scope = { client: 'scheduler-test', ip: '127.0.0.1' };

        const parsed = parseWhen({ date: '2027-01-15', time: '09:30', timezoneOffset: '+03:00', timezone: 'Africa/Cairo' }, Date.parse('2026-09-02T12:00:00Z'));
        assert.equal(parsed.utc, '2027-01-15T06:30:00.000Z');
        assert.equal(parsed.timezone, 'Africa/Cairo');

        const future = new Date(Date.now() + 60000).toISOString();
        let task = await mcp.schedule({
            from: 'sender@social-browser.com',
            to: 'recipient@example.com',
            subject: 'Scheduled test',
            text: 'hello later',
            sendAt: future,
            timezone: 'UTC',
            maxRetries: 2,
        }, scope);
        assert.equal(task.status, 'scheduled');
        assert.ok(fs.existsSync(path.join(schedulerDir, 'tasks', task.id + '.json')), 'scheduled job must persist as JSON');

        const reloadedScheduler = createEmailScheduler({ emailService, abusePolicy: policy, baseDir: schedulerDir, intervalMs: 1000 });
        const persisted = reloadedScheduler.get(task.id, true);
        assert.equal(persisted.message.subject, 'Scheduled test');
        assert.equal(persisted.sendAtUtc, future);

        task = await mcp.scheduleUpdate({ id: task.id, message: { subject: 'Updated scheduled test' }, sendAt: new Date(Date.now() + 120000).toISOString() }, scope);
        assert.equal(task.message.subject, 'Updated scheduled test');
        assert.equal(task.status, 'scheduled');

        task = await mcp.scheduleSendNow({ id: task.id }, scope);
        assert.equal(task.status, 'sent');
        assert.ok(task.sentGuid);
        assert.equal(delivered, 1);

        const list = await mcp.schedulesList({ status: 'sent', limit: 10, includeBody: false }, scope);
        assert.ok(list.tasks.some((item) => item.id === task.id));
        assert.ok(String(list.tasks.find((item) => item.id === task.id).message.text).startsWith('[stored '));

        const bulk = await mcp.scheduleBulk({
            messages: [
                { from: 'sender@social-browser.com', to: 'one@example.com', subject: 'One', text: '1' },
                { from: 'sender@social-browser.com', to: 'two@example.com', subject: 'Two', text: '2' },
            ],
            sendAt: new Date(Date.now() + 180000).toISOString(),
            spacingSeconds: 30,
        }, scope);
        assert.equal(bulk.scheduled, 2);
        assert.equal(Date.parse(bulk.tasks[1].sendAtUtc) - Date.parse(bulk.tasks[0].sendAtUtc), 30000);

        const cancelled = await mcp.scheduleCancel({ id: bulk.tasks[0].id }, scope);
        assert.equal(cancelled.status, 'cancelled');
        const retried = await mcp.scheduleRetry({ id: cancelled.id, resetAttempts: true }, scope);
        assert.equal(retried.status, 'scheduled');

        const status = await mcp.schedulerStatus(scope);
        assert.ok(status.total >= 3);
        assert.ok(status.counts.sent >= 1);

        const due = await mcp.schedule({ from: 'sender@social-browser.com', to: 'due@example.com', subject: 'Due', text: 'now', sendAt: new Date(Date.now() + 100).toISOString() }, scope);
        await new Promise((resolve) => setTimeout(resolve, 160));
        await scheduler.tick();
        assert.equal(scheduler.get(due.id, true).status, 'sent');
        assert.equal(delivered, 2);

        console.log('Persistent MCP email scheduler passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
