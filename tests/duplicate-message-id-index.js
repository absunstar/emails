'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EmailFileStore } = require('../apps/emails/core/json-store');
function assert(value, message) { if (!value) throw new Error(message); }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function writeMessage(root, doc) {
  const key = hash(doc.guid);
  const dir = path.join(root, 'messages', key.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(doc, null, 2));
}
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-mail-duplicate-id-'));
  try {
    writeMessage(root, { guid: 'legacy-a', id: 77, to: 'a@egytag.com', from: 'x@test.com', subject: 'A', date: '2026-09-09T10:00:00.000Z', folder: 'inbox' });
    writeMessage(root, { guid: 'legacy-b', id: 77, to: 'b@social-browser.com', from: 'x@test.com', subject: 'B', date: '2026-09-09T11:00:00.000Z', folder: 'inbox' });
    const store = new EmailFileStore({ baseDir: root, maxMessages: 100000 });
    const matches = await store.getMessagesById(77);
    assert(matches.length === 2, 'Duplicate numeric ids must keep all legacy candidates');
    assert(matches.some((m) => m.guid === 'legacy-a'), 'First legacy message must remain indexed');
    assert(matches.some((m) => m.guid === 'legacy-b'), 'Second legacy message must remain indexed');
    await store.deleteMessage('legacy-a');
    const remaining = await store.getMessagesById(77);
    assert(remaining.length === 1 && remaining[0].guid === 'legacy-b', 'Deleting one duplicate id must not remove the other from the index');
    console.log('Duplicate legacy message-id index checks passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
