'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

async function setup(N,durability){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v15-del-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{
    durability,
    walCompactEvery:1000000,
    compactEvery:1000000,
    tombstoneCompactRatio:0.95
  });
  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i}));
  await c.insertMany(docs);
  c.createIndex('email',{unique:true});
  c.createIndex('score');
  return c;
}

async function snapshotOne(N){
  const c=await setup(N,'snapshot');
  const target=`u${Math.floor(N/2)}@x.test`;
  let t=performance.now();
  await c.delete({where:{email:target}});
  const deleteOneMs=performance.now()-t;
  t=performance.now();
  const comp=c.compactTombstones(true);
  const compactionMs=performance.now()-t;
  return {N,durability:'snapshot',deleteOneMs,compactionMs,comp};
}

async function walSustained(N){
  const c=await setup(N,'wal');
  const target=`u${Math.floor(N/2)}@x.test`;
  let t=performance.now();
  await c.delete({where:{email:target}});
  const deleteOneMs=performance.now()-t;
  t=performance.now();
  for(let i=0;i<1000;i++)await c.delete({where:{email:`u${i}@x.test`}});
  const delete1000Ms=performance.now()-t;
  t=performance.now();
  const comp=c.compactTombstones(true);
  const compactionMs=performance.now()-t;
  return {N,durability:'wal',deleteOneMs,delete1000Ms,deleteOpsPerSec:1000/(delete1000Ms/1000),compactionMs,comp};
}

(async()=>{
  const results=[];
  for(const N of [50000,100000]){
    results.push(await snapshotOne(N));
    results.push(await walSustained(N));
  }
  console.log(JSON.stringify({version:aisite.version,node:process.version,results},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
