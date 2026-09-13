'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v2b2-'))}

test('paged numeric range index returns correct slice',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany(Array.from({length:1000},(_,i)=>({score:i})));
 c.engine.createRangeIndex('score');
 const rows=c.engine.queryRange('score',{$gte:100,$lte:110});
 assert.deepEqual(rows.map(x=>x.score),[100,101,102,103,104,105,106,107,108,109,110]);
});

test('paged compaction removes update/delete garbage and keeps ids stable',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{name:'a',v:1},{name:'b',v:2},{name:'c',v:3}]);
 await c.update({where:{id:1},set:{v:10}});
 await c.delete({where:{id:2}});
 assert.ok(c.engine.garbageBytes>0);
 const beforeId=(await c.findOne({where:{id:3}})).id;
 const r=c.engine.compactPaged();
 assert.equal(r.documents,2);
 assert.equal(c.engine.garbageBytes,0);
 assert.equal((await c.findOne({where:{id:1}})).v,10);
 assert.equal(await c.findOne({where:{id:2}}),null);
 assert.equal((await c.findOne({where:{id:3}})).id,beforeId);
});
