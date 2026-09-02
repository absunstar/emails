'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailMcpService } = require('../apps/emails/mcp-service');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-files-'));
    const dataDir = path.join(root, 'email-files');
    const vipPath = path.join(root, 'vip-email-list.json');
    const delivered = [];
    const sendmail = (message, callback) => {
        delivered.push(message);
        setImmediate(() => callback(null, '250 queued'));
    };

    const service = createEmailService({
        sendmail,
        dataDir,
        vipPath,
        maxMessages: 3,
    });

    try {
        await service.setVip({ email: 'corp@social-browser.com', vip: true, company: 'Social Browser' });

        await service.ingestIncoming({
            guid: 'vip-old',
            from: 'partner@example.net',
            to: 'corp@social-browser.com',
            subject: 'Corporate',
            text: 'Protected',
            date: '2026-09-01T00:00:00.000Z',
        });
        await service.ingestIncoming({
            guid: 'normal-old',
            from: 'a@example.net',
            to: 'temp1@social-browser.com',
            subject: 'Old temp',
            text: 'Old',
            date: '2026-09-01T01:00:00.000Z',
        });
        await service.ingestIncoming({
            guid: 'normal-mid',
            from: 'b@example.net',
            to: 'temp2@social-browser.com',
            subject: 'Mid temp',
            text: 'Mid',
            date: '2026-09-01T02:00:00.000Z',
        });
        await service.ingestIncoming({
            guid: 'normal-new',
            from: 'c@example.net',
            to: 'temp3@social-browser.com',
            subject: 'New temp',
            text: 'New',
            date: '2026-09-01T03:00:00.000Z',
        });

        // Auto cleanup starts only after the threshold is exceeded and preserves VIP mail.
        assert.equal((await service.store.listMessages()).length, 3);
        assert.ok(await service.store.getMessage('vip-old'));
        assert.equal(await service.store.getMessage('normal-old'), null);

        // Public temp-mail access can read normal addresses without an account.
        const publicSearch = await service.search({ to: 'temp2@social-browser.com', limit: 20, includeBody: true }, { allowVip: false });
        assert.equal(publicSearch.count, 1);
        assert.equal(publicSearch.messages[0].text, 'Mid');

        // VIP is blocked unless the caller has VIP/admin access.
        const blockedVip = await service.search({ to: 'corp@social-browser.com', limit: 20 }, { allowVip: false });
        assert.equal(blockedVip.count, 0);
        assert.equal(blockedVip.blockedVipCount, 1);
        const adminVip = await service.read('vip-old', { allowVip: true });
        assert.equal(adminVip.message.text, 'Protected');

        // Manual deletion requires explicit admin context.
        await assert.rejects(() => service.delete('normal-mid', { isAdmin: false }), /Admin permission/);
        const deleted = await service.delete('normal-mid', { isAdmin: true, allowVip: true });
        assert.equal(deleted.deleted, true);

        // Bulk send and JSON sent-mail persistence.
        const bulk = await service.sendBulk({
            concurrency: 2,
            messages: [
                { from: 'support@social-browser.com', to: 'one@example.net', subject: 'One', text: '1' },
                { from: 'support@social-browser.com', to: 'two@example.net', subject: 'Two', text: '2' },
            ],
        });
        assert.equal(bulk.sent, 2);
        assert.equal(bulk.failed, 0);
        assert.equal(delivered.length, 2);

        // MCP uses the same file service directly, never website API handlers.
        const mcp = createEmailMcpService({
            emailService: service,
        });
        const mcpScope = { domain: 'social-browser.com' };
        const mcpStats = await mcp.stats(mcpScope);
        assert.equal(mcpStats.storage, 'json-files-only');
        const mcpSearch = await mcp.search({ query: 'Corporate', limit: 20 }, mcpScope);
        assert.equal(mcpSearch.count, 1);

        // One shared process may serve many hostnames, but every website/MCP
        // request is isolated to the resolved mail-domain scope.
        await service.ingestIncoming({
            guid: 'other-domain',
            from: 'sender@example.net',
            to: 'temp@tenant-b.example.com',
            subject: 'Other tenant only',
            text: 'Isolated',
            date: '2099-09-02T00:00:00.000Z',
        });
        const wrongDomain = await service.search({ query: 'Other tenant only', limit: 20 }, { allowVip: true, domain: 'social-browser.com' });
        assert.equal(wrongDomain.count, 0);
        const rightDomain = await service.search({ query: 'Other tenant only', limit: 20 }, { allowVip: true, domain: 'tenant-b.example.com' });
        assert.equal(rightDomain.count, 1);
        await assert.rejects(() => service.read('other-domain', { allowVip: true, domain: 'social-browser.com' }), /Email not found/);

        const mcpDelete = await mcp.delete('vip-old', mcpScope);
        assert.equal(mcpDelete.deleted, true);

        // Every persistent artifact under the mail data directory is JSON.
        const files = [];
        function walk(dir) {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else files.push(full);
            }
        }
        walk(dataDir);
        assert.ok(files.length > 0);
        assert.ok(files.every((file) => file.endsWith('.json')));
        assert.ok(fs.existsSync(vipPath));
        assert.ok(vipPath.endsWith('.json'));

        console.log('File-first email service tests passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
