'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');

test('register() supports async plugins and dependency ordering', async()=>{
  const site=core({port:0});
  const order=[];
  site.register({name:'db',async setup(app,opts){await Promise.resolve();order.push('db');app.decorate('dbReady',opts.value);return {ok:true}}},{value:7});
  site.register({name:'api',dependencies:['db'],setup(app){order.push('api');assert.equal(app.dbReady,7)}});
  const returned=await site.ready();
  assert.equal(returned,site);
  assert.deepEqual(order,['db','api']);
  assert.equal(site.plugins.get('db').state,'enabled');
});

test('register() supports Fastify callback plugin shape', async()=>{
  const site=core({port:0});
  site.register(function legacy(app,opts,done){setImmediate(()=>{app.decorate('callbackValue',opts.value);done()})},{value:42});
  await site.ready();
  assert.equal(site.callbackValue,42);
});

test('register() supports Hapi-like plugin wrapper', async()=>{
  const site=core({port:0});
  site.register({plugin:{name:'wrapped',register(app,opts){app.decorate('wrappedValue',opts.value)}},options:{value:'yes'}});
  await site.ready();
  assert.equal(site.wrappedValue,'yes');
});

test('plugin dependency failures are explicit', async()=>{
  const site=core({port:0});
  site.register({name:'api',dependencies:['missing'],setup(){}});
  await assert.rejects(site.ready(),e=>e.code==='PLUGIN_DEPENDENCY_MISSING');
});

test('plugin dependency cycles are detected', async()=>{
  const site=core({port:0});
  site.register({name:'a',dependencies:['b'],setup(){}});
  site.register({name:'b',dependencies:['a'],setup(){}});
  await assert.rejects(site.ready(),e=>e.code==='PLUGIN_DEPENDENCY_CYCLE');
});

test('plugin teardown runs in reverse activation order', async()=>{
  const site=core({port:0});
  const out=[];
  site.register({name:'a',setup(){out.push('a+')},teardown(){out.push('a-')}});
  site.register({name:'b',dependencies:['a'],setup(){out.push('b+')},teardown(){out.push('b-')}});
  await site.ready();
  await site.plugins.disableAll();
  assert.deepEqual(out,['a+','b+','b-','a-']);
});
