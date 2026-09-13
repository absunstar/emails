'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-adaptive-'))}

test('adaptive planner selects direct slot for dense id',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{v:1},{v:2}]);
 const p=c.engine.explainAdaptive('read',{id:2});
 assert.equal(p.strategy,'direct-slot');
});

test('adaptive planner selects hash and range indexes',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany(Array.from({length:100},(_,i)=>({email:'u'+i,score:i})));
 c.createIndex('email',{unique:true});
 c.engine.createRangeIndex('score');
 assert.equal(c.engine.explainAdaptive('read',{email:'u1'}).strategy,'hash-index');
 assert.equal(c.engine.explainAdaptive('read',{score:{$gte:10}}).strategy,'disk-range-index');
});

test('large collections choose group commit adaptively',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 c.engine.countLive=3_000_000;
 const p=c.engine.explainAdaptive('write',{});
 assert.equal(p.strategy,'group-commit');
 assert.equal(p.durability,'group');
});

test('adaptive storage can be disabled',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',adaptiveStorage:false,writeDurability:'sync'});
 assert.equal(c.engine.adaptiveStorage,false);
 assert.equal(c.engine.writeDurability,'sync');
});


test('large adaptive update uses group commit automatically',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',adaptiveStorage:true,writeDurability:'sync',groupCommitMs:1000});
 await c.insertMany([{v:1}]);
 c.engine.countLive=3_000_000;
 await c.update({where:{id:1},set:{v:2}});
 assert.equal(c.engine._groupDirty,true);
 c.engine.flush();
 assert.equal((await c.findOne({where:{id:1}})).v,2);
});

test('large adaptive delete uses group commit automatically',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',adaptiveStorage:true,writeDurability:'sync',groupCommitMs:1000});
 await c.insertMany([{v:1},{v:2}]);
 c.engine.countLive=3_000_000;
 c.engine.delete({id:1},false);
 assert.equal(c.engine._groupDirty,true);
 c.engine.flush();
 assert.equal(await c.findOne({where:{id:1}}),null);
});
