'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const core=require('..');

test('importApp accepts an app directory and resolves app.js',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-app-'));
  fs.writeFileSync(path.join(dir,'app.js'),'module.exports=site=>{site.__directoryAppLoaded=true}');
  const site=core({compatibility:'isite'});
  const app=site.importApp(dir);
  assert.ok(app);assert.equal(site.__directoryAppLoaded,true);
});

test('iSite compatibility restores site.call event-bus semantics',()=>{
  const site=core({compatibility:'isite'});let got=null;
  site.on('[company][created]',doc=>got=doc);
  const doc={id:7};
  assert.equal(site.call('[company][created]',doc),true);
  assert.equal(got,doc);
  assert.equal(typeof site.httpCall,'function');
});

test('callRoute invokes a registered route by legacy route pattern',async()=>{
  const site=core({compatibility:'isite'});let value=0;
  site.get('/article/:guid',(req,res)=>{value=req.params.guid;return res});
  const req={params:{guid:'abc'}},res={writableEnded:false,send(){throw new Error('must not auto-send response object')}};
  await site.callRoute('/article/:guid',req,res);
  assert.equal(value,'abc');
});


test('iSite run(callback) uses configured port and invokes ready callback',async()=>{
  const site=core({compatibility:'isite',port:0,host:'127.0.0.1'});
  let ready=false;
  site.run(()=>{ready=true});
  await new Promise(r=>setTimeout(r,20));
  assert.equal(ready,true);
  assert.equal(site.servers.length,1);
  assert.equal(site.servers[0].listening,true);
  await site.stop();
});


test('iSite route strings without leading slash are normalized',()=>{
  const site=core({compatibility:'isite'});
  site.get('robots.txt',(req,res)=>res);
  assert.ok(site.router.match('GET','/robots.txt'));
});


test('iSite redirect supports redirect(location,status)',async()=>{
  const site=core({compatibility:'isite'});
  site.get('/go',(req,res)=>res.redirect('/target',301));
  const srv=site.createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const http=require('http');
  const result=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:srv.address().port,path:'/go'},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location}))}).on('error',reject));
  assert.equal(result.status,301);assert.equal(result.location,'/target');
  await new Promise(r=>srv.close(r));
});
