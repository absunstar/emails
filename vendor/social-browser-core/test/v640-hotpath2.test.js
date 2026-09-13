'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const core=require('..');

test('production identity hydration is session-first by default',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-idfast-'));
  const site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions')},fileCache:{prewarm:false}});
  let loads=0;
  site.identity.register('x',{load:async id=>{loads++;return{id,name:'Fresh'}}});
  const sid='sessionfirst';
  site.sessionStore.save(sid,{identityRef:{provider:'x',id:'u1'},user:{id:'u1',name:'Cached'}});
  site.get('/me',(req,res)=>res.json({name:req.user?.name}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  for(let i=0;i<5;i++)await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:'/me',headers:{Cookie:`${site.sessionStore.cookieName}=${sid}`}},res=>{
      res.resume();res.on('end',resolve);
    }).on('error',reject);
  });
  assert.equal(loads,0);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('identityHydration=always remains available explicitly',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-idalways-'));
  const site=core({cwd:dir,dir,session:{dir:path.join(dir,'sessions'),identityHydration:'always'},fileCache:{prewarm:false}});
  let loads=0;
  site.identity.register('x',{load:async id=>{loads++;return{id,name:'Fresh'}}});
  const sid='always';
  site.sessionStore.save(sid,{identityRef:{provider:'x',id:'u1'},user:{id:'u1',name:'Cached'}});
  site.get('/me',(req,res)=>res.json({name:req.user?.name}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:'/me',headers:{Cookie:`${site.sessionStore.cookieName}=${sid}`}},res=>{
      res.resume();res.on('end',resolve);
    }).on('error',reject);
  });
  assert.equal(loads,1);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('HTML without x-* directives uses fast string path and keeps token behavior',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-parserfast-'));
  const file=path.join(dir,'x.html');
  fs.writeFileSync(file,'<div title="##word.hello##">##word.hello##</div>');
  const site=core({dir,compatibility:'isite',fileCache:{prewarm:false}});
  let calls=0;
  site.word=name=>{calls++;return name==='hello'?'Hello':'x'};
  const out=site.parser.renderFile(file,{session:{language:{id:'en'}},data:{},features:[]},{},{route:{parser:'html'},parserDir:dir});
  assert.match(out,/title="Hello"/);
  assert.match(out,/>Hello</);
  assert.equal(calls,1);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});
