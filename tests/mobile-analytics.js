'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMobileAnalytics } = require('../apps/emails/core/mobile-analytics');

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-mobile-analytics-'));
const a = 'a'.repeat(28);
const b = 'b'.repeat(28);
let clock = new Date('2026-11-01T12:00:00Z');
try {
    const metrics = createMobileAnalytics({ baseDir, now: () => clock });
    assert.deepEqual(metrics.track({ installationId: 'invalid!', event: 'app_open' }),
        { done: false, code: 'invalid_event' });
    assert.deepEqual(metrics.track({ installationId: a, event: 'unknown_event' }),
        { done: false, code: 'invalid_event' });

    assert.equal(metrics.track({ installationId: a, event: 'app_open' }).done, true);
    assert.equal(metrics.track({ installationId: b, event: 'app_open' }).done, true);
    assert.equal(metrics.track({ installationId: a, event: 'mailbox_create_success' }).done, true);
    assert.equal(metrics.track({ installationId: a, event: 'inbox_load_success' }).done, true);
    assert.equal(metrics.track({ installationId: a, event: 'app_open' }).done, true);
    assert.equal(metrics.summary().series.at(-1).activeInstallations, 2);

    clock = new Date('2026-11-02T12:00:00Z');
    metrics.track({ installationId: a, event: 'app_open' });
    clock = new Date('2026-11-08T12:00:00Z');
    metrics.track({ installationId: a, event: 'app_open' });
    const summary = metrics.summary();
    assert.equal(summary.d1.eligible, 2);
    assert.equal(summary.d1.returned, 1);
    assert.equal(summary.d7.eligible, 2);
    assert.equal(summary.d7.returned, 1);
    assert.equal(summary.totals.mailbox_create_success, 1);
    assert.equal(summary.trackedInstallations, 2);
    assert.equal(summary.scope, 'consented_installations_only');

    metrics.flush();
    const serialized = fs.readFileSync(path.join(baseDir, 'events.json'), 'utf8');
    assert.equal(serialized.includes(a), false, 'raw installation identifier must not be saved');
    assert.equal(serialized.includes(b), false, 'raw installation identifier must not be saved');
    assert.equal(fs.statSync(path.join(baseDir, 'hmac.key')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(baseDir, 'events.json')).mode & 0o777, 0o600);
    const reloaded = createMobileAnalytics({ baseDir, now: () => clock });
    assert.equal(reloaded.summary().trackedInstallations, 2);
    assert.equal(reloaded.erase({ installationId: a }).done, true);
    assert.equal(reloaded.summary().trackedInstallations, 1);
    reloaded.flush();
    console.log('mobile-analytics: PASS (event whitelist, cohorts, HMAC, persistence, deletion)');
} finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
}
