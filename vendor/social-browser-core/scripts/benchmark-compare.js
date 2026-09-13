'use strict';
const http=require('http');
const fs=require('fs');
const os=require('os');
const path=require('path');
const cp=require('child_process');
const {performance}=require('perf_hooks');

const AISITE=path.resolve(__dirname,'..');

function percentile(xs,p){
  const a=[...xs].sort((x,y)=>x-y);
  if(!a.length)return 0;
  const i=Math.min(a.length-1,Math.max(0,Math.ceil(p*a.length)-1));
  return a[i];
}
function median(xs){return percentile(xs,.5)}

function startupChild(framework,routes){
  const code=framework==='native' ? `
const http=require('http'),{performance}=require('perf_hooks');
const t0=performance.now();
const t1=performance.now();
const table=new Map();
for(let i=0;i<${routes};i++)table.set('/r'+i,1);
const initMs=performance.now()-t1;
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end('{"ok":true}')});
const ts=performance.now();
server.listen(0,'127.0.0.1',()=>{
 console.log(JSON.stringify({totalReadyMs:performance.now()-t0,initMs,startReadyMs:performance.now()-ts,rssMB:process.memoryUsage().rss/1048576}));
 server.close();
});`
:
`
const {performance}=require('perf_hooks'),fs=require('fs'),os=require('os'),path=require('path');
const t0=performance.now();
const aisite=require(${JSON.stringify(AISITE)});
const t1=performance.now();
const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-start-')),session:{enabled:false}});
for(let i=0;i<${routes};i++)site.get('/r'+i,(req,res)=>res.json({ok:true}));
const initMs=performance.now()-t1;
const server=site.createServer();
const ts=performance.now();
server.listen(0,'127.0.0.1',()=>{
 console.log(JSON.stringify({totalReadyMs:performance.now()-t0,requireMs:t1-t0,initMs,startReadyMs:performance.now()-ts,rssMB:process.memoryUsage().rss/1048576}));
 server.close();
});`;
  const r=cp.spawnSync(process.execPath,['-e',code],{encoding:'utf8'});
  if(r.status!==0)throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

async function startup(){
  const out=[];
  for(const routes of [0,100,1000]){
    for(const framework of ['native','aisite']){
      const rows=[];
      for(let i=0;i<15;i++)rows.push(startupChild(framework,routes));
      out.push({
        framework,routes,n:rows.length,
        totalReadyMs:median(rows.map(x=>x.totalReadyMs)),
        requireMs:framework==='aisite'?median(rows.map(x=>x.requireMs)):0,
        initMs:median(rows.map(x=>x.initMs)),
        startReadyMs:median(rows.map(x=>x.startReadyMs)),
        rssMB:median(rows.map(x=>x.rssMB))
      });
    }
  }
  return out;
}

async function createServer(framework,routes){
  if(framework==='native'){
    const table=new Map();
    for(let i=0;i<routes;i++)table.set('/r'+i,true);
    const server=http.createServer((req,res)=>{
      if(req.url==='/bench'||table.has(req.url)){
        res.setHeader('content-type','application/json');
        res.end('{"ok":true}');
      }else{res.statusCode=404;res.end('no')}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    return server;
  }
  const aisite=require(AISITE);
  const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-runtime-')),session:{enabled:false}});
  for(let i=0;i<routes;i++)site.get('/r'+i,(req,res)=>res.json({ok:true}));
  site.get('/bench',(req,res)=>res.json({ok:true}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return server;
}

function oneRequest(agent,port){
  return new Promise((resolve,reject)=>{
    const t=performance.now();
    const req=http.get({host:'127.0.0.1',port,path:'/bench',agent},res=>{
      res.resume();
      res.on('end',()=>resolve(performance.now()-t));
    });
    req.on('error',reject);
  });
}

async function runtimeCase(framework,routes,total=6000,concurrency=64){
  const server=await createServer(framework,routes);
  const port=server.address().port;
  const agent=new http.Agent({keepAlive:true,maxSockets:concurrency});
  const firstRequestMs=await oneRequest(agent,port);

  // warmup
  for(let i=0;i<300;i+=concurrency){
    await Promise.all(Array.from({length:Math.min(concurrency,300-i)},()=>oneRequest(agent,port)));
  }

  const lat=[];
  let next=0;
  const t0=performance.now();
  async function worker(){
    while(true){
      const i=next++;
      if(i>=total)return;
      lat.push(await oneRequest(agent,port));
    }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  const elapsed=performance.now()-t0;
  agent.destroy();
  await new Promise(r=>server.close(r));
  return {
    framework,routes,total,concurrency,
    rps:total/(elapsed/1000),
    p50Ms:percentile(lat,.50),
    p95Ms:percentile(lat,.95),
    p99Ms:percentile(lat,.99),
    firstRequestMs
  };
}

async function runtime(){
  const out=[];
  for(const routes of [0,100,1000]){
    for(const framework of ['native','aisite']){
      // 3 runs, median each metric
      const rows=[];
      for(let i=0;i<3;i++)rows.push(await runtimeCase(framework,routes));
      out.push({
        framework,routes,n:rows.length,
        rps:median(rows.map(x=>x.rps)),
        p50Ms:median(rows.map(x=>x.p50Ms)),
        p95Ms:median(rows.map(x=>x.p95Ms)),
        p99Ms:median(rows.map(x=>x.p99Ms)),
        firstRequestMs:median(rows.map(x=>x.firstRequestMs))
      });
    }
  }
  return out;
}

(async()=>{
  const result={
    date:new Date().toISOString(),
    node:process.version,
    cpu:os.cpus()[0]?.model||null,
    platform:`${process.platform}-${process.arch}`,
    startup_median_15_processes:await startup(),
    runtime_median_3_runs_same_process_client_server:await runtime()
  };
  console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
