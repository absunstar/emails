'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

async function setup(N,mode){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-b3-write-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{storageMode:'paged',writeDurability:mode,groupCommitMs:50});
 c.engine.beginBulk();
 for(let start=0;start<N;start+=50000){
   const docs=Array.from({length:Math.min(50000,N-start)},(_,j)=>({value:start+j}));
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
 }
 c.engine.endBulk();
 return c;
}
async function run(N,mode){
 const c=await setup(N,mode);
 let t=performance.now();
 for(let i=0;i<1000;i++)await c.update({where:{id:i+1},set:{value:10_000_000+i}});
 const update1000Ms=performance.now()-t;
 if(mode==='group')c.engine.flush();

 t=performance.now();
 for(let i=0;i<1000;i++)await c.delete({where:{id:2000+i}});
 const delete1000Ms=performance.now()-t;
 if(mode==='group')c.engine.flush();

 // one transaction with 1000 updates
 const ops=Array.from({length:1000},(_,i)=>({type:'update',where:{id:5000+i},patch:{value:20_000_000+i}}));
 t=performance.now();
 await c.engine.transaction(ops);
 const tx1000Ms=performance.now()-t;

 return {N,mode,
  update1000Ms,updateOpsPerSec:1000/(update1000Ms/1000),
  delete1000Ms,deleteOpsPerSec:1000/(delete1000Ms/1000),
  tx1000Ms,txOpsPerSec:1000/(tx1000Ms/1000),
  rssMB:process.memoryUsage().rss/1048576,
  stats:c.stats()
 };
}
(async()=>{
 const N=1_000_000;
 const results=[];
 for(const mode of ['sync','group'])results.push(await run(N,mode));
 console.log(JSON.stringify({version:aisite.version,node:process.version,results},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
