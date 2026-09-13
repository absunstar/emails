'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http');
const aisite=require('..');

test('core request exposes requestId and AbortSignal with telemetry',async()=>{
  const site=aisite({port:0});
  site.requestTelemetry.configure({enabled:true});
  site.get('/signal',(req,res)=>{
    assert.ok(req.requestId);
    assert.ok(req.signal);
    assert.equal(req.signal.aborted,false);
    site.requestTelemetry.mark('handler');
    res.json({requestId:req.requestId});
  });
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  try{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/signal`);
    assert.equal(r.status,200);
    const body=await r.json();
    assert.ok(body.requestId);
    const rows=site.requestTelemetry.recent(10,{url:'/signal'});
    assert.equal(rows.length,1);
    assert.equal(rows[0].status,200);
    assert.equal(rows[0].phases.some(x=>x.name==='handler'),true);
  }finally{await new Promise(r=>server.close(r))}
});

test('core generic value helpers are independent of iSite',()=>{
  const site=aisite();
  assert.deepEqual(site.deepMerge({a:{x:1}},{a:{y:2}}),{a:{x:1,y:2}});
  assert.deepEqual(site.pick({a:1,b:2},['b']),{b:2});
  assert.deepEqual(site.omit({a:1,b:2},['a']),{b:2});
  assert.equal(site.compatibility.isite,undefined);
});

test('core numberWords returns Arabic words',()=>{
  const site=aisite();
  assert.equal(typeof site.numberWords(123),'string');
  assert.ok(site.numberWords(123).length>0);
});
