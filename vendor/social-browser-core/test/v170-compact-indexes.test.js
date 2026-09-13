'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {StorageEngine}=require('../lib/storage-engine');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v170-'))}

test('compact unique index stores scalar positions',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),compactIndexes:true,lazySortedIndexes:true,persistIndexes:false});
 e.docs=Array.from({length:100},(_,i)=>({_id:String(i),email:'u'+i,score:i}));
 e.createIndex('email',{unique:true,lazy:false});
 const idx=e.indexes.get('email');
 assert.equal(typeof idx.buckets.get('s:u50'),'number');
 assert.equal(idx.sorted,null);
 assert.equal(e.query({where:{email:'u50'}})[0].score,50);
});

test('sorted range index materializes lazily',()=>{
 const e=new StorageEngine('x',{dir:tmp(),compactIndexes:true,lazySortedIndexes:true,persistIndexes:false});
 e.docs=Array.from({length:1000},(_,i)=>({_id:String(i),score:i}));
 e.createIndex('score',{lazy:false});
 assert.equal(e.indexes.get('score').sorted,null);
 const rows=e.query({where:{score:{$gte:100,$lte:110}}});
 assert.equal(rows.length,11);
 assert.ok(Array.isArray(e.indexes.get('score').sorted));
});

test('compact unique constraint remains enforced',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),compactIndexes:true,lazySortedIndexes:true,persistIndexes:false,durability:'wal'});
 await e.add({email:'a'});
 e.createIndex('email',{unique:true,lazy:false});
 await assert.rejects(()=>e.add({email:'a'}));
});

test('highScale preset enables compact and lazy indexes without persisted snapshots',()=>{
 const e=new StorageEngine('x',{dir:tmp(),highScale:true});
 assert.equal(e.compactIndexes,true);
 assert.equal(e.lazyIndexes,true);
 assert.equal(e.lazySortedIndexes,true);
 assert.equal(e.persistIndexes,false);
});
