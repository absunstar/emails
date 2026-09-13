'use strict';
const cp=require('child_process');

function child(N,mode){
  const code=`
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('/mnt/data/aisite-v1.7.0');
function rss(){return process.memoryUsage().rss/1048576}
(async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-mem-child-'));
 const site=aisite({cwd});
 const c=site.connectCollection('bench',{durability:'wal',walCompactEvery:2000000,
   highScale:${mode==='highScale'?'true':'false'},
   compactIndexes:${mode==='compactEager'?'true':'false'},
   lazyIndexes:${mode==='highScale'?'true':'false'},
   lazySortedIndexes:${mode!=='standard'?'true':'false'},
   persistIndexes:false
 });
 const docs=Array.from({length:${N}},(_,i)=>({email:'u'+i+'@x.test',score:i,group:'g'+(i%100),flag:(i%2)===0}));
 let t=performance.now();await c.insertMany(docs);const insertMs=performance.now()-t;
 c.compact();
 const rssAfterData=rss();
 t=performance.now();
 c.createIndex('email',{unique:true,lazy:${mode==='highScale'?'true':'false'}});
 c.createIndex('score',{lazy:${mode==='highScale'?'true':'false'}});
 c.createCompoundIndex(['group','score'],{lazy:${mode==='highScale'?'true':'false'}});
 const indexDeclMs=performance.now()-t;
 const rssAfterIndexDecl=rss();
 t=performance.now();
 c.engine.query({where:{email:'u'+(${N}-1)+'@x.test'},limit:1});
 const firstEqMs=performance.now()-t;
 const rssAfterEq=rss();
 t=performance.now();
 c.engine.query({where:{score:{$gte:10000,$lte:10100}},limit:20});
 const firstRangeMs=performance.now()-t;
 const rssAfterRange=rss();
 console.log(JSON.stringify({N:${N},mode:'${mode}',insertMs,indexDeclMs,firstEqMs,firstRangeMs,
   rssAfterData,rssAfterIndexDecl,rssAfterEq,rssAfterRange,
   loadedIndexes:c.engine.indexes.size,docs:c.engine.docs.length,
   dataBytes:c.stats().bytes
 }));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
`;
  const r=cp.spawnSync(process.execPath,['--expose-gc','-e',code],{encoding:'utf8',maxBuffer:50*1024*1024});
  if(r.status!==0)return {N,mode,error:r.stderr||r.stdout,status:r.status};
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

const out={node:process.version,results:[]};
for(const N of [100000,300000,1000000]){
  for(const mode of ['standard','compactEager','highScale']){
    out.results.push(child(N,mode));
  }
}
console.log(JSON.stringify(out,null,2));
