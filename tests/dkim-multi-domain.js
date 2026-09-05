'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { domainFromAddress, createDkimResolver, parseMap } = require('../apps/emails/core/dkim-mailer');

assert.strictEqual(domainFromAddress('Social <info@social-browser.com>'), 'social-browser.com');
assert.strictEqual(domainFromAddress('support@egytag.com'), 'egytag.com');
assert.deepStrictEqual(parseMap('{"social-browser.com":"mail1"}'), { 'social-browser.com': 'mail1' });

const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'email-dkim-'));
const domain = 'social-browser.com';
const selector = 'mail1';
const dir = path.join(basePath, domain);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, selector + '.private'), 'TEST PRIVATE KEY');

const resolver = createDkimResolver({
    basePath,
    selector,
    requireSigning: true,
    enabled: true,
    allowedDomains: [domain],
});
const dkim = resolver.resolve('Social Browser <info@social-browser.com>');
assert.strictEqual(dkim.domainName, domain);
assert.strictEqual(dkim.keySelector, selector);
assert.strictEqual(dkim.privateKey, 'TEST PRIVATE KEY');
assert.throws(() => resolver.resolve('x@unauthorized.example'), /not allowed/);

fs.rmSync(basePath, { recursive: true, force: true });
console.log('Multi-domain DKIM resolver tests passed.');
