'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');
const {MemoryCache,LockManager,IdempotencyStore,LeaderElection}=require('../lib/distributed');
const {validateSchema}=require('../lib/openapi');

async function start(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);return {server,port:server.address().port};
}
function req(port,{method='GET',path='/',body,headers={}}={}){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method,path,headers},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });r.on('error',reject);if(body!=null)r.write(body);r.end();
  });
}

test('distributed memory cache supports TTL, increment, CAS and getOrSet',async()=>{
  const c=new MemoryCache({defaultTtlMs:20});
  await c.set('a',1);
  assert.equal(await c.get('a'),1);
  assert.equal(await c.increment('n',2,{ttlMs:100}),2);
  assert.equal(await c.increment('n',3,{ttlMs:100}),5);
  assert.equal(await c.compareAndSet('n',5,9,{ttlMs:100}),true);
  assert.equal(await c.compareAndSet('n',5,10),false);
  let calls=0;
  assert.equal(await c.getOrSet('x',async()=>{calls++;return 7}),7);
  assert.equal(await c.getOrSet('x',async()=>{calls++;return 8}),7);
  assert.equal(calls,1);
  await new Promise(r=>setTimeout(r,30));
  assert.equal(await c.get('a'),undefined);
});

test('locks provide mutual exclusion, extension and using()',async()=>{
  const cache=new MemoryCache(),locks=new LockManager(cache,{defaultTtlMs:100});
  const a=await locks.acquire('resource');
  assert.ok(a);
  assert.equal(await locks.acquire('resource',{waitMs:0}),null);
  assert.equal(await a.extend(200),true);
  assert.equal(await a.release(),true);
  let entered=0;
  const result=await locks.using('resource',async()=>{entered++;return 42});
  assert.equal(result,42);assert.equal(entered,1);
});

test('idempotency replays stored result and shared rate limit counts',async()=>{
  const site=core();
  let calls=0;
  const a=await site.distributed.idempotency.run('order:1',async()=>{calls++;return {id:1}});
  const b=await site.distributed.idempotency.run('order:1',async()=>{calls++;return {id:2}});
  assert.equal(a.replayed,false);assert.equal(b.replayed,true);assert.equal(calls,1);assert.equal(b.value.id,1);
  const r1=await site.distributed.rateLimit('ip:1',2,1000);
  const r2=await site.distributed.rateLimit('ip:1',2,1000);
  const r3=await site.distributed.rateLimit('ip:1',2,1000);
  assert.equal(r1.allowed,true);assert.equal(r2.allowed,true);assert.equal(r3.allowed,false);
});

test('distributed cache adapter is pluggable',async()=>{
  const site=core();
  const data=new Map();
  const adapter={
    async get(k){return data.get(k)},
    async set(k,v){data.set(k,v);return v},
    async delete(k){return data.delete(k)},
    async increment(k,n=1){const v=Number(data.get(k)||0)+n;data.set(k,v);return v}
  };
  site.setDistributedCache(adapter);
  await site.distributed.sessions.save('s1',{user:1});
  assert.deepEqual(await site.distributed.sessions.load('s1'),{user:1});
  const lock=await site.distributed.locks.acquire('x');
  assert.ok(lock);await lock.release();
});

test('leader election acquires and resigns',async()=>{
  const cache=new MemoryCache(),locks=new LockManager(cache);
  const leader=new LeaderElection(locks,{name:'test',ttlMs:100,renewMs:40});
  assert.equal(await leader.campaign(),true);
  assert.equal(leader.isLeader(),true);
  await leader.resign();
  assert.equal(leader.isLeader(),false);
});

test('platform event bus publish/subscribe/history and adapter forwarding',async()=>{
  const site=core();
  const seen=[],remote=[];
  const off=site.subscribe('orders.created',e=>seen.push(e.payload.id));
  site.setEventAdapter({async publish(topic,payload){remote.push([topic,payload.id])}});
  await site.publish('orders.created',{id:7});
  off();
  await site.publish('orders.created',{id:8});
  assert.deepEqual(seen,[7]);
  assert.deepEqual(remote,[['orders.created',7],['orders.created',8]]);
  assert.equal(site.eventsBus.recent(10,'orders.created').length,2);
});

test('job queue supports priority, retry, scheduling, idempotency and dead-letter',async()=>{
  const site=core({jobs:{concurrency:1}});
  const order=[];let flaky=0;
  site.jobs.define('work',async p=>{order.push(p.id);return p.id});
  site.jobs.define('flaky',async()=>{flaky++;if(flaky<2)throw new Error('again');return 'ok'},{retryDelayMs:5});
  site.jobs.define('dead',async()=>{throw new Error('dead')},{retryDelayMs:1});
  const low=site.jobs.enqueue('work',{id:'low'},{priority:1});
  const high=site.jobs.enqueue('work',{id:'high'},{priority:10});
  const idem1=site.jobs.enqueue('work',{id:'same'},{idempotencyKey:'k1'});
  const idem2=site.jobs.enqueue('work',{id:'other'},{idempotencyKey:'k1'});
  assert.equal(idem1.id,idem2.id);
  const f=site.jobs.enqueue('flaky',{}, {maxAttempts:2});
  const d=site.jobs.enqueue('dead',{}, {maxAttempts:2});
  const scheduled=site.jobs.schedule('work',{id:'later'},Date.now()+20);
  for(let i=0;i<100&&[low,high,idem1,f,d,scheduled].some(j=>!['completed','failed'].includes(j.state));i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.state,'completed');assert.equal(f.attempts,2);
  assert.equal(d.state,'failed');assert.ok(site.jobs.dead.includes(d.id));
  assert.equal(scheduled.state,'completed');
  assert.ok(order.includes('high'));assert.ok(order.includes('low'));
  await site.jobs.stop();
});

test('plugin manager provides lifecycle and capabilities',async()=>{
  const site=core();const events=[];
  site.plugins.register({
    name:'demo',version:'1.0.0',capabilities:['demo.read'],
    async setup(s){events.push('setup');s.demoValue=1;return {ok:true}},
    async teardown(s){events.push('teardown');delete s.demoValue}
  });
  await site.plugins.enable('demo');
  assert.equal(site.plugins.hasCapability('demo.read'),true);
  assert.equal(site.demoValue,1);
  await site.plugins.disable('demo');
  assert.deepEqual(events,['setup','teardown']);
  assert.equal(site.demoValue,undefined);
});

test('config profiles/env and masking keep secrets out of diagnostics',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-config-'));
  const file=path.join(dir,'config.json');
  fs.writeFileSync(file,JSON.stringify({default:{port:1,password:'secret'},profiles:{test:{port:2,apiKey:'key'}}}));
  const old=process.env.SB_CORE_FEATURES__X;process.env.SB_CORE_FEATURES__X='true';
  try{
    const site=core({config:{file,profile:'test'}});
    assert.equal(site.config.get('port'),2);
    assert.equal(site.config.get('features.x'),true);
    const snap=site.config.snapshot({masked:true});
    assert.equal(snap.password,'***');assert.equal(snap.apiKey,'***');
  }finally{if(old===undefined)delete process.env.SB_CORE_FEATURES__X;else process.env.SB_CORE_FEATURES__X=old}
});

test('OpenAPI contract validates body and generates OpenAPI 3.1 document',async()=>{
  const site=core();
  site.apiRoute('POST','/users',{
    summary:'Create user',
    body:{type:'object',required:['name'],additionalProperties:false,properties:{name:{type:'string',minLength:2}}},
    response:{type:'object',required:['ok'],properties:{ok:{type:'boolean'}}}
  },async req=>({ok:true}));
  site.enableOpenApiEndpoint();
  const {port}=await start(site);
  try{
    const bad=await req(port,{method:'POST',path:'/users',headers:{'content-type':'application/json'},body:'{"name":"A"}'});
    assert.equal(bad.status,400);
    const good=await req(port,{method:'POST',path:'/users',headers:{'content-type':'application/json'},body:'{"name":"Amr"}'});
    assert.equal(good.status,200);assert.deepEqual(JSON.parse(good.body),{ok:true});
    const doc=JSON.parse((await req(port,{path:'/openapi.json'})).body);
    assert.equal(doc.openapi,'3.1.0');assert.ok(doc.paths['/users'].post);
  }finally{await site.stop({forceAfterMs:200})}
});

test('schema validator catches required/additional/type errors',()=>{
  const r=validateSchema({x:'1',extra:true},{type:'object',required:['x','y'],additionalProperties:false,properties:{x:{type:'integer'},y:{type:'string'}}});
  assert.equal(r.length,3);
});

test('cluster runtime is opt-in and exposes status without forking by default',()=>{
  const site=core();
  const st=site.cluster.status();
  assert.equal(st.enabled,false);
  assert.equal(Array.isArray(st.workers),true);
});

test('TypeScript declarations are shipped and package points to them',()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.types,'index.d.ts');
  assert.equal(fs.existsSync(path.join(__dirname,'..','index.d.ts')),true);
});


test('Native HTTP sessions can share a distributed cache across site instances',async()=>{
  const shared=new MemoryCache();
  const a=core();a.setDistributedCache(shared);a.useDistributedSessions();
  a.get('/set',(req,res)=>{req.session.user={id:55};res.send('set')});
  const sa=await start(a);
  const set=await req(sa.port,{path:'/set'});
  const cookie=[].concat(set.headers['set-cookie']||[]).find(x=>x.startsWith('sb.sid='));
  assert.ok(cookie);
  await a.stop({forceAfterMs:200});

  const b=core();b.setDistributedCache(shared);b.useDistributedSessions();
  b.get('/get',(req,res)=>res.json({id:req.session.user?.id||null}));
  const sb=await start(b);
  try{
    const got=await req(sb.port,{path:'/get',headers:{cookie:cookie.split(';')[0]}});
    assert.equal(JSON.parse(got.body).id,55);
  }finally{await b.stop({forceAfterMs:200})}
});

test('distributed Native sessions cannot replace the iSite compatibility session store',()=>{
  const site=core({compatibility:'isite'});
  assert.throws(()=>site.useDistributedSessions(),e=>e.code==='ISITE_SESSION_STORE_CONFLICT');
});
