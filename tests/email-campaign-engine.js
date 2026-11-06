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

  // One-to-one assigned mode: each recipient gets exactly one personalized message.
  // Explicit per-recipient message assignment (messageIndex) + recipient variables.
  const oneToOne = engine.create({
    name: 'One-to-one',
    from: 'sender@example.com',
    recipients: [
      { email: 'd@example.com', name: 'Dana', role: 'Lead', messageIndex: 0 },
      { email: 'e@example.com', name: 'Eve', role: 'Prospect', messageIndex: 1 }
    ],
    messages: [
      { id: 'm_lead', subject: 'Hi {{name}}, try our lead plan', text: 'Hello {{name}} ({{role}})' },
      { id: 'm_pro', subject: 'Hi {{name}}, upgrade to pro', text: 'Welcome {{name}} ({{role}})' }
    ],
    messageMode: 'assigned',
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(oneToOne.stats.total, 2, 'assigned mode must build exactly one job per recipient');
  assert.equal(oneToOne.queue[0].messageIndex, 0);
  assert.equal(oneToOne.queue[1].messageIndex, 1);
  engine.start(oneToOne.id);
  await engine.tick();
  await engine.tick();
  const oneToOneDone = engine.get(oneToOne.id);
  assert.equal(oneToOneDone.status, 'completed');
  assert.equal(oneToOneDone.stats.sent, 2);
  assert.equal(sent.find(m => m.to === 'd@example.com').subject, 'Hi Dana, try our lead plan');
  assert.equal(sent.find(m => m.to === 'd@example.com').text, 'Hello Dana (Lead)');
  assert.equal(sent.find(m => m.to === 'e@example.com').subject, 'Hi Eve, upgrade to pro');
  assert.equal(sent.find(m => m.to === 'e@example.com').text, 'Welcome Eve (Prospect)');

  // Assigned mode with messageId reference per recipient.
  const byId = engine.create({
    name: 'Assigned by id',
    from: 'sender@example.com',
    recipients: [
      { email: 'f@example.com', messageId: 'm_pro' },
      { email: 'g@example.com', messageId: 'm_lead' }
    ],
    messages: [{ id: 'm_lead', subject: 'Lead', text: 'lead text' }, { id: 'm_pro', subject: 'Pro', text: 'pro text' }],
    messageMode: 'assigned',
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(byId.queue[0].messageIndex, 1);
  assert.equal(byId.queue[1].messageIndex, 0);
  assert.equal(byId.stats.total, 2);
  engine.start(byId.id);
  await engine.tick();
  await engine.tick();
  assert.equal(sent.find(m => m.to === 'f@example.com').subject, 'Pro');
  assert.equal(sent.find(m => m.to === 'g@example.com').subject, 'Lead');

  // Assigned mode with a single message: default per-recipient personalization is 1:1.
  const personal = engine.create({
    name: 'Personalized single',
    from: 'sender@example.com',
    recipients: [
      { email: 'h@example.com', company: 'H', nickname: 'Hal', messageIndex: 0 },
      { email: 'i@example.com', company: 'I', nickname: 'Ida', messageIndex: 0 }
    ],
    messages: [{ subject: 'Hello {{nickname}}', text: 'From {{company}}' }],
    messageMode: 'assigned',
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(personal.stats.total, 2);
  engine.start(personal.id);
  await engine.tick();
  await engine.tick();
  assert.equal(sent.find(m => m.to === 'h@example.com').subject, 'Hello Hal');
  assert.equal(sent.find(m => m.to === 'h@example.com').text, 'From H');
  assert.equal(sent.find(m => m.to === 'i@example.com').subject, 'Hello Ida');
  assert.equal(sent.find(m => m.to === 'i@example.com').text, 'From I');

  // Backwards compatibility: rotate and sequence modes are unaffected.
  const rotate = engine.create({
    name: 'Rotate compat',
    from: 'sender@example.com',
    recipients: [{ email: 'j@example.com' }, { email: 'k@example.com' }],
    messages: [{ subject: 'A1', text: 'a1' }, { subject: 'A2', text: 'a2' }],
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(rotate.messageMode, 'rotate');
  assert.equal(rotate.stats.total, 2);
  assert.equal(rotate.queue[0].messageIndex, 0);
  assert.equal(rotate.queue[1].messageIndex, 1);
  const sequence = engine.create({
    name: 'Sequence compat',
    from: 'sender@example.com',
    recipients: [{ email: 'l@example.com' }],
    messages: [{ subject: 'S1', text: 's1' }, { subject: 'S2', text: 's2' }],
    messageMode: 'sequence',
    startAt: 'now',
    pacing: { mode: 'fixed', intervalSeconds: 0 }
  });
  assert.equal(sequence.messageMode, 'sequence');
  assert.equal(sequence.stats.total, 2);
  assert.equal(sequence.queue[0].messageIndex, 0);
  assert.equal(sequence.queue[1].messageIndex, 1);

  console.log('email-campaign-engine tests passed');
})().catch(e => { console.error(e); process.exit(1); });
