'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('http');
const net=require('net');
const crypto=require('crypto');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {EventEmitter}=require('events');
const core=require('..');
const {decodeFrames}=require('../lib/websocket');

async function start(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {server,port:server.address().port};
}
async function close(server){
  await new Promise(resolve=>{
    let done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve()};
    const timer=setTimeout(()=>{try{server.closeAllConnections?.()}catch{};finish()},500);
    try{server.close(finish)}catch{finish()}
  });
}
function req(port,{method='GET',path='/',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method,path,headers},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({
        status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)
      }));
    });
    r.on('error',reject);
    if(body!=null)r.write(body);
    r.end();
  });
}
function cookieValue(headers,name){
  const rows=[].concat(headers['set-cookie']||[]);
  for(const row of rows){
    const m=new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(row);
    if(m)return decodeURIComponent(m[1]);
  }
  return null;
}
function cb1(fn,...args){
  return new Promise((resolve,reject)=>fn(...args,(err,value)=>err?reject(err):resolve(value)));
}
function cb3(fn,...args){
  return new Promise((resolve,reject)=>fn(...args,(err,a,b)=>err?reject(err):resolve([a,b])));
}
function maskedFrame(text){
  const payload=Buffer.from(String(text));
  const mask=crypto.randomBytes(4);
  let header;
  if(payload.length<126){
    header=Buffer.alloc(6);header[0]=0x81;header[1]=0x80|payload.length;mask.copy(header,2);
  }else{
    header=Buffer.alloc(8);header[0]=0x81;header[1]=0x80|126;header.writeUInt16BE(payload.length,2);mask.copy(header,4);
  }
  const start=payload.length<126?6:8;
  const out=Buffer.alloc(start+payload.length);header.copy(out);
  for(let i=0;i<payload.length;i++)out[start+i]=payload[i]^mask[i%4];
  return out;
}
function websocketExchange(port,cookie){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port});
    const key=crypto.randomBytes(16).toString('base64');
    let headerDone=false,buffer=Buffer.alloc(0),timeout;const allMessages=[];
    const finish=(err,value)=>{
      clearTimeout(timeout);
      try{socket.destroy()}catch{}
      err?reject(err):resolve(value);
    };
    timeout=setTimeout(()=>finish(new Error('websocket timeout')),4000);
    socket.on('error',e=>finish(e));
    socket.on('connect',()=>{
      socket.write([
        'GET /WS/Test?Code=ABC HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        cookie?`Cookie: ${cookie}`:'',
        '\r\n'
      ].filter(Boolean).join('\r\n'));
    });
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(!headerDone){
        const i=buffer.indexOf('\r\n\r\n');
        if(i<0)return;
        const head=buffer.subarray(0,i+4).toString();
        assert.match(head,/101 Switching Protocols/);
        buffer=buffer.subarray(i+4);headerDone=true;
        socket.write(maskedFrame(JSON.stringify({type:'hello',value:7})));
      }
      if(buffer.length){
        const parsed=decodeFrames(buffer);
        buffer=parsed.rest;
        const messages=parsed.frames.filter(f=>f.opcode===1).map(f=>JSON.parse(f.payload.toString()));
        allMessages.push(...messages);
        const echo=allMessages.find(x=>x.echo);
        if(echo)finish(null,{messages:allMessages,echo});
      }
    });
  });
}

test('iSite session uses aisite.sid, migrates sb.sid, persists and destroys correctly',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-isite-session-'));
  const sessionDir=path.join(dir,'.aisite','sessions');
  fs.mkdirSync(sessionDir,{recursive:true});
  const legacyId='legacy-session';
  fs.writeFileSync(path.join(sessionDir,legacyId+'.json'),JSON.stringify({
    user:{id:9,name:'Legacy'},language:{id:'Ar'},expiresAt:Date.now()+600000
  }));

  const site=core({cwd:dir,compatibility:'isite'});
  site.get({name:'/session',public:true},(req,res)=>{
    req.session.counter=(req.session.counter||0)+1;
    res.json({id:req.session.user?.id,counter:req.session.counter,cookie:req.session.$id});
  });
  site.get({name:'/destroy',public:true},(req,res)=>{req.session.destroy();res.send('ok')});
  const {server,port}=await start(site);

  const first=await req(port,{path:'/session',headers:{cookie:`sb.sid=${legacyId}`}});
  assert.equal(first.status,200);
  assert.equal(JSON.parse(first.body).id,9);
  assert.equal(cookieValue(first.headers,'aisite.sid'),legacyId);
  assert.equal(cookieValue(first.headers,'sb.sid'),null);

  const canonical=`aisite.sid=${legacyId}`;
  const second=await req(port,{path:'/session',headers:{cookie:canonical}});
  assert.equal(JSON.parse(second.body).counter,2);
  assert.ok(fs.existsSync(path.join(sessionDir,legacyId+'.json')));

  const destroyed=await req(port,{path:'/destroy',headers:{cookie:canonical}});
  assert.equal(destroyed.status,200);
  assert.equal(fs.existsSync(path.join(sessionDir,legacyId+'.json')),false);
  const setCookie=[].concat(destroyed.headers['set-cookie']||[]).join('\n');
  assert.match(setCookie,/aisite\.sid=/);
  assert.match(setCookie,/Expires=Thu, 01 Jan 1970/i);

  await close(server);
});

test('security CRUD/login/logout/roles are callback compatible and collection-backed',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-security-'));
  const site=core({cwd:dir,compatibility:'isite'});
  const sec=site.security;

  const user=await cb1(sec.register,{email:'a@example.com',password:'123',profile:{name:'A'}});
  assert.equal(user.id,1);
  assert.equal(await cb1(sec.isUserExists,{email:'a@example.com'}),true);

  const fetched=await cb1(sec.getUser,{email:'a@example.com'});
  assert.equal(fetched.profile.name,'A');

  const updated=await cb1(sec.updateUser,{...fetched,profile:{name:'B'}});
  assert.equal(updated.doc.profile.name,'B');

  await cb1(sec.register,{email:'b@example.com',password:'456'});
  assert.equal(await cb1(sec.isUserExists,{...updated.doc,email:'b@example.com'}),true);

  const [users,count]=await cb3(sec.getUsers,{where:{},sort:{id:1}});
  assert.equal(users.length,2);
  assert.equal(count,2);

  const fakeReq={session:{$save(){this.saved=true}},user:null};
  const logged=await cb1(sec.login,{email:'a@example.com',password:'123',$req:fakeReq});
  assert.equal(logged.email,'a@example.com');
  assert.equal(fakeReq.session.user.id,1);
  assert.equal(fakeReq.session.saved,true);
  assert.equal(sec.isUserLogin(fakeReq),true);

  const role=await cb1(sec.addRole,{name:'admin',permissions:['users.view']});
  assert.equal(role.name,'admin');
  await cb1(sec.addPermissions,'admin',['users.edit']);
  const userWithRole={roles:['admin']};
  assert.equal(sec.isUserHasPermission({user:userWithRole},null,'users.view'),true);
  assert.equal(sec.isUserHasPermission({user:userWithRole},null,'users.edit'),true);
  assert.equal(sec.isUserHasRole({user:userWithRole},null,'admin'),true);

  const logout=await cb1(sec.logout,fakeReq,{});
  assert.equal(logout,true);
  assert.equal(fakeReq.session.user,undefined);

  const deleted=await cb1(sec.deleteUser,{id:1});
  assert.equal(deleted.count,1);
  assert.equal(deleted.doc.email,'a@example.com');
  assert.equal((await cb3(sec.getUsers,{where:{}}))[1],1);
});

test('app loader preserves path metadata, prevents duplicates, reloads and emits lifecycle events',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-app-loader-'));
  const appDir=path.join(dir,'apps','hello');fs.mkdirSync(appDir,{recursive:true});
  fs.writeFileSync(path.join(appDir,'app.js'),`
    module.exports=function(site,opts,descriptor){
      site.__appLoads=(site.__appLoads||0)+1;
      return {loaded:site.__appLoads,path:descriptor.path};
    };
    module.exports.dispose=function(site){site.__appDisposes=(site.__appDisposes||0)+1};
  `);
  const site=core({cwd:dir,compatibility:'isite'});
  const events=[];site.on('[app][loaded]',a=>events.push(['loaded',a.name]));site.on('[app][unloaded]',a=>events.push(['unloaded',a.name]));

  const first=site.importApp(appDir);
  const second=site.importApp(appDir);
  assert.equal(first,second);
  assert.equal(site.__appLoads,1);
  assert.equal(site.apps.length,1);
  assert.equal(site.apps[0].path,appDir);
  assert.equal(site.apps[0].name,'hello');

  const reloaded=site.reloadApp(appDir);
  assert.notEqual(reloaded,first);
  assert.equal(site.__appLoads,2);
  assert.equal(site.__appDisposes,1);
  assert.equal(site.apps.length,1);
  assert.deepEqual(events,[['loaded','hello'],['unloaded','hello'],['loaded','hello']]);

  assert.equal(site.unloadApp(appDir),true);
  assert.equal(site.apps.length,0);
  assert.equal(site.__appDisposes,2);
});

test('site.call, site.on and site.events share one legacy event bus',()=>{
  const site=core({compatibility:'isite'});
  const seen=[];
  site.on('x',v=>seen.push(['site',v]));
  site.events.on('x',v=>seen.push(['events',v]));
  assert.equal(site.call('x',7),true);
  assert.deepEqual(seen,[['site',7],['events',7]]);
});

test('static files support range/etag and block symlink escape',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-static-'));
  const pub=path.join(dir,'public');fs.mkdirSync(pub);
  const file=path.join(pub,'a.txt');fs.writeFileSync(file,'0123456789');
  const outside=path.join(dir,'outside.txt');fs.writeFileSync(outside,'SECRET');
  try{fs.symlinkSync(outside,path.join(pub,'escape.txt'))}catch{}

  const site=core({cwd:dir,compatibility:'isite'});
  site.static('/assets',pub,{cacheControl:'public, max-age=60'});
  const {server,port}=await start(site);

  const full=await req(port,{path:'/assets/a.txt'});
  assert.equal(full.status,200);
  assert.equal(full.body.toString(),'0123456789');
  assert.equal(full.headers['accept-ranges'],'bytes');
  assert.ok(full.headers.etag);

  const partial=await req(port,{path:'/assets/a.txt',headers:{range:'bytes=2-5'}});
  assert.equal(partial.status,206);
  assert.equal(partial.body.toString(),'2345');
  assert.equal(partial.headers['content-range'],'bytes 2-5/10');

  const fresh=await req(port,{path:'/assets/a.txt',headers:{'if-none-match':full.headers.etag}});
  assert.equal(fresh.status,304);

  if(fs.existsSync(path.join(pub,'escape.txt'))){
    const escaped=await req(port,{path:'/assets/escape.txt'});
    assert.equal(escaped.status,403);
    assert.doesNotMatch(escaped.body.toString(),/SECRET/);
  }
  await close(server);
});

test('download streaming preserves exact bytes and range semantics under iSite response wrapper',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-download-'));
  const file=path.join(dir,'x.bin');const bytes=Buffer.from([0,1,2,3,4,5,6,7,8,9]);fs.writeFileSync(file,bytes);
  const site=core({cwd:dir,compatibility:'isite'});
  site.get({name:'/download',public:true},(q,r)=>r.download(file));
  const {server,port}=await start(site);

  const full=await req(port,{path:'/download'});
  assert.equal(full.status,200);
  assert.deepEqual(full.body,bytes);
  const partial=await req(port,{path:'/download',headers:{range:'bytes=3-6'}});
  assert.equal(partial.status,206);
  assert.deepEqual(partial.body,Buffer.from([3,4,5,6]));
  const invalid=await req(port,{path:'/download',headers:{range:'bytes=99-100'}});
  assert.equal(invalid.status,416);
  await close(server);
});

test('legacy WebSocket client supports session reuse, object send, onMessage and clientList lifecycle',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-ws-'));
  const site=core({cwd:dir,compatibility:'isite'});
  site.get({name:'/seed',public:true},(req,res)=>{req.session.user={id:44,name:'WS'};res.send('ok')});
  site.onWS('/ws/test',client=>{
    client.send({welcome:true,user:client.user?.id,path:client.path,query:client.query.code});
    client.onMessage=message=>client.send({echo:message,user:client.user?.id});
  });
  const {server,port}=await start(site);

  const seed=await req(port,{path:'/seed'});
  const sid=cookieValue(seed.headers,'aisite.sid');
  assert.ok(sid);
  const result=await websocketExchange(port,`aisite.sid=${sid}`);
  const welcome=result.messages.find(x=>x.welcome);
  assert.equal(welcome.user,44);
  assert.equal(welcome.path,'/ws/test');
  assert.equal(welcome.query,'abc');
  assert.deepEqual(result.echo.echo,{type:'hello',value:7});
  assert.equal(result.echo.user,44);

  for(let i=0;i<50&&site.ws.clientList.length;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(site.ws.clientList.length,0);
  await close(server);
});


test('site.sessions load/save/index/invalidate APIs are backed by the real session directory',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-sessions-api-'));
  const site=core({cwd:dir,compatibility:'isite'});
  site.sessions.saveSession('s1',{user:{id:7,name:'A'},user_id:7});
  site.sessions.saveSession('s2',{user:{id:8,name:'B'},user_id:8});
  site.sessions.replaceList([]);
  const loaded=site.sessions.loadAll();
  assert.equal(loaded.length,2);
  assert.equal(site.sessions.byToken.s1.user.id,7);
  assert.equal(site.sessions.byUserId[8].user.name,'B');
  site.sessions.invalidateUser(7);
  assert.equal(site.sessions.byUserId[7],undefined);
  assert.equal(site.sessions.getSession('s1').user,undefined);
  assert.equal(site.sessions.removeSession(site.sessions.byToken.s2),true);
  assert.equal(site.sessions.getSession('s2'),null);
});
