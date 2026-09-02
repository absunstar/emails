'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailAbusePolicy } = require('../apps/emails/core/abuse-policy');
const { createEmailMcpService } = require('../apps/emails/mcp-service');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-manager-'));
    try {
        const policy = createEmailAbusePolicy({ filePath: path.join(root, 'policy.json'), initial: {} });
        const emailService = createEmailService({
            dataDir: path.join(root, 'data'),
            vipPath: path.join(root, 'vip.json'),
            maxMessages: 10000,
            abusePolicy: policy,
            sendmail(message, callback) { callback(null, '250 accepted'); },
        });
        const mcp = createEmailMcpService({ emailService, abusePolicy: policy });
        const scope = { ip: '127.0.0.1', client: 'regression' };

        await emailService.ingestIncoming({
            guid: 'm1',
            from: 'sender@example.net',
            to: 'box@social-browser.com',
            subject: 'Verification 123456',
            text: 'hello',
            html: '<a href="https://example.com/verify">Verify</a><img width="1" height="1" src="https://tracker.example/pixel">',
            attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('abc') }],
        });

        const caps = await mcp.capabilities(scope);
        assert.equal(caps.manager, true);
        assert.ok(caps.capabilities.includes('security-policy-update'));

        let result = await mcp.search({ favorite: false, limit: 10 }, scope);
        assert.equal(result.totalMatches, 1);

        await mcp.update({ guid: 'm1', patch: { favorite: true, folder: 'Leads' } }, scope);
        result = await mcp.search({ favorite: true, folder: 'Leads', limit: 10 }, scope);
        assert.equal(result.totalMatches, 1);

        result = await mcp.analyze('m1', scope);
        assert.ok(result.trackingPixels >= 1);
        assert.ok(result.linkUrls.includes('https://example.com/verify'));

        const message = (await emailService.read('m1', { isAdmin: true, allowVip: true })).message;
        result = await mcp.attachmentRead({ guid: 'm1', attachmentId: message.attachments[0].id, maxBytes: 1000 }, scope);
        assert.equal(Buffer.from(result.contentBase64, 'base64').toString(), 'abc');

        result = await mcp.emlExport({ guid: 'm1', maxBytes: 100000 }, scope);
        assert.ok(Buffer.from(result.contentBase64, 'base64').toString().includes('Subject: Verification 123456'));

        result = await mcp.folderCreate('Customers', scope);
        assert.ok(result.folders.includes('Customers'));

        result = await mcp.vipSet({ email: 'box@social-browser.com', vip: true }, scope);
        assert.equal(result.vip, true);
        assert.equal((await mcp.vipList(scope)).count, 1);

        result = await mcp.policyRuleAdd({ list: 'blockFromDomains', value: 'spam.example', enabled: true }, scope);
        assert.ok(result.rule.values.includes('spam.example'));
        result = await mcp.policyTest({ type: 'from', value: 'bad@spam.example' }, scope);
        assert.equal(result.result.allowed, false);

        const exported = await mcp.policyExport(scope);
        assert.equal(exported.format, 'social-browser-email-policy-v1');
        result = await mcp.policyImport({ lists: { blockSubject: { enabled: true, values: ['*blocked phrase*'] } } }, scope);
        assert.equal(result.imported, true);
        result = await mcp.policyTest({ type: 'subject', value: 'This has blocked phrase inside' }, scope);
        assert.equal(result.result.allowed, false);

        result = await mcp.policyLimitSet({ group: 'smtp', key: 'connectionsPerMinute', value: 30 }, scope);
        assert.equal(result.value, 30);

        result = await mcp.send({ from: 'box@social-browser.com', to: 'person@example.org', subject: 'Hi', text: 'hello' }, scope);
        assert.equal(result.sent, true);

        result = await mcp.forward({ guid: 'm1', from: 'box@social-browser.com', to: 'forward@example.org', text: 'FYI' }, scope);
        assert.equal(result.sent, true);

        console.log('Full MCP manager service integration passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
