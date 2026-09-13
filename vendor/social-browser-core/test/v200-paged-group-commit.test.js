'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v2b3-'))}

test('group commit batches updates and flush persists latest values',async()=>{
 const cwd=tmp();
 let site=aisite({cwd});
 let c=site.connectCollection('x',{storageMode:'paged',writeDurability:'group',groupCommitMs:1000});
 await c.insertMany([{v:1},{v:2}]);
 await c.update({where:{id:1},set:{v:10}});
 await c.update({where:{id:2},set:{v:20}});
 assert.equal(c.engine._groupDirty,true);
 c.engine.flush();
 assert.equal(c.engine._groupDirty,false);
 c.engine.close();
 site=aisite({cwd});
 c=site.connectCollection('x',{storageMode:'paged'});
 assert.equal((await c.findOne({where:{id:1}})).v,10);
 assert.equal((await c.findOne({where:{id:2}})).v,20);
});

test('transaction performs one durable commit for many operations',async()=>{
 const cwd=tmp();
 const site=aisite({cwd});
 const c=site.connectCollection('x',{storageMode:'paged',writeDurability:'sync'});
 await c.insertMany(Array.from({length:100},(_,i)=>({v:i})));
 await c.engine.transaction(Array.from({length:50},(_,i)=>({type:'update',where:{id:i+1},patch:{v:1000+i}})));
 assert.equal((await c.findOne({where:{id:50}})).v,1049);
});
