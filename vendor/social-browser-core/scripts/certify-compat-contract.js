'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const r=spawnSync(process.execPath,['--test','--test-name-pattern=manifest|strict compatibility|strict runtime assertion','test/v610-compatibility-safety.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
const report={generatedAt:new Date().toISOString(),version:require('../package.json').version,contract:'isite/2026.08.31',pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-14000),stderr:(r.stderr||'').slice(-5000)};
fs.writeFileSync(path.join(root,'CERTIFICATION-COMPAT-CONTRACT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(report.pass?0:1);
