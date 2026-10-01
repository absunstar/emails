'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'app.js'), 'utf8');

assert(source.includes('async function authorizeProtectedMailbox'), 'protected mailbox authorization helper must exist');
assert(source.includes('const purchase = await authorizeProPurchase(req, data || {})'), 'protected mailbox helper must verify Google Play purchase in strict mode');

for (const route of [
  "onPost('/api/emails/view'",
  "onPost('/api/emails/all'",
  "site.onGET({ name: '/viewEmail'",
  "site.onGET({ name: '/api/emails/attachment'",
  "site.onGET({ name: '/api/emails/eml'",
]) {
  const start = source.indexOf(route);
  assert(start >= 0, route + ' must exist');
  const block = source.slice(start, start + 7000);
  assert(block.includes('authorizeProtectedMailbox'), route + ' must enforce protected mailbox authorization');
}

console.log('Pro mailbox purchase-verification read contract passed');
