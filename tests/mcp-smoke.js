'use strict';

const assert = require('assert');
const { createEmailMcpServer, MODERN_PROTOCOL, TOOLS, DEFAULT_MCP_SECRET } = require('../apps/emails/mcp-server');

async function main() {
    const calls = [];
    const service = {
        async capabilities() { calls.push(['capabilities']); return { manager: true, capabilities: ['global-search', 'security-policy-update'] }; },
        async search(args) { calls.push(['search', args]); return { count: 1, totalMatches: 1, messages: [{ guid: 'g1', subject: 'Hello' }] }; },
        async read(guid) { calls.push(['read', guid]); return { message: { guid, text: 'Body', html: '<img src="https://example.com/pixel.gif">' } }; },
        async readMany(guids) { calls.push(['readMany', guids]); return { count: guids.length, messages: guids.map((guid) => ({ guid })) }; },
        async mailboxStatuses(args) { calls.push(['mailboxStatuses', args]); return { items: args.addresses.map((email) => ({ email, count: 0 })) }; },
        async stats(args) { calls.push(['stats', args]); return { total: 1, unread: 1, favorite: 0 }; },
        async send(args) { calls.push(['send', args]); return { sent: true, guid: 'g2' }; },
        async sendBulk(args) { calls.push(['sendBulk', args]); return { requested: args.messages.length, sent: args.messages.length, failed: 0 }; },
        async reply(args) { calls.push(['reply', args]); return { sent: true, guid: 'g3' }; },
        async forward(args) { calls.push(['forward', args]); return { sent: true, guid: 'g4' }; },
        async update(args) { calls.push(['update', args]); return { guid: args.guid, ...args.patch }; },
        async updateBulk(args) { calls.push(['updateBulk', args]); return { updatedCount: args.guids.length }; },
        async setRead(guids, read) { calls.push(['setRead', guids, read]); return { updatedCount: guids.length }; },
        async attachmentRead(args) { calls.push(['attachmentRead', args]); return { guid: args.guid, encoding: 'base64', contentBase64: 'aGVsbG8=' }; },
        async emlExport(args) { calls.push(['emlExport', args]); return { guid: args.guid, encoding: 'base64', contentBase64: 'ZW1s' }; },
        async analyze(guid) { calls.push(['analyze', guid]); return { guid, remoteImages: 1, trackingPixels: 1, externalLinks: 0 }; },
        async vipList() { calls.push(['vipList']); return { count: 1, entries: [{ email: 'vip@example.com' }] }; },
        async vipSet(args) { calls.push(['vipSet', args]); return { vip: args.vip }; },
        async foldersList() { calls.push(['foldersList']); return { folders: ['Leads'] }; },
        async folderCreate(name) { calls.push(['folderCreate', name]); return { folder: name, created: true }; },
        async delete(guid) { calls.push(['delete', guid]); return { deleted: true, guid }; },
        async deleteMany(guids) { calls.push(['deleteMany', guids]); return { deletedCount: guids.length, deleted: guids }; },
        async deleteMatching(args) { calls.push(['deleteMatching', args]); return { preview: !args.confirm, deletedCount: args.confirm ? 1 : 0 }; },
        async policyGet() { calls.push(['policyGet']); return { config: { enabled: true, lists: {} }, status: {} }; },
        async policyExport() { calls.push(['policyExport']); return { format: 'social-browser-email-policy-v1', config: { enabled: true } }; },
        async policyImport(config) { calls.push(['policyImport', config]); return { imported: true, config }; },
        async policyStatus() { calls.push(['policyStatus']); return { metrics: {} }; },
        async policyUpdate(config) { calls.push(['policyUpdate', config]); return { config }; },
        async policyReset() { calls.push(['policyReset']); return { config: { enabled: true } }; },
        async policyTest(args) { calls.push(['policyTest', args]); return { result: { allowed: true } }; },
        async policyRuleAdd(args) { calls.push(['policyRuleAdd', args]); return { list: args.list, rule: { values: [args.value] } }; },
        async policyRuleRemove(args) { calls.push(['policyRuleRemove', args]); return { list: args.list, removed: true }; },
        async policyListSetEnabled(args) { calls.push(['policyListSetEnabled', args]); return { list: args.list, rule: { enabled: args.enabled } }; },
        async policyLimitSet(args) { calls.push(['policyLimitSet', args]); return { group: args.group, key: args.key, value: args.value }; },
    };

    assert.equal(DEFAULT_MCP_SECRET, 'SOCIALBROWERMANAGER');
    const created = createEmailMcpServer({ service });
    assert.equal(created.path, '/mcp/SOCIALBROWERMANAGER');
    const { server, path } = created;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}${path}`;

    const post = async (body, headers = {}) => {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify(body),
        });
        return { response, json: response.status === 202 ? null : await response.json() };
    };

    const modernPost = (id, method, params, name) => post({
        jsonrpc: '2.0', id, method,
        params: Object.assign({}, params || {}, { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL } }),
    }, {
        'MCP-Protocol-Version': MODERN_PROTOCOL,
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {}),
    });

    try {
        const init = await post({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        });
        assert.equal(init.response.status, 200);
        assert.equal(init.json.result.serverInfo.name, 'social-browser-email');

        const discover = await modernPost(2, 'server/discover', {});
        assert.equal(discover.response.status, 200);
        assert.ok(discover.json.result.supportedVersions.includes(MODERN_PROTOCOL));

        const list = await modernPost(3, 'tools/list', {});
        assert.equal(list.json.result.tools.length, TOOLS.length);
        assert.ok(TOOLS.length >= 34);
        for (const name of [
            'email_capabilities', 'email_search', 'email_forward', 'email_update_bulk', 'email_attachment_read', 'email_eml_export',
            'email_analyze', 'email_vip_set', 'email_folder_create', 'email_policy_get', 'email_policy_export', 'email_policy_import', 'email_policy_rule_add', 'email_policy_limit_set',
        ]) assert.ok(list.json.result.tools.some((t) => t.name === name), 'missing tool ' + name);

        const call = await modernPost(4, 'tools/call', { name: 'email_search', arguments: { query: 'hello', favorite: true, sortBy: 'subject', sortDir: 'asc', limit: 5 } }, 'email_search');
        assert.equal(call.response.status, 200);
        assert.equal(call.json.result.structuredContent.count, 1);

        const update = await modernPost(5, 'tools/call', { name: 'email_update', arguments: { guid: 'g1', patch: { favorite: true, folder: 'Leads' } } }, 'email_update');
        assert.equal(update.json.result.structuredContent.favorite, true);

        const rule = await modernPost(6, 'tools/call', { name: 'email_policy_rule_add', arguments: { list: 'blockFromDomains', value: '*.spam.example', enabled: true } }, 'email_policy_rule_add');
        assert.equal(rule.json.result.structuredContent.list, 'blockFromDomains');

        const limit = await modernPost(7, 'tools/call', { name: 'email_policy_limit_set', arguments: { group: 'smtp', key: 'connectionsPerMinute', value: 30 } }, 'email_policy_limit_set');
        assert.equal(limit.json.result.structuredContent.value, 30);

        const resetDenied = await modernPost(8, 'tools/call', { name: 'email_policy_reset', arguments: { confirm: false } }, 'email_policy_reset');
        assert.equal(resetDenied.json.result.isError, true);

        const reset = await modernPost(9, 'tools/call', { name: 'email_policy_reset', arguments: { confirm: true } }, 'email_policy_reset');
        assert.equal(reset.json.result.isError, undefined);

        const badHeaders = await modernPost(10, 'tools/call', { name: 'email_search', arguments: {} }, 'email_read');
        assert.equal(badHeaders.response.status, 400);
        assert.equal(badHeaders.json.error.code, -32020);

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(health.status, 200);
        const healthJson = await health.json();
        assert.equal(healthJson.version, '3.0.0');

        console.log('MCP manager protocol and capability tests passed (' + TOOLS.length + ' tools)');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
