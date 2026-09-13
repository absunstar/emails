'use strict';

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const SMTPServer = require('smtp-server').SMTPServer;
const parser = require('mailparser').simpleParser;
const { createSmtpOutboundTransport } = require('./apps/emails/core/smtp-outbound');
const sendmail = createSmtpOutboundTransport({ logger: (message) => console.log('[smtp-outbound]', message) });
const { createEmailService } = require('./apps/emails/core/email-service');
const { createEmailAbusePolicy } = require('./apps/emails/core/abuse-policy');
const { createEmailMcpService } = require('./apps/emails/mcp-service');
const { createEmailScheduler } = require('./apps/emails/core/email-scheduler');
const { createEmailDeliverabilityEngine } = require('./apps/emails/core/deliverability-engine');
const { createEmailRuntimeMonitor } = require('./apps/emails/core/runtime-monitor');
const { createEmailBackupStorageManager } = require('./apps/emails/core/backup-storage-manager');
const { createEmailUnsubscribeService } = require('./apps/emails/core/unsubscribe-service');
const { startEmailMcpServer } = require('./apps/emails/mcp-server');

const core = require('./vendor/social-browser-core');
const site = core({
    port: Number(process.env.EMAIL_HTTP_PORT || 60025),
    host: process.env.EMAIL_HTTP_HOST || '0.0.0.0',
    cwd: __dirname,
    request: {
        maxBodyBytes: Number(process.env.EMAIL_HTTP_MAX_BODY_BYTES || 5 * 1024 * 1024),
        maxFileBytes: Number(process.env.EMAIL_HTTP_MAX_FILE_BYTES || 25 * 1024 * 1024),
        uploadDir: path.join(__dirname, 'localStorage', 'uploads'),
    },
    observability: {
        endpoints: true,
        prefix: '/_core',
        tracing: { enabled: true, max: 1000 },
    },
    gracefulShutdown: { signals: true, forceAfterMs: 10000 },
});

// Native Core is the runtime authority. The legacy iSite runtime is not loaded.
site.cwd = __dirname;
site.dir = path.join(__dirname, 'site_files');
site.apps = [{ name: 'emails', name2: 'emails', path: path.join(__dirname, 'apps', 'emails') }];
site.options = site.options || {};
site.options.lang = 'En';
site.log = typeof site.log === 'function' ? site.log.bind(site) : console.log.bind(console);
site.use((req, res, next) => {
    // Small response-name bridge used by the existing email app. These aliases
    // map directly to Native Core response primitives; no iSite runtime is loaded.
    if (typeof res.sendHTML !== 'function') res.sendHTML = res.send.bind(res);
    if (typeof res.htmlContent !== 'function') res.htmlContent = res.send.bind(res);
    next();
});

const { createNativeTemplateRenderer } = require('./apps/emails/core/native-template');
site.emailTemplateRenderer = createNativeTemplateRenderer(site);

// Keep the existing app route descriptors, but render their HTML through the
// parser bundled inside @social-browser/core instead of loading iSite runtime.
const nativeOnGET = site.onGET.bind(site);
function normalizedRouteName(name) {
    name = String(name ?? '').trim();
    if (!name) return '/';
    return name.startsWith('/') ? name : '/' + name;
}
site.onGET = function onGETNativeBridge(route, callback) {
    if (route && typeof route === 'object' && !Array.isArray(route)) {
        const copy = { ...route };
        const names = Array.isArray(copy.name) ? copy.name.map(normalizedRouteName) : normalizedRouteName(copy.name);
        copy.name = names;
        if (copy.path && typeof callback !== 'function') {
            const file = path.resolve(copy.path);
            const parserEnabled = String(copy.parser || '').toLowerCase().includes('html');
            const register = (name) => nativeOnGET({ name, overwrite: copy.overwrite === true }, (req, res) => {
                if (!fs.existsSync(file)) {
                    if (typeof res.status === 'function') res.status(404);
                    return res.end('Not Found');
                }
                if (parserEnabled) return site.emailTemplateRenderer.renderResponse(req, res, file);
                const content = fs.readFileSync(file);
                if (typeof res.set === 'function') res.set('Content-Type', 'text/html; charset=utf-8');
                return res.end(content);
            });
            if (Array.isArray(names)) { let result; for (const name of names) result = register(name); return result; }
            return register(names);
        }
        return nativeOnGET(copy, callback);
    }
    if (typeof route === 'string') route = normalizedRouteName(route);
    return nativeOnGET(route, callback);
};


site.emailRuntimeMonitor = createEmailRuntimeMonitor();
site.emailRuntimeMonitor.component('site', 'starting');

site.emailAbusePolicy = createEmailAbusePolicy({
    filePath: process.env.EMAIL_POLICY_FILE || path.join(site.cwd, 'localStorage', 'email-abuse-policy.json'),
    initial: {
        blockFrom: process.env.EMAIL_BLOCK_FROM,
        allowFrom: process.env.EMAIL_ALLOW_FROM,
        blockFromDomains: process.env.EMAIL_BLOCK_FROM_DOMAINS,
        allowFromDomains: process.env.EMAIL_ALLOW_FROM_DOMAINS,
        blockTo: process.env.EMAIL_BLOCK_TO,
        allowTo: process.env.EMAIL_ALLOW_TO,
        blockToDomains: process.env.EMAIL_BLOCK_TO_DOMAINS,
        allowToDomains: process.env.EMAIL_ALLOW_TO_DOMAINS,
        blockIPs: process.env.EMAIL_BLOCK_IPS,
        allowIPs: process.env.EMAIL_ALLOW_IPS,
        blockSubject: process.env.EMAIL_BLOCK_SUBJECT,
        ignoreFrom: process.env.EMAIL_IGNORE_FROM,
        ignoreSubject: process.env.EMAIL_IGNORE_SUBJECT,
        blockOutboundFrom: process.env.EMAIL_BLOCK_OUTBOUND_FROM,
        allowOutboundFrom: process.env.EMAIL_ALLOW_OUTBOUND_FROM,
        blockOutboundTo: process.env.EMAIL_BLOCK_OUTBOUND_TO,
        allowOutboundTo: process.env.EMAIL_ALLOW_OUTBOUND_TO,
        blockOutboundDomains: process.env.EMAIL_BLOCK_OUTBOUND_DOMAINS,
        allowOutboundDomains: process.env.EMAIL_ALLOW_OUTBOUND_DOMAINS,
    },
});

site.emailDeliverability = createEmailDeliverabilityEngine({
    baseDir: process.env.EMAIL_DELIVERABILITY_DIR || path.join(site.cwd, 'localStorage', 'email-deliverability'),
    logger: (message) => site.log(message),
});

site.emailUnsubscribe = createEmailUnsubscribeService({
    deliverability: site.emailDeliverability,
    baseDir: process.env.EMAIL_UNSUBSCRIBE_DIR || path.join(site.cwd, 'localStorage', 'email-unsubscribe'),
    publicOrigin: process.env.EMAIL_PUBLIC_ORIGIN || 'https://emails.social-browser.com',
    monitor: site.emailRuntimeMonitor,
});

site.emailService = createEmailService({
    sendmail,
    dataDir: process.env.EMAIL_DATA_DIR || path.join(site.cwd, 'localStorage', 'email-files'),
    vipPath: process.env.EMAIL_VIP_FILE || path.join(site.cwd, 'localStorage', 'vip-email-list.json'),
    maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 100000),
    logger: (message) => site.log(message),
    abusePolicy: site.emailAbusePolicy,
    deliverability: site.emailDeliverability,
    unsubscribe: site.emailUnsubscribe,
    monitor: site.emailRuntimeMonitor,
});
site.emailStore = site.emailService.store;
site.emailOperationsManager = createEmailBackupStorageManager({
    emailService: site.emailService,
    monitor: site.emailRuntimeMonitor,
    rootDir: path.join(site.cwd, 'localStorage'),
    backupDir: process.env.EMAIL_BACKUP_DIR || path.join(site.cwd, 'localStorage', 'email-backups'),
    controlDir: process.env.EMAIL_STORAGE_CONTROL_DIR || path.join(site.cwd, 'localStorage', 'email-storage'),
    alertWebhook: process.env.EMAIL_OPS_ALERT_WEBHOOK || '',
    logger: (message) => site.log(message),
});

for (const publicFile of ['robots.txt', 'sitemap.xml', 'app-ads.txt']) {
    site.get('/' + publicFile, (req, res) => {
        const filePath = path.join(site.cwd, 'site_files', publicFile);
        if (!fs.existsSync(filePath)) { res.status(404); return res.end('Not Found'); }
        if (typeof res.set === 'function') res.set('Content-Type', publicFile.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
        res.end(fs.readFileSync(filePath));
    });
}

function smtpError(message, responseCode) {
    const error = new Error(String(message || 'Request rejected'));
    error.responseCode = Number(responseCode || 550);
    return error;
}

function remoteIp(session) {
    return String(session?.remoteAddress || '').trim();
}

const smtpServer = new SMTPServer({
    onAuth(auth, session, callback) {
        callback(null, { user: auth.username });
    },

    onConnect(session, callback) {
        const storage = site.emailOperationsManager?.canAcceptInbound?.();
        if (storage && storage.allowed === false) {
            site.emailRuntimeMonitor.increment('smtpRejected');
            return callback(smtpError(storage.reason || 'Temporary storage is unavailable', 452));
        }
        const result = site.emailAbusePolicy.smtpConnect(remoteIp(session));
        if (!result.allowed) { site.emailRuntimeMonitor.increment('smtpRejected'); return callback(smtpError(result.reason || 'SMTP connection rejected', 421)); }
        session.__emailPolicyConnection = true;
        site.emailRuntimeMonitor.increment('smtpAccepted');
        callback();
    },

    onSecure(socket, session, callback) {
        callback();
    },

    onClose(session) {
        if (session.__emailPolicyConnection) {
            site.emailAbusePolicy.smtpClose(remoteIp(session));
            session.__emailPolicyConnection = false;
        }
    },

    onMailFrom(address, session, callback) {
        const ipCheck = site.emailAbusePolicy.checkIp(remoteIp(session));
        if (!ipCheck.allowed) return callback(smtpError(ipCheck.reason || 'Sender IP is blocked', 550));
        const result = site.emailAbusePolicy.checkAddress('from', address.address);
        if (!result.allowed) {
            site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_from_blocked', { ip: remoteIp(session), address: address.address, rule: result.rule, reason: result.reason });
            return callback(smtpError(result.reason || 'Sender is not allowed', 550));
        }
        callback();
    },

    onRcptTo(address, session, callback) {
        const result = site.emailAbusePolicy.checkAddress('to', address.address);
        if (!result.allowed) {
            site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_to_blocked', { ip: remoteIp(session), address: address.address, rule: result.rule, reason: result.reason });
            return callback(smtpError(result.reason || 'Recipient is not allowed', 550));
        }
        callback();
    },

    onData(stream, session, callback) {
        const limits = site.emailAbusePolicy.getConfig().limits.smtp;
        const input = new PassThrough();
        let totalBytes = 0;
        let overLimit = false;
        let streamEnded = false;
        let parserSettled = false;
        let parserError = null;
        let finished = false;
        const maybeFinish = () => {
            if (finished || !streamEnded || !parserSettled) return;
            finished = true;
            callback(parserError || null);
        };

        stream.on('data', (chunk) => {
            totalBytes += Buffer.byteLength(chunk);
            if (limits.enabled && totalBytes > limits.maxMessageBytes) {
                if (!overLimit) {
                    overLimit = true;
                    const error = smtpError('Message exceeds the configured size limit', 552);
                    site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_message_too_large', { ip: remoteIp(session), bytes: totalBytes, limit: limits.maxMessageBytes });
                    input.destroy(error);
                }
                return;
            }
            if (!overLimit) input.write(chunk);
        });
        stream.on('end', () => {
            streamEnded = true;
            if (!overLimit) input.end();
            maybeFinish();
        });
        stream.on('error', (error) => {
            streamEnded = true;
            input.destroy(error);
            maybeFinish();
        });

        parser(input, {})
            .then(async (parsed) => {
                const from = parsed.from?.text || '';
                const headerFrom = parsed.from?.value?.[0]?.address || '';
                const subject = parsed.subject || '';
                if (headerFrom) {
                    const headerFromCheck = site.emailAbusePolicy.checkAddress('from', headerFrom);
                    if (!headerFromCheck.allowed) {
                        site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_header_from_blocked', { ip: remoteIp(session), address: headerFrom, rule: headerFromCheck.rule, reason: headerFromCheck.reason });
                        throw smtpError(headerFromCheck.reason || 'Message sender is blocked', 550);
                    }
                }
                const subjectCheck = site.emailAbusePolicy.checkSubject(subject);
                if (!subjectCheck.allowed) {
                    site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_subject_blocked', { ip: remoteIp(session), subject, rule: subjectCheck.rule, reason: subjectCheck.reason });
                    throw smtpError(subjectCheck.reason || 'Message subject is blocked', 550);
                }
                const ignored = site.emailAbusePolicy.shouldIgnore(from, subject);
                if (ignored.ignore) {
                    site.emailAbusePolicy.metrics.smtpMessagesIgnored += 1;
                    site.emailAbusePolicy.record('smtp_message_ignored', { ip: remoteIp(session), from, subject, rule: ignored.rule });
                    return;
                }
                const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
                if (limits.enabled && attachments.length > limits.maxAttachments) {
                    site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_too_many_attachments', { ip: remoteIp(session), count: attachments.length, limit: limits.maxAttachments });
                    throw smtpError('Message has too many attachments', 552);
                }
                if (limits.enabled) {
                    const tooLarge = attachments.find((item) => Buffer.byteLength(item?.content || Buffer.alloc(0)) > limits.maxAttachmentBytes);
                    if (tooLarge) {
                        site.emailAbusePolicy.reject('smtpMessagesRejected', 'smtp_attachment_too_large', { ip: remoteIp(session), filename: tooLarge.filename || '', size: Buffer.byteLength(tooLarge.content || Buffer.alloc(0)), limit: limits.maxAttachmentBytes });
                        throw smtpError('An attachment exceeds the configured size limit', 552);
                    }
                }
                await site.emailService.ingestIncoming({
                    messageId: parsed.messageId || '',
                    folder: 'inbox',
                    subject,
                    from,
                    to: parsed.to?.text || '',
                    cc: parsed.cc?.text || '',
                    replyTo: parsed.replyTo?.text || '',
                    inReplyTo: parsed.inReplyTo || '',
                    date: parsed.date || new Date(),
                    text: parsed.text || '',
                    html: typeof parsed.html === 'string' ? parsed.html : '',
                    attachments: attachments.map((item, index) => ({
                        id: String(item.checksum || item.cid || ('attachment-' + (index + 1))),
                        filename: item.filename || ('attachment-' + (index + 1)),
                        contentType: item.contentType || 'application/octet-stream',
                        contentDisposition: item.contentDisposition || 'attachment',
                        contentId: item.contentId || item.cid || '',
                        checksum: item.checksum || '',
                        related: !!item.related,
                        content: item.content,
                    })),
                });
            })
            .then(() => {
                parserSettled = true;
                maybeFinish();
            })
            .catch((error) => {
                parserError = error;
                parserSettled = true;
                maybeFinish();
            });
    },

    disabledCommands: ['AUTH'],
});

smtpServer.on('error', (err) => {
    console.error('SMTP Error %s', err.message);
    site.emailRuntimeMonitor.component('smtp', 'error', { error: err.message });
    site.emailRuntimeMonitor.error('smtp', err);
});
smtpServer.on('listening', () => {
    const address = smtpServer.server?.address?.() || null;
    site.emailRuntimeMonitor.component('smtp', 'listening', { address });
});
smtpServer.listen(Number(process.env.EMAIL_SMTP_PORT || 25), process.env.EMAIL_SMTP_HOST || undefined);

const mcpSecret = String(process.env.EMAIL_MCP_SECRET || '').trim();
site.emailScheduler = site.emailScheduler || createEmailScheduler({
    emailService: site.emailService,
    abusePolicy: site.emailAbusePolicy,
    baseDir: process.env.EMAIL_SCHEDULE_DIR || path.join(site.cwd, 'localStorage', 'email-schedules'),
    logger: (message) => site.log(message),
    intervalMs: Number(process.env.EMAIL_SCHEDULE_TICK_MS || 5000),
}).start();
site.emailRuntimeMonitor.component('scheduler', 'running', site.emailScheduler.status());
site.emailOperationsManager.setScheduler(site.emailScheduler).start();
site.emailRuntimeMonitor.component('storage', site.emailOperationsManager.status().storage.level, { backupCount: site.emailOperationsManager.listBackups().count });
const mcpService = createEmailMcpService({
    emailService: site.emailService,
    abusePolicy: site.emailAbusePolicy,
    scheduler: site.emailScheduler,
    deliverability: site.emailDeliverability,
    operationsManager: site.emailOperationsManager,
});
site.emailMcpServer = startEmailMcpServer({
    service: mcpService,
    secret: mcpSecret,
    bearerToken: process.env.EMAIL_MCP_BEARER_TOKEN || '',
    host: process.env.EMAIL_MCP_HOST || '127.0.0.1',
    port: Number(process.env.EMAIL_MCP_PORT || 60026),
    onListen(info) {
        site.emailRuntimeMonitor.component('mcp', 'listening', { host: info.host, port: info.port, path: info.path, ssePath: info.ssePath });
        site.log('Email MCP Streamable HTTP: http://' + info.host + ':' + info.port + info.path);
        site.log('Email MCP Legacy SSE: http://' + info.host + ':' + info.port + info.ssePath);
        site.log('Email MCP STDIO: npm run mcp:stdio');
    },
});

site.static('/js', path.join(site.dir, 'js'));
site.static('/css', path.join(site.dir, 'css'));
site.static('/fonts', path.join(site.dir, 'fonts'));
site.static('/images', path.join(site.dir, 'images'));
site.static('/json', path.join(site.dir, 'json'));
site.static('/html', path.join(site.dir, 'html'));

// Explicit app registration removes the old iSite auto-loader as an authority.
require('./apps/emails/app')(site);

site.onShutdown(async () => {
    try { await site.emailMcpServer?.close?.(); } catch (_) {}
    try { await site.emailScheduler?.stop?.(); } catch (_) {}
    try { await site.emailOperationsManager?.stop?.(); } catch (_) {}
    try { await new Promise((resolve) => smtpServer.close(() => resolve())); } catch (_) {}
});

site.start();
site.emailRuntimeMonitor.component('site', 'ready', { httpPort: Number(process.env.EMAIL_HTTP_PORT || 60025), runtime: '@social-browser/core', coreVersion: require('./vendor/social-browser-core/package.json').version });
