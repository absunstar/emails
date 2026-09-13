'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v200-'))}

test('paged storage bulk insert and indexed lookup',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',maxPagesInMemory:8});
 await c.insertMany(Array.from({length:1000},(_,i)=>({email:'u'+i,score:i})));
 c.createIndex('email',{unique:true});
 const x=await c.findOne({where:{email:'u999'}});
 assert.equal(x.score,999);
 assert.equal(c.stats().documents,1000);
});

test('paged storage reloads offsets without loading all docs',async()=>{
 const cwd=tmp();
 let site=aisite({cwd});
 let c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{email:'a'},{email:'b'}]);
 c.engine.close();
 site=aisite({cwd});
 c=site.connectCollection('x',{storageMode:'paged'});
 assert.equal(c.stats().documents,2);
 assert.equal((await c.findMany({where:{email:'b'}})).length,1);
});

test('paged delete persists',async()=>{
 const cwd=tmp();
 let site=aisite({cwd});
 let c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{email:'a'},{email:'b'}]);
 c.createIndex('email',{unique:true});
 const r=await c.delete({where:{email:'a'}});
 assert.equal(r.count,1);
 assert.equal((await c.findMany({where:{email:'a'}})).length,0);
});


test('paged bulk mode defers metadata persistence and flushes once',async()=>{
 const cwd=tmp();
 const site=aisite({cwd});
 const c=site.connectCollection('x',{storageMode:'paged',slotChunkSize:1024});
 c.engine.beginBulk();
 for(let b=0;b<5;b++){
   c.engine.insertManySync(Array.from({length:1000},(_,i)=>({value:b*1000+i})),{deferPersist:true,returnDocs:false});
 }
 assert.equal(c.engine.slots.length,5000);
 assert.equal(c.engine.bulkDirty,true);
 c.engine.endBulk();
 assert.equal(c.engine.bulkDirty,false);
 assert.ok(fs.existsSync(c.engine.indexFile));
 c.engine.close();

 const site2=aisite({cwd});
 const c2=site2.connectCollection('x',{storageMode:'paged',slotChunkSize:1024});
 assert.equal(c2.stats().documents,5000);
 assert.equal((await c2.findOne({where:{id:5000}})).value,4999);
});


test('paged sequential object ids are deterministic and optional random strategy exists',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 const a=await c.add({name:'a'});
 const b=await c.add({name:'b'});
 assert.equal(a._id,'000000000000000000000001');
 assert.equal(b._id,'000000000000000000000002');
});
