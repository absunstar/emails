'use strict';
const fs=require('fs');
const os=require('os');
const path=require('path');
const aisite=require('..');

(async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-bench-'));
  const site=aisite({cwd});
  const c=site.connectCollection('bench');
  const N=10000;
  const t0=performance.now();
  await c.insertMany(Array.from({length:N},(_,i)=>({email:`u${i}@x.test`,group:i%50,value:i})));
  const insertMs=performance.now()-t0;

  c.createIndex('email',{unique:true});
  c.createIndex('group');

  const t1=performance.now();
  for(let i=0;i<1000;i++) await c.findOne({where:{email:`u${i%N}@x.test`}});
  const indexedLookup1000Ms=performance.now()-t1;

  const t2=performance.now();
  for(let i=0;i<100;i++) await c.findMany({where:{group:i%50},limit:100});
  const indexedGroup100Ms=performance.now()-t2;

  console.log(JSON.stringify({
    rows:N,
    insertMs:+insertMs.toFixed(2),
    indexedLookup1000Ms:+indexedLookup1000Ms.toFixed(2),
    indexedGroup100Ms:+indexedGroup100Ms.toFixed(2),
    stats:c.stats()
  },null,2));
})();
