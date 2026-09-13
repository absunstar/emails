'use strict';
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawnSync}=require('child_process');
const {performance}=require('perf_hooks');
const core=require('..');
const {StorageEngine}=require('../lib/storage-engine');

const root=path.resolve(__dirname,'..');
function temp(name){return fs.mkdtempSync(path.join(os.tmpdir(),name))}
function runTests(){
  const r=spawnSync(process.execPath,['--test','test/v6100-storage-response-foundation.test.js'],{
    cwd:root,encoding:'utf8',timeout:180000
  });
  return{pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-16000),stderr:(r.stderr||'').slice(-3000)};
}
async function benchmark(){
  const out={};
  let dir=temp('sb-cert-limit-'),db=new StorageEngine('x',{dir,identity:false});
  db.docs=Array.from({length:30000},(_,i)=>({_id:String(i),group:i<15000?'a':'b',payload:'x'.repeat(64)}));
  let loops=60,t=performance.now();
  for(let i=0;i<loops;i++)db.query({where:{group:'a'},limit:1});
  out.limit1AvgMs=(performance.now()-t)/loops;
  fs.rmSync(dir,{recursive:true,force:true});

  dir=temp('sb-cert-sort-');db=new StorageEngine('x',{dir,identity:false});
  db.docs=Array.from({length:15000},(_,i)=>({_id:String(i),group:i%2,score:(i*7919)%15013}));
  loops=15;t=performance.now();
  for(let i=0;i<loops;i++)db.query({where:{group:1},sort:{score:-1},limit:25});
  out.sorted25AvgMs=(performance.now()-t)/loops;
  fs.rmSync(dir,{recursive:true,force:true});

  dir=temp('sb-cert-unique-');db=new StorageEngine('x',{dir,identity:false});
  db.docs=Array.from({length:8000},(_,i)=>({_id:String(i),email:`u${i}@x.test`}));
  db.createIndex('email',{unique:true});
  loops=300;t=performance.now();
  for(let i=0;i<loops;i++)db._assertUnique({_id:'n'+i,email:`n${i}@x.test`});
  out.uniqueCheckAvgMs=(performance.now()-t)/loops;
  fs.rmSync(dir,{recursive:true,force:true});

  dir=temp('sb-cert-provider-');
  const site=core({cwd:dir,fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  const col=site.connectCollection('items',{dir:path.join(dir,'data')});
  loops=75;t=performance.now();
  for(let i=0;i<loops;i++)await col.add({name:'n'+i,value:i});
  out.productionWriteAvgMs=(performance.now()-t)/loops;
  out.productionDurability=col.engine?.durability;
  out.productionCrashSafe=col.engine?.crashSafe;
  await site.stop({forceAfterMs:50});
  fs.rmSync(dir,{recursive:true,force:true});
  return out;
}
(async()=>{
  const tests=runTests();
  const bench=await benchmark();
  const checks={
    tests:tests.pass,
    limit1:bench.limit1AvgMs<2,
    sorted25:bench.sorted25AvgMs<50,
    uniqueCheck:bench.uniqueCheckAvgMs<0.25,
    productionWrite:bench.productionWriteAvgMs<5,
    productionWal:bench.productionDurability==='wal',
    crashSafe:bench.productionCrashSafe===true
  };
  const report={
    generatedAt:new Date().toISOString(),
    version:require('../package.json').version,
    runtime:process.version,
    tests,
    benchmark:bench,
    thresholds:{limit1AvgMsMax:2,sorted25AvgMsMax:50,uniqueCheckAvgMsMax:.25,productionWriteAvgMsMax:5},
    checks,
    pass:Object.values(checks).every(Boolean)
  };
  fs.writeFileSync(path.join(root,'CERTIFICATION-STORAGE-RESPONSE.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,tests:{...tests,stdout:undefined,stderr:undefined}},null,2));
  process.exit(report.pass?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
