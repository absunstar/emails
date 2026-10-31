'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createEmailBackupStorageManager } = require('../apps/emails/core/backup-storage-manager');
(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'email-nonblocking-backup-'));
    try {
        const root = path.join(work, 'live');
        const directory = path.join(root, 'email-files', 'messages', 'aa');
        fs.mkdirSync(directory, { recursive: true });
        const total = 56;
        for (let i = 0; i < total; i++) fs.writeFileSync(path.join(directory, 'message-' + i + '.json'), JSON.stringify({ i, text: 'sample-data-'.repeat(200) }));
        const manager = createEmailBackupStorageManager({ rootDir: root, emailService: { store: { audit: async () => {} } } });
        const manifest = [];
        let servedAnotherEvent = false;
        setTimeout(() => { servedAnotherEvent = true; }, 0);
        await manager._copySource('email-files', path.join(work, 'snapshot'), manifest);
        assert.equal(servedAnotherEvent, true, 'A live server must be able to process other events while backup copies files');
        assert.equal(manifest.length, total);
        const first = manifest[0];
        const saved = fs.readFileSync(path.join(work, 'snapshot', first.path));
        assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), first.sha256, 'Backup must retain SHA256 integrity');
        console.log('Nonblocking backup: responsive event loop and verified SHA256 PASS');
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
