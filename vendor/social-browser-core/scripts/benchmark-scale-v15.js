'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function rss(){return process.memoryUsage().rss/1048576}

async function build(N){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-scale-v15-'));
  let site=aisite({cwd});
  let c=site.connectCollection('bench',{durability:'wal',walCompactEvery:1000000,tombstoneCompactRatio:0.95});
  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i,group:'g'+(i%100),flag:(i%2)===0}));
  let t=performance.now();
  await c.insertMany(docs);
  const insertMs=performance.now()-t;
  t=performance.now(); c.createIndex('email',{unique:true}); const emailIndexMs=performance.now()-t;
  t=performance.now(); c.createIndex('score'); const scoreIndexMs=performance.now()-t;
  t=performance.now(); c.createCompoundIndex(['group','score']); const compoundIndexMs=performance.now()-t;
  c.compact();
  const afterBuildRss=rss();

  // force release references, reload same collection
  site=null;c=null;
  global.gc?.();

  t=performance.now();
  const site2=aisite({cwd});
  const c2=site2.connectCollection('bench',{durability:'wal',indexes:[
    {field:'email',unique:true},
    {field:'score'},
    {fields:['group','score']}
  ]});
  const reloadMs=performance.now()-t;
  const afterReloadRss=rss();

  t=performance.now();
  for(let i=0;i<2000;i++)c2.engine.query({where:{email:`u${(i*7919)%N}@x.test`},limit:1});
  const lookup2000Ms=performance.now()-t;

  return {N,insertMs,emailIndexMs,scoreIndexMs,compoundIndexMs,reloadMs,lookup2000Ms,
    lookupOpsPerSec:2000/(lookup2000Ms/1000),afterBuildRss,afterReloadRss,storage:c2.stats()};
}

(async()=>{
 const results=[];
 for(const N of [100000,300000])results.push(await build(N));
 console.log(JSON.stringify({version:aisite.version,node:process.version,results},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
