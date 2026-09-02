'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    normalizeHostname,
    mailDomainFromHostname,
    requestDomain,
    apiDomain,
    addressBelongsToDomain,
    messageBelongsToDomain,
    mailboxForDomain,
} = require('../apps/emails/core/domain');

assert.strictEqual(normalizeHostname('Mail.Example.COM:443'), 'mail.example.com');
assert.strictEqual(mailDomainFromHostname('xxx.yyyy.domain.com'), 'domain.com');
assert.strictEqual(mailDomainFromHostname('mail.domain.com'), 'domain.com');
assert.strictEqual(mailDomainFromHostname('domain.com'), 'domain.com');
assert.strictEqual(mailDomainFromHostname('xxx.domain.co.uk'), 'domain.co.uk');
assert.strictEqual(mailDomainFromHostname('a.b.domain.com.eg'), 'domain.com.eg');
assert.strictEqual(mailDomainFromHostname('localhost'), 'localhost');
assert.strictEqual(requestDomain({ headers: { host: 'xxx.yyyy.domain.com:443' } }), 'domain.com');

// API compatibility: an explicit email address wins over Host.
const legacyReq = { headers: { host: 'api.old-mobile-host.com:443' } };
assert.strictEqual(apiDomain(legacyReq, 'user@domain.com'), 'domain.com');
assert.strictEqual(apiDomain(legacyReq, '', 'Name <person@company.net>'), 'company.net');
assert.strictEqual(apiDomain(legacyReq), 'old-mobile-host.com');
assert.strictEqual(apiDomain({ headers: { host: 'x.y.domain.com' } }, 'not-an-email'), 'domain.com');

assert.strictEqual(mailboxForDomain('User@other.example', 'domain.com'), 'user@domain.com');
assert.strictEqual(addressBelongsToDomain('Name <user@domain.com>', 'domain.com'), true);
assert.strictEqual(addressBelongsToDomain('user@other.com', 'domain.com'), false);

const inboxA = { folder: 'inbox', from: 'sender@external.net', to: 'user@domain.com' };
const inboxB = { folder: 'inbox', from: 'sender@external.net', to: 'user@other.com' };
const sentA = { folder: 'send', from: 'user@domain.com', to: 'target@external.net' };
assert.strictEqual(messageBelongsToDomain(inboxA, 'domain.com'), true);
assert.strictEqual(messageBelongsToDomain(inboxB, 'domain.com'), false);
assert.strictEqual(messageBelongsToDomain(sentA, 'domain.com'), true);

const frontend = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'js', 'index.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'app.js'), 'utf8');
const mcpService = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'mcp-service.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(/labels\.slice\(-2\)\.join\('\.'\)/.test(frontend), 'Frontend must collapse subdomains to the root mail domain');
assert(!/location\.hostname\.includes\(['\"](?:egytag|social-browser)/i.test(frontend), 'Frontend must not special-case known domains');
assert(!/body\(req\)\.domain/.test(app), 'Backend must not accept a client domain field as the active mail domain');
assert(/apiDomain\(req,/.test(app), 'API routes must support explicit-email domain precedence');
assert(/readContext\(req, \{ maxLimit: 1 \}, apiDomain\(req, req\.query\?\.email, req\.query\?\.to, req\.query\?\.from\)\)/.test(app), 'Message body view must preserve explicit mailbox domain precedence');
assert(!/\|\|\s*['\"]egytag\.com['\"]/.test(app), 'Backend must not have a fallback configured mail domain');
assert(!/EMAIL_MCP_ALLOWED_ADDRESSES/.test(mcpService + server), 'MCP domain scope must come from its request URL, not domain settings');

console.log('Runtime mail-domain and legacy API precedence tests passed');
