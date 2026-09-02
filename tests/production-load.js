'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailScheduler } = require('../apps/emails/core/email-scheduler');

function num(flag, normal, full) {
    return process.argv.includes('--full') ? full : normal;
}

async function main() {
    const messageCount = num('--messages', 20000, 100000);
    const scheduleCount = num('--schedules', 2000, 10000);
    const pollClients = num('--polls', 250, 1000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-production-load-'));
    const started = Date.now();
    try {
        const service = createEmailService({
            dataDir: path.join(root, 'mail'),
            vipPath: path.join(root, 'vip.json'),
            maxMessages: Math.max(messageCount + 100, 1000),
            sendmail(message, callback) { callback(null, '250 queued'); },
            logger() {},
        });
        const base = Date.now() - messageCount * 1000;
        for (let index = 1; index <= messageCount; index += 1) {
            const guid = 'load-' + index;
            service.store.messages.set(guid, {
                guid,
                id: index,
                folder: 'inbox',
                status: 'received',
                read: index % 5 !== 0,
                favorite: false,
                from: 'sender' + (index % 500) + '@example.net',
                to: 'loadbox' + (index % 1000) + '@example.com',
                cc: '',
                subject: 'Load message ' + index,
                text: 'Synthetic load body ' + index,
                html: '',
                date: new Date(base + index * 1000).toISOString(),
                attachments: [],
            });
        }
        const searchStart = Date.now();
        const result = await service.search({ query: 'Load message', limit: 100, offset: Math.max(0, messageCount - 100), sortBy: 'id', sortDir: 'asc' }, { isAdmin: true, allowVip: true, maxLimit: 250 });
        const searchMs = Date.now() - searchStart;
        assert.equal(result.totalMatches, messageCount);
        assert.equal(result.messages.length, 100);

        const addresses = Array.from({ length: 100 }, (_, i) => 'loadbox' + i + '@example.com');
        const pollStart = Date.now();
        await Promise.all(Array.from({ length: pollClients }, () => service.mailboxStatuses(addresses, { allowVip: true, maxAddresses: 100 })));
        const pollMs = Date.now() - pollStart;

        const scheduleDir = path.join(root, 'schedules');
        const tasksDir = path.join(scheduleDir, 'tasks');
        fs.mkdirSync(tasksDir, { recursive: true });
        const future = Date.now() + 24 * 60 * 60 * 1000;
        for (let index = 0; index < scheduleCount; index += 1) {
            const id = 'schedule_load_' + index;
            const when = new Date(future + index * 1000).toISOString();
            fs.writeFileSync(path.join(tasksDir, id + '.json'), JSON.stringify({
                id,
                status: 'scheduled',
                sendAt: when,
                sendAtUtc: when,
                nextAttemptAt: when,
                timezone: 'UTC',
                timezoneOffset: 'Z',
                attempts: 0,
                maxRetries: 3,
                retryDelaySeconds: 300,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                message: { from: 'sender@example.com', to: 'recipient' + index + '@example.net', subject: 'Scheduled load ' + index, text: 'load', html: '' },
            }));
        }
        const schedulerLoadStart = Date.now();
        const scheduler = createEmailScheduler({ emailService: service, baseDir: scheduleDir, intervalMs: 5000 });
        const status = scheduler.status();
        const schedulerLoadMs = Date.now() - schedulerLoadStart;
        assert.equal(status.total, scheduleCount);
        assert.equal(status.counts.scheduled, scheduleCount);

        const interrupted = path.join(tasksDir, 'schedule_interrupted.json');
        fs.writeFileSync(interrupted, JSON.stringify({
            id: 'schedule_interrupted', status: 'sending', sendAt: new Date(future).toISOString(), sendAtUtc: new Date(future).toISOString(), nextAttemptAt: null,
            attempts: 1, maxRetries: 3, retryDelaySeconds: 300, message: { from: 'sender@example.com', to: 'recipient@example.net', subject: 'Interrupted', text: 'x' },
        }));
        const recovered = createEmailScheduler({ emailService: service, baseDir: scheduleDir, intervalMs: 5000 });
        const recoveredTask = recovered.get('schedule_interrupted', true);
        assert.equal(recoveredTask.status, 'failed');
        assert.match(recoveredTask.lastError, /Delivery state is unknown/);

        const totalMs = Date.now() - started;
        console.log(JSON.stringify({ messageCount, scheduleCount, pollClients, searchMs, pollMs, schedulerLoadMs, totalMs }, null, 2));
        console.log('Production load/failure harness passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
