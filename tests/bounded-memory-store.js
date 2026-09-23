'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmailFileStore } = require('../apps/emails/core/json-store');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mail-bounded-'));
  const opts = { baseDir: path.join(root, 'mail'), vipPath: path.join(root, 'vip.json'), maxMessages: 10000 };
  let store = new EmailFileStore(opts);
  const largeText = 'X'.repeat(256 * 1024);
  for (let i = 0; i < 40; i++) {
    await store.saveMessage({
      guid: 'm-' + i,
      from: 'a@example.com', to: 'box@egytag.com', subject: 'Memory ' + i,
      date: new Date(1700000000000 + i * 1000).toISOString(), text: largeText, html: '<p>' + largeText + '</p>', folder: 'inbox',
      cc: i % 2 ? 'copy@example.com' : ''
    });
  }
  store = new EmailFileStore(opts);
  assert.equal(store.messages.size, 40);
  for (const meta of store.messageValues()) {
    assert.equal(Object.prototype.hasOwnProperty.call(meta, 'text'), false, 'text must not live in RAM index');
    assert.equal(Object.prototype.hasOwnProperty.call(meta, 'html'), false, 'html must not live in RAM index');
  }
  const indexed = Array.from(store.messageValuesForRecipient('box@egytag.com'));
  assert.equal(indexed.length, 40, 'recipient index must contain all mailbox messages');
  assert.equal(Array.from(store.messageValuesForRecipient('copy@example.com')).length, 20, 'cc recipients must be indexed');
  assert.equal(Array.from(store.messageValuesForRecipient('missing@example.com')).length, 0, 'unknown mailbox index must be empty');
  const indexStats = store.recipientIndexStats();
  assert.equal(indexStats.recipients, 2);
  assert.equal(indexStats.references, 60);

  await store.updateMessage('m-5', { to: 'moved@example.com', cc: '' });
  assert.equal(Array.from(store.messageValuesForRecipient('box@egytag.com')).length, 39, 'recipient index must update after recipient change');
  assert.equal(Array.from(store.messageValuesForRecipient('copy@example.com')).length, 19, 'cc index must update after recipient change');
  assert.equal(Array.from(store.messageValuesForRecipient('moved@example.com')).length, 1, 'new recipient must be indexed');
  await store.deleteMessage('m-5');
  assert.equal(Array.from(store.messageValuesForRecipient('moved@example.com')).length, 0, 'recipient index must update after deletion');

  const full = await store.getMessage('m-6');
  assert.equal(full.text.length, largeText.length);
  assert.ok(full.html.length > largeText.length);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Bounded-memory JSON store test passed');
}
main().catch((error) => { console.error(error); process.exit(1); });
