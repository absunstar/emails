'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {StorageEngine}=require('../lib/storage-engine');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v160-'))}

test('persistent index snapshot reloads correctly',async()=>{
 const dir=tmp();
 let e=new StorageEngine('x',{dir,durability:'wal',persistIndexes:true,lazyIndexes:false});
 await e.transaction(tx=>{for(let i=0;i<1000;i++)tx.add({email:'u'+i,score:i})});
 e.createIndex('email',{unique:true,lazy:false});
 e.createIndex('score',{lazy:false});
 e.compact();
 assert.ok(fs.existsSync(e.indexSnapshotFile));
 e=new StorageEngine('x',{dir,durability:'wal',persistIndexes:true,lazyIndexes:true,indexes:[
   {field:'email',unique:true},{field:'score'}
 ]});
 assert.equal(e.query({where:{email:'u999'}})[0].score,999);
 assert.equal(e.explain({email:'u999'}).strategy,'index');
});

test('lazy index defers build until first indexed query',async()=>{
 const dir=tmp();
 let e=new StorageEngine('x',{dir,persistIndexes:false,lazyIndexes:true});
 e.docs=Array.from({length:100},(_,i)=>({email:'u'+i}));
 e.createIndex('email');
 assert.equal(e.indexes.size,0);
 assert.equal(e.query({where:{email:'u10'}}).length,1);
 assert.equal(e.indexes.size,1);
});

test('snapshot invalidates after write',async()=>{
 const dir=tmp();
 const e=new StorageEngine('x',{dir,durability:'snapshot',persistIndexes:true,lazyIndexes:false});
 await e.add({email:'a'});
 e.createIndex('email',{lazy:false});
 e.compact();
 assert.ok(fs.existsSync(e.indexSnapshotFile));
 await e.add({email:'b'});
 assert.equal(fs.existsSync(e.indexSnapshotFile),false);
});
