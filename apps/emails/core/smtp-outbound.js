'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { loadProjectEnv } = require('./env-loader');

// Node.js does not read .env files automatically. Load the project .env before
// resolving SMTP/DKIM options so every outbound path (HTTP/MCP/scheduler/stdio)
// receives the same multi-domain, multi-server configuration.
loadProjectEnv();

function extractAddresses(value) {
    return String(value || '').match(/[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|localhost)/gi) || [];
}

function firstAddress(value) {
    return (extractAddresses(value)[0] || '').trim().toLowerCase();
}

function domainOf(address) {
    const email = firstAddress(address);
    const at = email.lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

function boolEnv(value, fallback) {
    if (value === undefined || value === null || value === '') return !!fallback;
    return /^(?:1|true|yes|on)$/i.test(String(value));
}

function splitCsv(value) {
    return String(value || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function sanitizeHeader(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
    const text = sanitizeHeader(value);
    if (!/[^\x20-\x7E]/.test(text)) return text;
    return '=?UTF-8?B?' + Buffer.from(text, 'utf8').toString('base64') + '?=';
}

function normalizeCrlf(value) {
    return String(value == null ? '' : value).replace(/\r?\n/g, '\r\n');
}

function resolveDkimKey(fromDomain, selector, basePath) {
    const file = path.join(basePath, fromDomain, selector + '.private');
    return { file, privateKey: fs.readFileSync(file, 'utf8') };
}

function createMessageId(hostname) {
    return '<' + crypto.randomBytes(12).toString('hex') + '.' + Date.now() + '@' + sanitizeHeader(hostname || 'localhost') + '>';
}

function normalizeExtraHeaders(headers) {
    const result = {};
    if (!headers || typeof headers !== 'object') return result;
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || value === null || value === '') continue;
        const safeName = String(name).replace(/[^A-Za-z0-9-]/g, '');
        if (!safeName) continue;
        result[safeName] = Array.isArray(value) ? value.map((v) => sanitizeHeader(v)).join(', ') : sanitizeHeader(value);
    }
    return result;
}

function getNodemailer() {
    try {
        return require('nodemailer');
    } catch (error) {
        const wrapped = new Error('Nodemailer is required for outbound MIME/DKIM signing. Run npm install after deploying this build.');
        wrapped.cause = error;
        throw wrapped;
    }
}

function resolveDkimSigning(fromAddress, options) {
    if (!options.enabled) return null;
    const domain = domainOf(fromAddress);
    if (!domain) throw new Error('DKIM: cannot derive signing domain from From header');
    const allowed = options.allowedDomains || [];
    if (allowed.length && !allowed.includes(domain)) throw new Error('DKIM: From domain is not allowed for signing: ' + domain);

    try {
        const key = resolveDkimKey(domain, options.selector, options.basePath);
        options.logger?.('DKIM configured from=' + firstAddress(fromAddress) + ' d=' + domain + ' s=' + options.selector + ' key=' + key.file);
        return {
            domain,
            file: key.file,
            config: {
                domainName: domain,
                keySelector: options.selector,
                privateKey: key.privateKey,
            },
        };
    } catch (error) {
        if (options.requireSigning) {
            throw new Error('DKIM private key not found for ' + domain + ' at ' + path.join(options.basePath, domain, options.selector + '.private'));
        }
        options.logger?.('DKIM skipped for ' + domain + ': ' + error.message);
        return null;
    }
}

async function buildOutboundMessage(message, hostname, dkimOptions) {
    const nodemailer = getNodemailer();
    const signing = resolveDkimSigning(message.from, dkimOptions);
    const messageId = createMessageId(hostname);
    const transportOptions = {
        streamTransport: true,
        buffer: true,
        newline: 'windows',
    };
    if (signing) transportOptions.dkim = signing.config;

    // Nodemailer owns the complete MIME serialization and DKIM signing step. The returned
    // byte stream is then handed to our direct-to-MX SMTP transport without modification.
    // This prevents post-signing header/body changes from invalidating DKIM.
    const transport = nodemailer.createTransport(transportOptions);
    const mail = {
        from: sanitizeHeader(message.from),
        to: sanitizeHeader(message.to),
        subject: message.subject == null ? '' : String(message.subject),
        text: message.text == null ? '' : String(message.text),
        html: message.html == null ? '' : String(message.html),
        messageId,
        date: new Date(),
        headers: normalizeExtraHeaders(message.headers),
    };
    if (message.cc) mail.cc = sanitizeHeader(message.cc);
    if (message.replyTo) mail.replyTo = sanitizeHeader(message.replyTo);
    if (message.inReplyTo) mail.inReplyTo = sanitizeHeader(message.inReplyTo);

    const info = await transport.sendMail(mail);
    const raw = Buffer.isBuffer(info.message) ? info.message.toString('utf8') : String(info.message || '');
    if (!raw) throw new Error('Nodemailer produced an empty outbound message');
    return {
        raw: normalizeCrlf(raw).replace(/\r\n+$/, '') + '\r\n',
        messageId: info.messageId || messageId,
        dkimDomain: signing ? signing.domain : '',
        dkimSelector: signing ? dkimOptions.selector : '',
    };
}

function createLineReader(socket, timeoutMs) {
    let buffer = '';
    let lines = [];
    let waiter = null;
    let error = null;
    let timer = null;

    function wake() {
        if (!waiter) return;
        const fn = waiter;
        waiter = null;
        if (timer) clearTimeout(timer);
        timer = null;
        fn();
    }
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
            const index = buffer.indexOf('\n');
            if (index === -1) break;
            const line = buffer.slice(0, index + 1).replace(/\r?\n$/, '');
            buffer = buffer.slice(index + 1);
            lines.push(line);
        }
        wake();
    });
    socket.on('error', (err) => { error = err; wake(); });
    socket.on('close', () => { if (!error) error = new Error('SMTP connection closed'); wake(); });

    async function nextLine() {
        while (!lines.length && !error) {
            await new Promise((resolve) => {
                waiter = resolve;
                timer = setTimeout(() => {
                    error = new Error('SMTP response timeout');
                    wake();
                }, timeoutMs);
            });
        }
        if (error) throw error;
        return lines.shift();
    }

    async function response() {
        const first = await nextLine();
        const match = first.match(/^(\d{3})([ -])(.*)$/);
        if (!match) throw new Error('Invalid SMTP response: ' + first);
        const code = Number(match[1]);
        const result = [first];
        if (match[2] === '-') {
            while (true) {
                const line = await nextLine();
                result.push(line);
                if (line.startsWith(match[1] + ' ')) break;
            }
        }
        return { code, lines: result, text: result.join('\n') };
    }
    return { response };
}

function writeLine(socket, line) {
    socket.write(String(line) + '\r\n');
}

function expect(reply, min, max, step) {
    if (reply.code < min || reply.code > max) {
        const error = new Error('SMTP ' + step + ' failed: ' + reply.text);
        error.smtpCode = reply.code;
        throw error;
    }
}

async function connectTcp(host, port, timeoutMs, ipFamily) {
    return await new Promise((resolve, reject) => {
        const connectOptions = { host, port };
        if (ipFamily === 4 || ipFamily === 6) connectOptions.family = ipFamily;
        const socket = net.connect(connectOptions);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error('SMTP connect timeout to ' + host + ':' + port));
        }, timeoutMs);
        socket.once('connect', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function upgradeTls(socket, host, timeoutMs, verify) {
    return await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: host, rejectUnauthorized: !!verify });
        const timer = setTimeout(() => {
            secure.destroy();
            reject(new Error('SMTP STARTTLS timeout for ' + host));
        }, timeoutMs);
        secure.once('secureConnect', () => { clearTimeout(timer); resolve(secure); });
        secure.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
}

function dotStuff(raw) {
    return normalizeCrlf(raw).replace(/(^|\r\n)\./g, '$1..');
}

async function smtpConversation(host, envelopeFrom, recipients, raw, options, skipStartTls) {
    let socket = await connectTcp(host, options.port, options.timeoutMs, options.ipFamily);
    let reader = createLineReader(socket, options.timeoutMs);
    try {
        let reply = await reader.response();
        expect(reply, 200, 399, 'greeting');
        writeLine(socket, 'EHLO ' + options.hostname);
        reply = await reader.response();
        if (reply.code >= 400) {
            writeLine(socket, 'HELO ' + options.hostname);
            reply = await reader.response();
            expect(reply, 200, 399, 'HELO');
        }

        const supportsStartTls = reply.lines.some((line) => /(?:^|[ -])STARTTLS(?:$|\s)/i.test(line));
        if (!skipStartTls && supportsStartTls) {
            writeLine(socket, 'STARTTLS');
            const tlsReply = await reader.response();
            expect(tlsReply, 200, 399, 'STARTTLS');
            socket = await upgradeTls(socket, host, options.timeoutMs, options.tlsVerify);
            reader = createLineReader(socket, options.timeoutMs);
            writeLine(socket, 'EHLO ' + options.hostname);
            reply = await reader.response();
            expect(reply, 200, 399, 'EHLO after STARTTLS');
        } else if (options.requireTls && !supportsStartTls) {
            throw new Error('SMTP destination does not offer STARTTLS: ' + host);
        }

        writeLine(socket, 'MAIL FROM:<' + envelopeFrom + '>');
        reply = await reader.response();
        expect(reply, 200, 399, 'MAIL FROM');

        const accepted = [];
        const rejected = [];
        for (const recipient of recipients) {
            writeLine(socket, 'RCPT TO:<' + recipient + '>');
            reply = await reader.response();
            if (reply.code >= 200 && reply.code < 400) accepted.push(recipient);
            else rejected.push({ recipient, code: reply.code, response: reply.text });
        }
        if (!accepted.length) {
            const error = new Error('All recipients rejected by ' + host + ': ' + rejected.map((r) => r.recipient + ' [' + r.code + ']').join(', '));
            error.rejected = rejected;
            throw error;
        }

        writeLine(socket, 'DATA');
        reply = await reader.response();
        expect(reply, 300, 399, 'DATA');
        const stuffed = dotStuff(raw);
        socket.write(stuffed + (stuffed.endsWith('\r\n') ? '.\r\n' : '\r\n.\r\n'));
        reply = await reader.response();
        expect(reply, 200, 299, 'message delivery');
        try { writeLine(socket, 'QUIT'); } catch (_) {}
        return { host, accepted, rejected, response: reply.text, tls: !skipStartTls && supportsStartTls };
    } finally {
        try { socket.end(); } catch (_) {}
        setTimeout(() => { try { socket.destroy(); } catch (_) {} }, 1000).unref?.();
    }
}

async function resolveTargets(domain) {
    try {
        const mx = await dns.resolveMx(domain);
        if (Array.isArray(mx) && mx.length) return mx.sort((a, b) => Number(a.priority) - Number(b.priority)).map((item) => item.exchange);
    } catch (_) {}
    return [domain];
}

function groupRecipients(message) {
    const recipients = [];
    for (const address of extractAddresses([message.to, message.cc].filter(Boolean).join(', '))) {
        const normalized = address.toLowerCase();
        if (!recipients.includes(normalized)) recipients.push(normalized);
    }
    const groups = new Map();
    for (const recipient of recipients) {
        const domain = domainOf(recipient);
        if (!domain) continue;
        if (!groups.has(domain)) groups.set(domain, []);
        groups.get(domain).push(recipient);
    }
    return groups;
}

function createSmtpOutboundTransport(config) {
    config = config || {};
    const logger = typeof config.logger === 'function' ? config.logger : () => {};
    // Reload is harmless and lets a caller set EMAIL_ENV_FILE before transport creation.
    loadProjectEnv({ logger });
    const options = {
        hostname: sanitizeHeader(config.hostname || process.env.SMTP_HOSTNAME || require('os').hostname() || 'localhost'),
        port: Number(config.port || process.env.SMTP_OUTBOUND_PORT || 25),
        timeoutMs: Number(config.timeoutMs || process.env.SMTP_OUTBOUND_TIMEOUT_MS || 20000),
        // IPv4 is the production default because SPF/PTR/fcrDNS are provisioned per sending IP.
        // Set SMTP_OUTBOUND_IP_FAMILY=6 for an IPv6-provisioned server, or 0 for OS auto-selection.
        ipFamily: (() => {
            const value = Number(config.ipFamily !== undefined ? config.ipFamily : (process.env.SMTP_OUTBOUND_IP_FAMILY || 4));
            return value === 6 ? 6 : (value === 0 ? 0 : 4);
        })(),
        requireTls: config.requireTls !== undefined ? !!config.requireTls : boolEnv(process.env.SMTP_REQUIRE_TLS, false),
        tlsVerify: config.tlsVerify !== undefined ? !!config.tlsVerify : boolEnv(process.env.SMTP_TLS_VERIFY, false),
        dkim: {
            enabled: config.dkimEnabled !== undefined ? !!config.dkimEnabled : boolEnv(process.env.DKIM_ENABLED, false),
            requireSigning: config.dkimRequireSigning !== undefined ? !!config.dkimRequireSigning : boolEnv(process.env.DKIM_REQUIRE_SIGNING, false),
            selector: sanitizeHeader(config.dkimSelector || process.env.DKIM_SELECTOR || 'mail1'),
            basePath: config.dkimBasePath || process.env.DKIM_BASE_PATH || '/etc/mail/dkim',
            allowedDomains: splitCsv(config.dkimAllowedDomains !== undefined ? config.dkimAllowedDomains : process.env.DKIM_ALLOWED_DOMAINS),
            logger,
        },
    };

    logger('SMTP outbound configured: hostname=' + options.hostname + ', port=' + options.port + ', ipFamily=' + (options.ipFamily || 'auto') + ', dkim=' + (options.dkim.enabled ? 'enabled' : 'disabled') + ', requireSigning=' + (options.dkim.requireSigning ? 'true' : 'false') + ', selector=' + options.dkim.selector + ', keyBase=' + options.dkim.basePath);

    async function send(message) {
        const envelopeFrom = firstAddress(message.from);
        if (!envelopeFrom) throw new Error('SMTP outbound: valid From address is required');
        const groups = groupRecipients(message);
        if (!groups.size) throw new Error('SMTP outbound: no valid recipients');

        const mime = await buildOutboundMessage(message, options.hostname, options.dkim);
        const raw = mime.raw;
        const deliveries = [];
        for (const [recipientDomain, recipients] of groups.entries()) {
            const targets = await resolveTargets(recipientDomain);
            let delivered = null;
            let lastError = null;
            for (const host of targets) {
                try {
                    delivered = await smtpConversation(host, envelopeFrom, recipients, raw, options, false);
                    break;
                } catch (error) {
                    lastError = error;
                    logger('SMTP target failed ' + host + ' for ' + recipientDomain + ': ' + error.message);
                    if (!options.requireTls && /STARTTLS|TLS|certificate/i.test(error.message || '')) {
                        try {
                            delivered = await smtpConversation(host, envelopeFrom, recipients, raw, options, true);
                            break;
                        } catch (fallbackError) {
                            lastError = fallbackError;
                            logger('SMTP plaintext fallback failed ' + host + ': ' + fallbackError.message);
                        }
                    }
                }
            }
            if (!delivered) throw lastError || new Error('SMTP delivery failed for ' + recipientDomain);
            deliveries.push({ domain: recipientDomain, ...delivered });
        }
        return JSON.stringify({ messageId: mime.messageId, hostname: options.hostname, deliveries });
    }

    function callbackTransport(message, callback) {
        send(message).then((reply) => callback(null, reply)).catch((error) => callback(error));
    }
    callbackTransport.send = send;
    callbackTransport.config = options;
    return callbackTransport;
}

module.exports = {
    createSmtpOutboundTransport,
    buildOutboundMessage,
    resolveDkimSigning,
    domainOf,
};
