'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
 const N=100000;
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-b4-overhead-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{storageMode:'paged',adaptiveStorage:true,groupCommitMs:50});

 c.engine.beginBulk();
 for(let start=0;start<N;start+=10000){
   const docs=Array.from({length:Math.min(10000,N-start)},(_,j)=>{
     const i=start+j;
     return {score:i,value:i};
   });
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
 }
 c.engine.endBulk();

 const plans={
   smallRead:c.engine.adaptivePlanner.chooseRead({count:5000}),
   mediumRead:c.engine.adaptivePlanner.chooseRead({count:100000}),
   hugeRead:c.engine.adaptivePlanner.chooseRead({count:10000000}),
   hugeWrite:c.engine.adaptivePlanner.chooseWrite({count:10000000}),
   directUpdate:c.engine.adaptivePlanner.chooseUpdate({count:10000000,directId:true}),
   directDelete:c.engine.adaptivePlanner.chooseDelete({count:10000000,directId:true})
 };

 let t=performance.now();
 for(let i=0;i<100000;i++)c.engine.explainAdaptive('read',{id:(i%N)+1});
 const planner100kMs=performance.now()-t;

 t=performance.now();
 for(let i=0;i<5000;i++)c.engine.query({where:{id:((i*7919)%N)+1},limit:1});
 const direct5000Ms=performance.now()-t;

 // Simulate large adaptive policy to force group commit while retaining only 100k physical records.
 c.engine.countLive=10_000_000;
 t=performance.now();
 for(let i=0;i<1000;i++)await c.update({where:{id:(i%N)+1},set:{value:20_000_000+i}});
 const update1000Ms=performance.now()-t;
 c.engine.flush();

 t=performance.now();
 for(let i=0;i<1000;i++)c.engine.delete({id:5000+i},false);
 const delete1000Ms=performance.now()-t;
 c.engine.flush();

 console.log(JSON.stringify({
   version:aisite.version,node:process.version,N,plans,
   planner:{calls:100000,ms:planner100kMs,opsPerSec:100000/(planner100kMs/1000)},
   reads:{direct5000Ms,opsPerSec:5000/(direct5000Ms/1000)},
   writes:{
     update1000Ms,updateOpsPerSec:1000/(update1000Ms/1000),
     delete1000Ms,deleteOpsPerSec:1000/(delete1000Ms/1000)
   },
   rssMB:process.memoryUsage().rss/1048576
 },null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
