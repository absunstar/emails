'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmailFileStore } = require('../apps/emails/core/json-store');
(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-limit-'));
  try {
    const store = new EmailFileStore({ baseDir, maxMessages: 100000 });
    assert.equal(store.maxMessages, 100000);
    assert.equal(store.getMessageLimit().source, 'startup-config');
    await store.setMessageLimit(125000, { source: 'mcp-manager', managed: true });
    assert.equal(store.getMessageLimit().maxMessages, 125000);
    const restarted = new EmailFileStore({ baseDir, maxMessages: 100000 });
    assert.equal(restarted.maxMessages, 125000, 'MCP-managed limit must survive restart');
    await restarted.setMessageLimit(100000, { source: 'mcp-manager', managed: true });
    assert.equal(restarted.maxMessages, 100000);
    console.log('storage-message-limit: ok');
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exit(1); });
