'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http');
const core=require('..');

async function serve(options={}){
 const site=core(options);site.get('/ok',(req,res)=>res.send('ok'));
 const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));return {site,srv,port:srv.address().port};
}
function req(port,path='/ok',headers={}){
 return new Promise((resolve,reject)=>{
  const q=http.get({host:'127.0.0.1',port,path,headers},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(a).toString()}))});q.on('error',reject);
 });
}
test('security headers are added by default',async()=>{
 const {srv,port}=await serve();const r=await req(port);
 assert.equal(r.status,200);assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.headers['x-frame-options'],'DENY');
 await new Promise(res=>srv.close(res));
});
test('rate limit blocks excess requests',async()=>{
 const {srv,port}=await serve({securityShield:{rateLimit:{limit:2,windowMs:60000}}});
 assert.equal((await req(port)).status,200);assert.equal((await req(port)).status,200);assert.equal((await req(port)).status,429);
 await new Promise(res=>srv.close(res));
});
test('URL length limit returns 414',async()=>{
 const {srv,port}=await serve({securityShield:{maxUrlLength:256}});
 const r=await req(port,'/'+('a'.repeat(300)));assert.equal(r.status,414);
 await new Promise(res=>srv.close(res));
});
test('deny IP policy blocks local request',async()=>{
 const {srv,port}=await serve({securityShield:{denyIps:['127.0.0.1']}});
 try{await req(port);assert.fail('request should be blocked')}catch(e){assert.ok(e)}
 await new Promise(res=>srv.close(res));
});
