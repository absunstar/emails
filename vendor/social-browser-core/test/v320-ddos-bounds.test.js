'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SlidingWindowLimiter}=require('../lib/security-shield');

test('rate limiter bounds attacker-controlled key cardinality',()=>{
 const l=new SlidingWindowLimiter({limit:10,windowMs:60000,maxKeys:1000});
 for(let i=0;i<10000;i++)l.hit('ip-'+i);
 assert.ok(l.map.size<=1000);
});

test('stale rate-limit buckets are cleaned',()=>{
 const l=new SlidingWindowLimiter({limit:10,windowMs:1000,maxKeys:1000});
 for(let i=0;i<500;i++)l.hit('old-'+i,0);
 l.cleanup(10000);
 assert.equal(l.map.size,0);
});
