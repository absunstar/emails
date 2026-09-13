'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

async function run(N,durability){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-delete-v15-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{
    durability,
    walCompactEvery:1000000,
    compactEvery:1000000,
    tombstoneCompactRatio:0.95
  });

  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i,group:'g'+(i%100),flag:false}));
  await c.insertMany(docs);
  c.createIndex('email',{unique:true});
  c.createIndex('score');

  const target=`u${Math.floor(N/2)}@x.test`;
  let t=performance.now();
  await c.delete({where:{email:target}});
  const deleteOneMs=performance.now()-t;

  t=performance.now();
  const missing=c.engine.query({where:{email:target}});
  const postDeleteLookupMs=performance.now()-t;

  // Delete 1000 indexed records one-by-one to measure sustained delete.
  t=performance.now();
  for(let i=0;i<1000;i++) await c.delete({where:{email:`u${i}@x.test`}});
  const delete1000Ms=performance.now()-t;

  t=performance.now();
  const comp=c.compactTombstones(true);
  const compactionMs=performance.now()-t;

  return {
    N,durability,
    deleteOneMs,
    postDeleteLookupMs,
    delete1000Ms,
    deleteOpsPerSec:1000/(delete1000Ms/1000),
    compactionMs,
    compacted:comp,
    stats:c.stats(),
    rssMB:process.memoryUsage().rss/1048576
  };
}

(async()=>{
  const out={version:aisite.version,node:process.version,results:[]};
  for(const N of [50000,100000]){
    for(const durability of ['snapshot','wal']){
      out.results.push(await run(N,durability));
    }
  }
  console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
