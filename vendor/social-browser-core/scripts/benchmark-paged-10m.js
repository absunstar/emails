'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
  const N=10_000_000;
  const BATCH=100_000;
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-10m-'));
  let site=aisite({cwd});
  let c=site.connectCollection('records',{
    storageMode:'paged',
    slotChunkSize:1_000_000,
    maxPagesInMemory:64,
    objectIdStrategy:'sequential'
  });
  c.engine.beginBulk();
  const t0=performance.now();
  let peakRss=process.memoryUsage().rss;
  for(let base=0;base<N;base+=BATCH){
    const count=Math.min(BATCH,N-base);
    const docs=new Array(count);
    for(let j=0;j<count;j++) docs[j]={value:base+j,group:(base+j)%100};
    c.engine.insertManySync(docs,{deferPersist:true,returnDocs:false});
    const rss=process.memoryUsage().rss;if(rss>peakRss)peakRss=rss;
    if((base/BATCH)%10===9) console.error(`loaded ${base+count}/${N}`);
  }
  const insertOnlyMs=performance.now()-t0;
  const tf=performance.now();
  c.engine.endBulk();
  const flushMs=performance.now()-tf;
  const totalLoadMs=performance.now()-t0;
  const beforeClose=c.stats();
  const rssAfterLoad=process.memoryUsage().rss;
  const dataFile=c.engine.dataFile,indexFile=c.engine.indexFile,metaFile=c.engine.metaFile;
  c.engine.close();
  site=null;c=null;
  global.gc?.();

  const tr=performance.now();
  site=aisite({cwd});
  c=site.connectCollection('records',{storageMode:'paged',slotChunkSize:1_000_000,maxPagesInMemory:64,objectIdStrategy:'sequential'});
  const reopenMs=performance.now()-tr;
  const rssAfterReopen=process.memoryUsage().rss;

  const ids=[1,2,123456,5_000_000,9_999_999,10_000_000];
  const lookup=[];
  for(const id of ids){
    const t=performance.now();
    const row=await c.findOne({where:{id}});
    lookup.push({id,ms:performance.now()-t,ok:!!row,value:row?.value});
  }
  const tloop=performance.now();
  for(let i=0;i<5000;i++){
    const id=((i*7919)%N)+1;
    const row=await c.findOne({where:{id}});
    if(!row||row.id!==id)throw new Error('lookup mismatch '+id);
  }
  const lookup5000Ms=performance.now()-tloop;

  const result={
    version:aisite.version,node:process.version,N,batch:BATCH,
    insertOnlyMs,flushMs,totalLoadMs,docsPerSec:N/(totalLoadMs/1000),
    memory:{peakRssMB:peakRss/1048576,rssAfterLoadMB:rssAfterLoad/1048576,rssAfterReopenMB:rssAfterReopen/1048576},
    files:{dataBytes:fs.statSync(dataFile).size,indexBytes:fs.statSync(indexFile).size,metaBytes:fs.statSync(metaFile).size},
    storageBeforeClose:beforeClose,
    reopenMs,
    lookups:lookup,
    lookup5000Ms,lookupOpsPerSec:5000/(lookup5000Ms/1000)
  };
  console.log(JSON.stringify(result,null,2));
  c.engine.close();
  fs.rmSync(cwd,{recursive:true,force:true});
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
