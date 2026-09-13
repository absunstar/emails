'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const cp=require('child_process');
const aisite=require('..');
const { StorageEngine }=require('../lib/storage-engine');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v04-'));}

test('compound index is used', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('users');
  c.createCompoundIndex(['country','email'],{unique:true});
  await c.insertMany([
    {country:'EG',email:'a@x'},
    {country:'EG',email:'b@x'},
    {country:'US',email:'a@x'}
  ]);
  const plan=c.explain({where:{country:'EG',email:'b@x'}});
  assert.equal(plan.strategy,'index');
  assert.deepEqual(plan.index,['country','email']);
});

test('range index is used', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('nums');
  c.createIndex('n');
  await c.insertMany(Array.from({length:100},(_,i)=>({n:i})));
  const plan=c.explain({where:{n:{$gte:20,$lt:30}}});
  assert.equal(plan.strategy,'index');
  const rows=await c.findMany({where:{n:{$gte:20,$lt:30}},sort:{n:1}});
  assert.equal(rows.length,10);
  assert.equal(rows[0].n,20);
});

test('fast page returns metadata', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('rows');
  await c.insertMany(Array.from({length:53},(_,i)=>({n:i})));
  const p=await c.findPageFast({page:3,limit:10,sort:{n:1}});
  assert.equal(p.total,53);
  assert.equal(p.pages,6);
  assert.equal(p.list[0].n,20);
});

test('incremental wal crash recovery replays committed ops', ()=>{
  const dir=tmp();
  const r=cp.spawnSync(process.execPath,[path.join(__dirname,'crash-writer.js'),dir],{encoding:'utf8'});
  assert.equal(r.status,0);
  const e=new StorageEngine('crash',{dir});
  assert.equal(e.docs.length,1);
  assert.equal(e.docs[0].name,'recovered');
});

test('uncommitted wal is ignored', ()=>{
  const dir=tmp();
  const wal=path.join(dir,'x.wal');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(wal,
    JSON.stringify({type:'begin',txid:'t1'})+'\n'+
    JSON.stringify({type:'op',txid:'t1',op:{type:'add',doc:{_id:'x',id:1}}})+'\n'
  );
  const e=new StorageEngine('x',{dir});
  assert.equal(e.docs.length,0);
});

test('compaction clears wal', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('c');
  await c.add({x:1});
  const out=c.compact();
  assert.equal(out.done,true);
  assert.equal(c.stats().walBytes,0);
});

test('concurrent writes serialize safely', async()=>{
  const site=aisite({cwd:tmp()});
  const c=site.connectCollection('concurrent');
  await Promise.all(Array.from({length:50},(_,i)=>c.add({i})));
  assert.equal(await c.count({}),50);
});
