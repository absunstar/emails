'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function rss(){return process.memoryUsage().rss/1048576}
async function prepare(N){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v17-compact-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{durability:'wal',walCompactEvery:1000000});
  const docs=Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,score:i,group:'g'+(i%100)}));
  await c.insertMany(docs);
  c.compact();
  return cwd;
}
function open(cwd,opts){
  const t=performance.now();
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{durability:'wal',persistIndexes:false,indexes:[
    {field:'email',unique:true},{field:'score'},{fields:['group','score']}
  ],...opts});
  return {c,openMs:performance.now()-t,rssMB:rss()};
}
function firstEq(c,N){
  const t=performance.now();
  const v=c.engine.query({where:{email:`u${N-1}@x.test`},limit:1});
  return {ms:performance.now()-t,ok:v.length===1};
}
function firstRange(c){
  const t=performance.now();
  const v=c.engine.query({where:{score:{$gte:10000,$lte:10100}},limit:20});
  return {ms:performance.now()-t,count:v.length};
}
async function run(N){
  const cwd=await prepare(N);
  const cases={};
  for(const [name,opts] of Object.entries({
    standardEager:{compactIndexes:false,lazyIndexes:false,lazySortedIndexes:false},
    compactEager:{compactIndexes:true,lazyIndexes:false,lazySortedIndexes:true},
    compactLazy:{compactIndexes:true,lazyIndexes:true,lazySortedIndexes:true}
  })){
    global.gc?.();
    const x=open(cwd,opts);
    const eq=firstEq(x.c,N);
    const afterEqRss=rss();
    const range=firstRange(x.c);
    const afterRangeRss=rss();
    cases[name]={openMs:x.openMs,openRssMB:x.rssMB,firstEqualityMs:eq.ms,afterEqualityRssMB:afterEqRss,
      firstRangeMs:range.ms,afterRangeRssMB:afterRangeRss,loadedIndexes:x.c.engine.indexes.size};
  }
  return {N,cases};
}
(async()=>{
 const results=[];
 for(const N of [100000,300000])results.push(await run(N));
 console.log(JSON.stringify({version:aisite.version,node:process.version,results},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
