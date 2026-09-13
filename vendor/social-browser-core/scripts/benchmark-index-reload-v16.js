'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function rss(){return process.memoryUsage().rss/1048576}
async function prepare(N){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v16-index-'));
  let site=aisite({cwd});
  let c=site.connectCollection('bench',{durability:'wal',walCompactEvery:1000000,persistIndexes:true,lazyIndexes:false});
  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i,group:'g'+(i%100)}));
  await c.insertMany(docs);
  c.createIndex('email',{unique:true,lazy:false});
  c.createIndex('score',{lazy:false});
  c.createCompoundIndex(['group','score'],{lazy:false});
  c.compact();
  return cwd;
}
function open(cwd,lazy,persist){
  const t=performance.now();
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{
    durability:'wal',persistIndexes:persist,lazyIndexes:lazy,indexes:[
      {field:'email',unique:true},{field:'score'},{fields:['group','score']}
    ]
  });
  const openMs=performance.now()-t;
  return {c,openMs,rss:rss()};
}
async function run(N){
  const cwd=await prepare(N);

  // Persisted eager loading: read persisted snapshots during open.
  global.gc?.();
  let x=open(cwd,false,true);
  const persistedEagerOpenMs=x.openMs;
  let t=performance.now();x.c.engine.query({where:{email:`u${N-1}@x.test`},limit:1});const persistedEagerFirstQueryMs=performance.now()-t;
  const persistedEagerRss=x.rss;
  x=null;global.gc?.();

  // Persisted lazy loading: startup loads docs/specs only; first indexed query loads snapshot.
  x=open(cwd,true,true);
  const persistedLazyOpenMs=x.openMs;
  t=performance.now();x.c.engine.query({where:{email:`u${N-1}@x.test`},limit:1});const persistedLazyFirstQueryMs=performance.now()-t;
  const persistedLazyRss=x.rss;
  x=null;global.gc?.();

  // Rebuild baseline: disable snapshots, eager build all indexes.
  x=open(cwd,false,false);
  const rebuildOpenMs=x.openMs;
  t=performance.now();x.c.engine.query({where:{email:`u${N-1}@x.test`},limit:1});const rebuildFirstQueryMs=performance.now()-t;
  const rebuildRss=x.rss;

  let indexSnapshotBytes=0,dataBytes=0;
  try{indexSnapshotBytes=fs.statSync(path.join(cwd,'.aisite','data','bench.indexes.json')).size}catch{}
  try{dataBytes=fs.statSync(path.join(cwd,'.aisite','data','bench.json')).size}catch{}

  return {N,dataBytes,indexSnapshotBytes,
    persistedEager:{openMs:persistedEagerOpenMs,firstQueryMs:persistedEagerFirstQueryMs,rssMB:persistedEagerRss},
    persistedLazy:{openMs:persistedLazyOpenMs,firstQueryMs:persistedLazyFirstQueryMs,rssMB:persistedLazyRss},
    rebuild:{openMs:rebuildOpenMs,firstQueryMs:rebuildFirstQueryMs,rssMB:rebuildRss}
  };
}
(async()=>{
  const results=[];
  for(const N of [100000,300000])results.push(await run(N));
  console.log(JSON.stringify({version:aisite.version,node:process.version,results},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
