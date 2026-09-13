'use strict';
const fs=require('fs');
const path=require('path');
const http=require('http');
const {performance}=require('perf_hooks');
const core=require('..');
const root=path.resolve(__dirname,'..');

function percentile(list,p){
  if(!list.length)return 0;
  const sorted=[...list].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
}
function hit(port,pathName){
  const started=performance.now();
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,path:pathName,agent:false},res=>{
      res.resume();res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-started}));
    });r.on('error',reject);r.end();
  });
}
(async()=>{
  const site=core({
    jobs:{concurrency:8},
    observability:{tracing:{enabled:false}},
    securityShield:{maxConnectionsPerIp:1000},
    distributed:{cache:{max:50000}}
  });
  site.useDistributedSessions();
  const c=site.connectCollection('soak_'+Date.now());
  await c.insertMany(Array.from({length:3000},(_,i)=>({id:i,status:i%2?'a':'b',score:i%100})));
  let jobCount=0,eventCount=0;
  site.jobs.define('soak.job',async payload=>{jobCount++;await site.publish('soak.done',payload);return payload.id});
  site.subscribe('soak.done',()=>eventCount++);
  site.get('/ping',(q,r)=>r.send('ok'));
  site.get('/query',async(q,r)=>r.json(await c.findMany({where:{status:'a',score:{$gte:20}},limit:20,sort:{id:-1}})));
  site.get('/session',(q,r)=>{q.session.hits=(q.session.hits||0)+1;r.json({hits:q.session.hits})});
  site.get('/lock',async(q,r)=>r.json({ok:await site.distributed.locks.using('soak-lock',async()=>true,{waitMs:100})}));

  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);const port=server.address().port;

  const rssBefore=process.memoryUsage().rss;
  const handlesBefore=process._getActiveHandles?.().length||0;
  const latencies=[];let ok=0,errors=0,next=0;
  const total=8000,concurrency=125;
  const paths=['/ping','/query','/session','/lock'];
  let lagMax=0,last=performance.now();
  const lagTimer=setInterval(()=>{const n=performance.now(),lag=Math.max(0,n-last-50);lagMax=Math.max(lagMax,lag);last=n},50);
  lagTimer.unref?.();

  for(let i=0;i<500;i++)site.jobs.enqueue('soak.job',{id:i},{priority:i%5,maxAttempts:2});

  const started=performance.now();
  async function worker(){
    while(true){
      const i=next++;if(i>=total)return;
      try{
        const row=await hit(port,paths[i%paths.length]);
        latencies.push(row.ms);
        if(row.status===200)ok++;else errors++;
      }catch{errors++}
    }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  const elapsedMs=performance.now()-started;
  for(let i=0;i<300&&site.jobs.stats().completed<500;i++)await new Promise(r=>setTimeout(r,10));
  clearInterval(lagTimer);

  const readiness=await site.readiness();
  const cacheStats=site.distributed.cache.stats();
  const jobStats=site.jobs.stats();
  await site.stop({forceAfterMs:500});
  await new Promise(r=>setTimeout(r,50));
  const rssAfter=process.memoryUsage().rss;
  const handlesAfter=process._getActiveHandles?.().length||0;

  const report={
    generatedAt:new Date().toISOString(),version:core.version,
    total,concurrency,ok,errors,elapsedMs,rps:total/(elapsedMs/1000),
    latencyMs:{p50:percentile(latencies,.50),p95:percentile(latencies,.95),p99:percentile(latencies,.99),max:Math.max(...latencies)},
    eventLoopLagMaxMs:lagMax,
    rssBefore,rssAfter,rssGrowthBytes:rssAfter-rssBefore,
    handlesBefore,handlesAfter,
    jobs:jobStats,jobCount,eventCount,cache:cacheStats,readinessBeforeStop:readiness,
    stopped:{servers:site.servers.length,connections:site._connections.size,lifecycle:site.lifecycle.state},
    checks:{
      allHttp:ok===total,
      noHttpErrors:errors===0,
      jobsCompleted:jobStats.completed===500&&jobCount===500&&eventCount===500,
      ready:readiness.ok===true,
      p95:percentile(latencies,.95)<1000,
      eventLoopLag:lagMax<1000,
      rssGrowth:rssAfter-rssBefore<384*1024*1024,
      stopped:site.servers.length===0&&site._connections.size===0&&site.lifecycle.state==='stopped'
    }
  };
  report.pass=Object.values(report.checks).every(Boolean);
  fs.writeFileSync(path.join(root,'CERTIFICATION-SOAK.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  process.exit(report.pass?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
