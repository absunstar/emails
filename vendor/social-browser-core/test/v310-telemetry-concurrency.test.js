'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RequestTelemetry}=require('../lib/request-telemetry');

test('request telemetry is opt-in by default',()=>{
 const t=new RequestTelemetry();
 assert.equal(t.enabled,false);
});

test('request telemetry keeps concurrent requests isolated',()=>{
 const t=new RequestTelemetry({enabled:true});
 const a={requestId:'a',method:'GET',url:'/a'},b={requestId:'b',method:'GET',url:'/b'};
 t.begin(a);t.begin(b);
 t.mark(a,'a-phase');t.mark(b,'b-phase');
 t.end(b,{statusCode:201});t.end(a,{statusCode:200});
 const rows=t.recent(10);
 const ra=rows.find(x=>x.requestId==='a'),rb=rows.find(x=>x.requestId==='b');
 assert.deepEqual(ra.phases.map(x=>x.name),['a-phase']);
 assert.deepEqual(rb.phases.map(x=>x.name),['b-phase']);
 assert.equal(ra.status,200);assert.equal(rb.status,201);
});
