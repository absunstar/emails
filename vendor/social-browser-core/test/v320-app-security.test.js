'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http');
const core=require('..');

function call(port,{method='GET',path='/',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const q=http.request({host:'127.0.0.1',port,method,path,headers},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(a).toString()}))});q.on('error',reject);q.end();
 });
}
async function start(setup){
 const site=core();setup(site);const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));return {site,srv,port:srv.address().port};
}
test('origin guard rejects unexpected browser origin',async()=>{
 const {srv,port}=await start(site=>{site.use(site.originGuard(['https://good.example']));site.get('/',(q,r)=>r.send('ok'))});
 assert.equal((await call(port,{headers:{origin:'https://bad.example'}})).status,403);
 assert.equal((await call(port,{headers:{origin:'https://good.example'}})).status,200);
 await new Promise(res=>srv.close(res));
});
test('csrf double-submit middleware rejects missing token on unsafe request',async()=>{
 const {srv,port}=await start(site=>{site.use(site.csrfProtection());site.get('/',(q,r)=>r.send('ok'));site.post('/',(q,r)=>r.send('ok'))});
 const first=await call(port);assert.equal(first.status,200);
 const cookie=first.headers['set-cookie'][0].split(';')[0],token=decodeURIComponent(cookie.split('=').slice(1).join('='));
 assert.equal((await call(port,{method:'POST',headers:{cookie}})).status,403);
 assert.equal((await call(port,{method:'POST',headers:{cookie,'x-csrf-token':token}})).status,200);
 await new Promise(res=>srv.close(res));
});
test('SSRF guard identifies private networks',async()=>{
 const site=core();
 assert.equal(site.isPrivateIp('127.0.0.1'),true);
 assert.equal(site.isPrivateIp('10.1.2.3'),true);
 assert.equal(site.isPrivateIp('8.8.8.8'),false);
 await assert.rejects(()=>site.assertPublicTarget('127.0.0.1'),e=>e.code==='SSRF_PRIVATE_TARGET');
});
