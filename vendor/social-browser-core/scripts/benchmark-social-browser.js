'use strict';
const fs=require('fs'),fsp=fs.promises,path=require('path'),os=require('os'),http=require('http');
const {spawn}=require('child_process'),{performance}=require('perf_hooks');

function arg(name,fallback=null){const hit=process.argv.find(x=>x.startsWith(`--${name}=`));return hit?hit.slice(name.length+3):fallback}
const coreRoot=path.resolve(arg('core',path.resolve(__dirname,'..')));
const source=path.resolve(arg('website',process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH||''));
const requests=Math.max(3,Number(arg('requests',20)));
if(!source||!fs.existsSync(source)){console.error('Missing --website=/path/to/social-browser-website');process.exit(2)}

const agent=new http.Agent({keepAlive:true,maxSockets:32});
let port=0;
function req(pathName='/',headers={}){return new Promise((resolve,reject)=>{
 const r=http.request({host:'127.0.0.1',port,path:pathName,headers,agent,timeout:5000},res=>{let bytes=0;res.on('data',x=>bytes+=x.length);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes}))});
 r.on('timeout',()=>r.destroy(new Error('timeout')));r.on('error',reject);r.end();
})}
async function wait(child){for(let i=0;i<100;i++){if(child.exitCode!=null)return false;try{const r=await req('/');if(r.status===200)return true}catch{}await new Promise(r=>setTimeout(r,100))}return false}
function pct(rows,p){const a=[...rows].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.max(0,Math.ceil(a.length*p)-1))]||0}

(async()=>{
 const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'sb-core-site-bench-')),site=path.join(tmp,'site'),shim=path.join(tmp,'isite');
 await fsp.cp(source,site,{recursive:true});await fsp.mkdir(shim,{recursive:true});
 await fsp.writeFile(path.join(shim,'index.js'),`const core=require(${JSON.stringify(coreRoot)});module.exports=function(options={}){return core({...options,compatibility:'isite'})};\n`);
 const serverFile=path.join(site,'server.js');let src=await fsp.readFile(serverFile,'utf8');
 port=62000+Math.floor(Math.random()*1000);src=src.replace(/port:\s*60002\s*,/,'port:Number(process.env.SB_CERT_PORT||60002),');await fsp.writeFile(serverFile,src);
 const ls=path.join(site,'localStorage');await fsp.mkdir(ls,{recursive:true});
 for(const n of ['onlineKeyList','affiliateLinks','affiliateAttribution','affiliateRedirectRules','browserList','contactForms']){const p=path.join(ls,n+'.json');if(!fs.existsSync(p))await fsp.writeFile(p,'[]')}
 const env={...process.env,SB_CERT_PORT:String(port),NODE_ENV:'production',SOCIAL_BROWSER_LICENSE_V2_SECRET:'bench-license',SOCIAL_BROWSER_BROWSER_AUTH_SECRET:'bench-auth',SOCIAL_BROWSER_LICENSE_KEY_ENCRYPTION_SECRET:'bench-encryption',NODE_PATH:tmp};
 const child=spawn(process.execPath,['server.js'],{cwd:site,env,stdio:['ignore','ignore','pipe']});let err='';child.stderr.on('data',d=>err+=d);
 try{
  if(!await wait(child))throw new Error('boot failed: '+err.slice(-2000));
  for(let i=0;i<10;i++)await req('/');
  const times=[];let totalBytes=0;
  for(let i=0;i<requests;i++){const t=performance.now(),r=await req('/');times.push(performance.now()-t);totalBytes+=r.bytes;if(r.status!==200)throw new Error('unexpected status '+r.status)}
  const result={
    generatedAt:new Date().toISOString(),node:process.version,
    coreVersion:require(path.join(coreRoot,'package.json')).version,requests,
    html:{avgMs:times.reduce((a,b)=>a+b,0)/times.length,p50Ms:pct(times,.50),p95Ms:pct(times,.95),p99Ms:pct(times,.99),avgBytes:Math.round(totalBytes/requests)}
  };
  console.log(JSON.stringify(result,null,2));
 }finally{agent.destroy();child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));if(child.exitCode==null)child.kill('SIGKILL');await fsp.rm(tmp,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
