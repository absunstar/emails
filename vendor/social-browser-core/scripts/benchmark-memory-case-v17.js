'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

(async()=>{
 const N=Number(process.argv[2]||100000);
 const mode=String(process.argv[3]||'highScale');
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-mem-case-'));
 const site=aisite({cwd});
 const opts={
   durability:'wal',walCompactEvery:2000000,persistIndexes:false,
   highScale:mode==='highScale',
   compactIndexes:mode==='compactEager',
   lazyIndexes:mode==='highScale',
   lazySortedIndexes:mode!=='standard'
 };
 const c=site.connectCollection('bench',opts);
 const docs=Array.from({length:N},(_,i)=>({email:'u'+i+'@x.test',score:i,group:'g'+(i%100),flag:(i%2)===0}));
 const rss=()=>process.memoryUsage().rss/1048576;
 let t=performance.now();await c.insertMany(docs);const insertMs=performance.now()-t;
 c.compact();
 const rssAfterData=rss();

 t=performance.now();
 c.createIndex('email',{unique:true,lazy:mode==='highScale'});
 c.createIndex('score',{lazy:mode==='highScale'});
 c.createCompoundIndex(['group','score'],{lazy:mode==='highScale'});
 const indexDeclMs=performance.now()-t;
 const rssAfterIndexDecl=rss();

 t=performance.now();c.engine.query({where:{email:'u'+(N-1)+'@x.test'},limit:1});const firstEqMs=performance.now()-t;
 const rssAfterEq=rss();
 t=performance.now();c.engine.query({where:{score:{$gte:10000,$lte:10100}},limit:20});const firstRangeMs=performance.now()-t;
 const rssAfterRange=rss();

 console.log(JSON.stringify({N,mode,insertMs,indexDeclMs,firstEqMs,firstRangeMs,rssAfterData,rssAfterIndexDecl,rssAfterEq,rssAfterRange,loadedIndexes:c.engine.indexes.size,dataBytes:c.stats().bytes}));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
