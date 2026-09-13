'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const core=require('..');

const contractPath=path.join(__dirname,'..','compat','isite','contracts','2026.08.31.json');

function request(port,{method='GET',path='/',headers={},body=null}={}){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method,path,headers},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });r.on('error',reject);if(body!=null)r.write(body);r.end();
  });
}
async function start(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);return {port:server.address().port,server};
}
const cookieFrom=res=>([].concat(res.headers['set-cookie']||[])[0]||'').split(';')[0];

async function installGoldenRoutes(site){
  const accounts=new Map([['browser-user',{id:'browser-user',email:'browser@example.test'}],['password-user',{id:'password-user',email:'password@example.test'}]]);
  site.security.registerUserProvider('social-browser-json',({id},done)=>done(null,accounts.get(String(id))||null));
  site.post('/golden/browser-login',async(req,res)=>{
    await site.security.setSessionUser(req,accounts.get('browser-user'),{source:'social-browser-json',authMethod:'browser'});
    res.json({done:true});
  });
  site.post('/golden/password-login',async(req,res)=>{
    await site.security.setSessionUser(req,accounts.get('password-user'),{source:'social-browser-json',authMethod:'password'});
    res.json({done:true});
  });
  site.get('/golden/account',(req,res)=>{
    if(!(req.session?.user&&req.session?.user_source==='social-browser-json'))return res.redirect('/golden/login');
    res.json({done:true,id:req.session.user_id,source:req.session.user_source,method:req.session.user_auth_method,user:req.session.user});
  });
  site.get('/golden/login',(req,res)=>res.send('login'));
  site.post('/golden/logout',async(req,res)=>{await site.security.clearSessionUser(req);res.json({done:true})});
}

test('iSite compatibility manifest is machine-readable and covers critical login contracts',()=>{
  const contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  assert.equal(contract.name,'isite');
  assert.equal(contract.version,'2026.08.31');
  for(const name of ['security.setSessionUser','security.clearSessionUser','security.registerUserProvider','request.browserIdentity'])assert.ok(contract.criticalApis[name],name);
  assert.ok(contract.criticalApis['security.setSessionUser'].effects.includes('session.user'));
  assert.ok(contract.criticalApis['security.setSessionUser'].effects.includes('session.user_source'));
  assert.ok(contract.goldenFlows.includes('browser-login-session-persist-reload-logout'));
});

test('strict compatibility mode loads a versioned contract',()=>{
  const site=core({compatibility:{name:'isite',version:'2026.08.31',strict:true}});
  assert.equal(site.compatibility.isite.strict,true);
  assert.equal(site.compatibility.isite.contractVersion,'2026.08.31');
  assert.equal(site.compatibility.isite.contract?.name,'isite');
});

test('strict runtime assertion fails closed when session effects cannot be persisted',async()=>{
  const site=core({compatibility:{name:'isite',strict:true}});
  const raw={$save:async()=>{}};
  const session=new Proxy(raw,{set(target,key,value){if(key==='user_id')return true;target[key]=value;return true}});
  const req={session};
  await assert.rejects(()=>site.security.setSessionUser(req,{id:'u1'},{source:'social-browser-json',authMethod:'browser'}),e=>e.code==='ISITE_SESSION_USER_ID_MISSING');
});

test('golden browser-login flow persists across a second HTTP request and logout clears it',async()=>{
  const site=core({compatibility:{name:'isite',strict:true}});await installGoldenRoutes(site);const {port}=await start(site);
  try{
    const login=await request(port,{method:'POST',path:'/golden/browser-login'});assert.equal(login.status,200);const cookie=cookieFrom(login);assert.match(cookie,/aisite\.sid=/);
    const account1=await request(port,{path:'/golden/account',headers:{cookie}});assert.equal(account1.status,200);let row=JSON.parse(account1.body);assert.equal(row.id,'browser-user');assert.equal(row.source,'social-browser-json');assert.equal(row.method,'browser');
    const account2=await request(port,{path:'/golden/account',headers:{cookie}});assert.equal(account2.status,200);row=JSON.parse(account2.body);assert.equal(row.user.email,'browser@example.test');
    const logout=await request(port,{method:'POST',path:'/golden/logout',headers:{cookie}});assert.equal(logout.status,200);
    const after=await request(port,{path:'/golden/account',headers:{cookie}});assert.equal(after.status,302);assert.equal(after.headers.location,'/golden/login');
  }finally{await site.stop({forceAfterMs:200})}
});

test('golden password-login flow preserves source and auth method across reload',async()=>{
  const site=core({compatibility:{name:'isite',strict:true}});await installGoldenRoutes(site);const {port}=await start(site);
  try{
    const login=await request(port,{method:'POST',path:'/golden/password-login'});const cookie=cookieFrom(login);assert.ok(cookie);
    const account=await request(port,{path:'/golden/account',headers:{cookie}});assert.equal(account.status,200);const row=JSON.parse(account.body);assert.equal(row.id,'password-user');assert.equal(row.source,'social-browser-json');assert.equal(row.method,'password');
  }finally{await site.stop({forceAfterMs:200})}
});

test('user provider rehydrates the canonical session user from identityRef',async()=>{
  const site=core({compatibility:{name:'isite',strict:true}});
  site.security.registerUserProvider('social-browser-json',({id},done)=>done(null,{id,email:id+'@example.test'}));
  const session={user_id:'rehydrate-1',user_source:'social-browser-json',identityRef:{provider:'social-browser-json',id:'rehydrate-1'}};
  const user=await site.security.getSessionUser(session);
  assert.equal(user.id,'rehydrate-1');assert.equal(user.email,'rehydrate-1@example.test');
});
