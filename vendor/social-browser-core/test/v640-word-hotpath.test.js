'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');

test('iSite parser calls req.word once per unique word per render',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  let reqCalls=0,siteCalls=0;
  site.word=()=>{siteCalls++;return 'SITE'};
  const req={
    session:{language:{id:'en'}},
    data:{},features:[],
    word(name){reqCalls++;return name==='hello'?'Hello':'World'}
  };
  const html=Array.from({length:200},()=>'<b title="##word.hello##">##word.hello## ##word.world##</b>').join('');
  const out=site.parser.html(html,{req,parser:'html'});
  assert.match(out,/Hello/);
  assert.equal(reqCalls,2);
  assert.equal(siteCalls,0);
});

test('iSite parser falls back to site.word once per unique key when req.word is absent',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  let calls=0;
  site.word=name=>{calls++;return name.toUpperCase()};
  const req={session:{language:{id:'en'}},data:{},features:[]};
  const out=site.parser.html('##word.a## ##word.a## ##word.b## ##word.b##',{req});
  assert.equal(out,'A A B B');
  assert.equal(calls,2);
});
