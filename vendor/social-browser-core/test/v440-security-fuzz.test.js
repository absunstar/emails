'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const net=require('node:net');
const crypto=require('node:crypto');
const core=require('..');
const {Router}=require('../lib/router');
const {setPath,assertQueryComplexity,safeRegex}=require('../lib/utils');
const {decodeFrames}=require('../lib/websocket');

test('setPath rejects prototype-pollution paths',()=>{
  const target={};
  for(const key of ['__proto__.polluted','constructor.prototype.polluted','prototype.x']){
    assert.throws(()=>setPath(target,key,true),e=>e.code==='UNSAFE_OBJECT_PATH');
  }
  assert.equal({}.polluted,undefined);
});

test('ORM query complexity rejects deep/wide abusive filters before provider execution',async()=>{
  const site=core();
  const c=site.connectCollection('fuzz_query_'+Date.now());
  let deep={x:1};for(let i=0;i<40;i++)deep={$not:deep};
  assert.throws(()=>c.findMany({where:deep}),e=>e.code==='ORM_QUERY_TOO_COMPLEX');
  assert.throws(()=>c.findMany({where:{id:{$in:Array.from({length:2000},(_,i)=>i)}}}),e=>e.code==='ORM_QUERY_TOO_COMPLEX');
});

test('regex guard rejects oversized and common nested-quantifier ReDoS patterns',()=>{
  assert.throws(()=>safeRegex('a'.repeat(2000)),e=>e.code==='ORM_REGEX_UNSAFE');
  assert.throws(()=>safeRegex('(a+)+$'),e=>e.code==='ORM_REGEX_UNSAFE');
  assert.doesNotThrow(()=>safeRegex('^[a-z0-9_-]{1,32}$'));
});

test('router fuzz does not throw on arbitrary paths and encoded input',()=>{
  const r=new Router();
  r.add('GET','/a/:id',()=>{});
  r.add('GET','/files/*',()=>{});
  r.add('POST','/api/v1/items/:id?',()=>{});
  for(let i=0;i<5000;i++){
    const bytes=crypto.randomBytes(20);
    const path='/'+bytes.toString('base64url').replaceAll('_','/');
    assert.doesNotThrow(()=>r.match(i%2?'GET':'POST',path));
  }
  assert.doesNotThrow(()=>r.match('GET','/a/%E0%A4%A'));
});

test('WebSocket decoder rejects declared frames above configured maximum',()=>{
  const b=Buffer.alloc(10);b[0]=0x81;b[1]=127;b.writeBigUInt64BE(BigInt(1024*1024),2);
  assert.throws(()=>decodeFrames(b,{maxFrameBytes:64*1024}),e=>e.code==='WS_FRAME_TOO_LARGE');
});

async function startSite(options={}){
  const site=core(options);
  site.post('/echo',(req,res)=>res.json({ok:true}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {site,server,port:server.address().port};
}
function req(port,opts={}){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method:opts.method||'POST',path:opts.path||'/echo',headers:opts.headers||{}},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));
    });
    r.on('error',reject);if(opts.body)r.write(opts.body);r.end();
  });
}

test('malformed JSON and oversized bodies fail closed',async()=>{
  const {server,port}=await startSite({securityShield:{maxBodyBytes:1024}});
  try{
    const bad=await req(port,{headers:{'content-type':'application/json'},body:'{"x":'});
    assert.equal(bad.status,400);
    const huge=await req(port,{headers:{'content-type':'application/json'},body:JSON.stringify({x:'a'.repeat(3000)})});
    assert.equal(huge.status,413);
  }finally{await new Promise(r=>server.close(r))}
});

test('multipart requires boundary and enforces body size',async()=>{
  const {server,port}=await startSite({securityShield:{maxBodyBytes:2048}});
  try{
    const missing=await req(port,{headers:{'content-type':'multipart/form-data'},body:'x'});
    assert.equal(missing.status,400);
    const boundary='----fuzz';
    const body=`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\n${'a'.repeat(3000)}\r\n--${boundary}--\r\n`;
    const big=await req(port,{headers:{'content-type':`multipart/form-data; boundary=${boundary}`},body});
    assert.equal(big.status,413);
  }finally{await new Promise(r=>server.close(r))}
});
