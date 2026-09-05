'use strict';

const path = require('path');
const readline = require('readline');
const { createSmtpOutboundTransport } = require('./core/smtp-outbound');
let sendmailImpl = null;
function sendmail(message, callback) {
    if (!sendmailImpl) sendmailImpl = createSmtpOutboundTransport({ logger: (value) => console.error('[smtp-outbound]', value) });
    return sendmailImpl(message, callback);
}
const { createEmailService } = require('./core/email-service');
const { createEmailAbusePolicy } = require('./core/abuse-policy');
const { createEmailScheduler } = require('./core/email-scheduler');
const { createEmailDeliverabilityEngine } = require('./core/deliverability-engine');
const { createEmailBackupStorageManager } = require('./core/backup-storage-manager');
const { createEmailMcpService } = require('./mcp-service');
const { dispatchRpc, MODERN_PROTOCOL, SERVER_INFO } = require('./mcp-server');

const cwd = process.cwd();
const policy = createEmailAbusePolicy({
    filePath: process.env.EMAIL_POLICY_FILE || path.join(cwd, 'localStorage', 'email-abuse-policy.json'),
});
const deliverability = createEmailDeliverabilityEngine({
    baseDir: process.env.EMAIL_DELIVERABILITY_DIR || path.join(cwd, 'localStorage', 'email-deliverability'),
    logger: () => {},
});
const emailService = createEmailService({
    sendmail,
    dataDir: process.env.EMAIL_DATA_DIR || path.join(cwd, 'localStorage', 'email-files'),
    vipPath: process.env.EMAIL_VIP_FILE || path.join(cwd, 'localStorage', 'vip-email-list.json'),
    maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 10000),
    logger: () => {},
    abusePolicy: policy,
    deliverability,
});
const scheduler = createEmailScheduler({
    emailService,
    abusePolicy: policy,
    baseDir: process.env.EMAIL_SCHEDULE_DIR || path.join(cwd, 'localStorage', 'email-schedules'),
    logger: () => {},
    intervalMs: Number(process.env.EMAIL_SCHEDULE_TICK_MS || 5000),
}).start();
const operationsManager = createEmailBackupStorageManager({
    emailService,
    scheduler,
    rootDir: path.join(cwd, 'localStorage'),
    backupDir: process.env.EMAIL_BACKUP_DIR || path.join(cwd, 'localStorage', 'email-backups'),
    controlDir: process.env.EMAIL_STORAGE_CONTROL_DIR || path.join(cwd, 'localStorage', 'email-storage'),
    alertWebhook: process.env.EMAIL_OPS_ALERT_WEBHOOK || '',
    logger: () => {},
});
const service = createEmailMcpService({ emailService, abusePolicy: policy, scheduler, deliverability, operationsManager });
const session = {
    id: 'stdio',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    protocolVersion: '',
    clientInfo: {},
    clientCapabilities: {},
    logLevel: 'info',
    resourceSubscriptions: new Set(),
    streams: new Set(),
};

function write(value) {
    process.stdout.write(JSON.stringify(value) + '\n');
}

function error(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function isModern(body) {
    const version = body?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    return version === MODERN_PROTOCOL || body?.method === 'server/discover' || body?.method === 'subscriptions/listen';
}

async function handle(body) {
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
        write(error(body?.id, -32600, 'Invalid Request'));
        return;
    }
    session.lastSeenAt = Date.now();
    if (body.method === 'subscriptions/listen' && isModern(body)) {
        const requested = body?.params?.notifications || {};
        write({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: {
                notifications: {
                    toolsListChanged: !!requested.toolsListChanged,
                    promptsListChanged: !!requested.promptsListChanged,
                    resourcesListChanged: !!requested.resourcesListChanged,
                    resourceSubscriptions: Array.isArray(requested.resourceSubscriptions) ? requested.resourceSubscriptions.slice(0, 100) : [],
                },
                _meta: { 'io.modelcontextprotocol/subscriptionId': String(body.id) },
            },
        });
        return;
    }
    try {
        const result = await dispatchRpc(body, {
            modern: isModern(body),
            service,
            scope: { ip: 'stdio', client: 'stdio-agent', sessionId: 'stdio' },
            session,
        });
        if (result?.payload) write(result.payload);
    } catch (err) {
        write(error(body.id, -32603, err?.message || String(err)));
    }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
let queue = Promise.resolve();
rl.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    queue = queue.then(async () => {
        let body;
        try { body = JSON.parse(text); }
        catch (_) { write(error(null, -32700, 'Parse error')); return; }
        await handle(body);
    });
});
rl.on('close', () => queue.finally(() => process.exit(0)));
process.stderr.write(SERVER_INFO.name + ' MCP stdio ready\n');
