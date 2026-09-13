'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('http');
const core=require('..');

const req=(port,path,method='GET')=>new Promise((resolve,reject)=>{
  const r=http.request({host:'127.0.0.1',port,path,method},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});
  r.on('error',reject);r.end();
});

test('Express-style route chain and listen aliases are native', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  assert.equal(site.listen,site.run);
  assert.equal(site.start,site.run);
  site.route('/book')
    .get((q,r)=>r.send('get-book'))
    .post((q,r)=>r.status(201).send('post-book'))
    .head((q,r)=>r.status(204).end());
  assert.ok(site.router.match('GET','/book'));
  assert.ok(site.router.match('POST','/book'));
  assert.ok(site.router.match('HEAD','/book'));
});

test('Fastify/Hapi route object aliases normalize to one router',()=>{
  const site=core();
  const a=(q,r)=>r.send('a');
  const b=(q,r)=>r.send('b');
  site.route({method:'GET',url:'/fastify',handler:a});
  site.route({method:['POST','PUT'],path:'/hapi',handler:b});
  site.addRoute({method:'PATCH',url:'/added',handler:b});
  site.registerRoute({method:'DELETE',url:'/registered',handler:b});
  assert.equal(site.router.match('GET','/fastify').route.handler,a);
  assert.equal(site.router.match('POST','/hapi').route.handler,b);
  assert.equal(site.router.match('PUT','/hapi').route.handler,b);
  assert.equal(site.router.match('PATCH','/added').route.handler,b);
  assert.equal(site.router.match('DELETE','/registered').route.handler,b);
});

test('HEAD/OPTIONS route aliases preserve Core options config',()=>{
  const site=core();
  assert.equal(site.head,site.onHEAD);
  assert.equal(site.routeOptions,site.onOPTIONS);
  assert.equal(site.optionsRoute,site.onOPTIONS);
  assert.equal(typeof site.options,'object');
  site.onHEAD('/x',(q,r)=>r.end());
  site.onOPTIONS('/x',(q,r)=>r.end());
  assert.ok(site.router.match('HEAD','/x'));
  assert.ok(site.router.match('OPTIONS','/x'));
});

test('middleware and websocket aliases are direct aliases',()=>{
  const site=core();
  assert.equal(site.middleware,site.use);
  assert.equal(site.addMiddleware,site.use);
  assert.equal(site.websocket,site.onWS);
  const mw=(q,r,n)=>n();
  site.middleware(mw);
  assert.equal(site.middlewares[0],mw);
  const h=()=>{};site.websocket('/socket',h);
  assert.equal(site.wsRoutes[0].handler,h);
});

test('Fastify-style decorators are native and request/reply decorations apply',async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.decorate('utility',()=>42);
  site.decorateRequest('tenant','public');
  site.decorateReply('marker','reply');
  assert.equal(site.hasDecorator('utility'),true);
  assert.equal(site.hasRequestDecorator('tenant'),true);
  assert.equal(site.hasReplyDecorator('marker'),true);
  site.get('/decorated',(q,r)=>r.json({u:site.utility(),tenant:q.tenant,marker:r.marker}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const port=server.address().port;
  const out=await req(port,'/decorated');
  assert.equal(out.status,200);
  assert.deepEqual(JSON.parse(out.body),{u:42,tenant:'public',marker:'reply'});
  await new Promise(resolve=>server.close(resolve));
});
