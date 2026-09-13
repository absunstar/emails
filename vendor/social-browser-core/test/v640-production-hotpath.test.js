'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const core=require('..');

test('site.readFileSync is cache-first in production and raw API remains available',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-hotpath-'));
  const file=path.join(dir,'x.txt');
  fs.writeFileSync(file,'one');
  const site=core({dir,session:{enabled:false},fileCache:{prewarm:false}});
  assert.equal(site.readFileSync(file),'one');
  fs.writeFileSync(file,'two');
  assert.equal(site.readFileSync(file),'one');
  assert.equal(site.readFileRawSync(file),'two');
  site.invalidateFileCache(file);
  assert.equal(site.readFileSync(file),'two');
  fs.rmSync(dir,{recursive:true,force:true});
});

test('site.files.readSync is cache-first and iSite fsm.readFileSync shares same cache',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-hotpath-'));
  const file=path.join(dir,'x.html');
  fs.writeFileSync(file,'A');
  const site=core({dir,compatibility:'isite',fileCache:{prewarm:false}});
  assert.equal(site.files.readSync(file),'A');
  assert.equal(site.fsm.readFileSync(file),'A');
  fs.writeFileSync(file,'B');
  assert.equal(site.files.readSync(file),'A');
  assert.equal(site.fsm.readFileSync(file),'A');
  assert.equal(site.files.readRawSync(file),'B');
  fs.rmSync(dir,{recursive:true,force:true});
});

test('identity hydration does not dirty or persist an unchanged session',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-hot-'));
  const site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions')},fileCache:{prewarm:false}});
  site.identity.register('test',{load:async id=>({id,name:'User'})});

  // Seed persisted session explicitly.
  const id='abc123';
  site.sessionStore.save(id,{identityRef:{provider:'test',id:'u1'},user:{id:'u1',name:'Cached'}});
  let saves=0;
  const originalSave=site.sessionStore.save.bind(site.sessionStore);
  site.sessionStore.save=(...args)=>{saves++;return originalSave(...args)};

  site.get('/x',(req,res)=>res.json({id:req.user?.id||null,dirty:req._sessionState?.dirty||false}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;

  const call=()=>new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:'/x',headers:{Cookie:`${site.sessionStore.cookieName}=${id}`}},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));
    });req.on('error',reject);
  });

  const a=await call(),b=await call(),c=await call();
  assert.equal(a.id,'u1');assert.equal(b.id,'u1');assert.equal(c.id,'u1');
  assert.equal(a.dirty,false);assert.equal(b.dirty,false);assert.equal(c.dirty,false);
  assert.equal(saves,0);

  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('explicit session mutation still persists normally',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-write-'));
  const site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions')},fileCache:{prewarm:false}});
  let saves=0;
  const originalSave=site.sessionStore.save.bind(site.sessionStore);
  site.sessionStore.save=(...args)=>{saves++;return originalSave(...args)};
  site.get('/set',(req,res)=>{req.session.foo='bar';res.end('ok')});
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/set'},res=>{res.resume();res.on('end',resolve)}).on('error',reject));
  assert.equal(saves,1);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});
