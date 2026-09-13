'use strict';
const fs=require('fs');
const path=require('path');
const aisite=require('..');

const matrixFile=process.argv[2];
if(!matrixFile){console.error('Usage: node scripts/compatibility-audit.js <matrix.json>');process.exit(2);}
const matrix=JSON.parse(fs.readFileSync(matrixFile,'utf8'));
const site=aisite({cwd:fs.mkdtempSync(path.join(require('os').tmpdir(),'aisite-audit-'))});
const frameworkLikely = {
  site:['get','post','onGET','onPOST','run','start','connectCollection','readFile','writeFile','render','loadLocalApp','importApp','importApps','ready'],
  collection:(matrix.usage?.collection||[]).map(x=>x.name),
  response:(matrix.usage?.res||[]).map(x=>x.name).filter(x=>!x.includes('.'))
};
const out=site.compatAudit.auditSite(site,frameworkLikely);
console.log(JSON.stringify(out,null,2));
