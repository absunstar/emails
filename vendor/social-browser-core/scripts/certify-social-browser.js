'use strict';
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=process.env.SB_SOCIAL_BROWSER_WEBSITE_PATH||process.argv.find(x=>x.startsWith('--website='))?.slice(10)||'';
const port=Number(process.env.SB_SOCIAL_BROWSER_CERT_PORT||62102);
function request({method='GET',pathName='/',headers={},body=null}={}){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,method,path:pathName,headers},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});r.on('error',reject);if(body!=null)r.write(body);r.end()})}
async function waitReady(child,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(child.exitCode!=null)return false;try{const r=await request({pathName:'/login'});if([200,302].includes(r.status))return true}catch{}await new Promise(r=>setTimeout(r,200))}return false}
(async()=>{
  const report={generatedAt:new Date().toISOString(),version:require('../package.json').version,source,port,checks:{},pass:false};
  if(!source||!fs.existsSync(path.join(source,'server.js'))){report.error='Set SB_SOCIAL_BROWSER_WEBSITE_PATH to a Social Browser website checkout';fs.writeFileSync(path.join(root,'CERTIFICATION-SOCIAL-BROWSER.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(2)}
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'sb-site-cert-'));const site=path.join(tmp,'site'),shim=path.join(tmp,'isite');
  await fsp.cp(source,site,{recursive:true});await fsp.mkdir(shim,{recursive:true});
  await fsp.writeFile(path.join(shim,'index.js'),`const core=require(${JSON.stringify(root)});module.exports=function(options={}){return core({...options,compatibility:{name:'isite',version:'2026.08.31',strict:true}})};\n`);
  let serverSource=await fsp.readFile(path.join(site,'server.js'),'utf8');serverSource=serverSource.replace(/port:\s*60002\s*,/,'port: Number(process.env.SB_CERT_PORT||60002),');await fsp.writeFile(path.join(site,'server.js'),serverSource);
  const localStorage=path.join(site,'localStorage');await fsp.mkdir(localStorage,{recursive:true});for(const name of ['onlineKeyList','affiliateLinks','affiliateAttribution','affiliateRedirectRules','browserList','contactForms']){const p=path.join(localStorage,name+'.json');if(!fs.existsSync(p))await fsp.writeFile(p,'[]')}
  const env={...process.env,SB_CERT_PORT:String(port),SOCIAL_BROWSER_LICENSE_V2_SECRET:'cert-license-secret',SOCIAL_BROWSER_BROWSER_AUTH_SECRET:'cert-browser-auth-secret',SOCIAL_BROWSER_LICENSE_KEY_ENCRYPTION_SECRET:'cert-key-encryption-secret',NODE_ENV:'production'};
  const child=spawn(process.execPath,['server.js'],{cwd:site,env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  try{
    report.checks.boot=await waitReady(child);if(!report.checks.boot)throw new Error('website failed to boot: '+logs.slice(-4000));
    const browserID='browser_machine_profile_Chrome-cert-developer',browserUUID=browserID.split('_').pop();
    const registerBody=JSON.stringify({browserID,browserUUID,browserAuthKey:'K'.repeat(64),deviceId:'cert-device',locationId:'cert-location',browserVersion:'26.9.5',protocolVersion:2});
    const reg=await request({method:'POST',pathName:'/api/v2/browser-auth/register',headers:{'content-type':'application/json'},body:registerBody});const regJson=JSON.parse(reg.body);report.checks.register=reg.status===200&&regJson.done===true&&!!regJson.browserLoginToken;
    const authHeaders={'content-type':'application/json','x-browser':'social.'+browserID,'x-browser-token':regJson.browserLoginToken};
    const refreshBody=JSON.stringify({browserAuthId:regJson.browserAuthId,browserAuthRefreshToken:regJson.browserAuthRefreshToken,browserID,browserUUID,deviceId:'cert-device',locationId:'cert-location',browserVersion:'26.9.5'});
    const refresh=await request({method:'POST',pathName:'/api/v2/browser-auth/refresh',headers:{'content-type':'application/json'},body:refreshBody});const refreshJson=JSON.parse(refresh.body);report.checks.refresh=refresh.status===200&&refreshJson.done===true&&!!refreshJson.browserLoginToken;
    authHeaders['x-browser-token']=refreshJson.browserLoginToken;
    const guestAccount=await request({pathName:'/account'});report.checks.guestAccountRedirect=guestAccount.status===302&&/\/login$/.test(guestAccount.headers.location||'');
    for(const publicPath of ['/','/login','/ar/login','/payment-service?item=plan-pro&source=cert','/partners','/affiliate']){const page=await request({pathName:publicPath});report.checks['page:'+publicPath]=page.status===200}
    const login=await request({method:'POST',pathName:'/api/v2/browser-auth/login',headers:authHeaders,body:'{}'});const loginJson=JSON.parse(login.body);let cookie=([].concat(login.headers['set-cookie']||[])[0]||'').split(';')[0];report.checks.login=login.status===200&&loginJson.done===true&&loginJson.loggedIn===true&&/^aisite\.sid=/.test(cookie);
    const account=await request({pathName:'/account',headers:{cookie}});report.checks.accountAfterLogin=account.status===200&&!account.headers.location;
    const reload=await request({pathName:'/account',headers:{cookie}});report.checks.accountReload=reload.status===200&&!reload.headers.location;
    const status=await request({pathName:'/api/v2/browser-auth/status',headers:{cookie,...authHeaders}});const statusJson=JSON.parse(status.body);report.checks.statusLoggedIn=status.status===200&&statusJson.loggedIn===true&&statusJson.browser?.detected===true&&statusJson.browser?.tokenPresent===true;
    const accountApi=await request({pathName:'/api/v2/account',headers:{cookie}});const accountJson=JSON.parse(accountApi.body);report.checks.accountApi=accountApi.status===200&&accountJson.done===true&&accountJson.loggedIn===true&&accountJson.authMethod==='browser';
    const certEmail=`cert-${Date.now()}@example.test`,certPassword='Strong-Cert-Password-123!';
    const emailUpdate=await request({method:'POST',pathName:'/api/v2/account/email',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({email:certEmail})});const emailJson=JSON.parse(emailUpdate.body);report.checks.emailUpdate=emailUpdate.status===200&&emailJson.done===true&&emailJson.account?.email===certEmail;
    const passwordUpdate=await request({method:'POST',pathName:'/api/v2/account/password',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({newPassword:certPassword})});const passJson=JSON.parse(passwordUpdate.body);report.checks.passwordUpdate=passwordUpdate.status===200&&passJson.done===true&&passJson.account?.hasPassword===true;
    const invalidLicense=await request({method:'POST',pathName:'/api/v2/license/activate',headers:{'content-type':'application/json'},body:JSON.stringify({licenseKey:'NOT-A-REAL-LICENSE',browserID,browserUUID,deviceId:'cert-device',locationId:'cert-location'})});const invalidLicenseJson=JSON.parse(invalidLicense.body);report.checks.invalidLicenseFailsClosed=invalidLicense.status===200&&invalidLicenseJson.done===false;
    const logout=await request({method:'POST',pathName:'/api/v2/auth/logout',headers:{cookie,'content-type':'application/json'},body:'{}'});const logoutJson=JSON.parse(logout.body);report.checks.logout=logout.status===200&&logoutJson.done===true&&logoutJson.loggedIn===false;
    const after=await request({pathName:'/account',headers:{cookie}});report.checks.accountAfterLogout=after.status===302&&/\/login$/.test(after.headers.location||'');
    const passwordLogin=await request({method:'POST',pathName:'/api/v2/auth/login',headers:{'content-type':'application/json'},body:JSON.stringify({email:certEmail,password:certPassword})});const passwordLoginJson=JSON.parse(passwordLogin.body);cookie=([].concat(passwordLogin.headers['set-cookie']||[])[0]||'').split(';')[0];report.checks.passwordLogin=passwordLogin.status===200&&passwordLoginJson.done===true&&passwordLoginJson.loggedIn===true&&/^aisite\.sid=/.test(cookie);
    const passwordAccount=await request({pathName:'/api/v2/account',headers:{cookie}});const passwordAccountJson=JSON.parse(passwordAccount.body);report.checks.passwordAccountReload=passwordAccount.status===200&&passwordAccountJson.done===true&&passwordAccountJson.loggedIn===true&&passwordAccountJson.authMethod==='password';
    const finalLogout=await request({method:'POST',pathName:'/api/v2/auth/logout',headers:{cookie,'content-type':'application/json'},body:'{}'});report.checks.passwordLogout=finalLogout.status===200&&JSON.parse(finalLogout.body).done===true;
    report.pass=Object.values(report.checks).every(Boolean);
  }catch(e){report.error=e.message;report.logs=logs.slice(-6000)}finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,300));if(child.exitCode==null)child.kill('SIGKILL');await fsp.rm(tmp,{recursive:true,force:true})}
  fs.writeFileSync(path.join(root,'CERTIFICATION-SOCIAL-BROWSER.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exit(report.pass?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
