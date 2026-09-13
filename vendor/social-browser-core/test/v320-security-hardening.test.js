'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http');
const core=require('..');

async function start(options={},setup){
 const site=core(options);(setup||((s)=>s.post('/x',(req,res)=>res.json(req.body))))(site);
 const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));return {site,srv,port:srv.address().port};
}
function call(port,{method='GET',path='/',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,method,path,headers},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(a).toString()}))});
  req.on('error',reject);if(body)req.write(body);req.end();
 });
}
test('TRACE is blocked',async()=>{
 const {srv,port}=await start({},s=>s.get('/',(q,r)=>r.send('ok')));
 const r=await call(port,{method:'TRACE'});assert.equal(r.status,405);await new Promise(res=>srv.close(res));
});
test('content-length larger than configured body limit is rejected before body parsing',async()=>{
 const {srv,port}=await start({securityShield:{maxBodyBytes:1024}});
 const started=Date.now();
 const r=await call(port,{method:'POST',path:'/x',headers:{'content-length':'2048','content-type':'application/json'},body:'x'});
 assert.equal(r.status,413);assert.ok(Date.now()-started<1000);await new Promise(res=>srv.close(res));
});
test('allowed host policy rejects unknown host',async()=>{
 const {srv,port}=await start({securityShield:{allowedHosts:['example.test']}},s=>s.get('/',(q,r)=>r.send('ok')));
 const bad=await call(port,{headers:{host:'evil.test'}});assert.equal(bad.status,421);
 const good=await call(port,{headers:{host:'example.test'}});assert.equal(good.status,200);
 await new Promise(res=>srv.close(res));
});
test('named limiter can protect login/account routes separately',async()=>{
 const {srv,port}=await start({},site=>{
   site.use(site.securityLimit('login',req=>site.securityShield.ip(req),{limit:2,windowMs:60000}));
   site.get('/',(req,res)=>res.send('ok'));
 });
 assert.equal((await call(port)).status,200);assert.equal((await call(port)).status,200);assert.equal((await call(port)).status,429);
 await new Promise(res=>srv.close(res));
});
test('untrusted X-Forwarded-For cannot bypass direct IP limiter by default',async()=>{
 const {srv,port}=await start({securityShield:{rateLimit:{limit:1,windowMs:60000}}},s=>s.get('/',(q,r)=>r.send('ok')));
 assert.equal((await call(port,{headers:{'x-forwarded-for':'1.1.1.1'}})).status,200);
 assert.equal((await call(port,{headers:{'x-forwarded-for':'2.2.2.2'}})).status,429);
 await new Promise(res=>srv.close(res));
});
