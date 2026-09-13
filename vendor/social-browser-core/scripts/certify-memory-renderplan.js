'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const {performance}=require('perf_hooks');
const core=require('..');

const root=path.resolve(__dirname,'..');
function runTests(){
  const r=spawnSync(process.execPath,['--test','test/v680-foundation-memory-renderplan.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
  return{pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-12000),stderr:(r.stderr||'').slice(-2500)};
}
function renderBench(){
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  site.setting.show=true;site.security.isUserHasPermission=()=>true;site.security.isUserHasRole=()=>true;site.word=n=>n==='x'?'X':n;
  const req={session:{language:{id:'En'}},data:{},features:['f'],hasFeature:n=>n==='f',word:n=>site.word(n)};
  const row='<div class="a" id="b" data-x="1" aria-label="plain" x-setting="show" x-permission="read" x-role="admin" x-feature="f">##word.x##</div>';
  const html=row.repeat(1000);
  const ctx={req,file:'/tmp/core-v680-render-plan.html'};
  site.parser.html(html,ctx);
  const n=80,t=performance.now();
  for(let i=0;i<n;i++)site.parser.html(html,ctx);
  const ms=performance.now()-t,stats=site.parser.stats();
  site.memoryPressure.stop();
  return{renders:n,totalMs:ms,avgMs:ms/n,stats};
}
const tests=runTests(),render=renderBench();
const checks={
  tests:tests.pass,
  renderPlans:render.stats.renderPlansCompiled>=1,
  renderNodes:render.stats.renderPlanNodes>=1000,
  renderAvgMs:render.avgMs<30
};
const report={
  generatedAt:new Date().toISOString(),
  version:require('../package.json').version,
  runtime:process.version,
  tests,render,
  checks,
  pass:Object.values(checks).every(Boolean)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-MEMORY-RENDERPLAN.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,tests:{...tests,stdout:undefined,stderr:undefined}},null,2));
process.exit(report.pass?0:1);
