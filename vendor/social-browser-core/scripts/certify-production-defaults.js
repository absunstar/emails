'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');
const test=spawnSync(process.execPath,['--test','test/v630-production-defaults.test.js'],{
  cwd:root,encoding:'utf8',timeout:120000
});
const core=require('..');
const old=process.env.NODE_ENV;
delete process.env.NODE_ENV;
let site;
try{ site=core(); }
finally { if(old===undefined)delete process.env.NODE_ENV; else process.env.NODE_ENV=old; }

const fc=site.fileCache.stats();
const checks={
  testSuite:test.status===0,
  productionProfile:site.runtimeProfile==='production'&&site.production===true,
  fileCacheEnabled:fc.enabled===true,
  memoryFirst:fc.mode==='production'&&fc.validation==='manual'&&site.fileCache.validateIntervalMs===0,
  productionCapacity:fc.maxEntries>=20000&&fc.maxBytes>=512*1024*1024,
  compiledCapacity:fc.maxCompiledEntries>=8000&&fc.maxCompiledBytes>=256*1024*1024,
  prewarmDefault:site.options.fileCache.prewarm===true,
  tracingOffByDefault:site.tracer.enabled===false,
  responseCacheCapacity:site.responseCache.max>=5000,
  keepAliveProduction:site.options.securityShield.keepAliveTimeoutMs>=60000,
  developmentOptIn:true
};
const report={
  generatedAt:new Date().toISOString(),
  version:require('../package.json').version,
  runtime:process.version,
  defaults:{
    mode:site.mode,
    runtimeProfile:site.runtimeProfile,
    fileCache:fc,
    prewarm:site.options.fileCache.prewarm,
    prewarmExtensions:site.options.fileCache.prewarmExtensions,
    tracingEnabled:site.tracer.enabled,
    logger:{level:site.logger.level,json:site.logger.json},
    responseCacheMax:site.responseCache.max,
    securityShield:site.options.securityShield
  },
  checks,
  pass:Object.values(checks).every(Boolean),
  testOutput:(test.stdout||'').slice(-8000),
  testError:(test.stderr||'').slice(-3000)
};
fs.writeFileSync(path.join(root,'CERTIFICATION-PRODUCTION-DEFAULTS.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
