'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');
function request(port,path){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}))}).on('error',reject)})}
async function listening(site){site.run(0);await new Promise((resolve,reject)=>{const s=site.servers[0];if(s.listening)return resolve();s.once('listening',resolve);s.once('error',reject)});return site.servers[0].address().port}

test('encapsulated plugin prefix scopes routes and local decorators', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.decorate('globalValue','root');
  site.register({name:'users',setup(app){
    assert.equal(app.encapsulated,true);
    assert.equal(app.prefix,'/api');
    assert.equal(app.globalValue,'root');
    app.decorate('localValue','plugin');
    assert.equal(app.localValue,'plugin');
    assert.equal(site.localValue,undefined);
    app.onGET('/users',(req,res)=>res.json({local:app.localValue,global:app.globalValue}));
  }},{encapsulate:true,prefix:'/api'});
  const port=await listening(site);
  const ok=await request(port,'/api/users');
  const miss=await request(port,'/users');
  assert.equal(ok.status,200);assert.deepEqual(JSON.parse(ok.body),{local:'plugin',global:'root'});
  assert.equal(miss.status,404);
  await site.stop();
});

test('nested plugin scopes inherit and compose prefixes', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.register({name:'parent',setup(app){
    app.register({name:'child',setup(child){
      assert.equal(child.prefix,'/v1/admin');
      child.get('/health',(req,res)=>res.send('nested-ok'));
    }},{prefix:'/admin'});
  }},{encapsulate:true,prefix:'/v1'});
  const port=await listening(site);
  const result=await request(port,'/v1/admin/health');
  assert.equal(result.status,200);assert.equal(result.body,'nested-ok');
  await site.stop();
});

test('scoped request/reply decorators and middleware only affect plugin prefix', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.register({name:'scoped',setup(app){
    app.decorateRequest('tenant','acme');
    app.decorateReply('pluginReply','yes');
    app.use((req,res,next)=>{res.setHeader('x-plugin-scope','1');next()});
    app.get('/x',(req,res)=>res.json({tenant:req.tenant,reply:res.pluginReply}));
  }},{encapsulate:true,prefix:'/p'});
  site.get('/outside',(req,res)=>res.json({tenant:req.tenant||null,reply:res.pluginReply||null}));
  const port=await listening(site);
  const inside=await request(port,'/p/x');
  const outside=await request(port,'/outside');
  assert.equal(inside.headers['x-plugin-scope'],'1');
  assert.deepEqual(JSON.parse(inside.body),{tenant:'acme',reply:'yes'});
  assert.equal(outside.headers['x-plugin-scope'],undefined);
  assert.deepEqual(JSON.parse(outside.body),{tenant:null,reply:null});
  await site.stop();
});

test('plugin scope is opt-in for backward compatibility', async()=>{
  const site=core({port:0});
  site.register({name:'legacy',setup(app){assert.equal(app,site);app.decorate('legacyGlobal',true)}});
  await site.ready();
  assert.equal(site.legacyGlobal,true);
});
