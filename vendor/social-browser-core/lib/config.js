'use strict';
const fs=require('fs');
const path=require('path');

function deepMerge(a,b){
  const out={...(a||{})};for(const [k,v] of Object.entries(b||{})){
    if(v&&typeof v==='object'&&!Array.isArray(v)&&a?.[k]&&typeof a[k]==='object'&&!Array.isArray(a[k]))out[k]=deepMerge(a[k],v);
    else out[k]=v;
  }return out;
}
function parseEnv(prefix='SB_CORE_'){
  const out={};
  for(const [key,value] of Object.entries(process.env)){
    if(!key.startsWith(prefix))continue;
    const parts=key.slice(prefix.length).toLowerCase().split('__');
    let cur=out;for(let i=0;i<parts.length-1;i++)cur=cur[parts[i]]||(cur[parts[i]]={});
    let v=value;
    if(v==='true'||v==='false')v=v==='true';
    else if(v!==''&&!Number.isNaN(Number(v)))v=Number(v);
    else {try{v=JSON.parse(v)}catch{}}
    cur[parts.at(-1)]=v;
  }return out;
}
function maskSecrets(value,pattern=/pass(word)?|secret|token|api.?key|private.?key|credential/i){
  if(Array.isArray(value))return value.map(x=>maskSecrets(x,pattern));
  if(value&&typeof value==='object'){
    const out={};for(const [k,v] of Object.entries(value))out[k]=pattern.test(k)?'***':maskSecrets(v,pattern);return out;
  }return value;
}
class ConfigManager{
  constructor(base={},options={}){
    this.base={...base};this.options=options;this.profile=options.profile||process.env.NODE_ENV||base.mode||base.environment||'production';this.current={};this.reload();
  }
  reload(){
    let file={};
    if(this.options.file){
      const p=path.resolve(this.options.file);if(fs.existsSync(p))file=JSON.parse(fs.readFileSync(p,'utf8'));
    }
    const profileCfg=file.profiles?.[this.profile]||{};
    this.current=deepMerge(deepMerge(deepMerge(file.default||file,profileCfg),this.base),parseEnv(this.options.envPrefix||'SB_CORE_'));
    return this.current;
  }
  get(pathKey,fallback){
    const parts=String(pathKey||'').split('.').filter(Boolean);let cur=this.current;
    for(const p of parts){if(cur==null)return fallback;cur=cur[p]}
    return cur===undefined?fallback:cur;
  }
  snapshot({masked=true}={}){return masked?maskSecrets(this.current):JSON.parse(JSON.stringify(this.current))}
  diff(next){
    const a=JSON.stringify(this.current),b=JSON.stringify(next);return {changed:a!==b,before:this.snapshot(),after:maskSecrets(next)};
  }
}
module.exports={ConfigManager,deepMerge,parseEnv,maskSecrets};
