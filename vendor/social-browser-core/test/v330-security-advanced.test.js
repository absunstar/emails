'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http'),net=require('net');
const core=require('..');

async function start(options={},setup){
 const site=core(options);(setup||((s)=>s.get('/',(q,r)=>r.send('ok'))))(site);
 const srv=site.createServer();await new Promise(res=>srv.listen(0,'127.0.0.1',res));return {site,srv,port:srv.address().port};
}
function req(port,{method='GET',path='/',headers={}}={}){
 return new Promise((resolve,reject)=>{
  const q=http.request({host:'127.0.0.1',port,method,path,headers},r=>{const a=[];r.on('data',d=>a.push(d));r.on('end',()=>resolve({status:r.statusCode,body:Buffer.concat(a).toString()}))});q.on('error',reject);q.end();
 });
}

test('repeated blocked behavior causes temporary ban',async()=>{
 const {site,srv,port}=await start({securityShield:{banThreshold:2,banDurationMs:60000}});
 // Trigger two block events with TRACE.
 assert.equal((await req(port,{method:'TRACE'})).status,405);
 assert.equal((await req(port,{method:'TRACE'})).status,405);
 const ip='127.0.0.1';
 assert.equal(site.securityShield.isBanned(ip),true);
 const banned=await req(port);
 assert.equal(banned.status,403);
 site.securityShield.unban(ip);
 assert.equal((await req(port)).status,200);
 await new Promise(res=>srv.close(res));
});

test('ambiguous content-length and transfer-encoding is rejected',async()=>{
 const {srv,port}=await start();
 const socket=net.connect(port,'127.0.0.1');
 const data=await new Promise((resolve,reject)=>{
   let out='';socket.on('data',d=>out+=d.toString());
   socket.on('close',()=>resolve(out));socket.on('error',reject);
   socket.on('connect',()=>socket.write(
     'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n'
   ));
 });
 // Node may reject malformed framing before application dispatch; either way it must not reach handler.
 assert.ok(/400|Bad Request/i.test(data));
 await new Promise(res=>srv.close(res));
});

test('circuit breaker opens after repeated handler failures',async()=>{
 const {site,srv,port}=await start({exposeErrors:false,securityShield:{circuitBreaker:{errorThreshold:3,windowMs:60000,coolDownMs:60000}}},s=>{
   s.get('/boom',()=>{throw new Error('boom')});
   s.get('/',(q,r)=>r.send('ok'));
 });
 for(let i=0;i<3;i++)assert.equal((await req(port,{path:'/boom'})).status,500);
 assert.equal(site.securityShield.circuitOpen(),true);
 assert.equal((await req(port)).status,503);
 site.securityShield.circuit.openUntil=0;
 await new Promise(res=>srv.close(res));
});

test('websocket upgrade limit rejects excess concurrent upgrades',()=>{
 const {EventEmitter}=require('events');
 const {SecurityShield}=require('../lib/security-shield');
 const shield=new SecurityShield({maxWsConnectionsPerIp:1});
 function socket(){
   const s=new EventEmitter();s.remoteAddress='127.0.0.1';s.destroyed=false;s.destroy=()=>{s.destroyed=true;s.emit('close')};return s;
 }
 const req1={socket:socket(),headers:{}},req2={socket:socket(),headers:{}};
 assert.equal(shield.wsConnection(req1.socket,req1),true);
 assert.equal(shield.wsConnection(req2.socket,req2),false);
 assert.equal(req2.socket.destroyed,true);
 assert.ok(shield.recentEvents(20).some(x=>x.reason==='ws_connection_limit'));
 req1.socket.emit('close');
});
