'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v06-'));}

test('security helpers work',()=>{
  const site=aisite();
  const u={roles:['admin'],permissions:['users.read','users.write']};
  assert.equal(site.hasRole(u,'admin'),true);
  assert.equal(site.hasPermission(u,['users.read','users.write']),true);
  assert.equal(site.can(u,{roles:['admin'],permissions:['users.read']}),true);
});

test('template permission and role directives work',()=>{
  const site=aisite();
  const html=site.renderString('<x-role name="admin">A</x-role><x-permission name="x">X</x-permission>',{roles:['admin'],permissions:['x']});
  assert.equal(html,'AX');
});

test('app loader loads function modules',()=>{
  const cwd=tmp();
  fs.mkdirSync(path.join(cwd,'apps','hello'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'apps','hello','app.js'),"module.exports=(site)=>{site.helloLoaded=true}");
  const site=aisite({cwd});
  const mod=site.loadLocalApp('hello');
  assert.equal(typeof mod,'function');
  assert.equal(site.helloLoaded,true);
});

test('compat audit reports missing APIs',()=>{
  const site=aisite({cwd:tmp()});
  const r=site.compatAudit.auditObject(site,['get','post','doesNotExist']);
  assert.deepEqual(r.missing,['doesNotExist']);
  assert.equal(r.present.includes('get'),true);
});

test('request auth helpers are wired in handler source',()=>{
  const site=aisite();
  assert.equal(typeof site.requirePermission,'function');
  assert.equal(typeof site.can,'function');
});

test('reloadApp exists',()=>{
  const site=aisite({cwd:tmp()});
  assert.equal(typeof site.reloadApp,'function');
});

test('deleteDuplicate compatibility API works', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('dup');
  await c.insertMany([{email:'a'},{email:'a'},{email:'b'}]);
  const r=await c.deleteDuplicate('email');
  assert.equal(r.count,1);
  assert.equal(await c.count({}),2);
});
