'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const root=path.resolve(__dirname,'..');
const child=`
const path=require('path');
const {performance}=require('perf_hooks');
const root=${JSON.stringify(root)};
const t0=performance.now();
const core=require(root);
const t1=performance.now();
const site=core({fileCache:{prewarm:false},session:{enabled:false}});
const t2=performance.now();
const loaded=Object.keys(require.cache).filter(x=>x.startsWith(root)).map(x=>path.relative(root,x));
console.log(JSON.stringify({
  requireMs:t1-t0,createMs:t2-t1,totalMs:t2-t0,
  loadedModules:loaded.length,loaded,
  rss:process.memoryUsage().rss,
  lazy:Object.fromEntries([...(site._lazyValues||[])].map(([k,v])=>[k,v.loaded]))
}));
site.stop({forceAfterMs:20}).catch(()=>{});
`;
const rows=[];
for(let i=0;i<7;i++){
  const r=spawnSync(process.execPath,['-e',child],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'production'}});
  if(r.status!==0)throw new Error(r.stderr||'startup child failed');
  rows.push(JSON.parse((r.stdout||'').trim().split(/\r?\n/)[0]));
}
const median=(list)=>{const a=[...list].sort((a,b)=>a-b);return a[Math.floor(a.length/2)]};
const summary={
  requireMs:median(rows.map(x=>x.requireMs)),
  createMs:median(rows.map(x=>x.createMs)),
  totalMs:median(rows.map(x=>x.totalMs)),
  loadedModules:median(rows.map(x=>x.loadedModules)),
  rss:median(rows.map(x=>x.rss))
};
const forbidden=['lib/protocol-runtime.js','lib/ftp-client.js','lib/smtp-client.js','lib/mqtt-client.js','lib/protocol-factory.js','lib/distributed.js','lib/jobs.js','lib/plugins.js','lib/openapi.js','lib/cluster-runtime.js','lib/orm-mongodb-provider.js','lib/orm-sql-provider.js','lib/migrations.js'];
const loaded=new Set(rows[0].loaded);
const checks={
  totalMs:summary.totalMs<100,
  loadedModules:summary.loadedModules<=50,
  rss:summary.rss<64*1024*1024,
  optionalModulesLazy:forbidden.every(x=>!loaded.has(x))
};
const report={
  generatedAt:new Date().toISOString(),
  version:require('../package.json').version,
  runtime:process.version,
  samples:rows.map(({loaded,...x})=>x),
  median:summary,
  forbiddenEagerModules:forbidden,
  checks,
  pass:Object.values(checks).every(Boolean)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-STARTUP.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
