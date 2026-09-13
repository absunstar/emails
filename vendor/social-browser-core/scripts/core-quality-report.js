'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const aisite=require('..');
(async()=>{
 const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-core-quality-'))});
 const checks=[];
 const add=(name,ok,details=null)=>checks.push({name,ok:!!ok,details});

 add('zeroCompatibilityByDefault',site.compatibility.isite===undefined);
 add('coreFiles',!!site.files&&typeof site.files.read==='function');
 add('coreSessions',!!site.sessionStore&&typeof site.sessionStore.commit==='function');
 add('requestTelemetry',!!site.requestTelemetry&&typeof site.requestTelemetry.recent==='function');
 add('responseCache',!!site.responseCache&&typeof site.responseCache.stats==='function');
 add('scheduler',!!site.scheduler&&typeof site.scheduler.later==='function');
 add('hooks',!!site.hooks&&typeof site.hooks.run==='function');
 add('inflight',!!site.inflight&&typeof site.inflight.run==='function');

 console.log(JSON.stringify({
   version:site.version,
   passed:checks.filter(x=>x.ok).length,
   total:checks.length,
   score:checks.filter(x=>x.ok).length/checks.length,
   checks
 },null,2));
})();
