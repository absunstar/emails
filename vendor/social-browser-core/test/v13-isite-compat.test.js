'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('iSite compatibility report surface is complete for tracked batch',()=>{
 const site=aisite({compatibility:'isite'});
 const names=['onPROPFIND','fsm','mongodb','words','stringfiy','from123','to123','requestTelemetry','responseCache','mongoShapes','httpCache','coreV3','coreV18','package','Module','requireFromString'];
 for(const n of names) assert.ok(n in site,n);
});

test('tracked iSite collection aliases are available only in compat mode',()=>{
 const core=aisite();
 assert.equal(typeof core.connectCollection('x').ObjectID,'undefined');
 const legacy=aisite({compatibility:'isite'});
 assert.equal(typeof legacy.connectCollection('x').ObjectID,'function');
});
