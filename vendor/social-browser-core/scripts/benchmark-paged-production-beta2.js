'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
 const N=1_000_000,batch=50_000;
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-b2-prod-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{storageMode:'paged',slotChunkSize:1_000_000,maxPagesInMemory:128});
 c.engine.beginBulk();
 let t=performance.now();
 for(let start=0;start<N;start+=batch){
   const docs=Array.from({length:Math.min(batch,N-start)},(_,j)=>{
     const i=start+j;
     return {score:i,group:i%100,value:i};
   });
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
 }
 c.engine.endBulk();
 const loadMs=performance.now()-t;

 t=performance.now();
 const rangeBuild=c.engine.createRangeIndex('score');
 const rangeBuildMs=performance.now()-t;

 t=performance.now();
 for(let i=0;i<5000;i++)c.engine.query({where:{id:((i*7919)%N)+1},limit:1});
 const direct5000Ms=performance.now()-t;

 t=performance.now();
 let rangeRows=0;
 for(let i=0;i<1000;i++){
   const a=(i*977)%900000;
   rangeRows+=c.engine.queryRange('score',{$gte:a,$lte:a+99},{limit:100}).length;
 }
 const range1000Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<100;i++)await c.update({where:{id:1000+i},set:{value:9_000_000+i}});
 const update100Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<100;i++)await c.delete({where:{id:2000+i}});
 const delete100Ms=performance.now()-t;

 const beforeCompact=c.stats();
 t=performance.now();
 const compact=c.engine.compactPaged();
 const compactMs=performance.now()-t;

 const afterCompact=c.stats();
 console.log(JSON.stringify({
   version:aisite.version,node:process.version,N,
   load:{ms:loadMs,docsPerSec:N/(loadMs/1000)},
   rangeIndex:{buildMs:rangeBuildMs,count:rangeBuild.count,fileBytes:fs.statSync(rangeBuild.file).size},
   reads:{
     direct5000Ms,directOpsPerSec:5000/(direct5000Ms/1000),
     range1000Ms,rangeOpsPerSec:1000/(range1000Ms/1000),rangeRows
   },
   writes:{
     update100Ms,updateOpsPerSec:100/(update100Ms/1000),
     delete100Ms,deleteOpsPerSec:100/(delete100Ms/1000)
   },
   compaction:{ms:compactMs,result:compact,before:beforeCompact,after:afterCompact},
   rssMB:process.memoryUsage().rss/1048576
 },null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
