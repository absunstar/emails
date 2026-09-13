'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('core scheduler preserves jobs',async()=>{
  const site=aisite();
  site.scheduler.later('x',60_000,()=>{});
  assert.equal(site.scheduler.list().includes('x'),true);
  site.scheduler.cancel('x');
  assert.equal(site.scheduler.has('x'),false);
});

test('core hooks run in order',async()=>{
  const site=aisite();const seen=[];
  site.hooks.on('x',()=>seen.push(1));
  site.hooks.on('x',()=>seen.push(2));
  await site.hooks.run('x');
  assert.deepEqual(seen,[1,2]);
});

test('core response cache tracks hits',()=>{
  const site=aisite({responseCache:{max:2}});
  site.responseCache.set('a',{ok:true});
  assert.deepEqual(site.responseCache.get('a'),{ok:true});
  assert.equal(site.responseCache.stats().hits,1);
});

test('core inflight deduplicates same key',async()=>{
  const site=aisite();let n=0;
  const a=site.inflight.run('k',async()=>{n++;await new Promise(r=>setTimeout(r,5));return 7});
  const b=site.inflight.run('k',async()=>{n++;return 8});
  assert.equal(await a,7);assert.equal(await b,7);assert.equal(n,1);
});

test('core queryShapes groups structurally equal queries',()=>{
  const site=aisite();
  site.queryShapes.observe({where:{age:20}});
  site.queryShapes.observe({where:{age:30}});
  assert.equal(site.queryShapes.report()[0].count,2);
});
