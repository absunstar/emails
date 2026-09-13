'use strict';
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const root=path.resolve(__dirname,'..');
const run=(name,args,options={})=>{
  const started=Date.now();
  const r=spawnSync(args[0],args.slice(1),{
    cwd:root,encoding:'utf8',timeout:options.timeout||420000,
    env:{...process.env,...(options.env||{})}
  });
  return {
    name,pass:r.status===0,status:r.status,
    durationMs:Date.now()-started,
    stdout:(r.stdout||'').slice(-12000),
    stderr:(r.stderr||'').slice(-6000)
  };
};

const steps=[
  run('zero-dependency',['npm','run','check'],{timeout:30000}),
  run('test-suite',['node','--test'],{timeout:420000}),
  run('production-defaults-certification',['node','scripts/certify-production-defaults.js'],{timeout:120000}),
  run('node24-certification',['node','scripts/certify-node24.js'],{timeout:120000}),
  run('isite-certification',['node','scripts/certify-isite.js'],{timeout:60000}),
  run('compat-contract-certification',['node','scripts/certify-compat-contract.js'],{timeout:120000}),
  run('golden-flow-certification',['node','scripts/certify-golden-flows.js'],{timeout:120000}),
  run('security-certification',['node','scripts/certify-security.js'],{timeout:180000}),
  run('performance-certification',['node','scripts/certify-performance.js'],{timeout:180000}),
  run('file-cache-certification',['node','scripts/certify-file-cache.js'],{timeout:180000}),
  run('reliability-certification',['node','scripts/certify-reliability.js'],{timeout:180000}),
  run('observability-certification',['node','scripts/certify-observability.js'],{timeout:120000}),
  run('stress-certification',['node','scripts/certify-stress.js'],{timeout:240000}),
  run('distributed-certification',['node','scripts/certify-distributed.js'],{timeout:180000}),
  run('cluster-certification',['node','scripts/certify-cluster.js'],{timeout:120000}),
  run('platform-certification',['node','scripts/certify-platform.js'],{timeout:300000}),
  run('soak-certification',['node','scripts/certify-soak.js'],{timeout:360000}),
  run('database-certification',['node','scripts/certify-databases.js'],{
    timeout:60000,
    env:{
      MONGODB_URL:process.env.MONGODB_URL||'',
      POSTGRES_URL:process.env.POSTGRES_URL||'',
      MYSQL_URL:process.env.MYSQL_URL||''
    }
  }),
  run('npm-audit',['npm','audit','--omit=dev','--json'],{timeout:60000}),
  run('publish-dry-run',['npm','publish','--dry-run','--ignore-scripts','--json'],{
    timeout:60000,
    env:{npm_config_cache:process.env.npm_config_cache||path.join(root,'.cert-npm-cache')}
  })
];
if(process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH) steps.push(run('social-browser-website-certification',['node','scripts/certify-social-browser.js'],{timeout:240000}));

const report={
  generatedAt:new Date().toISOString(),
  package:require('../package.json').name,
  version:require('../package.json').version,
  compatibilityDefault:'off',
  rule:'iSite compatibility is optional; Native Core is the release baseline.',
  steps
};
report.pass=steps.every(x=>x.pass);
fs.writeFileSync(path.join(root,'CERTIFICATION-RELEASE.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
process.exit(report.pass?0:1);
