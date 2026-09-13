'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const core=require('..');

const root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'compat','isite','contracts','isite-v30-documented-surface.json'),'utf8'));
const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});

const siteMissing=manifest.siteMethods.filter(name=>typeof site[name]!=='function');
const aliasMissing=manifest.sourceAliases.filter(name=>name==='fn'?typeof site.fn!=='object':typeof site[name]!=='function');
const nestedMissing={};
for(const [ns,names] of Object.entries(manifest.nested)){
  const rows=names.filter(name=>typeof site[ns]?.[name]!=='function');
  if(rows.length)nestedMissing[ns]=rows;
}
const tests=spawnSync(process.execPath,['--test','test/v6102-isite-public-surface.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
const report={
  generatedAt:new Date().toISOString(),
  version:require('../package.json').version,
  runtime:process.version,
  source:manifest.source,
  counts:{
    documentedSiteMethods:manifest.siteMethods.length,
    sourceAliases:manifest.sourceAliases.length,
    nestedMethods:Object.values(manifest.nested).reduce((n,x)=>n+x.length,0)
  },
  missing:{site:siteMissing,aliases:aliasMissing,nested:nestedMissing},
  tests:{pass:tests.status===0,status:tests.status},
  pass:siteMissing.length===0&&aliasMissing.length===0&&Object.keys(nestedMissing).length===0&&tests.status===0
};
fs.writeFileSync(path.join(root,'CERTIFICATION-ISITE-SURFACE.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
site.memoryPressure?.stop?.();
process.exit(report.pass?0:1);
