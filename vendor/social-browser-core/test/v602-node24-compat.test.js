'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {enhanceRequest}=require('../lib/request');
const {enhanceResponse}=require('../lib/response');
const core=require('..');

test('Node 24 getter-only IncomingMessage.signal is never overwritten',()=>{
  const native=new AbortController();
  const req=new http.IncomingMessage({encrypted:false,remoteAddress:'127.0.0.1',on(){},once(){}});
  req.url='/x?a=1';req.headers={host:'localhost'};
  Object.defineProperty(req,'signal',{get:()=>native.signal,configurable:true});
  const descriptorBefore=Object.getOwnPropertyDescriptor(req,'signal');
  assert.equal(descriptorBefore.set,undefined);
  assert.doesNotThrow(()=>enhanceRequest(req));
  assert.equal(req.signal,native.signal);
  assert.ok(req.abortController instanceof AbortController);
  assert.ok(req.abortSignal instanceof AbortSignal);
});

test('request enhancement never depends on legacy URL API',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','request.js'),'utf8');
  assert.doesNotMatch(source,/\burl\.(parse|format|resolve)\s*\(/);
  assert.match(source,/new URL\(/);
});

test('Node 24 removed/deprecated fs and Dirent surfaces are not used',()=>{
  const root=path.join(__dirname,'..','lib');
  const sources=fs.readdirSync(root).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(path.join(root,x),'utf8')).join('\n');
  assert.doesNotMatch(sources,/\bfs\.(F_OK|R_OK|W_OK|X_OK)\b/);
  assert.doesNotMatch(sources,/\bdirent\.path\b/i);
});

test('Node 24 removed HTTP/2 priority signaling is not used',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','lib','http2-client.js'),'utf8');
  assert.doesNotMatch(source,/\.priority\s*\(/);
  assert.doesNotMatch(source,/\bpriority\s*:/);
});

test('Node internal stream modules and process.binding are not used',()=>{
  const root=path.join(__dirname,'..');
  const files=[];
  const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.name==='node_modules')continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.js'))files.push(p)}};
  walk(root);
  const source=files.map(x=>fs.readFileSync(x,'utf8')).join('\n');
  assert.doesNotMatch(source,/require\(['"](?:node:)?_stream_/);
  assert.doesNotMatch(source,/process\.binding\s*\(/);
});

test('server lifecycle works with Node modern close helpers being present or absent',async()=>{
  const site=core();
  site.get('/ok',(req,res)=>res.json({ok:true}));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  const status=await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:'/ok'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))}).on('error',reject);
  });
  assert.equal(status,200);
  await site.stop({forceAfterMs:200});
  assert.equal(site.servers.length,0);
  assert.equal(site._connections.size,0);
});

test('WHATWG URL parsing handles malformed percent encoding without legacy url.parse fallback',()=>{
  const req=new http.IncomingMessage({encrypted:false,remoteAddress:'127.0.0.1',on(){},once(){}});
  req.headers={host:'localhost'};req.url='/a/%E0%A4%A?x=%E0%A4%A';
  assert.doesNotThrow(()=>enhanceRequest(req));
  assert.equal(req.path,'/a/%E0%A4%A');
});

test('package explicitly documents Node 24 as supported',()=>{
  const pkg=require('../package.json');
  assert.ok(pkg.nodeSupport?.tested?.includes('24.20.0'));
});
