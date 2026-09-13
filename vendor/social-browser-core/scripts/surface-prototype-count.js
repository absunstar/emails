
const aisite=require('..');
const fs=require('fs'),os=require('os'),path=require('path');
const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-surface-'))});
const col=site.connectCollection('surface');
function collect(o){
 const out=new Map();
 let cur=o;
 while(cur&&cur!==Object.prototype){
   for(const n of Object.getOwnPropertyNames(cur)){
     if(n==='constructor'||out.has(n))continue;
     let t;
     try { const d=Object.getOwnPropertyDescriptor(cur,n); t=d.get?'getter':typeof o[n]; }
     catch(e){ t='getter-error'; }
     out.set(n,t);
   }
   cur=Object.getPrototypeOf(cur);
 }
 return Object.fromEntries([...out.entries()].sort());
}
const s=collect(site), c=collect(col);
console.log(JSON.stringify({
 site:{count:Object.keys(s).length,functions:Object.values(s).filter(x=>x==='function').length},
 collection:{count:Object.keys(c).length,functions:Object.values(c).filter(x=>x==='function').length,names:Object.keys(c)}
},null,2));
