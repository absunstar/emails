'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

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

function relaxedBodyCanonicalize(body) {
    const lines = normalizeCrlf(body).split('\r\n').map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' '));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return (lines.length ? lines.join('\r\n') : '') + '\r\n';
}

function relaxedHeaderCanonicalize(name, value) {
    const unfolded = String(value || '').replace(/\r\n[ \t]+/g, ' ');
    return String(name || '').toLowerCase().trim() + ':' + unfolded.replace(/[ \t]+/g, ' ').trim() + '\r\n';
}

function parseHeaderLines(rawHeaders) {
    const rows = normalizeCrlf(rawHeaders).split('\r\n');
    const list = [];
    let current = null;
    for (const row of rows) {
        if (!row) continue;
        if (/^[ \t]/.test(row) && current) {
            current.value += '\r\n' + row;
            continue;
        }
        const index = row.indexOf(':');
        if (index <= 0) continue;
        current = { name: row.slice(0, index), value: row.slice(index + 1).trimStart() };
        list.push(current);
    }
    return list;
}

function buildMimeMessage(message, hostname) {
    const boundary = 'sb-alt-' + crypto.randomBytes(12).toString('hex');
    const from = sanitizeHeader(message.from);
    const to = sanitizeHeader(message.to);
    const cc = sanitizeHeader(message.cc);
    const subject = encodeHeader(message.subject || '');
    const date = new Date().toUTCString();
    const messageId = '<' + crypto.randomBytes(12).toString('hex') + '.' + Date.now() + '@' + sanitizeHeader(hostname || 'localhost') + '>';
    const headers = [
        ['From', from],
        ['To', to],
    ];
    if (cc) headers.push(['Cc', cc]);
    if (message.replyTo) headers.push(['Reply-To', sanitizeHeader(message.replyTo)]);
    headers.push(['Subject', subject]);
    headers.push(['Date', date]);
    headers.push(['Message-ID', messageId]);
    if (message.inReplyTo) headers.push(['In-Reply-To', sanitizeHeader(message.inReplyTo)]);
    headers.push(['MIME-Version', '1.0']);
    headers.push(['Content-Type', 'multipart/alternative; boundary="' + boundary + '"']);

    const extra = message.headers && typeof message.headers === 'object' ? message.headers : {};
    for (const [name, value] of Object.entries(extra)) {
        if (value === undefined || value === null || value === '') continue;
        const safeName = String(name).replace(/[^A-Za-z0-9-]/g, '');
        if (!safeName) continue;
        headers.push([safeName, sanitizeHeader(Array.isArray(value) ? value.join(', ') : value)]);
    }

    const body = [
        '--' + boundary,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        normalizeCrlf(message.text || ''),
        '--' + boundary,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        normalizeCrlf(message.html || ''),
        '--' + boundary + '--',
        '',
    ].join('\r\n');

    return {
        headers,
        body,
        messageId,
        raw: headers.map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n' + body,
    };
}

function resolveDkimKey(fromDomain, selector, basePath) {
    const file = path.join(basePath, fromDomain, selector + '.private');
    return { file, privateKey: fs.readFileSync(file, 'utf8') };
}

function signDkim(raw, fromAddress, options) {
    const enabled = options.enabled;
    if (!enabled) return raw;
    const domain = domainOf(fromAddress);
    if (!domain) throw new Error('DKIM: cannot derive signing domain from From header');
    const allowed = options.allowedDomains || [];
    if (allowed.length && !allowed.includes(domain)) throw new Error('DKIM: From domain is not allowed for signing: ' + domain);

    let key;
    try {
        key = resolveDkimKey(domain, options.selector, options.basePath);
    } catch (error) {
        if (options.requireSigning) throw new Error('DKIM private key not found for ' + domain + ' at ' + path.join(options.basePath, domain, options.selector + '.private'));
        options.logger?.('DKIM skipped for ' + domain + ': ' + error.message);
        return raw;
    }

    const separator = raw.indexOf('\r\n\r\n');
    const headerRaw = separator === -1 ? raw : raw.slice(0, separator);
    const bodyRaw = separator === -1 ? '' : raw.slice(separator + 4);
    const headers = parseHeaderLines(headerRaw);
    const wanted = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'reply-to', 'in-reply-to', 'mime-version', 'content-type', 'list-unsubscribe', 'list-unsubscribe-post'];
    const selected = [];
    for (const wantedName of wanted) {
        const matches = headers.filter((h) => h.name.toLowerCase() === wantedName);
        if (matches.length) selected.push(matches[matches.length - 1]);
    }
    if (!selected.some((h) => h.name.toLowerCase() === 'from')) throw new Error('DKIM: From header is required');

    const canonicalBody = relaxedBodyCanonicalize(bodyRaw);
    const bodyHash = crypto.createHash('sha256').update(canonicalBody, 'utf8').digest('base64');
    const hList = selected.map((h) => h.name.toLowerCase()).join(':');
    const dkimValueWithoutSignature = [
        'v=1',
        'a=rsa-sha256',
        'c=relaxed/relaxed',
        'd=' + domain,
        's=' + options.selector,
        't=' + Math.floor(Date.now() / 1000),
        'h=' + hList,
        'bh=' + bodyHash,
        'b=',
    ].join('; ');

    let signingData = '';
    for (const header of selected) signingData += relaxedHeaderCanonicalize(header.name, header.value);
    signingData += relaxedHeaderCanonicalize('DKIM-Signature', dkimValueWithoutSignature);

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingData, 'utf8');
    signer.end();
    const signature = signer.sign(key.privateKey, 'base64');
    const dkimHeader = 'DKIM-Signature: ' + dkimValueWithoutSignature + signature;
    options.logger?.('DKIM signed from=' + firstAddress(fromAddress) + ' d=' + domain + ' s=' + options.selector + ' key=' + key.file);
    return dkimHeader + '\r\n' + raw;
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

async function connectTcp(host, port, timeoutMs) {
    return await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
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
    let socket = await connectTcp(host, options.port, options.timeoutMs);
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
        socket.write(dotStuff(raw) + '\r\n.\r\n');
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
    const options = {
        hostname: sanitizeHeader(config.hostname || process.env.SMTP_HOSTNAME || require('os').hostname() || 'localhost'),
        port: Number(config.port || process.env.SMTP_OUTBOUND_PORT || 25),
        timeoutMs: Number(config.timeoutMs || process.env.SMTP_OUTBOUND_TIMEOUT_MS || 20000),
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

    async function send(message) {
        const envelopeFrom = firstAddress(message.from);
        if (!envelopeFrom) throw new Error('SMTP outbound: valid From address is required');
        const groups = groupRecipients(message);
        if (!groups.size) throw new Error('SMTP outbound: no valid recipients');

        const mime = buildMimeMessage(message, options.hostname);
        const raw = signDkim(mime.raw, message.from, options.dkim);
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
    buildMimeMessage,
    signDkim,
    relaxedBodyCanonicalize,
    relaxedHeaderCanonicalize,
    domainOf,
};
