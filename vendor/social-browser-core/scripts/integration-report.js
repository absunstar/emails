'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
const matrixFile=process.argv[2];
const matrix=matrixFile?JSON.parse(fs.readFileSync(matrixFile,'utf8')):null;

function surface(obj){
 const names=new Set();let cur=obj;
 while(cur&&cur!==Object.prototype){for(const n of Object.getOwnPropertyNames(cur))names.add(n);cur=Object.getPrototypeOf(cur)}
 return names;
}
const core=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-core-report-'))});
const legacy=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-compat-report-')),compatibility:'isite'});
const coreSite=surface(core), compatSite=surface(legacy), col=surface(legacy.connectCollection('x'));

const trackedHttpResponse=25,trackedHttpRequest=6,trackedHttpAliasGroups=4,trackedPrototype=3;
const trackedNamespaces={
 stream:['ndjson','jsonLines','jsonArray'],
 featuresV3:['clear','disable','enable','get','isEnabled','list','set'],
 query:['cached','generation','invalidate','invalidateAll','key','stats'],
 queryPlan:['clear','compile','instantiate','key','stats'],
 sessions:['attach','handleSessions','indexSession']
};
let nsTotal=0,nsPresent=0;
for(const [n,items] of Object.entries(trackedNamespaces)){nsTotal+=items.length;nsPresent+=items.filter(x=>typeof legacy[n]?.[x]==='function').length}

let observedServer={total:0,present:0,weightedTotal:0,weightedPresent:0,missing:[]};
if(matrix){
 for(const row of matrix.usage?.site||[]){
   if(row.name.includes('.')||!row.serverCount)continue;
   observedServer.total++;observedServer.weightedTotal+=row.count;
   const ok=compatSite.has(row.name);
   if(ok){observedServer.present++;observedServer.weightedPresent+=row.count}
   else observedServer.missing.push({name:row.name,count:row.count});
 }
 observedServer.missing.sort((a,b)=>b.count-a.count);
}

const frameworkHotPaths=new Set(['get_RegExp','getRegExp','fetch','request','fetchURLContent','post','get','on','call','connectCollection','cmd','copy','createDir','createDirSync','deleteFile','deleteFileSync','addApp','connectApp','addFeature','addfeatures','hasFeature','feature','callRoute','onPOST','onGET','onWS']);
const hotRows=matrix?(matrix.usage?.site||[]).filter(x=>!x.name.includes('.')&&frameworkHotPaths.has(x.name)):[];
const frameworkObserved={
 total:hotRows.length,
 present:hotRows.filter(x=>compatSite.has(x.name)).length,
 weightedTotal:hotRows.reduce((n,x)=>n+x.count,0),
 weightedPresent:hotRows.filter(x=>compatSite.has(x.name)).reduce((n,x)=>n+x.count,0)
};
frameworkObserved.ratio=frameworkObserved.total?frameworkObserved.present/frameworkObserved.total:1;
frameworkObserved.weightedRatio=frameworkObserved.weightedTotal?frameworkObserved.weightedPresent/frameworkObserved.weightedTotal:1;

const result={
 version:legacy.version,
 core:{
   externalRuntimeDependencies:0,
   isiteCompatibilityDefault:false,
   ownSurfaceCount:coreSite.size,
   qualityChecks:{
     storage:!!core.connectCollection,
     sessions:!!core.sessionStore,
     files:!!core.files,
     scheduler:!!core.scheduler,
     hooks:!!core.hooks,
     telemetry:!!core.requestTelemetry,
     responseCache:!!core.responseCache,
     streaming:!!core.streamTools,
     identity:!!core.identity,
     queryCache:!!core.queryCache
   }
 },
 compatibility:{
   officialBaselineCounts:{site:339,collection:105,namespaces:32},
   currentSurfaceCounts:{site:compatSite.size,collection:col.size},
   surfaceRatios:{site:compatSite.size/339,collection:col.size/105},
   baselineCoverageEstimate:{site:Math.min(1,compatSite.size/339),collection:Math.min(1,col.size/105)},
   extraSurface:{site:Math.max(0,compatSite.size-339),collection:Math.max(0,col.size-105)},
   exactTracked:{
     httpResponseFunctions:trackedHttpResponse,
     httpRequestFunctions:trackedHttpRequest,
     responseAliasGroups:trackedHttpAliasGroups,
     prototypeHelpers:trackedPrototype,
     namespaceFunctions:{present:nsPresent,total:nsTotal,ratio:nsPresent/nsTotal}
   },
   frameworkObservedUsage:frameworkObserved,
   observedServerUsage:{
     ...observedServer,
     ratio:observedServer.total?observedServer.present/observedServer.total:0,
     weightedRatio:observedServer.weightedTotal?observedServer.weightedPresent/observedServer.weightedTotal:0,
     topMissing:observedServer.missing.slice(0,30)
   }
 }
};
console.log(JSON.stringify(result,null,2));
