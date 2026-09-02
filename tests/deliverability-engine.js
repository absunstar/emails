'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailDeliverabilityEngine } = require('../apps/emails/core/deliverability-engine');
const { createEmailService } = require('../apps/emails/core/email-service');
const { TOOLS, SERVER_INSTRUCTIONS } = require('../apps/emails/mcp-server');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-deliverability-'));
    const engine = createEmailDeliverabilityEngine({ baseDir: path.join(root, 'deliverability') });
    const status = engine.status();
    assert.equal(status.enabled, true);
    assert.equal(status.warmup.currentDailyLimit, 250);
    assert.equal(engine.getConfig().global.perDay, 10000);
    assert.equal(engine.getConfig().providers.apple.perDay, 300);

    const dry = engine.preflightReport('sender@example.com', 'one@gmail.com');
    assert.equal(dry.allowed, true);
    assert.equal(engine.status().global.dayAttempts, 0, 'dry-run must not consume quota');

    engine.addSuppression('optout@example.com', 'unsubscribe', 'requested opt-out', 'test');
    const suppressed = engine.preflightReport('sender@example.com', 'optout@example.com');
    assert.equal(suppressed.allowed, false);
    assert.equal(suppressed.code, 'DELIVERABILITY_SUPPRESSED');
    assert.equal(suppressed.permanent, true);
    assert.equal(engine.listSuppressions({ type: 'unsubscribe' }).count, 1);
    engine.removeSuppression('optout@example.com');
    assert.equal(engine.getSuppression('optout@example.com'), null);

    const first = engine.preflight('sender@example.com', 'one@gmail.com');
    assert.equal(first.allowed, true);
    const paced = engine.preflightReport('sender@example.com', 'two@gmail.com');
    assert.equal(paced.allowed, false);
    assert.equal(paced.code, 'DELIVERABILITY_DOMAIN_PACING');

    engine.reportFeedback({ email: 'bad@example.com', type: 'hard_bounce', reason: '5.1.1 user unknown', source: 'test' });
    assert.equal(engine.getSuppression('bad@example.com').type, 'hard_bounce');
    engine.reportFeedback({ email: 'complaint@example.net', type: 'complaint', reason: 'FBL', source: 'test' });
    assert.equal(engine.getSuppression('complaint@example.net').type, 'complaint');

    const dsn = engine.ingestFeedback({
        from: 'MAILER-DAEMON@example.net',
        subject: 'Delivery Status Notification (Failure)',
        text: 'Final-Recipient: rfc822; bounced@example.org\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 user unknown',
    });
    assert.equal(dsn.detected, true);
    assert.equal(engine.getSuppression('bounced@example.org').type, 'hard_bounce');

    const sendRoot = path.join(root, 'service');
    const serviceEngine = createEmailDeliverabilityEngine({ baseDir: path.join(root, 'service-deliverability') });
    let sends = 0;
    const service = createEmailService({
        dataDir: path.join(sendRoot, 'messages'),
        vipPath: path.join(sendRoot, 'vip.json'),
        deliverability: serviceEngine,
        sendmail(message, callback) {
            sends += 1;
            if (String(message.to).includes('dead@example.com')) return callback(new Error('550 5.1.1 user unknown'));
            callback(null, '250 accepted');
        },
    });
    await service.send({ from: 'sender@example.com', to: 'ok@example.net', subject: 'ok', text: 'hello' });
    assert.equal(sends, 1);
    assert.equal(serviceEngine.status().global.sent, 1);
    try {
        await service.send({ from: 'sender@example.com', to: 'dead@example.com', subject: 'bad', text: 'hello' });
        assert.fail('expected transport failure');
    } catch (error) {
        assert.match(error.message, /550/);
    }
    assert.equal(serviceEngine.getSuppression('dead@example.com').type, 'hard_bounce');

    const scheduleTool = TOOLS.find((item) => item.name === 'email_schedule');
    const sendTool = TOOLS.find((item) => item.name === 'email_send');
    const deliverabilityTools = ['email_deliverability_status', 'email_deliverability_preflight', 'email_deliverability_config_get', 'email_deliverability_config_update', 'email_suppressions_list', 'email_suppression_add', 'email_suppression_remove', 'email_delivery_feedback_report'];
    assert.ok(scheduleTool.description.toLowerCase().includes('tomorrow'));
    assert.ok(scheduleTool.inputSchema.properties.sendAt.description.includes('PREFERRED'));
    assert.ok(sendTool.description.toLowerCase().includes('immediately'));
    for (const name of deliverabilityTools) assert.ok(TOOLS.some((item) => item.name === name), name + ' missing');
    assert.ok(SERVER_INSTRUCTIONS.includes('email_schedule'));
    assert.ok(SERVER_INSTRUCTIONS.includes('timezone'));
    assert.ok(SERVER_INSTRUCTIONS.includes('circuit breakers'));

    fs.rmSync(root, { recursive: true, force: true });
    console.log('Deliverability engine and agent scheduling guidance tests passed (' + TOOLS.length + ' MCP tools)');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
