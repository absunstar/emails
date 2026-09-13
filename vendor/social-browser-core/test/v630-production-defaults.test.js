'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');
const {FileCacheEngine}=require('../lib/file-cache');
const {ConfigManager}=require('../lib/config');

test('zero-config Core defaults to production runtime profile',()=>{
  const old=process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try{
    const site=core();
    assert.equal(site.mode,'production');
    assert.equal(site.runtimeProfile,'production');
    assert.equal(site.production,true);
    assert.equal(site.development,false);
    assert.equal(site.config.profile,'production');
    assert.equal(site.tracer.enabled,false);
    assert.equal(site.logger.level,'warn');
    assert.equal(site.logger.json,true);
    assert.equal(site.responseCache.max,5000);
    assert.equal(site.options.fileCache.prewarm,true);
    assert.equal(site.fileCache.mode,'production');
    assert.equal(site.fileCache.validation,'manual');
    assert.equal(site.fileCache.validateIntervalMs,0);
    assert.equal(site.fileCache.maxEntries,20000);
    assert.equal(site.fileCache.maxBytes,512*1024*1024);
    assert.equal(site.fileCache.maxCompiledEntries,8000);
    assert.equal(site.fileCache.maxCompiledBytes,256*1024*1024);
    assert.equal(site.options.securityShield.keepAliveTimeoutMs,65000);
    assert.equal(site.options.securityShield.maxRequestsPerSocket,10000);
  } finally {
    if(old===undefined)delete process.env.NODE_ENV; else process.env.NODE_ENV=old;
  }
});

test('development mode is explicit opt-in and restores change revalidation',()=>{
  const site=core({mode:'development'});
  assert.equal(site.runtimeProfile,'development');
  assert.equal(site.development,true);
  assert.equal(site.fileCache.mode,'development');
  assert.equal(site.fileCache.validation,'mtime');
  assert.equal(site.fileCache.validateIntervalMs,200);
  assert.equal(site.options.fileCache.prewarm,false);
  assert.equal(site.tracer.enabled,true);
  assert.equal(site.logger.level,'info');
  assert.equal(site.logger.json,false);
});

test('NODE_ENV=development is treated as explicit development opt-in',()=>{
  const old=process.env.NODE_ENV;
  process.env.NODE_ENV='development';
  try{
    const site=core();
    assert.equal(site.runtimeProfile,'development');
    assert.equal(site.fileCache.mode,'development');
  } finally {
    if(old===undefined)delete process.env.NODE_ENV; else process.env.NODE_ENV=old;
  }
});

test('standalone FileCacheEngine defaults to production memory-first settings',()=>{
  const old=process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try{
    const cache=new FileCacheEngine();
    assert.equal(cache.mode,'production');
    assert.equal(cache.validation,'manual');
    assert.equal(cache.validateIntervalMs,0);
    assert.equal(cache.maxEntries,20000);
    assert.equal(cache.maxBytes,512*1024*1024);
    assert.equal(cache.maxCompiledEntries,8000);
    assert.equal(cache.maxCompiledBytes,256*1024*1024);
  } finally {
    if(old===undefined)delete process.env.NODE_ENV; else process.env.NODE_ENV=old;
  }
});

test('production prewarm loads text/site assets before ready event',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-core-prod-'));
  fs.writeFileSync(path.join(dir,'index.html'),'<h1>cached</h1>');
  fs.writeFileSync(path.join(dir,'app.js'),'console.log(1)');
  const site=core({dir,port:0,host:'127.0.0.1'});
  await new Promise((resolve,reject)=>{
    site.once('error',reject);
    site.once('ready',resolve);
    site.run(0);
  });
  const stats=site.fileCache.stats();
  assert.ok(stats.prewarmed>=2);
  assert.ok(stats.entries>=2);
  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('explicit user production overrides always win over defaults',()=>{
  const site=core({
    fileCache:{maxBytes:64*1024*1024,maxEntries:1234,prewarm:false},
    tracing:{enabled:true},
    logger:{level:'error',json:false},
    responseCache:{max:42},
    securityShield:{keepAliveTimeoutMs:9000}
  });
  assert.equal(site.fileCache.maxBytes,64*1024*1024);
  assert.equal(site.fileCache.maxEntries,1234);
  assert.equal(site.options.fileCache.prewarm,false);
  assert.equal(site.tracer.enabled,true);
  assert.equal(site.logger.level,'error');
  assert.equal(site.logger.json,false);
  assert.equal(site.responseCache.max,42);
  assert.equal(site.options.securityShield.keepAliveTimeoutMs,9000);
});
