'use strict';
const fs=require('fs');
const path=require('path');
const core=require('..');

function typeOfValue(value){
  if(Array.isArray(value))return 'array';
  if(value===null)return 'null';
  return typeof value;
}
function parseArgs(argv){
  const out={};
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a==='--manifest')out.manifest=argv[++i];
    else if(a==='--json')out.json=argv[++i];
    else if(a==='--strict-arity')out.strictArity=true;
  }
  return out;
}
function descriptorType(target,name){
  const d=Object.getOwnPropertyDescriptor(target,name);
  if(!d)return {exists:false,type:'missing'};
  if(typeof d.get==='function'&&!('value' in d)){
    try{return {exists:true,type:typeOfValue(target[name]),descriptor:d}}
    catch{return {exists:true,type:'getter-error',descriptor:d}}
  }
  return {exists:true,type:typeOfValue(d.value),value:d.value,descriptor:d};
}
function compareEntries(target,entries,{strictArity=false}={}){
  const missing=[],typeMismatch=[],arityMismatch=[],descriptorMismatch=[];
  for(const [name,expected] of Object.entries(entries||{})){
    const actual=descriptorType(target,name);
    if(!actual.exists){missing.push(name);continue}
    if(expected.type&&actual.type!==expected.type){typeMismatch.push({name,expected:expected.type,actual:actual.type});continue}
    if(expected.type==='function'&&strictArity&&Number.isInteger(expected.arity)&&typeof actual.value==='function'&&actual.value.length!==expected.arity)
      arityMismatch.push({name,expected:expected.arity,actual:actual.value.length});
    for(const key of ['enumerable','writable','configurable']){
      if(expected[key]===undefined)continue;
      const got=key==='writable'&&actual.descriptor&&!('writable' in actual.descriptor)?undefined:actual.descriptor?.[key];
      if(got!==expected[key])descriptorMismatch.push({name,key,expected:expected[key],actual:got});
    }
  }
  return{missing,typeMismatch,arityMismatch,descriptorMismatch,pass:missing.length===0&&typeMismatch.length===0&&arityMismatch.length===0};
}

const args=parseArgs(process.argv);
if(!args.manifest){
  console.error('Usage: node scripts/diff-isite-public-surface.js --manifest /path/to/isite-v30-public-surface.json [--strict-arity] [--json report.json]');
  process.exit(2);
}
const manifest=JSON.parse(fs.readFileSync(path.resolve(args.manifest),'utf8'));
const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
const report={
  generatedAt:new Date().toISOString(),
  coreVersion:require('../package.json').version,
  manifestVersion:manifest.frameworkVersion||manifest.version||null,
  site:compareEntries(site,manifest.site?.entries||{},args),
  namespaces:{}
};
for(const [ns,row] of Object.entries(manifest||{})){
  if(ns==='site'||!row?.entries)continue;
  report.namespaces[ns]=compareEntries(site[ns],row.entries,args);
}
report.pass=report.site.pass&&Object.values(report.namespaces).every(x=>x.pass);
if(args.json)fs.writeFileSync(path.resolve(args.json),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
site.memoryPressure?.stop?.();
process.exit(report.pass?0:1);
