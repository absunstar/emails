'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const core=require('..');

function get(port,cookie){
  return new Promise((resolve,reject)=>{
    const q=http.get({host:'127.0.0.1',port,path:'/me',headers:cookie?{Cookie:cookie}:{}},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });q.on('error',reject);
  });
}
async function start(site){
  site.get('/me',(req,res)=>res.json({name:req.user?.name||null,dirty:req._sessionState?.dirty||false}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);return server.address().port;
}

test('user invalidation epoch reaches disk-only sessions without directory scans',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-user-epoch-'));
  const sessionDir=path.join(dir,'sessions');
  const a=core({cwd:dir,session:{dir:sessionDir},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  a.sessionStore.save('s1',{user_id:'u1',user:{id:'u1',name:'OLD'},identityRef:{provider:'test',id:'u1'}});
  a.sessionStore.close();

  const b=core({cwd:dir,session:{dir:sessionDir},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  assert.equal(b.sessionStore.memory.size,0);
  assert.equal(b.invalidateUserSessions('u1'),0); // no resident sessions were required
  assert.ok(b.sessionStore.userInvalidationEpoch('u1')>0);
  const loaded=b.sessionStore.load('s1');
  assert.equal(loaded.user,undefined);
  assert.equal(loaded.identityRef.id,'u1');
  b.sessionStore.close();
  fs.rmSync(dir,{recursive:true,force:true});
});

test('invalidated identity refreshes once, persists fresh cache, and survives restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-user-refresh-'));
  const sessionDir=path.join(dir,'sessions');
  const seed=core({cwd:dir,session:{dir:sessionDir},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  seed.sessionStore.save('sid',{user_id:'u1',user:{id:'u1',name:'OLD'},identityRef:{provider:'test',id:'u1'}});
  seed.sessionStore.close();

  const site=core({cwd:dir,session:{dir:sessionDir},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  let loads=0;
  site.identity.register('test',{load:async id=>{loads++;return{id,name:'FRESH'}}});
  site.invalidateUserSessions('u1');
  const port=await start(site);
  const first=await get(port,`${site.sessionStore.cookieName}=sid`);
  assert.equal(first.body.name,'FRESH');
  assert.equal(loads,1);
  await site.stop({forceAfterMs:100});

  const restarted=core({cwd:dir,session:{dir:sessionDir},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  let restartLoads=0;
  restarted.identity.register('test',{load:async id=>{restartLoads++;return{id,name:'SHOULD_NOT_LOAD'}}});
  const port2=await start(restarted);
  const second=await get(port2,`${restarted.sessionStore.cookieName}=sid`);
  assert.equal(second.body.name,'FRESH');
  assert.equal(restartLoads,0);
  await restarted.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('normal cached authenticated requests still perform zero identity refreshes and zero writes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-user-hot-'));
  const site=core({cwd:dir,session:{dir:path.join(dir,'sessions')},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  site.identity.register('test',{load:async id=>({id,name:'UNEXPECTED'})});
  site.sessionStore.save('sid',{user_id:'u1',user:{id:'u1',name:'CACHED'},identityRef:{provider:'test',id:'u1'}});
  let writes=0,loads=0;
  const originalWrite=site.sessionStore._writeOne.bind(site.sessionStore);
  site.sessionStore._writeOne=(...a)=>{writes++;return originalWrite(...a)};
  site.identity.providers.get('test').load=async id=>{loads++;return{id,name:'UNEXPECTED'}};
  const port=await start(site);
  writes=0;
  for(let i=0;i<5;i++){
    const row=await get(port,`${site.sessionStore.cookieName}=sid`);
    assert.equal(row.body.name,'CACHED');
    assert.equal(row.body.dirty,false);
  }
  assert.equal(loads,0);
  assert.equal(writes,0);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('expired invalidation markers are pruned and do not grow forever',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-user-prune-'));
  const sessionDir=path.join(dir,'sessions');fs.mkdirSync(sessionDir,{recursive:true});
  fs.writeFileSync(path.join(sessionDir,'.user-invalidations'),JSON.stringify({old:Date.now()-100000,new:Date.now()}));
  const site=core({cwd:dir,session:{dir:sessionDir,userInvalidationTtlMs:60000},fileCache:{prewarm:false},memoryPressure:{enabled:false}});
  assert.equal(site.sessionStore.userInvalidations.has('old'),false);
  assert.equal(site.sessionStore.userInvalidations.has('new'),true);
  site.sessionStore.close();
  fs.rmSync(dir,{recursive:true,force:true});
});
