'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailAbusePolicy } = require('../apps/emails/core/abuse-policy');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailMcpService } = require('../apps/emails/mcp-service');

async function build(root, mcpPerHour, bulkMaxMessages) {
    const policy = createEmailAbusePolicy({ filePath: path.join(root, 'policy.json') });
    const config = policy.getConfig();
    config.limits.outbound.mcpPerHour = mcpPerHour;
    config.limits.outbound.bulkMaxMessages = bulkMaxMessages;
    policy.update(config);
    let delivered = 0;
    const emailService = createEmailService({
        dataDir: path.join(root, 'data'),
        vipPath: path.join(root, 'vip.json'),
        abusePolicy: policy,
        sendmail(message, callback) { delivered += 1; callback(null, '250 accepted'); },
    });
    return { policy, emailService, mcp: createEmailMcpService({ emailService, abusePolicy: policy }), delivered: () => delivered };
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-send-limits-'));
    try {
        const a = await build(path.join(root, 'a'), 2, 100);
        const messages = [1, 2, 3].map((n) => ({ from: 'sender@example.com', to: 'user' + n + '@example.net', subject: 'Bulk ' + n, text: 'hello' }));
        const result = await a.mcp.sendBulk({ messages, concurrency: 3 }, { client: 'test' });
        assert.equal(result.requested, 3);
        assert.equal(result.sent, 2);
        assert.equal(result.failed, 1);
        assert.equal(a.delivered(), 2, 'every actual message must consume one MCP rate-limit slot');
        assert.ok(result.results.some((item) => !item.ok && /rate limit/i.test(item.error)));

        const b = await build(path.join(root, 'b'), 500, 2);
        let blocked = false;
        try {
            await b.mcp.sendBulk({ messages, concurrency: 1 }, { client: 'test' });
        } catch (error) {
            blocked = /limited to 2/i.test(error.message);
        }
        assert.equal(blocked, true, 'configured bulk maximum must be enforced before delivery');
        assert.equal(b.delivered(), 0);

        console.log('MCP safe outbound and bulk accounting passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
