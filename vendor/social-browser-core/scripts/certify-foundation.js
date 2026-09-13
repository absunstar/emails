'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

function run(args,env={}){
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:240000,env:{...process.env,...env}});
  return{args,status:r.status,stdout:(r.stdout||'').slice(-12000),stderr:(r.stderr||'').slice(-4000)};
}
const rows=[];
rows.push(run(['--test','test/v660-foundation-phase2.test.js','test/v670-invalidation-foundation.test.js','test/v680-foundation-memory-renderplan.test.js','test/v690-session-coherence.test.js','test/v691-distributed-session-coherence.test.js','test/v6100-storage-response-foundation.test.js']));
rows.push(run(['scripts/certify-performance.js']));
rows.push(run(['scripts/certify-startup.js']));
rows.push(run(['scripts/certify-memory-renderplan.js']));
rows.push(run(['scripts/certify-storage-response.js']));
rows.push(run(['scripts/certify-isite-surface.js']));
if(process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH)rows.push(run(['scripts/certify-social-browser.js']));
const report={
  generatedAt:new Date().toISOString(),
  version:require('../package.json').version,
  node:process.version,
  checks:rows.map(x=>({command:[process.execPath,...x.args].join(' '),pass:x.status===0,status:x.status})),
  outputs:rows,
  liveISiteBenchmark:{
    available:false,
    reason:'Direct iSite runtime benchmark requires ISITE_PATH/--isite and the official runtime dependencies on the same machine.'
  }
};
report.pass=report.checks.every(x=>x.pass);
fs.writeFileSync(path.join(root,'CERTIFICATION-FOUNDATION.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,outputs:undefined},null,2));
process.exit(report.pass?0:1);
