'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {StorageEngine}=require('../lib/storage-engine');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v180-'))}

test('highScale sorted index stores packed positions',()=>{
 const e=new StorageEngine('x',{dir:tmp(),highScale:true,persistIndexes:false});
 e.docs=Array.from({length:1000},(_,i)=>({_id:String(i),score:i}));
 e.createIndex('score');
 const rows=e.query({where:{score:{$gte:100,$lte:110}}});
 assert.equal(rows.length,11);
 const idx=e.indexes.get('score');
 assert.equal(idx.sortedPacked,true);
 assert.equal(typeof idx.sorted[0],'number');
 assert.ok(idx.sorted instanceof Uint32Array);
});

test('packed sorted pagination returns correct order',()=>{
 const e=new StorageEngine('x',{dir:tmp(),highScale:true,persistIndexes:false});
 e.docs=Array.from({length:100},(_,i)=>({_id:String(i),score:99-i}));
 e.createIndex('score');
 const page=e.queryPage({page:1,limit:5,sort:{score:1}});
 assert.deepEqual(page.list.map(x=>x.score),[0,1,2,3,4]);
});

test('packed sorted index invalidates on append and rebuilds lazily',async()=>{
 const e=new StorageEngine('x',{dir:tmp(),highScale:true,persistIndexes:false,durability:'wal'});
 await e.transaction(tx=>{for(let i=0;i<10;i++)tx.add({score:i})});
 e.createIndex('score');
 e.query({where:{score:{$gte:2,$lte:4}}});
 assert.ok(e.indexes.get('score').sorted);
 await e.add({score:20});
 assert.equal(e.indexes.get('score').sorted,null);
 const rows=e.query({where:{score:{$gte:19}}});
 assert.equal(rows.length,1);
});
