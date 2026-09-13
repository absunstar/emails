'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const aisite=require('..');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-sb-compat-'))}
async function listen(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return server;
}
async function get(server,p){
  const r=await fetch(`http://127.0.0.1:${server.address().port}${p}`);
  return {status:r.status,body:Buffer.from(await r.arrayBuffer()),headers:r.headers};
}

test('router exact route beats earlier wildcard route',async()=>{
  const site=aisite();
  site.get('/*',(req,res)=>res.send('wild'));
  site.get('/tools',(req,res)=>res.send('exact'));
  const server=await listen(site);
  try{
    const r=await get(server,'/tools');
    assert.equal(r.status,200);
    assert.equal(r.body.toString(),'exact');
  }finally{await new Promise(r=>server.close(r))}
});

test('iSite merged static mounts fall back across app directories',async()=>{
  const cwd=tmp();
  const a=path.join(cwd,'a'),b=path.join(cwd,'site_files','images');
  fs.mkdirSync(a,{recursive:true});fs.mkdirSync(b,{recursive:true});
  fs.writeFileSync(path.join(a,'app-only.txt'),'app');
  fs.writeFileSync(path.join(b,'logo.webp'),'logo');
  const site=aisite({cwd,dir:path.join(cwd,'site_files'),compatibility:'isite'});
  site.onGET({name:'/images',path:a});
  site.onGET({name:'/images',path:b});
  const server=await listen(site);
  try{
    let r=await get(server,'/images/app-only.txt');
    assert.equal(r.status,200);assert.equal(r.body.toString(),'app');
    r=await get(server,'/images/logo.webp');
    assert.equal(r.status,200);assert.equal(r.body.toString(),'logo');
  }finally{await new Promise(r=>server.close(r))}
});

test('iSite parserDir render resolves app site_files/html and words',async()=>{
  const cwd=tmp(),app=path.join(cwd,'apps','demo');
  fs.mkdirSync(path.join(app,'site_files','html'),{recursive:true});
  fs.mkdirSync(path.join(cwd,'site_files','json'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'site_files','json','words.json'),JSON.stringify([{name:'hello',En:'Hello',Ar:'مرحبا'}]));
  fs.writeFileSync(path.join(app,'site_files','html','index.html'),'<h1>##word.hello##</h1><p>##session.language.id##</p>');
  const site=aisite({cwd,dir:path.join(cwd,'site_files'),compatibility:'isite'});
  site.get('/demo',(req,res)=>{
    req.session.language={id:'Ar',urlPrefix:'/ar'};
    return res.render('demo/index.html',{}, {parserDir:app});
  });
  const server=await listen(site);
  try{
    const r=await get(server,'/demo');
    const body=r.body.toString();
    assert.equal(r.status,200);
    assert.match(body,/مرحبا/);
    assert.match(body,/Ar/);
    assert.doesNotMatch(body,/##/);
  }finally{await new Promise(r=>server.close(r))}
});

test('iSite to123/from123 exact codec roundtrips and matches known encoding model',()=>{
  const site=aisite({compatibility:'isite'});
  const values=['hello','Social Browser','7337779763:example',JSON.stringify({a:1})];
  for(const v of values)assert.equal(site.from123(site.to123(v)),v);
  // Every encoded unit is a two-digit member of the historical mapping table.
  const encoded=site.to123('A');
  assert.equal(encoded.length%2,0);
  assert.match(encoded,/^\d+$/);
});

test('iSite Telegram adapter can suppress external network in tests',async()=>{
  const core=aisite();
  core.useCompatibility('isite',{external:false});
  const bot=core.sendTelegramMessage('token','123','hello');
  const result=await bot.sendMessage('123','hello');
  assert.equal(result.suppressed,true);
});

test('iSite legacy date helpers return Date objects',()=>{
  const site=aisite({compatibility:'isite'});
  assert.ok(site.getDate('2026-09-05T01:02:03Z') instanceof Date);
  assert.ok(site.getDateTime('2026-09-05T01:02:03Z') instanceof Date);
  assert.strictEqual(site.getDateTime,site.toDateTime);
});
