'use strict';
const fs=require('fs');
const path=require('path');
const http=require('http');
const {performance}=require('perf_hooks');
const core=require('..');
const root=path.resolve(__dirname,'..');

function hit(port,path){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,path,agent:false},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });r.on('error',reject);r.end();
  });
}
(async()=>{
  const site=core({observability:{tracing:{enabled:false}},securityShield:{maxConnectionsPerIp:500}});
  site.get('/ping',(q,r)=>r.json({ok:true}));
  const c=site.connectCollection('stress_'+Date.now());
  await c.insertMany(Array.from({length:2000},(_,i)=>({id:i,n:i,status:i%2?'a':'b'})));
  site.get('/query',async(q,r)=>r.json(await c.findMany({where:{status:'a'},limit:10})));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);const port=server.address().port;
  const before=process.memoryUsage().rss;
  const total=4000,concurrency=100;let next=0,ok=0,errors=0;
  const started=performance.now();
  async function worker(){
    while(true){
      const i=next++;if(i>=total)return;
      try{const status=await hit(port,i%4?'/ping':'/query');if(status===200)ok++;else errors++}
      catch{errors++}
    }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  const elapsed=performance.now()-started;
  const after=process.memoryUsage().rss;
  await site.stop({forceAfterMs:500});
  const report={
    generatedAt:new Date().toISOString(),version:core.version,
    total,concurrency,ok,errors,elapsedMs:elapsed,rps:total/(elapsed/1000),
    rssBefore:before,rssAfter:after,rssGrowthBytes:after-before,
    checks:{
      allRequests:ok===total,
      noErrors:errors===0,
      rps:total/(elapsed/1000)>=500,
      rssGrowth:after-before<256*1024*1024,
      stopped:site.servers.length===0&&site._connections.size===0
    }
  };
  report.pass=Object.values(report.checks).every(Boolean);
  fs.writeFileSync(path.join(root,'CERTIFICATION-STRESS.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  process.exit(report.pass?0:1);
})();
