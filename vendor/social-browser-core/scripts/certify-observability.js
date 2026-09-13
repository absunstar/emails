'use strict';
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const r=spawnSync(process.execPath,['--test','--test-name-pattern=observability endpoints|structured logger|tracer creates','test/v500-reliability-observability.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
const report={generatedAt:new Date().toISOString(),version:require('../package.json').version,scope:'Observability certification',pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-12000),stderr:(r.stderr||'').slice(-4000)};
fs.writeFileSync(path.join(root,'CERTIFICATION-OBSERVABILITY.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
