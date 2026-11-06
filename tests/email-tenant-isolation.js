'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { createEmailScheduler } = require('../apps/emails/core/email-scheduler');
const { createEmailDeliverabilityEngine } = require('../apps/emails/core/deliverability-engine');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-tenant-isolation-'));
  const service = createEmailService({
    sendmail: (message, callback) => callback(null, 'ok'),
    dataDir: path.join(root, 'email-files'),
    vipPath: path.join(root, 'vip.json'),
    maxMessages: 1000,
  });

  await service.ingestIncoming({
    guid: 'msg_a',
    from: 'outside@example.net',
    to: 'user@a.test',
    subject: 'A only',
    text: 'tenant A',
    date: new Date().toISOString(),
  });
  await service.ingestIncoming({
    guid: 'msg_b',
    from: 'outside@example.net',
    to: 'user@b.test',
    subject: 'B only',
    text: 'tenant B',
    date: new Date().toISOString(),
  });

  const ctxA = { isAdmin: true, allowVip: true, organizationId: 'org_a', organizationDomains: ['a.test'] };
  const ctxB = { isAdmin: true, allowVip: true, organizationId: 'org_b', organizationDomains: ['b.test'] };

  const searchA = await service.search({ limit: 100 }, ctxA);
  assert.equal(searchA.totalMatches, 1);
  assert.equal(searchA.messages[0].guid, 'msg_a');

  const searchB = await service.search({ limit: 100 }, ctxB);
  assert.equal(searchB.totalMatches, 1);
  assert.equal(searchB.messages[0].guid, 'msg_b');

  const emptyScope = await service.search({ limit: 100 }, { isAdmin: true, allowVip: true, organizationId: 'org_empty', organizationDomains: [] });
  assert.equal(emptyScope.totalMatches, 0);

  await assert.rejects(() => service.read('msg_b', ctxA));
  assert.equal(await service.update('msg_b', { favorite: true }, ctxA), null);
  const deleteWrong = await service.delete('msg_b', ctxA);
  assert.equal(deleteWrong.deleted, false);
  assert.equal(deleteWrong.notFound, true);

  const statsA = await service.stats(ctxA);
  assert.equal(statsA.total, 1);
  const statsB = await service.stats(ctxB);
  assert.equal(statsB.total, 1);

  const scheduler = createEmailScheduler({
    emailService: service,
    baseDir: path.join(root, 'schedules'),
    intervalMs: 10000,
  });
  const sendAt = new Date(Date.now() + 3600000).toISOString();
  const taskA = await scheduler.schedule({
    from: 'sender@a.test',
    to: 'recipient@example.com',
    text: 'scheduled A',
    sendAt,
    organizationId: 'org_a',
  }, { client: 'test', organizationId: 'org_a' });

  assert.equal(taskA.organizationId, 'org_a');
  assert.equal(scheduler.list({ organizationId: 'org_a' }).total, 1);
  assert.equal(scheduler.list({ organizationId: 'org_b' }).total, 0);
  assert.throws(() => scheduler.get(taskA.id, true, 'org_b'), /not found/i);
  await assert.rejects(() => scheduler.cancel(taskA.id, { organizationId: 'org_b' }), /not found/i);

  const guardRegistry = {
    getOrganization(id) { return id === 'org_a' ? { id: 'org_a' } : null; },
    organizationDomains(id) { return id === 'org_a' ? ['a.test'] : []; },
  };
  const sentNow = [];
  const guardService = createEmailService({
    sendmail: (message, callback) => { sentNow.push(message); callback(null, 'ok'); },
    dataDir: path.join(root, 'guard-email-files'),
    vipPath: path.join(root, 'guard-vip.json'),
    tenantRegistry: guardRegistry,
  });
  await guardService.send({ from: 'sender@a.test', to: 'recipient@example.com', text: 'allowed', organizationId: 'org_a' });
  assert.equal(sentNow.length, 1);
  await assert.rejects(() => guardService.send({ from: 'sender@b.test', to: 'recipient@example.com', text: 'wrong tenant', organizationId: 'org_a' }), /selected organization/i);

  const deliverability = createEmailDeliverabilityEngine({
    baseDir: path.join(root, 'deliverability'),
  });
  deliverability.addSuppression('blocked@example.com', 'manual', 'tenant test', 'test', 'org_a');
  assert.equal(deliverability.listSuppressions({ organizationId: 'org_a' }).total, 1);
  assert.equal(deliverability.listSuppressions({ organizationId: 'org_b' }).total, 0);
  const blockedA = deliverability.preflight('sender@a.test', ['blocked@example.com'], { organizationId: 'org_a' });
  assert.equal(blockedA.allowed, false);
  assert.equal(blockedA.code, 'DELIVERABILITY_SUPPRESSED');
  const allowedB = deliverability.preflight('sender@b.test', ['blocked@example.com'], { organizationId: 'org_b' });
  assert.equal(allowedB.allowed, true);

  console.log('tenant isolation tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});