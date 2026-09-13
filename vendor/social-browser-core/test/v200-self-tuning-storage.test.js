'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-selftune-'))}

test('planner records latency and reports best observed strategy',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 for(let i=0;i<60;i++)c.engine.adaptivePlanner.recordLatency('read','direct-slot',0.1);
 for(let i=0;i<60;i++)c.engine.adaptivePlanner.recordLatency('read','paged-scan',5);
 assert.equal(c.engine.adaptivePlanner.bestObserved('read').strategy,'direct-slot');
});

test('frequent equality queries recommend hash index',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',adaptiveStorage:{minSamples:10}});
 for(let i=0;i<20;i++)c.engine.adaptivePlanner.observeQueryFields({email:'x'+i});
 const r=c.engine.adaptiveIndexRecommendations();
 assert.equal(r[0].type,'hash');assert.equal(r[0].field,'email');
});

test('frequent range queries recommend disk range index',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged',adaptiveStorage:{minSamples:10}});
 for(let i=0;i<20;i++)c.engine.adaptivePlanner.observeQueryFields({score:{$gte:i}});
 const r=c.engine.adaptiveIndexRecommendations();
 assert.equal(r[0].type,'range');assert.equal(r[0].field,'score');
});

test('adaptive status exposes planner and recommendations',()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 const s=c.engine.adaptiveStatus();
 assert.ok(s.planner);assert.ok(Array.isArray(s.recommendations));
});
