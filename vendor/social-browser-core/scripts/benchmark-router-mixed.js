'use strict';
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function pct(a,p){a=[...a].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]||0}
function median(a){return pct(a,.5)}
function req(agent,port,p){
 return new Promise((resolve,reject)=>{
   const t=performance.now();
   const q=http.get({host:'127.0.0.1',port,path:p,agent},r=>{r.resume();r.on('end',()=>resolve(performance.now()-t))});
   q.on('error',reject);
 });
}
async function run(kind,count,total=6000,concurrency=64){
 const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-mixed-')),session:{enabled:false}});
 let target='/bench';
 if(kind==='exact'){
   for(let i=0;i<count;i++)site.get('/exact/'+i,(q,s)=>s.json({i}));
   target='/exact/'+(count-1);
 }else if(kind==='param'){
   for(let i=0;i<count;i++)site.get('/group'+i+'/:id',(q,s)=>s.json({id:q.params.id}));
   target='/group'+(count-1)+'/123';
 }else if(kind==='wildcard'){
   for(let i=0;i<count;i++)site.get('/files'+i+'/*',(q,s)=>s.json({p:q.params.wild}));
   target='/files'+(count-1)+'/a/b/c';
 }else if(kind==='mixed'){
   const each=Math.floor(count/3);
   for(let i=0;i<each;i++)site.get('/e/'+i,(q,s)=>s.json({i}));
   for(let i=0;i<each;i++)site.get('/p'+i+'/:id',(q,s)=>s.json({id:q.params.id}));
   for(let i=0;i<count-each*2;i++)site.get('/w'+i+'/*',(q,s)=>s.json({p:q.params.wild}));
   target='/p'+(each-1)+'/123';
 }
 const server=site.createServer();
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res)});
 const port=server.address().port,agent=new http.Agent({keepAlive:true,maxSockets:concurrency});
 for(let i=0;i<256;i+=64)await Promise.all(Array.from({length:64},()=>req(agent,port,target)));
 let next=0;const lat=[];const t=performance.now();
 async function worker(){while(true){const i=next++;if(i>=total)return;lat.push(await req(agent,port,target))}}
 await Promise.all(Array.from({length:concurrency},worker));
 const elapsed=performance.now()-t;
 agent.destroy();await new Promise(r=>server.close(r));
 return {rps:total/(elapsed/1000),p50Ms:pct(lat,.5),p95Ms:pct(lat,.95),p99Ms:pct(lat,.99)};
}
(async()=>{
 const out={version:aisite.version,node:process.version,results:[]};
 for(const count of [1000,10000]){
   for(const kind of ['exact','param','wildcard','mixed']){
     const rows=[];for(let i=0;i<3;i++)rows.push(await run(kind,count));
     out.results.push({kind,count,n:3,rps:median(rows.map(x=>x.rps)),p50Ms:median(rows.map(x=>x.p50Ms)),p95Ms:median(rows.map(x=>x.p95Ms)),p99Ms:median(rows.map(x=>x.p99Ms))});
   }
 }
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
