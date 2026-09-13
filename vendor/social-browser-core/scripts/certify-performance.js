'use strict';
const fs=require('fs');
const path=require('path');
const http=require('http');
const {performance}=require('perf_hooks');
const core=require('..');

const root=path.resolve(__dirname,'..');

async function start(options={}){
  const site=core(options);
  site.get('/text',(req,res)=>res.send('ok'));
  site.get('/json',(req,res)=>res.json({ok:true,n:1}));
  site.get('/user/:id',(req,res)=>res.json({id:req.params.id}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {site,server,port:server.address().port};
}

function one(port,path,agent){
  return new Promise((resolve,reject)=>{
    const t=performance.now();
    const req=http.request({host:'127.0.0.1',port,path,agent},res=>{
      res.resume();res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-t}));
    });
    req.on('error',reject);req.end();
  });
}
function pct(rows,p){
  if(!rows.length)return 0;
  const sorted=[...rows].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
}
async function benchHttpSample(options,label,sample){
  const {site,server,port}=await start(options);
  const concurrency=50,total=1800;
  const agent=new http.Agent({keepAlive:true,maxSockets:concurrency});
  try{
    for(let i=0;i<150;i++)await one(port,i%3===0?'/text':i%3===1?'/json':`/user/${i}`,agent);
    let next=0,ok=0;const latencies=[];
    const started=performance.now();
    async function worker(){
      while(true){
        const i=next++;if(i>=total)return;
        const route=i%3===0?'/text':i%3===1?'/json':`/user/${i}`;
        const row=await one(port,route,agent);latencies.push(row.ms);if(row.status===200)ok++;
      }
    }
    await Promise.all(Array.from({length:concurrency},worker));
    const elapsed=performance.now()-started;
    return {label,sample,total,ok,elapsedMs:elapsed,rps:total/(elapsed/1000),p50Ms:pct(latencies,.50),p95Ms:pct(latencies,.95),p99Ms:pct(latencies,.99)};
  }finally{
    agent.destroy();
    await site.stop({forceAfterMs:100}).catch(()=>{});
    if(server.listening)await new Promise(r=>server.close(r));
  }
}
async function benchHttp(options,label){
  const samples=[];
  for(let i=0;i<3;i++)samples.push(await benchHttpSample(options,label,i+1));
  const byRps=[...samples].sort((a,b)=>a.rps-b.rps);
  const median=byRps[Math.floor(byRps.length/2)];
  return {...median,samples,method:'3-sample median, warm keep-alive'};
}
function benchRouter(){
  const {Router}=require('../lib/router');
  const r=new Router();
  for(let i=0;i<200;i++){
    r.add('GET',`/static/${i}`,()=>{});
    r.add('GET',`/api/${i}/:id`,()=>{});
  }
  const total=200000;
  const started=performance.now();
  let hit=0;
  for(let i=0;i<total;i++){
    const p=i%2?`/static/${i%200}`:`/api/${i%200}/${i}`;
    if(r.match('GET',p))hit++;
  }
  const elapsed=performance.now()-started;
  return {total,hit,elapsedMs:elapsed,opsPerSec:total/(elapsed/1000)};
}
async function benchOrm(){
  const site=core();
  const c=site.connectCollection('perf_'+Date.now());
  const docs=Array.from({length:5000},(_,i)=>({id:i,age:i%80,status:i%2?'active':'inactive'}));
  const t0=performance.now();
  await c.insertMany(docs);
  const insertMs=performance.now()-t0;
  const t1=performance.now();
  for(let i=0;i<200;i++)await c.findMany({where:{age:{$gte:18},status:'active'},limit:25,sort:{id:-1}});
  const queryMs=performance.now()-t1;
  return {
    insertDocs:docs.length,insertMs,insertDocsPerSec:docs.length/(insertMs/1000),
    queries:200,queryMs,queriesPerSec:200/(queryMs/1000)
  };
}

(async()=>{
  const native=await benchHttp({},'native');
  const compat=await benchHttp({compatibility:'isite'},'isite-compat');
  const router=benchRouter();
  const orm=await benchOrm();
  const thresholds={
    nativeRpsMin:900,
    compatRpsMin:650,
    compatVsNativeRatioMin:0.25,
    routerOpsPerSecMin:100000,
    ormInsertDocsPerSecMin:10000,
    ormQueriesPerSecMin:100
  };
  const ratio=compat.rps/native.rps;
  const checks={
    nativeRps:native.rps>=thresholds.nativeRpsMin,
    compatRps:compat.rps>=thresholds.compatRpsMin,
    compatRatio:ratio>=thresholds.compatVsNativeRatioMin,
    router:router.opsPerSec>=thresholds.routerOpsPerSecMin,
    ormInsert:orm.insertDocsPerSec>=thresholds.ormInsertDocsPerSecMin,
    ormQuery:orm.queriesPerSec>=thresholds.ormQueriesPerSecMin
  };
  const report={
    generatedAt:new Date().toISOString(),
    package:require('../package.json').name,
    version:require('../package.json').version,
    note:'Environment-local regression thresholds, not public comparative benchmarks.',
    native,compat,compatVsNativeRatio:ratio,router,orm,thresholds,checks,
    pass:Object.values(checks).every(Boolean)
  };
  fs.writeFileSync(path.join(root,'CERTIFICATION-PERFORMANCE.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  process.exit(report.pass?0:1);
})();
