'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
 const N=100000;
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-b5-self-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{
   storageMode:'paged',
   adaptiveStorage:{minSamples:20,selfTune:true},
   autoIndex:false,
   autoTuneEvery:200
 });
 c.engine.beginBulk();
 for(let start=0;start<N;start+=10000){
   const docs=Array.from({length:Math.min(10000,N-start)},(_,j)=>{
     const i=start+j;return {email:`u${i}@x.test`,score:i,value:i};
   });
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
 }
 c.engine.endBulk();

 // train planner on equality/range patterns without auto-building yet
 for(let i=0;i<50;i++){
   c.engine.adaptivePlanner.observeQueryFields({email:`u${i}@x.test`});
   c.engine.adaptivePlanner.observeQueryFields({score:{$gte:i}});
 }
 const before=c.engine.adaptiveIndexRecommendations();

 let t=performance.now();
 for(let i=0;i<100000;i++)c.engine.explainAdaptive('read',{id:(i%N)+1});
 const explain100kMs=performance.now()-t;

 // apply recommended indexes on 100k dataset
 t=performance.now();
 const actions=c.engine.applyAdaptiveIndexRecommendations();
 const applyMs=performance.now()-t;
 const after=c.engine.adaptiveIndexRecommendations();

 t=performance.now();
 for(let i=0;i<5000;i++)c.engine.query({where:{email:`u${(i*7919)%N}@x.test`},limit:1});
 const hash5000Ms=performance.now()-t;

 t=performance.now();
 for(let i=0;i<500;i++)c.engine.query({where:{score:{$gte:(i*101)%90000,$lte:((i*101)%90000)+50}},limit:50});
 const range500Ms=performance.now()-t;

 // inject observed strategy latencies
 for(let i=0;i<60;i++)c.engine.adaptivePlanner.recordLatency('read','direct-slot',0.08);
 for(let i=0;i<60;i++)c.engine.adaptivePlanner.recordLatency('read','paged-scan',5.0);

 const tune=c.engine.adaptivePlanner.tune({count:N});

 console.log(JSON.stringify({
   version:aisite.version,node:process.version,N,
   recommendations:{before,actions,after},
   planner:{explain100kMs,explainOpsPerSec:100000/(explain100kMs/1000),bestRead:c.engine.adaptivePlanner.bestObserved('read'),tune},
   reads:{
     hash5000Ms,hashOpsPerSec:5000/(hash5000Ms/1000),
     range500Ms,rangeOpsPerSec:500/(range500Ms/1000)
   },
   stats:c.stats(),
   rssMB:process.memoryUsage().rss/1048576
 },null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
