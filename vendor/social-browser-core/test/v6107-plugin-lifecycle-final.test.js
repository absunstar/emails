'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');
function request(port,path){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}))}).on('error',reject)})}
async function listening(site){site.run(0);await new Promise((resolve,reject)=>{const s=site.servers[0];if(s.listening)return resolve();s.once('listening',resolve);s.once('error',reject)});return site.servers[0].address().port}

test('preValidation is scoped and ordered before preHandler',async()=>{
  const site=core({port:0,host:'127.0.0.1'});const order=[];
  site.addHook('preValidation',(req)=>{if(req.path==='/api/x')order.push('root:validate')});
  site.register({name:'p',setup(app){
    app.addHook('preValidation',()=>order.push('scope:validate'));
    app.addHook('preHandler',()=>order.push('scope:handler'));
    app.get('/x',(req,res)=>{order.push('route');res.send('ok')});
  }},{encapsulate:true,prefix:'/api'});
  const port=await listening(site);const out=await request(port,'/api/x');
  assert.equal(out.body,'ok');assert.deepEqual(order,['root:validate','scope:validate','scope:handler','route']);
  await site.stop();
});

test('preSerialization and onSend transform structured payloads',async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.register({name:'p',setup(app){
    app.addHook('preSerialization',(req,res,payload)=>({...payload,stage:'serialized'}));
    app.addHook('onSend',(req,res,payload)=>String(payload).replace('serialized','sent'));
    app.get('/json',(req,res)=>res.json({ok:true}));
    app.get('/return',()=>({ok:true}));
  }},{encapsulate:true,prefix:'/api'});
  const port=await listening(site);
  const a=await request(port,'/api/json');const b=await request(port,'/api/return');
  assert.equal(a.body,'{"ok":true,"stage":"sent"}');
  assert.equal(b.body,'{"ok":true,"stage":"sent"}');
  await site.stop();
});

test('payload hooks do not alter sync response helpers when absent',async()=>{
  const site=core({port:0,host:'127.0.0.1'});let endedInside=false;
  site.get('/x',(req,res)=>{res.send('x');endedInside=res.writableEnded;});
  const port=await listening(site);const out=await request(port,'/x');
  assert.equal(out.body,'x');assert.equal(endedInside,true);
  await site.stop();
});

test('onError inherits scope and observes original error',async()=>{
  const site=core({port:0,host:'127.0.0.1',exposeErrors:true});const order=[];
  site.addHook('onError',(err,req)=>{if(req.path==='/api/fail')order.push('root:'+err.message)});
  site.register({name:'p',setup(app){
    app.addHook('onError',(err)=>order.push('scope:'+err.message));
    app.get('/fail',()=>{throw new Error('boom')});
  }},{encapsulate:true,prefix:'/api'});
  const port=await listening(site);const out=await request(port,'/api/fail');
  assert.equal(out.status,500);assert.match(out.body,/boom/);assert.deepEqual(order,['root:boom','scope:boom']);
  await site.stop();
});
