'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v05-'));}

test('schema validation blocks invalid writes', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('users',{
    schema:{required:['email'],properties:{email:{type:'string'},age:{type:'integer',minimum:0}}}
  });
  await c.add({email:'a@x',age:20});
  await assert.rejects(()=>c.add({age:-1}),e=>e.code==='SCHEMA_VALIDATION_FAILED');
  assert.equal(await c.count({}),1);
});

test('ttl index purges expired rows', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('sessions');
  c.createTTLIndex('expiresAt');
  await c.insertMany([{expiresAt:Date.now()-1},{expiresAt:Date.now()+999999}]);
  const r=c.purgeExpired();
  assert.equal(r.count,1);
  assert.equal(await c.count({}),1);
});

test('text index finds matching docs', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('articles');
  await c.insertMany([
    {title:'Social Browser automation',body:'AI and MCP tools'},
    {title:'Other article',body:'nothing relevant'}
  ]);
  c.createTextIndex(['title','body']);
  const rows=c.searchText('browser ai');
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,'Social Browser automation');
});

test('integrity check and repair duplicate ids', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('x');
  await c.add({_id:'same',x:1});
  c.engine.docs.push({_id:'same',x:2});
  let r=c.integrityCheck();
  assert.equal(r.ok,false);
  c.repair();
  r=c.integrityCheck();
  assert.equal(r.ok,true);
});

test('checksum changes after write', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('x');
  const a=c.checksum();
  await c.add({x:1});
  const b=c.checksum();
  assert.notEqual(a,b);
});

test('migrations transform stored docs', async()=>{
  const cwd=tmp();
  let site=aisite({cwd});
  let c=site.connectCollection('m');
  await c.add({name:'A'});
  site=aisite({cwd});
  c=site.connectCollection('m',{
    schemaVersion:2,
    migrations:[{version:2,up:(docs)=>docs.map(d=>({...d,migrated:true}))}]
  });
  assert.equal((await c.findOne({})).migrated,true);
});

test('diagnostics surface exists', async()=>{
  const site=aisite({cwd:tmp()});
  site.connectCollection('x');
  const d=site.diagnostics.snapshot();
  assert.equal(d.version,site.version);
  assert.ok(d.metrics);
  assert.equal(Array.isArray(d.collections),true);
});
