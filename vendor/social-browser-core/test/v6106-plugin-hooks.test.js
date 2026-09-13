'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');
function request(port,path){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}))}).on('error',reject)})}
async function listening(site){site.run(0);await new Promise((resolve,reject)=>{const s=site.servers[0];if(s.listening)return resolve();s.once('listening',resolve);s.once('error',reject)});return site.servers[0].address().port}

test('scoped hooks inherit parent lifecycle in deterministic order', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  const order=[];
  site.addHook('onRequest',(req,res)=>{if(req.path==='/v1/admin/x')order.push('root:onRequest')});
  site.addHook('preHandler',(req,res)=>{if(req.path==='/v1/admin/x')order.push('root:preHandler')});
  site.addHook('onResponse',(req,res)=>{if(req.path==='/v1/admin/x')order.push('root:onResponse')});
  site.register({name:'parent',setup(app){
    app.addHook('onRequest',(req,res)=>order.push('parent:onRequest'));
    app.addHook('preHandler',(req,res)=>order.push('parent:preHandler'));
    app.addHook('onResponse',(req,res)=>order.push('parent:onResponse'));
    app.register({name:'child',setup(child){
      child.addHook('onRequest',(req,res,done)=>{order.push('child:onRequest');done()});
      child.addHook('preHandler',async(req,res)=>{order.push('child:preHandler')});
      child.addHook('onResponse',(req,res)=>order.push('child:onResponse'));
      child.get('/x',(req,res)=>{order.push('handler');res.send('ok')});
    }},{prefix:'/admin'});
  }},{encapsulate:true,prefix:'/v1'});
  const port=await listening(site);
  const out=await request(port,'/v1/admin/x');
  assert.equal(out.status,200);assert.equal(out.body,'ok');
  assert.deepEqual(order,[
    'root:onRequest','parent:onRequest','child:onRequest',
    'root:preHandler','parent:preHandler','child:preHandler',
    'handler',
    'root:onResponse','parent:onResponse','child:onResponse'
  ]);
  await site.stop();
});

test('scoped hooks do not leak outside the plugin route tree', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  let scoped=0;
  site.register({name:'p',setup(app){
    app.addHook('onRequest',()=>{scoped++});
    app.addHook('preHandler',()=>{scoped++});
    app.addHook('onResponse',()=>{scoped++});
    app.get('/inside',(req,res)=>res.send('inside'));
  }},{encapsulate:true,prefix:'/p'});
  site.get('/outside',(req,res)=>res.send('outside'));
  const port=await listening(site);
  const outside=await request(port,'/outside');
  assert.equal(outside.status,200);assert.equal(scoped,0);
  const inside=await request(port,'/p/inside');
  assert.equal(inside.status,200);assert.equal(scoped,3);
  await site.stop();
});

test('onClose hooks run child before parent and global root last', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  const order=[];
  site.addHook('onClose',(app,done)=>{order.push('root:close');done()});
  site.register({name:'parent',setup(app){
    app.addHook('onClose',()=>order.push('parent:close'));
    app.register({name:'child',setup(child){child.addHook('onClose',()=>order.push('child:close'))}},{encapsulate:true});
  }},{encapsulate:true});
  await site.ready();
  await site.stop();
  assert.deepEqual(order,['child:close','parent:close','root:close']);
});
