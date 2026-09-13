'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');

function request(port,path){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}))}).on('error',reject)})}

test('first request waits for async registered plugin boot', async()=>{
  const site=core({port:0,host:'127.0.0.1'});
  site.register({name:'routes',async setup(app){await new Promise(r=>setTimeout(r,20));app.onGET('/from-plugin',(req,res)=>res.send('plugin-ready'))}});
  site.run(0);
  await new Promise((resolve,reject)=>{const server=site.servers[0];if(server.listening)return resolve();server.once('listening',resolve);server.once('error',reject)});
  const port=site.servers[0].address().port;
  const result=await request(port,'/from-plugin');
  assert.equal(result.status,200);
  assert.equal(result.body,'plugin-ready');
  await site.stop();
});
