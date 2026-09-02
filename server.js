'use strict';

const path = require('path');
const { PassThrough } = require('stream');
const SMTPServer = require('smtp-server').SMTPServer;
const parser = require('mailparser').simpleParser;
const sendmail = require('sendmail')();
const { createEmailService } = require('./apps/emails/core/email-service');
const { createEmailAbusePolicy } = require('./apps/emails/core/abuse-policy');
const { createEmailMcpService } = require('./apps/emails/mcp-service');
const { startEmailMcpServer } = require('./apps/emails/mcp-server');

const site = require('../isite')({
    port: 60025,
    language: { id: 'En', dir: 'ltr', text: 'left' },
    lang: 'En',
    version: new Date().getTime(),
    log: true,
    require: {
        features: [],
        permissions: [],
    },
    security: {
        keys: [process.env.EMAIL_SESSION_SECRET || 'a2797cd0076d385e86663865dc4d855b'],
    },
    session: {
        save: false,
    },
});

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

site.emailService = createEmailService({
    sendmail,
    dataDir: process.env.EMAIL_DATA_DIR || path.join(site.cwd, 'localStorage', 'email-files'),
    vipPath: process.env.EMAIL_VIP_FILE || path.join(site.cwd, 'localStorage', 'vip-email-list.json'),
    maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 10000),
    logger: (message) => site.log(message),
    abusePolicy: site.emailAbusePolicy,
});
site.emailStore = site.emailService.store;

site.get('robots.txt', (req, res) => res.txt('robots.txt'));
site.get('app-ads.txt', (req, res) => res.txt('app-ads.txt'));

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
        const result = site.emailAbusePolicy.smtpConnect(remoteIp(session));
        if (!result.allowed) return callback(smtpError(result.reason || 'SMTP connection rejected', 421));
        session.__emailPolicyConnection = true;
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

smtpServer.on('error', (err) => console.error('SMTP Error %s', err.message));
smtpServer.listen(Number(process.env.EMAIL_SMTP_PORT || 25), process.env.EMAIL_SMTP_HOST || undefined);

const mcpSecret = 'SOCIALBROWERMANAGER';
const mcpService = createEmailMcpService({
    emailService: site.emailService,
    abusePolicy: site.emailAbusePolicy,
});
site.emailMcpServer = startEmailMcpServer({
    service: mcpService,
    secret: mcpSecret,
    bearerToken: process.env.EMAIL_MCP_BEARER_TOKEN || '',
    host: process.env.EMAIL_MCP_HOST || '127.0.0.1',
    port: Number(process.env.EMAIL_MCP_PORT || 60026),
    onListen(info) {
        site.log('Email MCP listening on http://' + info.host + ':' + info.port + info.path);
    },
});

site.onGET({ name: '/js', path: site.dir + '/js' });
site.onGET({ name: '/css', path: site.dir + '/css' });
site.onGET({ name: '/fonts', path: site.dir + '/fonts' });
site.onGET({ name: '/images', path: site.dir + '/images' });
site.onGET({ name: '/json', path: site.dir + '/json' });
site.onGET({ name: '/html', path: site.dir + '/html' });

site.loadLocalApp('client-side');
site.start();
