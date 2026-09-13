'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

const forbidden=[
  ['legacy-url',/\burl\.(?:parse|format|resolve)\s*\(/],
  ['fs-direct-access-constants',/\bfs\.(?:F_OK|R_OK|W_OK|X_OK)\b/],
  ['dirent-path',/\bdirent\.path\b/i],
  ['http2-priority',/\.priority\s*\(/],
  ['internal-stream',/require\(['"](?:node:)?_stream_/],
  ['process-binding',/process\.binding\s*\(/],
  ['legacy-cipher',/crypto\.create(?:Cipher|Decipher)\s*\(/],
  ['punycode',/require\(['"](?:node:)?punycode['"]\)/]
];
const files=[];
const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(['node_modules','.git'].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js')&&(p.includes(path.sep+'lib'+path.sep)||p.includes(path.sep+'compat'+path.sep)))files.push(p)}};
walk(root);
const staticFindings=[];
for(const file of files){
  const source=fs.readFileSync(file,'utf8');
  for(const [name,re] of forbidden)if(re.test(source))staticFindings.push({name,file:path.relative(root,file)});
}
const focused=spawnSync(process.execPath,['--test','test/v601-node24-request-signal.test.js','test/v602-node24-compat.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
const dep=spawnSync(process.execPath,['--pending-deprecation','--test','test/v602-node24-compat.test.js'],{cwd:root,encoding:'utf8',timeout:120000});
const warnings=(dep.stderr||'').split(/\r?\n/).filter(x=>/DeprecationWarning|DEP\d+/.test(x));
const report={
  generatedAt:new Date().toISOString(),
  package:require('../package.json').name,
  version:require('../package.json').version,
  target:'Node.js 24.20.0',
  executionRuntime:process.version,
  note:process.versions.node.startsWith('24.')?
    'Certification executed directly on Node 24.' :
    'Sandbox runtime is not Node 24; Node-24-specific API changes are validated by static audit and focused behavioral simulations. Direct Node 24 execution is still recommended in CI.',
  staticAudit:{pass:staticFindings.length===0,findings:staticFindings},
  focusedTests:{pass:focused.status===0,status:focused.status,stdout:(focused.stdout||'').slice(-12000),stderr:(focused.stderr||'').slice(-4000)},
  pendingDeprecation:{pass:dep.status===0&&warnings.length===0,status:dep.status,warnings,stderr:(dep.stderr||'').slice(-6000)},
};
report.pass=report.staticAudit.pass&&report.focusedTests.pass&&report.pendingDeprecation.pass;
fs.writeFileSync(path.join(root,'CERTIFICATION-NODE24.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
