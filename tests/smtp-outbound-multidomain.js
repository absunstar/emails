'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMimeMessage, signDkim, domainOf, relaxedBodyCanonicalize, relaxedHeaderCanonicalize } = require('../apps/emails/core/smtp-outbound');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dkim-'));
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

function parseSignedMessage(raw) {
    const sep = raw.indexOf('\r\n\r\n');
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
    const used = new Set();
    for (const name of hNames) {
        let picked = -1;
        for (let i = parsed.headers.length - 1; i >= 0; i -= 1) {
            if (used.has(i)) continue;
            if (parsed.headers[i].name.toLowerCase() === name) { picked = i; break; }
        }
        assert.ok(picked >= 0, 'Signed header missing: ' + name);
        used.add(picked);
        signingData += relaxedHeaderCanonicalize(parsed.headers[picked].name, parsed.headers[picked].value);
    }
    const emptyB = unfolded.replace(/((?:^|;\s*)b=)[^;]*/i, '$1');
    signingData += relaxedHeaderCanonicalize('DKIM-Signature', emptyB);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signingData, 'utf8');
    verifier.end();
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64')), 'DKIM RSA signature mismatch');
}

assert.equal(domainOf('Social Browser <info@social-browser.com>'), 'social-browser.com');
assert.equal(domainOf('support@egytag.com'), 'egytag.com');
for (const from of ['info@social-browser.com', 'support@egytag.com']) {
    const mime = buildMimeMessage({
        from,
        to: 'receiver@example.net',
        subject: 'Test',
        text: 'hello',
        html: '<b>hello</b>',
        headers: {
            'List-Unsubscribe': '<https://example.net/unsubscribe?id=1>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
    }, 'mail.social-browser.com');
    const signed = signDkim(mime.raw, from, {
        enabled: true,
        requireSigning: true,
        selector: 'mail1',
        basePath: tmp,
        allowedDomains: domains,
        logger() {},
    });
    const d = domainOf(from);
    assert.ok(signed.startsWith('DKIM-Signature: '));
    assert.ok(signed.includes('d=' + d + ';'));
    assert.ok(signed.includes('s=mail1;'));
    assert.ok(signed.includes('q=dns/txt;'));
    assert.ok(signed.includes('\r\nFrom: '));
    assert.ok(!/h=[^;]*list-unsubscribe/i.test(signed), 'Operational list headers should not be signed');
    verifySignedMessage(signed, publicKeys[d]);
}
assert.throws(() => {
    const mime = buildMimeMessage({ from: 'x@unknown.test', to: 'receiver@example.net', text: 'x' }, 'mail.social-browser.com');
    signDkim(mime.raw, 'x@unknown.test', { enabled: true, requireSigning: true, selector: 'mail1', basePath: tmp, allowedDomains: domains, logger() {} });
}, /not allowed/);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('smtp-outbound multi-domain DKIM cryptographic verification passed');
