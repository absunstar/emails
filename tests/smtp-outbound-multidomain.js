'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMimeMessage, signDkim, domainOf } = require('../apps/emails/core/smtp-outbound');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dkim-'));
const domains = ['social-browser.com', 'egytag.com'];
for (const domain of domains) {
    const dir = path.join(tmp, domain);
    fs.mkdirSync(dir, { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    fs.writeFileSync(path.join(dir, 'mail1.private'), privateKey);
}
assert.equal(domainOf('Social Browser <info@social-browser.com>'), 'social-browser.com');
assert.equal(domainOf('support@egytag.com'), 'egytag.com');
for (const from of ['info@social-browser.com', 'support@egytag.com']) {
    const mime = buildMimeMessage({ from, to: 'receiver@example.net', subject: 'Test', text: 'hello', html: '<b>hello</b>' }, 'mail.social-browser.com');
    const signed = signDkim(mime.raw, from, { enabled: true, requireSigning: true, selector: 'mail1', basePath: tmp, allowedDomains: domains, logger() {} });
    const d = domainOf(from);
    assert.ok(signed.startsWith('DKIM-Signature: '));
    assert.ok(signed.includes('d=' + d + ';'));
    assert.ok(signed.includes('s=mail1;'));
    assert.ok(signed.includes('\r\nFrom: '));
}
assert.throws(() => {
    const mime = buildMimeMessage({ from: 'x@unknown.test', to: 'receiver@example.net', text: 'x' }, 'mail.social-browser.com');
    signDkim(mime.raw, 'x@unknown.test', { enabled: true, requireSigning: true, selector: 'mail1', basePath: tmp, allowedDomains: domains, logger() {} });
}, /not allowed/);
console.log('smtp-outbound multi-domain tests passed');
