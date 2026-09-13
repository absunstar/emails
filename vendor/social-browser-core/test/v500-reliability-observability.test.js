'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {CircuitBreaker,ResilienceRegistry}=require('../lib/resilience');
const {Tracer}=require('../lib/observability');
const {Logger}=require('../lib/logger');
const core=require('..');

async function start(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  return {server,port:server.address().port};
}
function req(port,path){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,path},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({
        status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()
      }));
    });r.on('error',reject);r.end();
  });
}

test('circuit breaker opens, half-opens and closes',async()=>{
  const b=new CircuitBreaker({failureThreshold:2,successThreshold:1,resetTimeoutMs:20});
  b.begin();b.failure();
  assert.equal(b.state,'closed');
  b.begin();b.failure();
  assert.equal(b.state,'open');
  assert.throws(()=>b.begin(),e=>e.code==='CIRCUIT_OPEN');
  await new Promise(r=>setTimeout(r,25));
  b.begin();assert.equal(b.state,'half-open');b.success();
  assert.equal(b.state,'closed');
});

test('resilience registry retries retryable reads with exponential backoff',async()=>{
  const r=new ResilienceRegistry({retries:3,baseDelayMs:1,maxDelayMs:2,jitter:0});
  let calls=0;
  const value=await r.execute('db.read',async()=>{
    calls++;
    if(calls<3)throw Object.assign(new Error('temporary'),{code:'ECONNRESET'});
    return 42;
  });
  assert.equal(value,42);
  assert.equal(calls,3);
  assert.equal(r.snapshot()['db.read'].state,'closed');
});

test('non-retryable ORM safety errors never retry',async()=>{
  const r=new ResilienceRegistry({retries:5,baseDelayMs:1});
  let calls=0;
  await assert.rejects(()=>r.execute('query',async()=>{
    calls++;throw Object.assign(new Error('unsafe'),{code:'ORM_QUERY_TOO_COMPLEX'});
  }));
  assert.equal(calls,1);
});

test('tracer creates parent-child spans and bounded history',()=>{
  const tracer=new Tracer({max:10});
  const parent=tracer.start('parent',{a:1});
  const child=tracer.start('child',{},parent);
  child.end();parent.end();
  const rows=tracer.recent(10);
  assert.equal(rows.length,2);
  assert.equal(rows[0].traceId,rows[1].traceId);
  assert.equal(rows[0].parentSpanId,parent.spanId);
});

test('structured logger is Native Core branded and JSON-capable',()=>{
  const rows=[];
  const sink={info:x=>rows.push(x)};
  const log=new Logger({sink,json:true,base:{app:'test'}});
  log.info({event:'ready'});
  const row=JSON.parse(rows[0]);
  assert.equal(row.service,'social-browser-core');
  assert.equal(row.app,'test');
  assert.equal(row.event,'ready');
});

test('observability endpoints are opt-in and export liveness/readiness/metrics',async()=>{
  const site=core({observability:{endpoints:true,tracing:{enabled:true}}});
  site.get('/hello',(q,r)=>r.send('hi'));
  const {port}=await start(site);
  try{
    assert.equal((await req(port,'/hello')).status,200);
    const live=await req(port,'/_core/live');
    assert.equal(live.status,200);
    assert.equal(JSON.parse(live.body).status,'alive');
    const ready=await req(port,'/_core/ready');
    assert.equal(ready.status,200);
    assert.equal(JSON.parse(ready.body).ok,true);
    const metrics=await req(port,'/_core/metrics');
    assert.equal(metrics.status,200);
    assert.match(metrics.body,/http_requests/);
    assert.match(metrics.body,/process_rss_bytes/);
    assert.ok(site.tracer.recent(20).some(x=>x.name==='http.request'));
  }finally{await site.stop({forceAfterMs:200})}
});

test('drain mode rejects new HTTP requests and graceful stop clears resources',async()=>{
  const site=core();
  site.get('/x',(q,r)=>r.send('x'));
  const {port}=await start(site);
  assert.equal((await req(port,'/x')).status,200);
  await site.drain({timeoutMs:50});
  const drained=await req(port,'/x');
  assert.equal(drained.status,503);
  assert.equal(drained.headers.connection,'close');
  await site.stop({forceAfterMs:200});
  assert.equal(site.servers.length,0);
  assert.equal(site._connections.size,0);
  assert.equal(site.scheduler.list().length,0);
});

test('databaseOperation uses named resilience policy without automatic write assumptions',async()=>{
  const site=core({resilience:{retries:2,baseDelayMs:1,jitter:0}});
  let reads=0;
  const result=await site.databaseOperation('core','read',async()=>{
    reads++;if(reads<2)throw Object.assign(new Error('tmp'),{code:'EAGAIN'});return 'ok';
  });
  assert.equal(result,'ok');
  assert.equal(reads,2);
  let writes=0;
  await assert.rejects(()=>site.databaseOperation('core','write',async()=>{
    writes++;throw new Error('write failed');
  }));
  assert.equal(writes,1);
});


test('shutdown hooks run once and lifecycle reaches stopped',async()=>{
  const site=core();
  let calls=0;
  site.onShutdown(async()=>{calls++});
  site.get('/x',(q,r)=>r.send('x'));
  await start(site);
  await site.stop({forceAfterMs:200});
  await site.stop({forceAfterMs:200});
  assert.equal(calls,1);
  assert.equal(site.lifecycle.state,'stopped');
  assert.ok(site.lifecycle.stoppedAt);
});

test('signal handlers are opt-in and removable without affecting native startup',()=>{
  const site=core();
  assert.equal(site._signalHandlersInstalled,undefined);
  site.installSignalHandlers({signals:['SIGUSR2'],exit:false});
  assert.equal(site._signalHandlersInstalled,true);
  assert.equal(site._signalHandlers.length,1);
  site.removeSignalHandlers();
  assert.equal(site._signalHandlersInstalled,false);
  assert.equal(site._signalHandlers.length,0);
});


test('gracefulShutdown signals=true installs the default SIGTERM/SIGINT handlers',()=>{
  const site=core({gracefulShutdown:{signals:true,exit:false}});
  try{
    assert.equal(site._signalHandlersInstalled,true);
    assert.deepEqual(site._signalHandlers.map(x=>x[0]),['SIGTERM','SIGINT']);
  }finally{
    site.removeSignalHandlers();
  }
});
