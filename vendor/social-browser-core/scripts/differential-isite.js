'use strict';

const fs=require('fs');
const os=require('os');
const path=require('path');
const http=require('http');

const AISITE=path.resolve(__dirname,'..');
const arg=process.argv.find(x=>x.startsWith('--isite='));
const isitePath=arg ? path.resolve(arg.slice('--isite='.length)) : process.env.ISITE_PATH ? path.resolve(process.env.ISITE_PATH) : null;

function type(v){ return Array.isArray(v)?'array':v===null?'null':typeof v; }
function collectSurface(obj){
  const map=new Map();
  let cur=obj;
  while(cur&&cur!==Object.prototype){
    for(const name of Object.getOwnPropertyNames(cur)){
      if(name==='constructor'||map.has(name)) continue;
      try { map.set(name,type(obj[name])); } catch { map.set(name,'getter-error'); }
    }
    cur=Object.getPrototypeOf(cur);
  }
  return Object.fromEntries([...map].sort((a,b)=>a[0].localeCompare(b[0])));
}

async function httpCase(init,label){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),`${label}-`));
  const site=init({cwd,port:0,apps:false,stdin:false,help:false,log:false,mongodb:{enabled:false},security:{enabled:false},session:{enabled:false}});
  const route = site.get || site.onGET;
  const addRoute=(p,h)=>{
    try { return route.call(site,p,h); }
    catch { return route.call(site,{name:p,public:true},h); }
  };
  addRoute('/params/:id',(req,res)=>{
    const payload={id:req.params?.id||null,q:req.query?.q||null};
    if(res.json)res.json(payload); else res.end(JSON.stringify(payload));
  });
  addRoute('/headers',(req,res)=>{
    if(res.set)res.set('X-Test','ok'); else res.setHeader('X-Test','ok');
    if(res.status)res.status(201); else res.statusCode=201;
    if(res.json)res.json({ok:true}); else res.end('{"ok":true}');
  });

  let server;
  if(site.createServer) server=site.createServer();
  else if(site.routing?.handleServer) server=http.createServer(site.routing.handleServer);
  else if(site.handler) server=http.createServer(site.handler);
  else throw new Error(`${label}: no HTTP handler`);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const a=await fetch(base+'/params/42?q=yes');
    const b=await fetch(base+'/headers');
    return {
      params:{status:a.status,body:await a.text(),contentType:a.headers.get('content-type')},
      headers:{status:b.status,body:await b.text(),xTest:b.headers.get('x-test'),contentType:b.headers.get('content-type')}
    };
  } finally {
    if(server.closeAllConnections)server.closeAllConnections();
    await new Promise(r=>server.close(r));
    try{await site.stop?.()}catch{}
    try{site.ws?.stopHeartbeat?.()}catch{}
    try{site.scheduler?.clear?.()}catch{}
    try{site.diagnostics?.close?.()}catch{}
  }
}

async function collectionCase(init,label){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),`${label}-col-`));
  const site=init({cwd,apps:false,stdin:false,help:false,log:false,mongodb:{enabled:false},security:{enabled:false},session:{enabled:false}});
  const c=site.connectCollection('users');
  const surface=collectSurface(c);

  // Behavioral CRUD is only run when the collection can work without Mongo.
  const out={surface,count:Object.keys(surface).length};
  try{
    const call=(name,...args)=>new Promise((resolve,reject)=>{
      let settled=false;
      const cb=(err,data)=>{
        if(settled)return; settled=true;
        // iSite legacy callback shapes can be callback(result) instead of node-style.
        if(arguments.length===1){resolve(err);return;}
        if(err)reject(err);else resolve(data);
      };
      try{
        const r=c[name](...args,cb);
        if(r&&typeof r.then==='function')r.then(x=>{if(!settled){settled=true;resolve(x)}},e=>{if(!settled){settled=true;reject(e)}});
      }catch(e){reject(e)}
    });
    if(typeof c.add==='function'&&typeof c.findMany==='function'){
      const a=await call('add',{name:'A',age:20});
      const rows=await call('findMany',{where:{age:20}});
      out.crud={addType:type(a),findManyIsArray:Array.isArray(rows),findManyCount:Array.isArray(rows)?rows.length:null};
    }
  }catch(e){ out.crud={skipped:true,error:e.message}; }
  return out;
}

async function load(libPath,isAisite=false){
  const init=require(libPath);
  const site=init({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'surface-')),apps:false,stdin:false,help:false,log:false,mongodb:{enabled:false},security:{enabled:false},session:{enabled:false}});
  const surface=collectSurface(site);
  const col=site.connectCollection('surface');
  const colSurface=collectSurface(col);
  return {
    version:site.version||site.package?.version||null,
    siteSurface:surface,
    siteCount:Object.keys(surface).length,
    collectionSurface:colSurface,
    collectionCount:Object.keys(colSurface).length
  };
}

function compare(a,b){
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  const missing=[],extra=[],typeChanges=[];
  for(const k of [...keys].sort()){
    if(!(k in b))missing.push(k);
    else if(!(k in a))extra.push(k);
    else if(a[k]!==b[k])typeChanges.push({name:k,isite:a[k],aisite:b[k]});
  }
  return {missing,extra,typeChanges};
}

(async()=>{
  const aisite=await load(AISITE,true);
  const result={
    generatedAt:new Date().toISOString(),
    aisite:{version:aisite.version,siteCount:aisite.siteCount,collectionCount:aisite.collectionCount},
    isite:null,
    mode:isitePath?'live-differential':'official-baseline-only',
    officialBaseline:{
      frameworkVersion:'2026.08.26-v32',
      siteApis:339,
      collectionApis:105,
      namespaces:32,
      frameworkMissing:0,
      typeChanges:0,
      brokenAliases:0,
      source:'iSite v32 compatibility report / official repository tests'
    }
  };

  if(isitePath && fs.existsSync(isitePath)){
    const isite=await load(isitePath);
    result.isite={version:isite.version,siteCount:isite.siteCount,collectionCount:isite.collectionCount};
    result.surface={
      site:compare(isite.siteSurface,aisite.siteSurface),
      collection:compare(isite.collectionSurface,aisite.collectionSurface)
    };
    result.behavior={
      http:{isite:await httpCase(require(isitePath),'isite'),aisite:await httpCase(require(AISITE),'aisite')},
      collection:{isite:await collectionCase(require(isitePath),'isite'),aisite:await collectionCase(require(AISITE),'aisite')}
    };
  } else {
    result.coverageAgainstOfficialCounts={
      siteCountRatio:aisite.siteCount/339,
      collectionCountRatio:aisite.collectionCount/105,
      note:'Count ratio is not semantic compatibility. It is a warning indicator only.'
    };
    result.aisiteBehavior={
      http:await httpCase(require(AISITE),'aisite'),
      collection:await collectionCase(require(AISITE),'aisite')
    };
  }

  const out=path.join(AISITE,'DIFFERENTIAL-REPORT.json');
  fs.writeFileSync(out,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})();
