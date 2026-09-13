'use strict';
const fs=require('fs'),path=require('path');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const commands=[
  ['distributed',['node','scripts/certify-distributed.js'],180000],
  ['cluster',['node','scripts/certify-cluster.js'],120000],
  ['reliability',['node','scripts/certify-reliability.js'],180000],
  ['observability',['node','scripts/certify-observability.js'],120000]
];
const rows=commands.map(([name,cmd,timeout])=>{
  const r=spawnSync(cmd[0],cmd.slice(1),{cwd:root,encoding:'utf8',timeout});
  return {name,pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-6000),stderr:(r.stderr||'').slice(-3000)};
});
const report={generatedAt:new Date().toISOString(),version:require('../package.json').version,rows,pass:rows.every(x=>x.pass)};
fs.writeFileSync(path.join(root,'CERTIFICATION-PLATFORM.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
