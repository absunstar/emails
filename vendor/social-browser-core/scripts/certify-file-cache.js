'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {performance}=require('node:perf_hooks');
const core=require('..');

const root=path.resolve(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-cache-cert-'));
const siteFiles=path.join(dir,'site_files'),htmlDir=path.join(siteFiles,'html');fs.mkdirSync(htmlDir,{recursive:true});
const raw=path.join(dir,'payload.txt');fs.writeFileSync(raw,'x'.repeat(64*1024));
const part=path.join(htmlDir,'part.html');fs.writeFileSync(part,'<section><b>##data.name##</b><i>##data.value##</i></section>');
const page=path.join(htmlDir,'page.html');fs.writeFileSync(page,'<!doctype html><html><body><header>Header</header><div x-import="part.html"></div><footer>Footer</footer></body></html>');

function measure(fn,iterations){
  for(let i=0;i<Math.min(100,iterations);i++)fn(i);
  const start=performance.now();for(let i=0;i<iterations;i++)fn(i);return performance.now()-start;
}
function speedup(slow,fast){return slow/Math.max(fast,0.0001)}

const disabled=core({cwd:dir,dir:siteFiles,fileCache:{enabled:false},compatibility:'isite'});
const enabled=core({cwd:dir,dir:siteFiles,fileCache:{enabled:true,mode:'production'},compatibility:'isite'});

const rawIterations=4000;
const rawDiskMs=measure(()=>fs.readFileSync(raw,'utf8'),rawIterations);
const rawCacheMs=measure(()=>enabled.fileCache.getTextSync(raw),rawIterations);

const nativeIterations=3000;
const nativeDisabled=core({cwd:dir,dir:siteFiles,fileCache:{enabled:false}});
const nativeEnabled=core({cwd:dir,dir:siteFiles,fileCache:{enabled:true,mode:'production'}});
const nativeDiskMs=measure(()=>nativeDisabled.render(path.relative(siteFiles,page),{name:'A',value:1}),nativeIterations);
const nativeCacheMs=measure(()=>nativeEnabled.render(path.relative(siteFiles,page),{name:'A',value:1}),nativeIterations);

const compatIterations=1200;
const reqA={data:{name:'A',value:1},session:{},features:[]};
const reqB={data:{name:'A',value:1},session:{},features:[]};
const compatDisabledMs=measure(()=>disabled.parser.renderFile(page,reqA,reqA.data),compatIterations);
const compatCacheMs=measure(()=>enabled.parser.renderFile(page,reqB,reqB.data),compatIterations);

const report={
  generatedAt:new Date().toISOString(),version:core.version,runtime:process.version,
  note:'Environment-local regression benchmark; values are not public capacity claims.',
  rawFile:{iterations:rawIterations,diskMs:rawDiskMs,cacheMs:rawCacheMs,speedup:speedup(rawDiskMs,rawCacheMs)},
  nativeTemplate:{iterations:nativeIterations,cacheDisabledMs:nativeDiskMs,cacheEnabledMs:nativeCacheMs,speedup:speedup(nativeDiskMs,nativeCacheMs)},
  isiteCompatibilityTemplate:{iterations:compatIterations,cacheDisabledMs:compatDisabledMs,cacheEnabledMs:compatCacheMs,speedup:speedup(compatDisabledMs,compatCacheMs)},
  cacheStats:enabled.fileCache.stats()
};
report.checks={
  rawFileFaster:report.rawFile.speedup>1.2,
  nativeNoRegression:report.nativeTemplate.speedup>0.9,
  compatFaster:report.isiteCompatibilityTemplate.speedup>1.2,
  compiledCacheUsed:report.cacheStats.compiledHits>0,
  fileCacheUsed:report.cacheStats.hits>0
};
report.pass=Object.values(report.checks).every(Boolean);
fs.writeFileSync(path.join(root,'CERTIFICATION-FILE-CACHE.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
