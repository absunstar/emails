'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailRuntimeMonitor } = require('../apps/emails/core/runtime-monitor');
const { createEmailUnsubscribeService } = require('../apps/emails/core/unsubscribe-service');
const { createEmailDeliverabilityEngine } = require('../apps/emails/core/deliverability-engine');
const { createEmailService } = require('../apps/emails/core/email-service');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-ops-features-'));
    const monitor = createEmailRuntimeMonitor();
    try {
        const deliverability = createEmailDeliverabilityEngine({ baseDir: path.join(root, 'deliverability') });
        const unsubscribe = createEmailUnsubscribeService({ deliverability, baseDir: path.join(root, 'unsubscribe'), publicOrigin: 'https://emails.social-browser.com', monitor });
        const token = unsubscribe.createToken('recipient@example.com');
        assert.equal(unsubscribe.verifyToken(token), 'recipient@example.com');
        assert.equal(unsubscribe.verifyToken(token + 'x'), null);
        const headers = unsubscribe.headersFor('recipient@example.com');
        assert.match(headers['List-Unsubscribe'], /^<https:\/\/emails\.social-browser\.com\/api\/emails\/unsubscribe\?token=/);
        assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        unsubscribe.unsubscribeToken(token, 'test');
        assert.equal(deliverability.getSuppression('recipient@example.com').type, 'unsubscribe');

        const arf = deliverability.ingestFeedback({
            from: 'feedback-loop@example.net',
            subject: 'Feedback report',
            text: 'Feedback-Type: abuse\nOriginal-Rcpt-To: rfc822; complaint@example.org\nUser-Agent: FBL',
        });
        assert.equal(arf.detected, true);
        assert.equal(deliverability.getSuppression('complaint@example.org').type, 'complaint');

        let deliveredMessage = null;
        const service = createEmailService({
            dataDir: path.join(root, 'mail'),
            vipPath: path.join(root, 'vip.json'),
            deliverability,
            unsubscribe,
            monitor,
            sendmail(message, callback) { deliveredMessage = message; callback(null, '250 queued'); },
        });
        const events = [];
        const off = service.subscribe((event) => events.push(event));
        await service.ingestIncoming({ from: 'source@example.net', to: 'live@example.com', subject: 'SSE event test', text: 'hello' });
        assert.ok(events.some((event) => event.type === 'incoming' && event.recipients.includes('live@example.com')));
        await service.send({ from: 'sender@example.com', to: 'outbound@example.net', subject: 'Unsubscribe headers', text: 'hello' });
        assert.ok(deliveredMessage.headers && deliveredMessage.headers['List-Unsubscribe']);
        assert.equal(deliveredMessage.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        assert.ok(events.some((event) => event.type === 'outgoing' && event.status === 'sent'));
        off();

        monitor.component('site', 'ready');
        monitor.component('smtp', 'listening');
        monitor.component('mcp', 'listening');
        monitor.component('scheduler', 'running');
        monitor.increment('sseConnections');
        monitor.increment('sseEvents', 2);
        monitor.error('test', new Error('synthetic runtime warning'));
        const publicHealth = monitor.publicSnapshot();
        assert.equal(publicHealth.ok, true);
        monitor.component('storage', 'warning');
        assert.equal(monitor.publicSnapshot().ok, true);
        assert.equal(monitor.publicSnapshot().status, 'degraded');
        monitor.component('storage', 'blocked');
        assert.equal(monitor.publicSnapshot().ok, false);
        monitor.component('storage', 'healthy');
        const health = await monitor.snapshot({ service, deliverability });
        assert.equal(health.counters.sseConnections, 1);
        assert.equal(health.counters.sseEvents, 2);
        assert.ok(health.recentErrors.some((item) => item.component === 'test'));
        assert.ok(health.process.memory.rss > 0);

        const appJs = fs.readFileSync(path.join(__dirname, '..', 'apps/emails/app.js'), 'utf8');
        const publicJs = fs.readFileSync(path.join(__dirname, '..', 'apps/emails/site_files/js/index.js'), 'utf8');
        const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'apps/emails/site_files/html/index.html'), 'utf8');
        const adminJs = fs.readFileSync(path.join(__dirname, '..', 'apps/emails/site_files/js/admin.js'), 'utf8');
        assert.ok(appJs.includes("'/api/emails/live'") && publicJs.includes('new EventSource'), 'SSE live inbox wiring missing');
        assert.ok(appJs.includes("'/api/emails/feedback'") && appJs.includes('EMAIL_FEEDBACK_TOKEN'), 'FBL webhook protection missing');
        assert.ok(appJs.includes("'/health'") && appJs.includes("'/ready'"), 'health/readiness endpoints missing');
        assert.ok(adminHtml.includes('adminSchedulesModal') && adminJs.includes('openSchedules'), 'Admin scheduler UI missing');
        assert.ok(adminHtml.includes('adminDeliverabilityModal') && adminJs.includes('openDeliverability'), 'Deliverability dashboard missing');
        assert.ok(adminHtml.includes('adminHealthModal') && adminJs.includes('openHealth'), 'Health dashboard missing');
        assert.ok(adminHtml.includes('adminOperationsModal') && adminJs.includes('openOperations'), 'Backup and storage dashboard missing');
        assert.ok(appJs.includes('/api/emails/admin/operations/backup/create') && appJs.includes('/api/emails/admin/operations/restore/preview'), 'Backup and disaster recovery admin APIs missing');

        console.log('Operational UI, SSE, unsubscribe, feedback and monitoring tests passed');
    } finally {
        monitor.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
