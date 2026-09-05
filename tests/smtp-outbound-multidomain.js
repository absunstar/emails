'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOutboundMessage, resolveDkimSigning, domainOf } = require('../apps/emails/core/smtp-outbound');

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

function parseSignedMessage(raw) {
    const sep = raw.indexOf('\r\n\r\n');
    assert.ok(sep > 0, 'RFC5322 header/body separator missing');
    const headerRaw = raw.slice(0, sep);
    const body = raw.slice(sep + 4);
    const lines = headerRaw.split('\r\n');
    const headers = [];
    let current = null;
    for (const line of lines) {
        if (/^[ \t]/.test(line) && current) {
            current.value += '\r\n' + line;
            continue;
        }
        const idx = line.indexOf(':');
        if (idx < 1) continue;
        current = { name: line.slice(0, idx), value: line.slice(idx + 1).trimStart() };
        headers.push(current);
    }
    return { headers, body };
}

function verifySignedMessage(raw, publicKey) {
    const parsed = parseSignedMessage(raw);
    const dkim = parsed.headers.find((h) => h.name.toLowerCase() === 'dkim-signature');
    assert.ok(dkim, 'DKIM-Signature missing');
    const unfolded = dkim.value.replace(/\r\n[ \t]+/g, ' ');
    const bMatch = unfolded.match(/(?:^|;\s*)b=([^;]*)/i);
    const bhMatch = unfolded.match(/(?:^|;\s*)bh=([^;\s]+)/i);
    const hMatch = unfolded.match(/(?:^|;\s*)h=([^;]+)/i);
    assert.ok(bMatch && bhMatch && hMatch, 'DKIM tags incomplete');

    const signature = bMatch[1].replace(/\s+/g, '');
    const bodyHash = crypto.createHash('sha256').update(relaxedBodyCanonicalize(parsed.body), 'utf8').digest('base64');
    assert.strictEqual(bodyHash, bhMatch[1], 'DKIM body hash mismatch');

    const hNames = hMatch[1].split(':').map((v) => v.trim().toLowerCase()).filter(Boolean);
    let signingData = '';
    const consumed = new Set();
    for (const name of hNames) {
        let picked = -1;
        for (let i = parsed.headers.length - 1; i >= 0; i -= 1) {
            if (consumed.has(i)) continue;
            if (parsed.headers[i].name.toLowerCase() === name) { picked = i; break; }
        }
        assert.ok(picked >= 0, 'Signed header missing: ' + name);
        consumed.add(picked);
        signingData += relaxedHeaderCanonicalize(parsed.headers[picked].name, parsed.headers[picked].value);
    }
    const emptyB = unfolded.replace(/((?:^|;\s*)b=)[^;]*/i, '$1');
    signingData += relaxedHeaderCanonicalize('DKIM-Signature', emptyB);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signingData, 'utf8');
    verifier.end();
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64')), 'DKIM RSA signature mismatch');
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dkim-nodemailer-'));
    try {
        const domains = ['social-browser.com', 'egytag.com'];
        const publicKeys = {};
        for (const domain of domains) {
            const dir = path.join(tmp, domain);
            fs.mkdirSync(dir, { recursive: true });
            const pair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' },
            });
            fs.writeFileSync(path.join(dir, 'mail1.private'), pair.privateKey);
            publicKeys[domain] = pair.publicKey;
        }

        assert.equal(domainOf('Social Browser <info@social-browser.com>'), 'social-browser.com');
        assert.equal(domainOf('support@egytag.com'), 'egytag.com');

        for (const from of ['info@social-browser.com', 'support@egytag.com']) {
            const built = await buildOutboundMessage({
                from,
                to: 'receiver@example.net',
                subject: 'Nodemailer DKIM Test',
                text: 'hello',
                html: '<b>hello</b>',
                headers: {
                    'List-Unsubscribe': '<https://example.net/unsubscribe?id=1>',
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                },
            }, 'mail.social-browser.com', {
                enabled: true,
                requireSigning: true,
                selector: 'mail1',
                basePath: tmp,
                allowedDomains: domains,
                logger() {},
            });
            const d = domainOf(from);
            assert.ok(/DKIM-Signature:/i.test(built.raw));
            assert.ok(new RegExp('(?:^|[;\\s])d=' + d.replace(/\./g, '\\.') + '(?:;|\\s)', 'i').test(built.raw));
            assert.ok(/(?:^|[;\s])s=mail1(?:;|\s)/i.test(built.raw));
            assert.ok(built.raw.includes('List-Unsubscribe:'));
            verifySignedMessage(built.raw, publicKeys[d]);
        }

        assert.throws(() => resolveDkimSigning('x@unknown.test', {
            enabled: true,
            requireSigning: true,
            selector: 'mail1',
            basePath: tmp,
            allowedDomains: domains,
            logger() {},
        }), /not allowed/);

        console.log('smtp-outbound Nodemailer multi-domain DKIM verification passed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
});
