'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('generic core capabilities remain available without iSite aliases',async()=>{
 const site=aisite();
 assert.equal(typeof site.features.set,'function');
 assert.equal(typeof site.streamTools.ndjson,'function');
 assert.equal(typeof site.queryCache.cached,'function');
 assert.equal(typeof site.queryPlan.compile,'function');
 assert.equal(typeof site.eventBus.emit,'function');
 assert.equal(site.sessions,undefined);
});

test('iSite v14 namespace batch maps to Core',async()=>{
 const site=aisite({compatibility:'isite'});
 for(const [ns,fns] of Object.entries({
   stream:['ndjson','jsonLines','jsonArray'],
   featuresV3:['clear','disable','enable','get','isEnabled','list','set'],
   query:['cached','generation','invalidate','invalidateAll','key','stats'],
   queryPlan:['clear','compile','instantiate','key','stats'],
   sessions:['attach','handleSessions','indexSession']
 })){
   assert.ok(site[ns],ns);
   for(const fn of fns)assert.equal(typeof site[ns][fn],'function',`${ns}.${fn}`);
 }
 assert.strictEqual(site.stream.jsonLines,site.stream.ndjson);
});
