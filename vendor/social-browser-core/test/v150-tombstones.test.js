'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {StorageEngine}=require('../lib/storage-engine');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v150-'))}

test('delete uses tombstone and keeps index positions stable',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),durability:'wal',walCompactEvery:1000,tombstoneCompactRatio:0.9});
 await e.transaction(tx=>{for(let i=0;i<100;i++)tx.add({email:'u'+i,score:i})});
 e.createIndex('email',{unique:true});
 const before=e.indexes.get('email').sorted.find(x=>x.values[0]==='u99').pos;
 await e.delete({email:'u50'},false);
 const after=e.indexes.get('email').sorted.find(x=>x.values[0]==='u99').pos;
 assert.equal(before,after);
 assert.equal(e.query({where:{email:'u50'}}).length,0);
 assert.equal(e.count({}),99);
 assert.equal(e.tombstones,1);
});

test('tombstone compaction physically removes deleted slots',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),durability:'wal',tombstoneCompactRatio:0.9});
 await e.transaction(tx=>{for(let i=0;i<10;i++)tx.add({email:'u'+i})});
 await e.delete({email:'u2'},false);
 assert.equal(e.docs.length,10);
 const r=e.compactTombstones(true);
 assert.equal(r.compacted,true);
 assert.equal(e.docs.length,9);
 assert.equal(e.tombstones,0);
});

test('tombstones survive wal recovery as deleted records',async()=>{
 const dir=tmp();
 let e=new StorageEngine('x',{dir,durability:'wal',walCompactEvery:1000,tombstoneCompactRatio:0.9});
 await e.add({email:'a'});
 await e.add({email:'b'});
 await e.delete({email:'a'},false);
 e=new StorageEngine('x',{dir,durability:'wal',walCompactEvery:1000,tombstoneCompactRatio:0.9});
 assert.equal(e.query({where:{email:'a'}}).length,0);
 assert.equal(e.query({where:{email:'b'}}).length,1);
});
