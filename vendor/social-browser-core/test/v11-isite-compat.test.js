'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('iSite legacy helper names are absent from Core',()=>{
  const site=aisite();
  for(const n of ['stringfiy','from123','to123','showObject']) assert.equal(site[n],undefined,n);
});

test('iSite stringfiy alias is enabled only in compat layer',()=>{
  const site=aisite({compatibility:'isite'});
  assert.equal(typeof site.stringfiy,'function');
  assert.equal(site.stringfiy(123,'ar'),site.numberWords(123));
});

test('iSite from123 is deterministic across input types',()=>{
  const site=aisite({compatibility:'isite'});
  const values=['4159236947792757465382744578276241387191','2619517126151271','bad','',null,undefined,123,[],{}];
  for(const value of values){
    let a,b,ea,eb;
    try{a=site.from123(value)}catch(e){ea=e?.constructor?.name+':'+e?.message}
    try{b=site.from123(value)}catch(e){eb=e?.constructor?.name+':'+e?.message}
    assert.equal(a,b);
    assert.equal(ea,eb);
  }
});
