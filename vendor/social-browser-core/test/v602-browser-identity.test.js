'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const core=require('..');
const {enhanceRequest,parseBrowserIdentity}=require('../lib/request');

function mockReq(headers={}){
  const req=new http.IncomingMessage({encrypted:false,remoteAddress:'127.0.0.1',on(){},once(){}});
  req.url='/';req.headers={host:'localhost',...headers};
  return req;
}

test('Social Browser X-Browser header matches current iSite identity semantics',()=>{
  const full='browser_machine_profile_Chrome-test-developer';
  const req=mockReq({'x-browser':'social.'+full,'x-browser-token':'opaque-proof'});
  enhanceRequest(req);
  assert.equal(req.browserHeader,'social.'+full);
  assert.equal(req.browserName,'social');
  assert.equal(req.browserID,full);
  assert.equal(req.browserUUID,'Chrome-test-developer');
  assert.equal(req.browserIDShort,'Chrome-test-developer');
  assert.equal(req.browserFullID,full);
  assert.equal(req.browserCanonicalID,'Chrome-test-developer');
  assert.equal(req.browserDetected,true);
  assert.equal(req.isSocialBrowser,true);
  assert.equal(req.browserToken,'opaque-proof');
  assert.deepEqual(req.browserAuth,{
    detected:true,
    socialBrowser:true,
    tokenPresent:true,
    browserHeader:'social.'+full,
    browserName:'social',
    browserID:full,
    browserUUID:'Chrome-test-developer',
    browserIDShort:'Chrome-test-developer',
    browserFullID:full,
    browserCanonicalID:'Chrome-test-developer'
  });
});

test('header without brand remains backward-compatible browser ID but is not Social Browser',()=>{
  const req=mockReq({'x-browser':'ABC_DEF_123'});
  enhanceRequest(req);
  assert.equal(req.browserName,'');
  assert.equal(req.browserID,'ABC_DEF_123');
  assert.equal(req.browserUUID,'123');
  assert.equal(req.browserIDShort,'123');
  assert.equal(req.browserDetected,true);
  assert.equal(req.isSocialBrowser,false);
});

test('missing browser header exposes explicit empty identity state',()=>{
  const req=mockReq();
  enhanceRequest(req);
  assert.equal(req.browserHeader,'');
  assert.equal(req.browserID,'');
  assert.equal(req.browserUUID,'');
  assert.equal(req.browserIDShort,'');
  assert.equal(req.browserDetected,false);
  assert.equal(req.isSocialBrowser,false);
  assert.equal(req.browserAuth.detected,false);
});

test('iSite compatibility adds browser features expected by legacy website code',async()=>{
  const site=core({compatibility:'isite'});
  site.get('/identity',(req,res)=>res.json({
    browserHeader:req.browserHeader,
    browserName:req.browserName,
    browserID:req.browserID,
    browserUUID:req.browserUUID,
    browserIDShort:req.browserIDShort,
    detected:req.browserDetected,
    social:req.isSocialBrowser,
    features:req.features
  }));
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  site.servers.push(server);
  const port=server.address().port;
  const full='social_machine_ABCDEF123456';
  const row=await new Promise((resolve,reject)=>{
    const r=http.get({host:'127.0.0.1',port,path:'/identity',headers:{'X-Browser':'social.'+full,'X-Browser-Token':'proof'}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });r.on('error',reject);
  });
  assert.equal(row.browserName,'social');
  assert.equal(row.browserID,full);
  assert.equal(row.browserUUID,'ABCDEF123456');
  assert.equal(row.browserIDShort,'ABCDEF123456');
  assert.equal(row.social,true);
  assert.ok(row.features.includes('browser.social'));
  assert.ok(row.features.includes('browser.social.'+full));
  assert.ok(row.features.includes('browser.'+full));
  assert.ok(row.features.includes('browser.ABCDEF123456'));
  assert.ok(row.features.includes('browser.auth-token'));
  await site.stop({forceAfterMs:200});
});
