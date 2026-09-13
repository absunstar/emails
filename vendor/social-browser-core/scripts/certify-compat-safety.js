'use strict';
const fs=require('node:fs'),path=require('node:path');const {spawnSync}=require('node:child_process');const root=path.resolve(__dirname,'..');
const steps=[['contract',['node','scripts/certify-compat-contract.js'],120000],['golden-flows',['node','scripts/certify-golden-flows.js'],120000],['node24',['node','scripts/certify-node24.js'],180000]];
if(process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH)steps.push(['social-browser',['node','scripts/certify-social-browser.js'],180000]);
const rows=steps.map(([name,cmd,timeout])=>{const r=spawnSync(cmd[0],cmd.slice(1),{cwd:root,encoding:'utf8',timeout,env:process.env});return{name,pass:r.status===0,status:r.status,stdout:(r.stdout||'').slice(-7000),stderr:(r.stderr||'').slice(-3000)}});
const report={generatedAt:new Date().toISOString(),version:require('../package.json').version,rows,websiteIncluded:!!process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH,pass:rows.every(x=>x.pass)};fs.writeFileSync(path.join(root,'CERTIFICATION-COMPAT-SAFETY.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(report.pass?0:1);
