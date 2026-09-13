'use strict';
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function pct(a,p){a=[...a].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]||0}
function median(a){return pct(a,.5)}
function req(agent,port,path){
 return new Promise((resolve,reject)=>{
   const t=performance.now();
   const q=http.get({host:'127.0.0.1',port,path,agent},r=>{r.resume();r.on('end',()=>resolve(performance.now()-t))});
   q.on('error',reject);
 });
}
async function once(routes,total=8000,concurrency=64){
 const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-router-bench-')),session:{enabled:false}});
 for(let i=0;i<routes;i++)site.get('/r'+i,(q,s)=>s.json({i}));
 site.get('/bench',(q,s)=>s.json({ok:true}));
 const server=site.createServer();
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res)});
 const port=server.address().port,agent=new http.Agent({keepAlive:true,maxSockets:concurrency});
 for(let i=0;i<256;i+=64)await Promise.all(Array.from({length:64},()=>req(agent,port,'/bench')));
 const lat=[];let next=0;const t=performance.now();
 async function worker(){while(true){const i=next++;if(i>=total)return;lat.push(await req(agent,port,'/bench'))}}
 await Promise.all(Array.from({length:concurrency},worker));
 const elapsed=performance.now()-t;
 agent.destroy();await new Promise(r=>server.close(r));
 return {rps:total/(elapsed/1000),p50:pct(lat,.5),p95:pct(lat,.95),p99:pct(lat,.99)};
}
(async()=>{
 const out={node:process.version,version:aisite.version,results:[]};
 for(const routes of [100,1000,5000,10000]){
   const rows=[];for(let i=0;i<3;i++)rows.push(await once(routes));
   out.results.push({routes,n:3,rps:median(rows.map(x=>x.rps)),p50Ms:median(rows.map(x=>x.p50)),p95Ms:median(rows.map(x=>x.p95)),p99Ms:median(rows.map(x=>x.p99))});
 }
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
