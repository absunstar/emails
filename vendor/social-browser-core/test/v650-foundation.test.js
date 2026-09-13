'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const core=require('..');

function tmp(prefix='sb-foundation-'){return fs.mkdtempSync(path.join(os.tmpdir(),prefix))}
function get(port,url='/',headers={}){return new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:url,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))});r.on('error',reject)})}
async function listen(site){const server=site.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});site.servers.push(server);return server.address().port}

test('production file cache remembers negative stat results',()=>{
  const dir=tmp(),site=core({dir,fileCache:{prewarm:false}}),missing=path.join(dir,'never.txt');
  const before=site.fileCache.stats();
  assert.equal(site.isFileExistsSync(missing),false);
  const once=site.fileCache.stats();
  assert.equal(site.isFileExistsSync(missing),false);
  const twice=site.fileCache.stats();
  assert.equal(once.statMisses,before.statMisses+1);
  assert.ok(twice.statHits>=once.statHits+1);
  assert.equal(twice.missingEntries,1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('router precompiles dynamic ordering and caches safely',()=>{
  const site=core({fileCache:{prewarm:false}});
  site.get('/x/*',()=>1);site.get('/x/:id',()=>2);site.get('/x/fixed',()=>3);
  site.router.prepare();
  assert.equal(site.router.match('GET','/x/fixed').route.handler(),3);
  const a=site.router.match('GET','/x/Abc');assert.equal(a.params.id,'Abc');a.params.id='mutated';
  const b=site.router.match('GET','/x/Abc');assert.equal(b.params.id,'Abc');
  const st=site.router.stats();assert.ok(st.prepares>=1);assert.ok(st.cacheHits>=1);
});

test('native security uses indexed users, roles and compiled permission checks',()=>{
  const site=core({security:{roles:[{name:'editor',permissions:['posts.read','posts.write']}],users:[{id:7,email:'A@Example.com',roles:['editor']} ]},fileCache:{prewarm:false}});
  const u=site.security.findCachedUser({email:'a@example.com'});assert.equal(u.id,7);
  assert.equal(site.security.hasPermission(u,'posts.write'),true);
  assert.equal(site.security.hasPermission(u,'admin'),false);
  const check=site.security.compile({roles:['editor'],permissions:['posts.read']});
  assert.equal(check(u),true);assert.equal(site.security.compile({roles:['editor'],permissions:['posts.read']}),check);
  const st=site.security.stats();assert.ok(st.userIndexEntries>=2);assert.equal(st.roles,1);assert.ok(st.compiledRules>=1);
});

test('unchanged authenticated requests never persist session again',async()=>{
  const dir=tmp(),site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions')},fileCache:{prewarm:false}});
  const sid='stable';site.sessionStore.save(sid,{user:{id:1,name:'A'}});
  const baseline=site.sessionStore.stats().diskWrites;
  site.get('/me',(req,res)=>res.json({id:req.user?.id||req.session.user?.id}));
  const port=await listen(site);
  for(let i=0;i<8;i++){const r=await get(port,'/me',{Cookie:`${site.sessionStore.cookieName}=${sid}`});assert.equal(r.status,200)}
  assert.equal(site.sessionStore.stats().diskWrites,baseline);
  await site.stop({forceAfterMs:100});fs.rmSync(dir,{recursive:true,force:true});
});

test('dirty session persists once while write-behind is available as opt-in',async()=>{
  const dir=tmp(),site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions'),persistence:'write-behind',flushIntervalMs:10000},fileCache:{prewarm:false}});
  site.get('/set',(req,res)=>{req.session.value=1;res.end('ok')});
  const port=await listen(site),r=await get(port,'/set');assert.equal(r.status,200);
  assert.equal(site.sessionStore.stats().diskWrites,0);assert.equal(site.sessionStore.stats().dirty,1);
  assert.equal(site.sessionStore.flushSync(),1);assert.equal(site.sessionStore.stats().dirty,0);assert.equal(site.sessionStore.stats().diskWrites,1);
  await site.stop({forceAfterMs:100});fs.rmSync(dir,{recursive:true,force:true});
});

test('iSite words dictionary is indexed once in memory and request language aware',()=>{
  const dir=tmp(),jsonDir=path.join(dir,'site_files','json');fs.mkdirSync(jsonDir,{recursive:true});
  fs.writeFileSync(path.join(jsonDir,'words.json'),JSON.stringify([{name:'hello',En:'Hello',Ar:'مرحبا'}]));
  const site=core({cwd:dir,dir:path.join(dir,'site_files'),compatibility:'isite',fileCache:{prewarm:false},session:{dir:path.join(dir,'sessions')}});
  const warm=site.fileCache.stats();
  for(let i=0;i<1000;i++)assert.equal(site.word('hello','En'),'Hello');
  const after=site.fileCache.stats();assert.equal(after.loads,warm.loads);assert.equal(after.statMisses,warm.statMisses);
  const out=site.parser.html('##word.hello##',{req:{session:{language:{id:'Ar'}},data:{},features:[],word:name=>site.word(name,'Ar')}});
  assert.equal(out,'مرحبا');fs.rmSync(dir,{recursive:true,force:true});
});

test('production startup prewarms before server is exposed as ready',async()=>{
  const dir=tmp();fs.writeFileSync(path.join(dir,'index.html'),'<h1>x</h1>');
  const site=core({dir,port:0,host:'127.0.0.1',session:{enabled:false}});
  site.run(0);
  assert.ok(site.fileCache.stats().prewarmed>=1);
  await site.stop({forceAfterMs:100});fs.rmSync(dir,{recursive:true,force:true});
});

test('production browser cache defaults mirror mature long-lived asset caching',()=>{
  const site=core({fileCache:{prewarm:false}});
  assert.equal(site.staticCacheControl('/x/index.html'),'no-cache');
  assert.equal(site.staticCacheControl('/x/app.js'),'public, max-age=31104000');
  assert.equal(site.staticCacheControl('/x/style.css'),'public, max-age=31104000');
  assert.equal(site.staticCacheControl('/x/font.woff2'),'public, max-age=31104000');
});
