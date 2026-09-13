'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const core=require('..');

function request(port,path='/'){
  return new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    }).on('error',reject);
  });
}
test('anonymous GET does not create session cookie or disk file',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-'));
  const site=core({session:{dir}});
  site.get('/',(req,res)=>res.send('ok'));
  const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));
  const r=await request(srv.address().port);
  assert.equal(r.headers['set-cookie'],undefined);
  assert.equal(fs.readdirSync(dir).length,0);
  await new Promise(res=>srv.close(res));
});
test('session persists only after mutation',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-session-'));
  const site=core({session:{dir}});
  site.get('/set',(req,res)=>{req.session.user={id:1};res.json({ok:true})});
  const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));
  const r=await request(srv.address().port,'/set');
  assert.ok(r.headers['set-cookie']);
  assert.equal(fs.readdirSync(dir).filter(x=>x.endsWith('.json')).length,1);
  await new Promise(res=>srv.close(res));
});
