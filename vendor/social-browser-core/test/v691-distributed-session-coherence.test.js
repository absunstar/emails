'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');
const {MemoryCache}=require('../lib/distributed');

function request(port,cookie){
  return new Promise((resolve,reject)=>{
    const q=http.get({host:'127.0.0.1',port,path:'/me',headers:{Cookie:cookie}},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));
    });q.on('error',reject);
  });
}
async function listen(site){
  site.get('/me',(req,res)=>res.json({name:req.user?.name||null,dirty:req._sessionState?.dirty||false}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);return server.address().port;
}
function distributedSite(shared){
  const site=core({fileCache:{prewarm:false},session:{enabled:true},memoryPressure:{enabled:false},jobs:{autoStart:false}});
  site.setDistributedCache(shared);
  site.useDistributedSessions(null,{userInvalidationCheckIntervalMs:0});
  return site;
}

test('distributed invalidation epoch propagates across site instances without scanning sessions',async()=>{
  const shared=new MemoryCache();
  const a=distributedSite(shared),b=distributedSite(shared);
  let loads=0;
  b.identity.register('test',{load:async id=>{loads++;return{id,name:'FRESH'}}});
  await a.sessionStore.save('sid',{user_id:'u1',user:{id:'u1',name:'OLD'},identityRef:{provider:'test',id:'u1'}});
  const port=await listen(b);

  const first=await request(port,`${b.sessionStore.cookieName}=sid`);
  assert.equal(first.name,'OLD');
  assert.equal(loads,0);

  await a.invalidateUserSessions('u1');
  const second=await request(port,`${b.sessionStore.cookieName}=sid`);
  assert.equal(second.name,'FRESH');
  assert.equal(loads,1);

  const third=await request(port,`${b.sessionStore.cookieName}=sid`);
  assert.equal(third.name,'FRESH');
  assert.equal(loads,1);

  await a.stop({forceAfterMs:100});await b.stop({forceAfterMs:100});
});

test('distributed invalidation marker survives a new Core instance and refreshed session remains hot',async()=>{
  const shared=new MemoryCache();
  const a=distributedSite(shared);
  await a.sessionStore.save('sid',{user_id:'u2',user:{id:'u2',name:'OLD'},identityRef:{provider:'test',id:'u2'}});
  await a.invalidateUserSessions('u2');

  const b=distributedSite(shared);
  let loads=0;b.identity.register('test',{load:async id=>{loads++;return{id,name:'NEW'}}});
  const p1=await listen(b);
  assert.equal((await request(p1,`${b.sessionStore.cookieName}=sid`)).name,'NEW');
  assert.equal(loads,1);
  await b.stop({forceAfterMs:100});

  const c=distributedSite(shared);
  let reloads=0;c.identity.register('test',{load:async id=>{reloads++;return{id,name:'BAD'}}});
  const p2=await listen(c);
  assert.equal((await request(p2,`${c.sessionStore.cookieName}=sid`)).name,'NEW');
  assert.equal(reloads,0);

  await a.stop({forceAfterMs:100});await c.stop({forceAfterMs:100});
});

test('distributed invalidation lookup cache removes per-request extra backend reads within its window',async()=>{
  const shared=new MemoryCache();
  const site=core({fileCache:{prewarm:false},memoryPressure:{enabled:false},jobs:{autoStart:false}});
  site.setDistributedCache(shared);
  site.useDistributedSessions(null,{userInvalidationCheckIntervalMs:60000});
  await site.sessionStore.save('sid',{user_id:'u3',user:{id:'u3',name:'CACHED'},identityRef:{provider:'test',id:'u3'}});
  let markerLoads=0;
  const original=site.sessionStore.backend.load.bind(site.sessionStore.backend);
  site.sessionStore.backend.load=async id=>{if(String(id).includes('__sb_user_invalidation__'))markerLoads++;return original(id)};
  const port=await listen(site);
  for(let i=0;i<5;i++)assert.equal((await request(port,`${site.sessionStore.cookieName}=sid`)).name,'CACHED');
  assert.equal(markerLoads,1);
  assert.ok(site.sessionStore.stats().invalidationCacheHits>=4);
  await site.stop({forceAfterMs:100});
});


test('distributed commit and $save mark the async session clean and avoid duplicate writes',async()=>{
  const shared=new MemoryCache();
  const site=distributedSite(shared);
  let saves=0;
  const original=site.sessionStore.backend.save.bind(site.sessionStore.backend);
  site.sessionStore.backend.save=async(...args)=>{saves++;return original(...args)};
  site.get('/set',async(req,res)=>{
    req.session.foo='bar';
    await req.session.$save();
    const afterSave=req._sessionState.dirty;
    await site.sessionStore.commitAsync(req);
    res.json({afterSave,afterCommit:req._sessionState.dirty});
  });
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  const row=await new Promise((resolve,reject)=>{
    const q=http.get({host:'127.0.0.1',port,path:'/set'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve(JSON.parse(b)))});q.on('error',reject);
  });
  assert.equal(row.afterSave,false);
  assert.equal(row.afterCommit,false);
  assert.equal(saves,1);
  await site.stop({forceAfterMs:100});
});
