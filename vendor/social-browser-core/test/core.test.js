'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aisite = require('..');

test('native Core surface includes explicit onVERB route APIs without loading iSite', () => {
  const site = aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-'))});
  for (const name of ['get','post','run','start','connectCollection','readFile','writeFile','loadLocalApp','render','use']) {
    assert.equal(typeof site[name], 'function', name);
  }
  for (const name of ['onGET','onPOST','onPUT','onPATCH','onDELETE','onALL','onANY','onWS']) {
    assert.equal(typeof site[name], 'function', name);
  }
  assert.match(site.sessionStore.dir,/\.social-browser[\\/]sessions$/);
});

test('router handles params', async () => {
  const site = aisite();
  site.get('/u/:id', (req,res) => res.json({id:req.params.id}));
  const found = site.router.match('GET','/u/42');
  assert.equal(found.params.id,'42');
});

test('json collection supports CRUD', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(),'aisite-col-'));
  const site = aisite({cwd});
  const c = site.connectCollection('users');
  const a = await c.add({name:'A', age:20});
  assert.ok(a._id);
  assert.equal((await c.findMany({where:{age:{$gte:18}}})).length,1);
  await c.update({where:{_id:a._id}, set:{name:'B'}});
  assert.equal((await c.findOne({where:{_id:a._id}})).name,'B');
  await c.delete({where:{_id:a._id}});
  assert.equal(await c.count({}),0);
});

test('templates escape by default', () => {
  const site = aisite();
  assert.equal(site.renderString('{{x}}',{x:'<b>'}),'&lt;b&gt;');
  assert.equal(site.renderString('{{{x}}}',{x:'<b>'}),'<b>');
});

test('compat snapshot/assert works', () => {
  const site = aisite();
  const snap = site.compat.snapshot(site,['get','post','connectCollection']);
  assert.equal(site.compat.assert(snap,site),true);
});
