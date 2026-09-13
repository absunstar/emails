'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {performance}=require('node:perf_hooks');

const coreRoot=path.resolve(__dirname,'..');
const arg=process.argv.find(x=>x.startsWith('--isite='));
const isitePath=arg?path.resolve(arg.slice(8)):process.env.ISITE_PATH?path.resolve(process.env.ISITE_PATH):null;
const outFile=path.join(coreRoot,'BENCHMARK-ISITE-LIVE.json');

function percentile(rows,p){
  if(!rows.length)return 0;const a=[...rows].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(a.length*p))];
}
async function runFramework(label,init,compat=false){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),`sb-${label}-`));
  const opts={cwd,dir:cwd,port:0,apps:false,stdin:false,help:false,log:false,mongodb:{enabled:false},security:{enabled:false},session:{enabled:false}};
  const site=compat?init({...opts,compatibility:'isite'}):init(opts);
  const route=site.get||site.onGET;
  const add=(p,h)=>{try{return route.call(site,p,h)}catch{return route.call(site,{name:p,public:true},h)}};
  for(let i=0;i<500;i++)add(`/exact/${i}`,(req,res)=>res.end?res.end('ok'):null);
  for(let i=0;i<100;i++)add(`/user/${i}/:id`,(req,res)=>res.json?res.json({id:req.params?.id}):res.end(JSON.stringify({id:req.params?.id})));

  let server;
  if(site.createServer)server=site.createServer();
  else if(site.routing?.handleServer)server=http.createServer(site.routing.handleServer);
  else if(site.handler)server=http.createServer(site.handler);
  else throw new Error(label+': no server handler');
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const port=server.address().port,agent=new http.Agent({keepAlive:true,maxSockets:64});
  const one=p=>new Promise((resolve,reject)=>{
    const t=performance.now();
    const q=http.request({host:'127.0.0.1',port,path:p,agent},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-t}))});
    q.on('error',reject);q.end();
  });
  try{
    for(let i=0;i<100;i++)await one(`/exact/${i%500}`);
    const total=3000,concurrency=64,latencies=[];let next=0,ok=0;
    const start=performance.now();
    async function worker(){
      while(true){
        const i=next++;if(i>=total)return;
        const p=i%3?`/exact/${i%500}`:`/user/${i%100}/${i}`;
        const r=await one(p);latencies.push(r.ms);if(r.status===200)ok++;
      }
    }
    await Promise.all(Array.from({length:concurrency},worker));
    const elapsed=performance.now()-start;
    return{
      label,total,ok,elapsedMs:elapsed,rps:total/(elapsed/1000),
      p50Ms:percentile(latencies,.50),p95Ms:percentile(latencies,.95),p99Ms:percentile(latencies,.99)
    };
  }finally{
    agent.destroy();
    if(server.closeAllConnections)server.closeAllConnections();
    await new Promise(r=>server.close(r));
    try{await site.stop?.({forceAfterMs:100})}catch{}
    fs.rmSync(cwd,{recursive:true,force:true});
  }
}
(async()=>{
  const report={generatedAt:new Date().toISOString(),node:process.version,isitePath,available:false,results:{},pass:null};
  if(!isitePath||!fs.existsSync(isitePath)){
    report.reason='Provide --isite=/path/to/isite (or ISITE_PATH) for a direct same-process benchmark.';
    fs.writeFileSync(outFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(2);
  }
  const isite=require(isitePath),core=require(coreRoot);
  report.available=true;
  report.results.isite=await runFramework('isite',isite,false);
  report.results.coreCompat=await runFramework('core-compat',core,true);
  report.results.coreNative=await runFramework('core-native',core,false);
  report.ratios={
    coreCompatVsISite:report.results.coreCompat.rps/report.results.isite.rps,
    coreNativeVsISite:report.results.coreNative.rps/report.results.isite.rps
  };
  report.pass=report.ratios.coreCompatVsISite>=0.90&&report.ratios.coreNativeVsISite>=1.0;
  fs.writeFileSync(outFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  process.exit(report.pass?0:1);
})().catch(e=>{
  const report={generatedAt:new Date().toISOString(),available:false,error:e.stack||e.message};
  fs.writeFileSync(outFile,JSON.stringify(report,null,2));console.error(JSON.stringify(report,null,2));process.exit(1);
});
