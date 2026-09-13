'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

async function run(N,durability){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-delete-v15-fast-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{
    durability,
    walCompactEvery:1000000,
    compactEvery:1000000,
    tombstoneCompactRatio:0.95
  });
  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i,flag:false}));
  await c.insertMany(docs);
  c.createIndex('email',{unique:true});
  c.createIndex('score');

  const target=`u${Math.floor(N/2)}@x.test`;
  let t=performance.now();
  await c.delete({where:{email:target}});
  const deleteOneMs=performance.now()-t;

  const count=durability==='wal'?1000:50;
  t=performance.now();
  for(let i=0;i<count;i++)await c.delete({where:{email:`u${i}@x.test`}});
  const batchDeleteMs=performance.now()-t;

  t=performance.now();
  const compact=c.compactTombstones(true);
  const compactionMs=performance.now()-t;

  return {
    N,durability,
    deleteOneMs,
    deleteBatchCount:count,
    deleteBatchMs:batchDeleteMs,
    deleteOpsPerSec:count/(batchDeleteMs/1000),
    compactionMs,
    compact,
    rssMB:process.memoryUsage().rss/1048576
  };
}

(async()=>{
  const out={version:aisite.version,node:process.version,results:[]};
  for(const N of [50000,100000]){
    for(const durability of ['snapshot','wal'])out.results.push(await run(N,durability));
  }
  console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
