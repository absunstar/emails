'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aisite = require('..');

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v03-')); }

test('indexed query uses index', async () => {
  const site = aisite({cwd:tmp()});
  const c = site.connectCollection('users');
  c.createIndex('email',{unique:true});
  await c.insertMany([
    {email:'a@example.com',name:'A'},
    {email:'b@example.com',name:'B'},
    {email:'c@example.com',name:'C'}
  ]);
  const plan = c.explain({where:{email:'b@example.com'}});
  assert.equal(plan.strategy,'index');
  assert.equal(plan.index,'email');
  assert.equal((await c.findOne({where:{email:'b@example.com'}})).name,'B');
});

test('unique index prevents duplicate values', async () => {
  const site = aisite({cwd:tmp()});
  const c = site.connectCollection('users');
  c.createIndex('email',{unique:true});
  await c.add({email:'a@example.com'});
  await assert.rejects(()=>c.add({email:'a@example.com'}));
  assert.equal(await c.count({}),1);
});

test('transaction rollback is atomic', async () => {
  const site = aisite({cwd:tmp()});
  const c = site.connectCollection('items');
  await c.add({name:'before'});
  await assert.rejects(()=>c.transaction(async tx=>{
    tx.add({name:'x'});
    throw new Error('fail');
  }));
  const all = await c.findMany({});
  assert.deepEqual(all.map(x=>x.name),['before']);
});

test('transaction batch commits', async () => {
  const site = aisite({cwd:tmp()});
  const c = site.connectCollection('items');
  await c.transaction([
    {type:'add',doc:{name:'a'}},
    {type:'add',doc:{name:'b'}}
  ]);
  assert.equal(await c.count({}),2);
});

test('backup and restore work', async () => {
  const cwd=tmp();
  const site=aisite({cwd});
  const c=site.connectCollection('users');
  await c.add({name:'A'});
  const b=c.backup('test');
  await c.deleteMany({where:{}});
  assert.equal(await c.count({}),0);
  c.restore(b.file);
  assert.equal(await c.count({}),1);
});

test('streamFast yields all rows', async () => {
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('rows');
  await c.insertMany(Array.from({length:25},(_,i)=>({n:i})));
  const seen=[];
  for await (const row of c.streamFast({batchSize:7,sort:{n:1}})) seen.push(row.n);
  assert.equal(seen.length,25);
  assert.equal(seen[24],24);
});

test('storage stats available', async () => {
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('stats');
  await c.add({x:1});
  const s=c.stats();
  assert.equal(s.documents,1);
  assert.equal(s.name,'stats');
});
