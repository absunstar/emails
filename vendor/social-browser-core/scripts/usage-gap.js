'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
const matrix=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'gap-'))});
function collect(o){const s=new Set();let c=o;while(c&&c!==Object.prototype){for(const n of Object.getOwnPropertyNames(c))s.add(n);c=Object.getPrototypeOf(c)}return s}
const have=collect(site);
const rows=(matrix.usage?.site||[])
 .filter(x=>!x.name.includes('.')&&x.serverCount>0)
 .map(x=>({...x,implemented:have.has(x.name)}))
 .sort((a,b)=>b.count-a.count);
const frameworkLikely=rows.filter(x=>/^(on[A-Z]+|addApp|addFeature|addVar|addVars|addfeatures|connectApp|cmd|cookie|copy|createDir|createDirSync|canRequire|cacheGetOrLoad|callRoute|close|closeGracefully|hasFeature|feature)$/.test(x.name));
console.log(JSON.stringify({
 serverObserved:rows.length,
 implementedServerObserved:rows.filter(x=>x.implemented).length,
 topMissing:rows.filter(x=>!x.implemented).slice(0,50),
 frameworkLikely
},null,2));
