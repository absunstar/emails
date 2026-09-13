const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const core = require('..');

test('get/onGET share descriptor normalization and Express-style registration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-core-route-'));
  const file = path.join(dir, 'home.html');
  fs.writeFileSync(file, '<h1>home</h1>');
  const site = core({ dir, cwd: dir, apps: false, session: { enabled: false } });

  assert.equal(site.get, site.onGET);
  assert.equal(site.post, site.onPOST);
  assert.equal(site.all, site.onALL);

  const expressHandler = () => {};
  site.get('/express', expressHandler);
  site.get({ name: '/home', path: file, parser: 'html css js' });
  site.onGET({ name: ['/one', '/two'], content: 'ok' });

  assert.equal(site.router.match('GET', '/express')?.route?.handler, expressHandler);
  assert.equal(typeof site.router.match('GET', '/home')?.route?.handler, 'function');
  assert.equal(typeof site.router.match('GET', '/one')?.route?.handler, 'function');
  assert.equal(typeof site.router.match('GET', '/two')?.route?.handler, 'function');
});
