'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {performance}=require('node:perf_hooks');
const core=require('..');
const {ResponseCache}=require('../lib/response-cache');
const {CompressionCache}=require('../lib/compression-cache');
const {SessionStore}=require('../lib/session');
const {Router}=require('../lib/router');
const {createSecurity}=require('../lib/security');
const template=require('../lib/template');

test('response cache supports tags, dependencies, byte limits and inflight de-duplication',async()=>{
  const cache=new ResponseCache({max:10,maxBytes:1024*1024});
  cache.set('a','hello',{tags:['public'],dependencies:['/a.html']});
  assert.equal(cache.get('a'),'hello');
  assert.equal(cache.invalidateTag('public'),1);
  assert.equal(cache.get('a'),null);

  cache.set('b','world',{dependencies:['/b.html']});
  assert.equal(cache.invalidateDependency('/b.html'),1);
  assert.equal(cache.get('b'),null);

  let calls=0;
  const producer=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return 'shared'};
  const rows=await Promise.all(Array.from({length:20},()=>cache.getOrSet('same',producer,{ttlMs:1000})));
  assert.equal(calls,1);
  assert.equal(new Set(rows).size,1);
  assert.ok(cache.stats().inflightHits>=19);
});

test('dynamic compression cache returns identical buffers and records cache hits',async()=>{
  const cache=new CompressionCache({maxEntries:10,maxBytes:1024*1024});
  const source=Buffer.from('hello world '.repeat(1000));
  const a=await cache.compress(source,'gzip');
  const b=await cache.compress(source,'gzip');
  assert.deepEqual(a,b);
  assert.ok(a.length<source.length);
  assert.ok(cache.stats().hits>=1);
});

test('file cache stores precompressed variants and invalidates them on file change',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-compress-file-'));
  const file=path.join(dir,'app.js');
  fs.writeFileSync(file,'const a=1;'.repeat(1000));
  const site=core({cwd:dir,dir,fileCache:{prewarm:false},session:{enabled:false}});
  const a=site.fileCache.getCompressedSync(file,'br');
  const b=site.fileCache.getCompressedSync(file,'br');
  assert.deepEqual(a,b);
  assert.ok(site.fileCache.stats().compressedHits>=1);
  fs.writeFileSync(file,'const a=2;'.repeat(1000));
  site.invalidateFileCache(file);
  const c=site.fileCache.getCompressedSync(file,'br');
  assert.notDeepEqual(a,c);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('native template uses reusable interpolation plans without changing escaping semantics',()=>{
  template.clearTemplatePlans();
  const src='<b>{{name}}</b><i>{{{html}}}</i>';
  assert.equal(template.renderString(src,{name:'<x>',html:'<em>ok</em>'}),'<b>&lt;x&gt;</b><i><em>ok</em></i>');
  for(let i=0;i<100;i++)template.renderString(src,{name:'A',html:'B'});
  assert.ok(template.templateStats().interpolationPlans>=1);
});

test('iSite token execution plan preserves recursive token expansion',()=>{
  const site=core({compatibility:'isite',session:{enabled:false},fileCache:{prewarm:false}});
  site.word=name=>name==='first'?'##word.second##':name==='second'?'DONE':name;
  const req={session:{language:{id:'En'}},data:{},features:[],word:name=>site.word(name)};
  const out=site.parser.html('A ##word.first## Z',{req});
  assert.equal(out,'A DONE Z');
  assert.ok(site.parser.stats().tokenPlans>=1);
});

test('static assets use cached Brotli when accepted',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-static-br-'));
  fs.writeFileSync(path.join(dir,'app.js'),'console.log("x");'.repeat(2000));
  const site=core({cwd:dir,dir,session:{enabled:false},fileCache:{prewarm:false}});
  site.static('/',dir,{cacheControl:'public, max-age=31536000'});
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  const get=()=>new Promise((resolve,reject)=>{
    const q=http.get({host:'127.0.0.1',port,path:'/app.js',headers:{'Accept-Encoding':'br'}},res=>{
      const rows=[];res.on('data',x=>rows.push(x));res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(rows)}));
    });q.on('error',reject);
  });
  const a=await get(),b=await get();
  assert.equal(a.headers['content-encoding'],'br');
  assert.equal(b.headers['content-encoding'],'br');
  assert.deepEqual(a.body,b.body);
  assert.ok(site.fileCache.stats().compressedHits>=1);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('session RAM index scales and unchanged sessions do not write',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-scale-'));
  const store=new SessionStore({dir,persistence:'memory'});
  const started=performance.now();
  for(let i=0;i<10000;i++)store.save('s'+i,{user_id:i%1000,user:{id:i%1000},n:i});
  const buildMs=performance.now()-started;
  assert.equal(store.memory.size,10000);
  assert.equal(store.byUserId.size,1000);
  assert.equal(store.invalidateUser(42),10);
  assert.equal(store.stats().diskWrites,0);
  assert.ok(buildMs<5000);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('security indexed lookup and compiled permission checks scale',()=>{
  const security=createSecurity();
  security.addRole('editor',{permissions:['read','write']});
  for(let i=0;i<10000;i++)security.addUser({id:i,email:`u${i}@x.test`,roles:i%2?['editor']:[],permissions:i%2?[]:['read']});
  const check=security.compile({permissions:['read']});
  const started=performance.now();
  let ok=0;
  for(let i=0;i<100000;i++){
    const u=security.findCachedUser({id:i%10000});
    if(check(u))ok++;
  }
  const elapsed=performance.now()-started;
  assert.equal(ok,100000);
  assert.ok(elapsed<5000);
  assert.equal(security.stats().users,10000);
});

test('router exact index handles large route sets without linear scanning',()=>{
  const router=new Router();
  for(let i=0;i<20000;i++)router.add('GET',`/r/${i}`,()=>i);
  router.prepare();
  const started=performance.now();let hits=0;
  for(let i=0;i<200000;i++)if(router.match('GET',`/r/${i%20000}`))hits++;
  const elapsed=performance.now()-started;
  assert.equal(hits,200000);
  assert.ok(elapsed<5000);
  assert.ok(router.stats().exactHits>0);
});


test('session RAM is bounded for durable persistence and expired entries are cleaned',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-bound-'));
  const store=new SessionStore({dir,persistence:'sync',maxMemorySessions:100,cleanupIntervalMs:600000,timeout:60});
  for(let i=0;i<250;i++)store.save('s'+i,{user_id:i,user:{id:i}});
  assert.ok(store.memory.size<=100);
  assert.ok(store.stats().memoryEvictions>=150);

  store.memory.set('expired',{user_id:999,user:{id:999},expiresAt:Date.now()-1});
  store._index('expired',store.memory.get('expired'));
  assert.equal(store.cleanupExpired(),1);
  assert.equal(store.memory.has('expired'),false);
  store.close();
  fs.rmSync(dir,{recursive:true,force:true});
});


test('dynamic route trie preserves specificity and parameter extraction at scale',()=>{
  const router=new Router({cacheMax:128});
  router.add('GET','/api/:tenant/users/:id',()=>1);
  router.add('GET','/api/admin/users/:id',()=>2);
  for(let i=0;i<5000;i++)router.add('GET',`/api/:tenant/resource${i}/:id`,()=>i);
  router.prepare();

  const admin=router.match('GET','/api/admin/users/42');
  assert.equal(admin.route.pattern,'/api/admin/users/:id');
  assert.equal(admin.params.id,'42');

  const dynamic=router.match('GET','/api/acme/resource4999/ABC');
  assert.equal(dynamic.route.pattern,'/api/:tenant/resource4999/:id');
  assert.equal(dynamic.params.tenant,'acme');
  assert.equal(dynamic.params.id,'ABC');
  assert.ok(router.stats().trieHits>=2);
});
