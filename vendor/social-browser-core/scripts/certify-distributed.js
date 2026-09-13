'use strict';
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const r=spawnSync(process.execPath,['--test','test/v600-distributed-platform.test.js'],{cwd:root,encoding:'utf8',timeout:180000});
const report={
  generatedAt:new Date().toISOString(),version:require('../package.json').version,
  scope:'Distributed/platform primitives',pass:r.status===0,status:r.status,
  checks:['cache TTL/CAS','locks','idempotency','shared rate limits','pluggable adapters','leader election','event bus','jobs','plugins','config masking','OpenAPI','distributed HTTP sessions','TypeScript declarations'],
  stdout:(r.stdout||'').slice(-18000),stderr:(r.stderr||'').slice(-5000)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-DISTRIBUTED.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
