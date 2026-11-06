'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailCampaignEngine } = require('../apps/emails/core/email-campaign-engine');

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-campaigns-'));
  const sent = [];
  const service = { send: async (message) => { sent.push(message); return { guid: 'g' + sent.length }; } };
  const engine = createEmailCampaignEngine({ emailService: service, baseDir, intervalMs: 500 });

  const c = engine.create({
    name: 'Test Campaign',
    from: 'sender@example.com',
    recipients: [
      { email: 'a@example.com', name: 'Alice', company: 'A' },
      { email: 'b@example.com', name: 'Bob', company: 'B' }
    ],
    messages: [{ name: 'M1', subject: 'Hello {{name}}', text: 'Hi {{name}} from {{company}}' }],
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(c.status, 'draft');
  assert.equal(c.stats.total, 2);
  engine.start(c.id);
  await engine.tick();
  await engine.tick();
  const done = engine.get(c.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.stats.sent, 2);
  assert.equal(sent[0].subject, 'Hello Alice');
  assert.equal(sent[1].text, 'Hi Bob from B');

  const seq = engine.create({
    name: 'Sequence',
    from: 'sender@example.com',
    recipients: [{ email: 'c@example.com', name: 'Carol' }],
    messages: [{ subject: 'One', text: '1' }, { subject: 'Two', text: '2' }],
    messageMode: 'sequence',
    startAt: new Date(Date.now() + 60000).toISOString(),
    pacing: { mode: 'rate', perHour: 120 }
  });
  assert.equal(seq.stats.total, 2);
  const scheduled = engine.start(seq.id);
  assert.equal(scheduled.status, 'scheduled');
  const paused = engine.pause(seq.id);
  assert.equal(paused.status, 'paused');
  const resumed = engine.resume(seq.id);
  assert.equal(resumed.status, 'running');
  engine.stop(seq.id);
  assert.equal(engine.get(seq.id).status, 'stopped');

  const report = engine.report(c.id);
  assert.equal(report.stats.sent, 2);
  assert(report.events.some(e => e.type === 'complete'));
  console.log('email-campaign-engine tests passed');
})().catch(e => { console.error(e); process.exit(1); });
