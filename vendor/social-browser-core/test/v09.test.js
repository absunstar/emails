'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v09-'))}

test('iSite compatibility is OFF by default',()=>{
  const site=aisite({cwd:tmp()});
  assert.equal(site.compatibility.isite,undefined);
  assert.equal(site.fsm,undefined);
  assert.equal(site.mongodb,undefined);
  assert.equal(site.onPROPFIND,undefined);
});

test('iSite compatibility can be enabled explicitly',()=>{
  const site=aisite({cwd:tmp()});
  site.useCompatibility('isite');
  assert.equal(site.compatibility.isite.enabled,true);
  assert.equal(typeof site.onPROPFIND,'function');
  assert.equal(typeof site.fsm.readFile,'function');
  assert.equal(typeof site.mongodb.findMany,'function');
});

test('iSite compatibility can be enabled from options',()=>{
  const site=aisite({cwd:tmp(),compatibility:'isite'});
  assert.equal(site.compatibility.isite.enabled,true);
  assert.equal(typeof site.onCOPY,'function');
});

test('iSite compatibility can be uninstalled',()=>{
  const site=aisite({cwd:tmp(),compatibility:'isite'});
  assert.equal(typeof site.onLOCK,'function');
  site.removeCompatibility('isite');
  assert.equal(site.onLOCK,undefined);
  assert.equal(site.compatibility.isite,undefined);
});

test('core filesystem API is independent from iSite fsm',async()=>{
  const cwd=tmp(),site=aisite({cwd});
  const f=path.join(cwd,'a.txt');
  site.files.writeSync(f,'x');
  assert.equal(site.files.readSync(f),'x');
  assert.equal(site.fsm,undefined);
});

test('compat collection aliases are installed only with compatibility',async()=>{
  const core=aisite({cwd:tmp()});
  const c1=core.connectCollection('a');
  assert.equal(typeof c1.ObjectID,'undefined');

  const legacy=aisite({cwd:tmp(),compatibility:'isite'});
  const c2=legacy.connectCollection('b');
  assert.equal(typeof c2.ObjectID,'function');
  await c2.insertOne({name:'A'});
  assert.equal((await c2.findOne({where:{name:'A'}})).name,'A');

  const freshCore=aisite({cwd:tmp()});
  const c3=freshCore.connectCollection('c');
  assert.equal(typeof c3.ObjectID,'undefined');
});

test('removing iSite compatibility removes collection instance aliases', async()=>{
  const site=aisite({cwd:tmp(),compatibility:'isite'});
  const c=site.connectCollection('x');
  assert.equal(typeof c.insertOne,'function');
  site.removeCompatibility('isite');
  assert.equal(typeof c.insertOne,'undefined');
  const next=site.connectCollection('y');
  assert.equal(typeof next.insertOne,'undefined');
});
