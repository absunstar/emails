'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailInstanceConfig } = require('../apps/emails/core/instance-config');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-instance-'));
const cfg = createEmailInstanceConfig({ cwd: root });
const initial = cfg.getPublic();

assert(initial.instance.id);
assert.equal(initial.instance.name, 'Social Mail');
assert.equal(initial.brand.productName, 'Social Mail');
assert.equal(initial.mcp.name, 'social-browser-email');
assert.equal(initial.mcp.secret, undefined);
assert.equal(initial.mcp.bearerToken, undefined);

const updated = cfg.update({
  instance: { name: 'Acme Mail', edition: 'enterprise' },
  network: {
    publicOrigin: 'https://mail.acme.example/',
    smtpHostname: 'mx.acme.example',
    mailDomains: ['acme.example', 'support.acme.example', 'acme.example'],
  },
  brand: {
    productName: 'Acme Mail',
    companyName: 'Acme Corp',
    websiteUrl: 'https://acme.example/',
    supportUrl: 'https://support.acme.example/',
    logoUrl: '/assets/acme-logo.svg',
    socialBrowserLogin: { enabled: false, label: 'Login by Browser' },
  },
  mcp: {
    name: 'acme-mail',
    title: 'Acme Mail MCP',
    host: '127.0.0.1',
    port: 61026,
  },
  features: {
    socialBrowserLogin: false,
    campaigns: true,
    mcp: true,
    temporaryMail: false,
  },
});

assert.equal(updated.restartRequired, true);
assert.equal(updated.config.instance.name, 'Acme Mail');
assert.equal(updated.config.network.publicOrigin, 'https://mail.acme.example');
assert.equal(updated.config.network.smtpHostname, 'mx.acme.example');
assert.deepEqual(updated.config.network.mailDomains, ['acme.example', 'support.acme.example']);
assert.equal(updated.config.brand.companyName, 'Acme Corp');
assert.equal(updated.config.brand.socialBrowserLogin.enabled, false);
assert.equal(updated.config.mcp.name, 'acme-mail');
assert.equal(updated.config.mcp.title, 'Acme Mail MCP');
assert.equal(updated.config.mcp.port, 61026);
assert.equal(updated.config.features.temporaryMail, false);

const reloaded = createEmailInstanceConfig({ cwd: root }).getPublic();
assert.equal(reloaded.instance.name, 'Acme Mail');
assert.equal(reloaded.network.smtpHostname, 'mx.acme.example');
assert.equal(reloaded.mcp.name, 'acme-mail');

console.log('portable email instance configuration tests passed');
