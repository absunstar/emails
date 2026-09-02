'use strict';

const assert = require('assert');
const { createEmailMcpServer, MODERN_PROTOCOL, DEFAULT_MCP_SECRET, RESOURCES, RESOURCE_TEMPLATES, PROMPTS } = require('../apps/emails/mcp-server');

function stubService() {
    return {
        async capabilities() { return { manager: true, capabilities: ['search', 'send', 'security'] }; },
        async search() { return { count: 1, totalMatches: 1, messages: [{ guid: 'g1', subject: 'Hello' }] }; },
        async read(guid) { return { message: { guid, subject: 'Hello', text: 'Body', html: '<p>Body</p>' } }; },
        async readMany(guids) { return { messages: guids.map((guid) => ({ guid })) }; },
        async mailboxStatuses(args) { return { items: (args.addresses || []).map((email) => ({ email, count: 0 })) }; },
        async stats() { return { total: 3, unread: 1, favorite: 1 }; },
        async send() { return { sent: true }; },
        async sendBulk(args) { return { requested: args.messages.length, sent: args.messages.length }; },
        async reply() { return { sent: true }; },
        async forward() { return { sent: true }; },
        async update(args) { return { guid: args.guid, ...args.patch }; },
        async updateBulk(args) { return { updatedCount: args.guids.length }; },
        async setRead(guids) { return { updatedCount: guids.length }; },
        async attachmentRead(args) { return { guid: args.guid, contentType: 'text/plain', contentBase64: 'aGVsbG8=' }; },
        async emlExport(args) { return { guid: args.guid, contentType: 'message/rfc822', contentBase64: 'RnJvbTogeEB5DQo=' }; },
        async analyze(guid) { return { guid, remoteImages: 0, trackingPixels: 0 }; },
        async vipList() { return { count: 1, entries: [{ email: 'vip@example.com' }] }; },
        async vipSet(args) { return args; },
        async foldersList() { return { folders: ['Leads', 'Partners'] }; },
        async folderCreate(name) { return { folder: name, created: true }; },
        async delete(guid) { return { deleted: true, guid }; },
        async deleteMany(guids) { return { deletedCount: guids.length }; },
        async deleteMatching(args) { return { preview: !args.confirm }; },
        async policyGet() { return { config: { enabled: true, lists: {}, limits: {} } }; },
        async policyExport() { return { config: { enabled: true } }; },
        async policyImport(config) { return { config }; },
        async policyStatus() { return { metrics: { rejected: 0 } }; },
        async policyUpdate(config) { return { config }; },
        async policyReset() { return { reset: true }; },
        async policyTest() { return { allowed: true }; },
        async policyRuleAdd(args) { return args; },
        async policyRuleRemove(args) { return args; },
        async policyListSetEnabled(args) { return args; },
        async policyLimitSet(args) { return args; },
    };
}

async function readSseBlock(reader, state, timeoutMs = 3000) {
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for SSE event')), timeoutMs));
    const work = (async () => {
        while (true) {
            const index = state.text.indexOf('\n\n');
            if (index >= 0) {
                const block = state.text.slice(0, index);
                state.text = state.text.slice(index + 2);
                if (!block.trim() || block.trim().startsWith(':')) continue;
                const event = { event: 'message', data: '', id: '' };
                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) event.event = line.slice(6).trim();
                    else if (line.startsWith('data:')) event.data += (event.data ? '\n' : '') + line.slice(5).trimStart();
                    else if (line.startsWith('id:')) event.id = line.slice(3).trim();
                }
                return event;
            }
            const { done, value } = await reader.read();
            if (done) throw new Error('SSE stream closed before event');
            state.text += Buffer.from(value).toString('utf8').replace(/\r\n/g, '\n');
        }
    })();
    return Promise.race([work, timer]);
}

async function main() {
    assert.equal(DEFAULT_MCP_SECRET, 'SOCIALBROWERMANAGER');
    const created = createEmailMcpServer({ service: stubService(), heartbeatMs: 60000 });
    await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
    const port = created.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const endpoint = base + created.path;

    const post = async (body, headers = {}) => {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
            body: JSON.stringify(body),
        });
        const json = response.status === 202 || response.status === 204 ? null : await response.json();
        return { response, json };
    };

    const modernPost = (id, method, params, name) => post({
        jsonrpc: '2.0', id, method,
        params: Object.assign({}, params || {}, { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'compat-test', version: '1' } } }),
    }, {
        'MCP-Protocol-Version': MODERN_PROTOCOL,
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {}),
    });

    try {
        const options = await fetch(endpoint, { method: 'OPTIONS' });
        assert.equal(options.status, 204);
        assert.match(options.headers.get('access-control-allow-methods') || '', /POST/);
        assert.match(options.headers.get('access-control-allow-methods') || '', /GET/);
        assert.match(options.headers.get('access-control-allow-methods') || '', /DELETE/);

        const head = await fetch(endpoint, { method: 'HEAD' });
        assert.equal(head.status, 200);

        const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } });
        assert.equal(init.response.status, 200);
        const sessionId = init.response.headers.get('mcp-session-id');
        assert.ok(sessionId);
        assert.equal(init.json.result.protocolVersion, '2025-11-25');
        assert.ok(init.json.result.capabilities.resources);
        assert.ok(init.json.result.capabilities.prompts);
        assert.ok(init.json.result.capabilities.completions);

        const ping = await post({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }, { 'Mcp-Session-Id': sessionId });
        assert.deepEqual(ping.json.result, {});

        const resources = await post({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} }, { 'Mcp-Session-Id': sessionId });
        assert.equal(resources.json.result.resources.length, RESOURCES.length);
        const templates = await post({ jsonrpc: '2.0', id: 4, method: 'resources/templates/list', params: {} }, { 'Mcp-Session-Id': sessionId });
        assert.equal(templates.json.result.resourceTemplates.length, RESOURCE_TEMPLATES.length);
        const resourceRead = await post({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'email-manager://stats' } }, { 'Mcp-Session-Id': sessionId });
        assert.equal(resourceRead.json.result.contents[0].mimeType, 'application/json');

        const prompts = await post({ jsonrpc: '2.0', id: 6, method: 'prompts/list', params: {} }, { 'Mcp-Session-Id': sessionId });
        assert.equal(prompts.json.result.prompts.length, PROMPTS.length);
        const prompt = await post({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'draft_reply', arguments: { guid: 'g1', tone: 'friendly' } } }, { 'Mcp-Session-Id': sessionId });
        assert.match(prompt.json.result.messages[0].content.text, /g1/);
        const completion = await post({ jsonrpc: '2.0', id: 8, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'draft_reply' }, argument: { name: 'tone', value: 'fri' } } }, { 'Mcp-Session-Id': sessionId });
        assert.ok(completion.json.result.completion.values.includes('friendly'));

        const sseOnly = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
        });
        assert.equal(sseOnly.status, 200);
        assert.match(sseOnly.headers.get('content-type') || '', /text\/event-stream/);
        const sseText = await sseOnly.text();
        assert.match(sseText, /"tools"/);

        const streamAbort = new AbortController();
        const getStream = await fetch(endpoint, { headers: { accept: 'text/event-stream', 'Mcp-Session-Id': sessionId }, signal: streamAbort.signal });
        assert.equal(getStream.status, 200);
        assert.match(getStream.headers.get('content-type') || '', /text\/event-stream/);
        streamAbort.abort();
        try { await getStream.body.cancel(); } catch (_) {}

        const del = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
        assert.equal(del.status, 204);

        const modernResources = await modernPost(10, 'resources/list', {});
        assert.equal(modernResources.response.status, 200);
        assert.equal(modernResources.json.result.resources.length, RESOURCES.length);
        const modernRead = await modernPost(11, 'resources/read', { uri: 'email-manager://message/g1' }, 'email-manager://message/g1');
        assert.equal(modernRead.response.status, 200);
        assert.match(modernRead.json.result.contents[0].text, /g1/);
        const modernPrompt = await modernPost(12, 'prompts/get', { name: 'security_audit', arguments: {} }, 'security_audit');
        assert.equal(modernPrompt.response.status, 200);

        const listenAbort = new AbortController();
        const listenBody = {
            jsonrpc: '2.0', id: 'listen-1', method: 'subscriptions/listen',
            params: {
                notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['email-manager://stats'] },
                _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'listen-test', version: '1' } },
            },
        };
        const listenResponse = await fetch(endpoint, {
            method: 'POST',
            signal: listenAbort.signal,
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'MCP-Protocol-Version': MODERN_PROTOCOL, 'Mcp-Method': 'subscriptions/listen' },
            body: JSON.stringify(listenBody),
        });
        assert.equal(listenResponse.status, 200);
        const listenReader = listenResponse.body.getReader();
        const listenState = { text: '' };
        const ack = await readSseBlock(listenReader, listenState);
        assert.match(ack.data, /notifications\/subscriptions\/acknowledged/);
        listenAbort.abort();
        try { await listenReader.cancel(); } catch (_) {}

        const legacyAbort = new AbortController();
        const legacySse = await fetch(base + created.ssePath, { headers: { accept: 'text/event-stream' }, signal: legacyAbort.signal });
        assert.equal(legacySse.status, 200);
        const legacyReader = legacySse.body.getReader();
        const legacyState = { text: '' };
        const endpointEvent = await readSseBlock(legacyReader, legacyState);
        assert.equal(endpointEvent.event, 'endpoint');
        assert.match(endpointEvent.data, /\/message\?sessionId=/);
        const legacyMessageUrl = new URL(endpointEvent.data, base).href;
        const legacyPost = await fetch(legacyMessageUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old-sse-agent', version: '1' } } }),
        });
        assert.equal(legacyPost.status, 202);
        const legacyResponseEvent = await readSseBlock(legacyReader, legacyState);
        const legacyRpc = JSON.parse(legacyResponseEvent.data);
        assert.equal(legacyRpc.result.protocolVersion, '2024-11-05');
        legacyAbort.abort();
        try { await legacyReader.cancel(); } catch (_) {}

        const health = await fetch(base + '/health');
        const healthJson = await health.json();
        assert.equal(healthJson.version, '4.0.0');
        assert.ok(healthJson.transports.includes('sse-legacy'));
        assert.ok(healthJson.transports.includes('streamable-http-stateless'));
        assert.ok(healthJson.methods.includes('DELETE'));

        console.log('MCP Streamable HTTP, stateful HTTP, legacy SSE, resources, prompts and completion compatibility passed');
    } finally {
        await new Promise((resolve) => created.server.close(resolve));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
