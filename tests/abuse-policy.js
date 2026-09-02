'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailAbusePolicy, ipMatches, wildcardMatch } = require('../apps/emails/core/abuse-policy');
const { createEmailService } = require('../apps/emails/core/email-service');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-abuse-policy-'));
    const filePath = path.join(dir, 'policy.json');
    const policy = createEmailAbusePolicy({ filePath });

    const safeDefaults = policy.getConfig().limits.outbound;
    assert.strictEqual(safeDefaults.perHour, 60, 'Social Browser safe send default must be 60/hour');
    assert.strictEqual(safeDefaults.adminPerHour, 500, 'Admin safe send default must be 500/hour');
    assert.strictEqual(safeDefaults.apiPerHour, 120, 'Legacy/API safe send default must be 120/hour');
    assert.strictEqual(safeDefaults.mcpPerHour, 500, 'MCP safe send default must be 500/hour');
    assert.strictEqual(safeDefaults.bulkMaxMessages, 100, 'MCP bulk safe default must be 100 messages/request');

    assert.strictEqual(policy.checkAddress('from', 'bot@contaboserver.net').allowed, false, 'legacy default blocked sender must remain blocked');
    assert.strictEqual(ipMatches('10.5.4.3', '10.0.0.0/8'), true, 'IPv4 CIDR must match');
    assert.strictEqual(ipMatches('203.0.113.9', '203.0.113.*'), true, 'IP wildcard must match');
    assert.strictEqual(wildcardMatch('user@example.com', '*@example.com'), true, 'email wildcard must match');

    const config = policy.getConfig();
    config.lists.blockIPs.enabled = true;
    config.lists.blockIPs.values = ['198.51.100.7', '10.0.0.0/8'];
    config.lists.allowToDomains.enabled = true;
    config.lists.allowToDomains.values = ['example.com'];
    config.lists.blockOutboundDomains.enabled = true;
    config.lists.blockOutboundDomains.values = ['blocked.example'];
    config.limits.smtp.connectionsPerMinute = 2;
    config.limits.smtp.concurrentPerIp = 2;
    config.limits.http.apiPerMinute = 2;
    config.limits.outbound.perHour = 2;
    policy.update(config);

    assert.strictEqual(policy.checkIp('198.51.100.7').allowed, false, 'blocked IP must be rejected');
    assert.strictEqual(policy.checkIp('10.22.33.44').allowed, false, 'blocked CIDR must be rejected');
    assert.strictEqual(policy.checkAddress('to', 'hello@example.com').allowed, true, 'allow-to domain must permit matching recipient');
    assert.strictEqual(policy.checkAddress('to', 'hello@other.example').allowed, false, 'enabled allow-to domains must act as whitelist');
    assert.strictEqual(policy.checkOutbound('sender@example.com', 'user@blocked.example').allowed, false, 'outbound block domain must reject recipient');

    const smtp1 = policy.smtpConnect('192.0.2.10');
    assert.strictEqual(smtp1.allowed, true);
    policy.smtpClose('192.0.2.10');
    const smtp2 = policy.smtpConnect('192.0.2.10');
    assert.strictEqual(smtp2.allowed, true);
    policy.smtpClose('192.0.2.10');
    const smtp3 = policy.smtpConnect('192.0.2.10');
    assert.strictEqual(smtp3.allowed, false, 'SMTP per-minute rate must reject excess connections');

    assert.strictEqual(policy.httpHit('api', '203.0.113.20').allowed, true);
    assert.strictEqual(policy.httpHit('api', '203.0.113.20').allowed, true);
    assert.strictEqual(policy.httpHit('api', '203.0.113.20').allowed, false, 'HTTP API rate must reject excess requests');
    assert.strictEqual(policy.outboundHit('browser-1', false).allowed, true);
    assert.strictEqual(policy.outboundHit('browser-1', false).allowed, true);
    assert.strictEqual(policy.outboundHit('browser-1', false).allowed, false, 'outbound rate must reject excess sends');
    const mcpConfig = policy.getConfig();
    mcpConfig.limits.outbound.mcpPerHour = 2;
    policy.update(mcpConfig);
    assert.strictEqual(policy.outboundHit('mcp-global', 'mcp').allowed, true);
    assert.strictEqual(policy.outboundHit('mcp-global', 'mcp').allowed, true);
    assert.strictEqual(policy.outboundHit('mcp-global', 'mcp').allowed, false, 'MCP rate must count each actual send');

    const reloaded = createEmailAbusePolicy({ filePath });
    assert.deepStrictEqual(reloaded.getConfig().lists.blockIPs.values, ['198.51.100.7', '10.0.0.0/8'], 'policy lists must persist to JSON');
    assert.strictEqual(reloaded.getConfig().limits.smtp.connectionsPerMinute, 2, 'policy limits must persist to JSON');

    let delivered = 0;
    const service = createEmailService({
        sendmail(message, callback) { delivered += 1; callback(null, 'ok'); },
        dataDir: path.join(dir, 'service-data'),
        vipPath: path.join(dir, 'service-vip.json'),
        abusePolicy: reloaded,
    });
    let outboundBlocked = false;
    try {
        await service.send({ from: 'sender@example.com', to: 'user@blocked.example', subject: 'Blocked', text: 'test' });
    } catch (error) {
        outboundBlocked = /blocked/i.test(error.message);
    }
    assert.strictEqual(outboundBlocked, true, 'Email service must enforce outbound domain policy');
    assert.strictEqual(delivered, 0, 'blocked outbound mail must not reach the transport');

    const root = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
    const adminHtml = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/index.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/admin.js'), 'utf8');
    const store = fs.readFileSync(path.join(root, 'apps/emails/core/json-store.js'), 'utf8');

    assert(server.includes('emailAbusePolicy.smtpConnect'), 'SMTP connection protection hook is missing');
    assert(server.includes('maxMessageBytes'), 'SMTP message size limit is missing');
    assert(server.includes('maxAttachmentBytes'), 'attachment size limit is missing');
    assert(app.includes('/api/emails/admin/policy/update'), 'admin policy update endpoint is missing');
    assert(app.includes("postBuckets(name)"), 'HTTP API rate-limit wrapper is missing');
    assert(adminHtml.includes('Security &amp; Policies'), 'admin Security & Policies UI is missing');
    assert(adminHtml.includes('data-policy-list-groups'), 'admin policy-list manager is missing');
    assert(adminHtml.includes('limits.outbound.mcpPerHour'), 'Admin MCP outbound limit control is missing');
    assert(adminHtml.includes('limits.outbound.bulkMaxMessages'), 'Admin MCP bulk limit control is missing');
    assert(adminJs.includes("name: 'blockIPs'"), 'IP policy list UI is missing');
    assert(adminJs.includes("name: 'blockOutboundDomains'"), 'outbound-domain policy UI is missing');
    assert(store.includes("hash(id) + '.bin'"), 'attachment paths must remain hash-based');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Abuse policy, rate limits and admin policy controls passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
