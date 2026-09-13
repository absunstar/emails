'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const {performance}=require('perf_hooks');
const aisite=require('..');
(async()=>{
 const N=10_000_000,BATCH=100_000,cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-10m-iso-'));
 let site=aisite({cwd});let c=site.connectCollection('records',{storageMode:'paged',slotChunkSize:1_000_000,objectIdStrategy:'sequential'});
 c.engine.beginBulk();const t0=performance.now();let peak=process.memoryUsage().rss;
 for(let base=0;base<N;base+=BATCH){
   const docs=new Array(BATCH);for(let j=0;j<BATCH;j++)docs[j]={value:base+j,group:(base+j)%100};
   c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
   peak=Math.max(peak,process.memoryUsage().rss);
 }
 c.engine.endBulk();const loadMs=performance.now()-t0;const stats=c.stats();c.engine.close();site=null;c=null;
 const childCode=`
 const {performance}=require('perf_hooks');
 const aisite=require(${JSON.stringify('/mnt/data/aisite-v2.0.0-alpha2')});
 const t=performance.now();const site=aisite({cwd:${JSON.stringify(cwd)}});const c=site.connectCollection('records',{storageMode:'paged',slotChunkSize:1000000,objectIdStrategy:'sequential'});const openMs=performance.now()-t;
 const rss=process.memoryUsage().rss/1048576;
 (async()=>{const t2=performance.now();for(let i=0;i<5000;i++){const id=((i*7919)%10000000)+1;const x=await c.findOne({where:{id}});if(!x||x.id!==id)throw new Error('mismatch')}const ms=performance.now()-t2;console.log(JSON.stringify({openMs,rssMB:rss,lookup5000Ms:ms,lookupOpsPerSec:5000/(ms/1000),stats:c.stats()}));c.engine.close()})().catch(e=>{console.error(e.stack);process.exit(1)});`;
 const child=cp.spawnSync(process.execPath,['-e',childCode],{encoding:'utf8',maxBuffer:10*1024*1024});
 if(child.status!==0)throw new Error(child.stderr);
 const isolated=JSON.parse(child.stdout.trim().split(/\r?\n/).pop());
 console.log(JSON.stringify({version:aisite.version,N,loadMs,docsPerSec:N/(loadMs/1000),bulkPeakRssMB:peak/1048576,files:{dataBytes:stats.dataBytes,indexBytes:stats.indexBytes},isolatedReopen:isolated},null,2));
 fs.rmSync(cwd,{recursive:true,force:true});
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
