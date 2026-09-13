
const aisite=require('..');
const fs=require('fs'),os=require('os'),path=require('path');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-surface-'));
const site=aisite({cwd});
const col=site.connectCollection('surface');
function entries(o){
  const out={};
  for(const n of Object.keys(o).sort()){
    let t;
    try { const v=o[n]; t=Array.isArray(v)?'array':v===null?'null':typeof v; }
    catch(e){ t='getter-error'; }
    out[n]=t;
  }
  return out;
}
const s=entries(site), c=entries(col);
console.log(JSON.stringify({
  version:site.version,
  site:{count:Object.keys(s).length,functions:Object.values(s).filter(x=>x==='function').length,entries:s},
  collection:{count:Object.keys(c).length,functions:Object.values(c).filter(x=>x==='function').length,entries:c}
},null,2));
