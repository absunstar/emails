'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmailFileStore } = require('../apps/emails/core/json-store');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-index-'));
    const opts = { baseDir: path.join(root, 'email-files'), maxMessages: 1000 };
    try {
        let store = new EmailFileStore(opts);
        assert.equal(store.messageIndexStatus().loadMode, 'full-scan');
        assert.ok(fs.existsSync(store.messageIndexPath));

        for (let i = 1; i <= 120; i += 1) {
            await store.saveMessage({
                guid: 'm-' + i,
                from: 'sender@example.net',
                to: i % 2 ? 'one@egytag.com' : 'two@egytag.com',
                cc: i % 5 === 0 ? 'copy@example.com' : '',
                subject: 'Message ' + i,
                text: 'body-' + i,
                html: '<p>body-' + i + '</p>',
                date: new Date(1700000000000 + i * 1000).toISOString(),
                folder: 'inbox',
            });
        }
        const before = store.messageIndexStatus();
        assert.equal(before.messageCount, 120);
        assert.ok(before.journalEntries >= 120);
        assert.equal(before.dirty, false);

        store = new EmailFileStore(opts);
        const loaded = store.messageIndexStatus();
        assert.equal(loaded.loadMode, 'persistent-index');
        assert.equal(loaded.messageCount, 120);
        assert.equal(Array.from(store.messageValuesForRecipient('one@egytag.com')).length, 60);
        assert.equal(Array.from(store.messageValuesForRecipient('two@egytag.com')).length, 60);
        assert.equal(Array.from(store.messageValuesForRecipient('copy@example.com')).length, 24);

        assert.equal(await store.updateMessage('missing-guid', { subject: 'none' }), null);
        assert.equal(store.messageIndexStatus().dirty, false);
        await store.updateMessage('m-1', { to: 'moved@egytag.com', subject: 'Moved' });
        await store.deleteMessage('m-2');
        store = new EmailFileStore(opts);
        assert.equal(store.messageIndexStatus().loadMode, 'persistent-index');
        assert.equal(store.messages.size, 119);
        assert.equal(Array.from(store.messageValuesForRecipient('moved@egytag.com')).length, 1);
        assert.equal(await store.getMessage('m-2'), null);

        store.invalidatePersistentIndex('test-dirty-recovery');
        assert.equal(fs.existsSync(store.messageIndexDirtyPath), true);
        store = new EmailFileStore(opts);
        assert.equal(store.messageIndexStatus().loadMode, 'full-scan');
        assert.equal(store.messages.size, 119);
        assert.equal(store.messageIndexStatus().dirty, false);

        fs.writeFileSync(store.messageIndexPath, '{broken', 'utf8');
        store = new EmailFileStore(opts);
        assert.equal(store.messageIndexStatus().loadMode, 'full-scan');
        assert.equal(store.messages.size, 119);

        console.log('Persistent message metadata index tests passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
