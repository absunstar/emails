'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const aisite=require('..');

function rss(){return process.memoryUsage().rss/1048576}
async function run(durability){
  const N=50000;
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-storage-v14-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench',{compactEvery:1000000,durability,walCompactEvery:1000000});
  const docs=Array.from({length:N},(_,i)=>({
    id:i+1,email:`user${i}@example.com`,age:i%100,score:i,group:'g'+(i%50),name:'User '+i,active:(i%2)===0
  }));

  let t=performance.now();await c.insertMany(docs);const insertMs=performance.now()-t;
  c.createIndex('email',{unique:true}); c.createIndex('score'); c.createCompoundIndex(['group','age']);
  const afterIndexRss=rss();

  t=performance.now();
  for(let i=0;i<5000;i++) c.engine.query({where:{email:`user${(i*7919)%N}@example.com`},limit:1});
  const equality5000Ms=performance.now()-t;

  t=performance.now();
  for(let i=0;i<1000;i++) c.engine.query({where:{score:{$gte:10000,$lte:10100}},limit:20});
  const range1000Ms=performance.now()-t;

  t=performance.now();
  for(let i=0;i<1000;i++) c.engine.queryPage({page:1000,limit:20,sort:{score:1}});
  const page1000Ms=performance.now()-t;

  t=performance.now();
  for(let i=0;i<1000;i++) await c.count({where:{group:'g10',age:10}});
  const count1000Ms=performance.now()-t;

  t=performance.now();await c.update({where:{email:'user25000@example.com'},set:{active:false}});const updateMs=performance.now()-t;
  t=performance.now();await c.delete({where:{email:'user25001@example.com'}});const deleteMs=performance.now()-t;

  t=performance.now();await c.transaction([
    {type:'add',doc:{email:'tx1@example.com',age:1,score:N+1,group:'tx'}},
    {type:'add',doc:{email:'tx2@example.com',age:2,score:N+2,group:'tx'}},
    {type:'update',where:{email:'user100@example.com'},patch:{active:false}}
  ]);const txMs=performance.now()-t;

  const stats=c.stats();
  return {
    durability,N,
    insertMany:{ms:insertMs,docsPerSec:N/(insertMs/1000)},
    reads:{
      equality5000Ms,equalityOpsPerSec:5000/(equality5000Ms/1000),
      range1000Ms,rangeOpsPerSec:1000/(range1000Ms/1000),
      page1000Ms,pageOpsPerSec:1000/(page1000Ms/1000),
      count1000Ms,countOpsPerSec:1000/(count1000Ms/1000)
    },
    writes:{updateOneMs:updateMs,deleteOneMs:deleteMs,transaction3OpsMs:txMs},
    memory:{afterIndexRssMB:afterIndexRss},
    storage:{bytes:stats.bytes,walBytes:stats.walBytes,documents:stats.documents}
  };
}

(async()=>{
  console.log(JSON.stringify({version:aisite.version,node:process.version,results:[await run('snapshot'),await run('wal')]},null,2));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
