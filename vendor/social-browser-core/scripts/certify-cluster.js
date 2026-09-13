'use strict';
const cluster=require('cluster');
const fs=require('fs');
const path=require('path');
const core=require('..');
const root=path.resolve(__dirname,'..');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=8000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const v=fn();if(v)return v;await sleep(50)}
  return null;
}

if(cluster.isWorker){
  const site=core({cluster:{enabled:true,heartbeatMs:150,respawn:false},jobs:{autoStart:false}});
  const keep=setInterval(()=>{},1000);
  process.on('disconnect',async()=>{
    clearInterval(keep);
    await site.stop({forceAfterMs:200}).catch(()=>{});
    process.exit(0);
  });
}else{
  (async()=>{
    const site=core({cluster:{enabled:true,workers:2,heartbeatMs:150,respawn:false},jobs:{autoStart:false}});
    const initial=await waitFor(()=>{
      const st=site.cluster.status();
      return st.workers.length===2&&st.workers.every(x=>x.state==='ready'&&x.lastHeartbeat)?st:null;
    });
    let rolling=false,after=null,error=null;
    if(initial){
      try{
        rolling=await site.cluster.rollingRestart({timeoutMs:5000,drainMs:50});
        after=await waitFor(()=>{
          const st=site.cluster.status();
          return st.workers.length===2&&st.workers.every(x=>x.state==='ready')?st:null;
        },8000);
      }catch(e){error={message:e.message,code:e.code||null}}
    }
    await site.cluster.stop().catch(()=>{});
    const report={
      generatedAt:new Date().toISOString(),version:core.version,
      initialReady:!!initial,
      initialWorkers:initial?.workers?.length||0,
      heartbeats:initial?.workers?.every(x=>!!x.lastHeartbeat)||false,
      rollingRestart:rolling,
      afterReady:!!after,
      afterWorkers:after?.workers?.length||0,
      error
    };
    report.pass=report.initialReady&&report.heartbeats&&report.rollingRestart&&report.afterReady&&report.afterWorkers===2&&!report.error;
    fs.writeFileSync(path.join(root,'CERTIFICATION-CLUSTER.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    process.exit(report.pass?0:1);
  })().catch(e=>{console.error(e);process.exit(1)});
}
