'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
 const N=300000;
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-b4-adaptive-fast-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{
   storageMode:'paged',
   adaptiveStorage:true,
   groupCommitMs:50
 });

 c.engine.beginBulk();
 for(let start=0;start<N;start+=50000){
   const docs=Array.from({length:Math.min(50000,N-start)},(_,j)=>{
     const i=start+j;
     return {email:`u${i}@x.test`,score:i,value:i};
   });
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
 }
 c.engine.endBulk();

 c.createIndex('email',{unique:true});
 c.engine.createRangeIndex('score');

 const plans={
   id:c.engine.explainAdaptive('read',{id:N-1}),
   hash:c.engine.explainAdaptive('read',{email:`u${N-2}@x.test`}),
   range:c.engine.explainAdaptive('read',{score:{$gte:100000,$lte:100100}}),
   updateId:c.engine.explainAdaptive('update',{id:100}),
   deleteId:c.engine.explainAdaptive('delete',{id:200}),
   write:c.engine.explainAdaptive('write',{})
 };

 let t=performance.now();
 for(let i=0;i<2000;i++)c.engine.query({where:{id:((i*7919)%N)+1},limit:1});
 const id2000Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<2000;i++)c.engine.query({where:{email:`u${(i*7919)%N}@x.test`},limit:1});
 const hash2000Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<300;i++){
   const a=(i*997)%200000;
   c.engine.query({where:{score:{$gte:a,$lte:a+99}},limit:100});
 }
 const range300Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<300;i++)await c.update({where:{id:i+1},set:{value:10_000_000+i}});
 const update300Ms=performance.now()-t;
 c.engine.flush();

 t=performance.now();
 for(let i=0;i<300;i++)await c.delete({where:{id:2000+i}});
 const delete300Ms=performance.now()-t;
 c.engine.flush();

 console.log(JSON.stringify({
   version:aisite.version,node:process.version,N,plans,
   reads:{
     id2000Ms,idOpsPerSec:2000/(id2000Ms/1000),
     hash2000Ms,hashOpsPerSec:2000/(hash2000Ms/1000),
     range300Ms,rangeOpsPerSec:300/(range300Ms/1000)
   },
   writes:{
     update300Ms,updateOpsPerSec:300/(update300Ms/1000),
     delete300Ms,deleteOpsPerSec:300/(delete300Ms/1000)
   },
   stats:c.stats(),
   rssMB:process.memoryUsage().rss/1048576
 },null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
