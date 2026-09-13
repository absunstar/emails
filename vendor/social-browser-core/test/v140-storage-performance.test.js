'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {StorageEngine}=require('../lib/storage-engine');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v140-'))}

test('binary range index returns exact bounds',()=>{
 const e=new StorageEngine('x',{dir:tmp(),compactEvery:100000});
 e.docs=Array.from({length:1000},(_,i)=>({_id:String(i),score:i}));
 e.createIndex('score');
 const out=e.query({where:{score:{$gte:100,$lte:110}}});
 assert.equal(out.length,11);
 assert.equal(out[0].score,100);assert.equal(out.at(-1).score,110);
 assert.equal(e.explain({score:{$gte:100,$lte:110}}).reason,'range-binary');
});

test('count uses index without cloning documents',()=>{
 const e=new StorageEngine('x',{dir:tmp()});
 e.docs=Array.from({length:100},(_,i)=>({_id:String(i),group:'g'+(i%2)}));
 e.createIndex('group');
 assert.equal(e.count({group:'g1'}),50);
});

test('wal durability survives restart before snapshot compaction',async()=>{
 const dir=tmp();
 let e=new StorageEngine('x',{dir,durability:'wal',walCompactEvery:1000});
 await e.add({name:'a'});
 await e.add({name:'b'});
 assert.equal(e.docs.length,2);
 assert.ok(fs.statSync(e.walFile).size>0);
 e=new StorageEngine('x',{dir,durability:'wal',walCompactEvery:1000});
 assert.equal(e.docs.length,2);
 assert.equal(e.query({where:{name:'b'}})[0].name,'b');
});

test('snapshot durability remains default',()=>{
 const e=new StorageEngine('x',{dir:tmp()});
 assert.equal(e.durability,'snapshot');
});


test('non-indexed update preserves index and uses journal path',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),durability:'wal',walCompactEvery:1000});
 await e.transaction(tx=>{for(let i=0;i<100;i++)tx.add({_id:String(i),email:'u'+i,flag:false})});
 e.createIndex('email',{unique:true});
 const before=e.explain({email:'u50'});
 await e.update({email:'u50'},{flag:true},false);
 const after=e.explain({email:'u50'});
 assert.equal(before.strategy,'index');assert.equal(after.strategy,'index');
 assert.equal(e.query({where:{email:'u50'}})[0].flag,true);
});

test('indexed update rebuilds index correctly',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),durability:'wal',walCompactEvery:1000});
 await e.transaction(tx=>{for(let i=0;i<20;i++)tx.add({_id:String(i),email:'u'+i})});
 e.createIndex('email',{unique:true});
 await e.update({email:'u10'},{email:'changed'},false);
 assert.equal(e.query({where:{email:'changed'}}).length,1);
 assert.equal(e.query({where:{email:'u10'}}).length,0);
});
