'use strict';
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const r=spawnSync(process.execPath,['--test','test/v500-reliability-observability.test.js'],{cwd:root,encoding:'utf8',timeout:180000});
const report={
  generatedAt:new Date().toISOString(),version:require('../package.json').version,
  scope:'Reliability certification',pass:r.status===0,status:r.status,
  checks:['circuit breaker','retry/backoff','non-retryable safety','tracing','structured logging','health/readiness/metrics','drain/graceful shutdown'],
  stdout:(r.stdout||'').slice(-16000),stderr:(r.stderr||'').slice(-5000)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-RELIABILITY.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
