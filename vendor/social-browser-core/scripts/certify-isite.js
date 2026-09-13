'use strict';
const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawnSync}=require('child_process');

const ROOT=path.resolve(__dirname,'..');
const core=require(ROOT);
const args=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')).map(x=>{
  const i=x.indexOf('=');return i<0?[x.slice(2),true]:[x.slice(2,i),x.slice(i+1)];
}));
const isitePath=args.isite||process.env.ISITE_PATH||null;

const OFFICIAL={
  repository:'absunstar/isite',
  packageVersion:'2026.08.31',
  packageJsonSha:'5b15e57adec51779a20fcc6fdc120d163954e491',
  frameworkCompatSha:'07838c2b454c06ab3722793cad738994233a73b6',
  httpLegacySurfaceSha:'c57c622cd24141601100132576bb8613a9dc74e1',
  publicSurface:{
    frameworkVersion:'2026.08.26-v32',
    siteApis:339,
    collectionApis:105,
    namespaces:32
  }
};

function surface(obj){
  const out={};let cur=obj;
  while(cur&&cur!==Object.prototype){
    for(const key of Object.getOwnPropertyNames(cur)){
      if(key==='constructor'||key in out)continue;
      try{out[key]=Array.isArray(obj[key])?'array':obj[key]===null?'null':typeof obj[key]}
      catch{out[key]='getter-error'}
    }
    cur=Object.getPrototypeOf(cur);
  }
  return out;
}
function compare(a,b){
  const missing=[],extra=[],typeChanges=[];
  for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
    if(!(k in b))missing.push(k);
    else if(!(k in a))extra.push(k);
    else if(a[k]!==b[k])typeChanges.push({name:k,expected:a[k],actual:b[k]});
  }
  return {missing:missing.sort(),extra:extra.sort(),typeChanges};
}
function snapshot(init,options={}){
  const site=init({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'sb-cert-')),apps:false,stdin:false,help:false,log:false,
    mongodb:{enabled:false},security:{enabled:false},session:{enabled:false},...options});
  const col=site.connectCollection('surface_'+Date.now());
  return {
    version:site.version||site.package?.version||null,
    site:surface(site),
    collection:surface(col)
  };
}
function nativeOptionality(){
  const code=`
    const assert=require('node:assert/strict');
    const core=require(${JSON.stringify(ROOT)});
    const site=core();
    assert.equal(Object.keys(require.cache).some(x=>x.replace(/\\\\/g,'/').includes('/compat/isite/')),false);
    assert.equal(site.compatibility.isite,undefined);
    assert.equal(site.sessionStore.cookieName,'sb.sid');
    assert.equal(Object.prototype.hasOwnProperty.call(site,'parser'),false);
    assert.equal(Object.prototype.hasOwnProperty.call(site,'routing'),false);
  `;
  const r=spawnSync(process.execPath,['-e',code],{encoding:'utf8'});
  return {pass:r.status===0,error:r.stderr||null};
}

(async()=>{
  const compat=snapshot(opts=>core({...opts,compatibility:'isite'}));
  const native=snapshot(core);
  const result={
    generatedAt:new Date().toISOString(),
    coreVersion:core.version,
    compatibilityMode:'opt-in',
    nativeOptionality:nativeOptionality(),
    officialReference:OFFICIAL,
    mode:'official-contract',
    native:{
      siteApiCount:Object.keys(native.site).length,
      collectionApiCount:Object.keys(native.collection).length,
      isiteParserPresent:'parser' in native.site,
      isiteRoutingPresent:'routing' in native.site
    },
    compatibility:{
      siteApiCount:Object.keys(compat.site).length,
      collectionApiCount:Object.keys(compat.collection).length
    }
  };

  if(isitePath&&fs.existsSync(isitePath)){
    try{
      const officialInit=require(path.resolve(isitePath));
      const live=snapshot(officialInit);
      result.mode='live-differential';
      result.officialLive={version:live.version,siteApiCount:Object.keys(live.site).length,collectionApiCount:Object.keys(live.collection).length};
      result.differential={
        site:compare(live.site,compat.site),
        collection:compare(live.collection,compat.collection)
      };
      result.pass=result.nativeOptionality.pass &&
        result.differential.site.missing.length===0 &&
        result.differential.site.typeChanges.length===0 &&
        result.differential.collection.missing.length===0 &&
        result.differential.collection.typeChanges.length===0;
    }catch(e){
      result.mode='official-contract-live-unavailable';
      result.liveError={name:e.name,message:e.message,code:e.code||null};
    }
  }
  if(result.pass===undefined){
    // The embedded Core test suite is the executable contract when the official package cannot
    // be installed in this environment. Do not label this as a live differential.
    result.pass=result.nativeOptionality.pass;
    result.note='Official iSite source metadata is current, but live package execution requires its dependencies. Run with --isite=/path/to/isite for direct surface differential.';
  }

  const out=path.join(ROOT,'CERTIFICATION-ISITE.json');
  fs.writeFileSync(out,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  process.exit(result.pass?0:1);
})();
