'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('path');
const aisite=require('..');

test('iSite advanced aliases absent from Core',()=>{
  const site=aisite();
  for(const n of ['coreV3','coreV18','httpCache','mongoShapes','package','Module','requireFromString'])assert.equal(site[n],undefined,n);
});

test('iSite advanced aliases map to core when enabled',()=>{
  const site=aisite({compatibility:'isite'});
  assert.equal(site.scheduler,site.scheduler);
  assert.equal(typeof site.httpCache.etag,'function');
  assert.equal(typeof site.responseCache.stats,'function');
  assert.equal(typeof site.mongoShapes.report,'function');
  assert.equal(typeof site.inflight.run,'function');
});

test('iSite package and Module metadata work',()=>{
  const site=aisite({compatibility:'isite'});
  assert.equal(site.package.version,site.version);
  assert.strictEqual(site.Module,require('module'));
  assert.deepEqual(site.requireFromString('module.exports={ok:true}',path.join(process.cwd(),'inline-test.js')),{ok:true});
});
