'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const started=Date.now();
const r=spawnSync(process.execPath,['--test','test/v440-security-fuzz.test.js'],{cwd:root,encoding:'utf8',timeout:180000});
const report={
  generatedAt:new Date().toISOString(),
  package:require('../package.json').name,
  version:require('../package.json').version,
  scope:'Native Core fuzz/security certification',
  pass:r.status===0,
  status:r.status,
  durationMs:Date.now()-started,
  checks:[
    'prototype pollution paths',
    'ORM query complexity',
    'regex ReDoS guard',
    'router random-path fuzz',
    'WebSocket oversized frames',
    'malformed JSON',
    'oversized request body',
    'multipart boundary/body limits'
  ],
  stdout:(r.stdout||'').slice(-16000),
  stderr:(r.stderr||'').slice(-6000)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-SECURITY.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
