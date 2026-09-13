'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Router}=require('../lib/router');

test('indexed router preserves exact > param > wildcard specificity',()=>{
  const r=new Router();
  r.add('GET','/*',()=>1);
  r.add('GET','/:id',()=>2);
  r.add('GET','/users/:id',()=>3);
  r.add('GET','/users/me',()=>4);
  assert.equal(r.match('GET','/users/me').route.pattern,'/users/me');
  assert.equal(r.match('GET','/users/42').route.pattern,'/users/:id');
  assert.equal(r.match('GET','/x').route.pattern,'/:id');
});

test('indexed router keeps method separation and ALL fallback',()=>{
  const r=new Router();
  r.add('ALL','/x',()=>1);
  r.add('POST','/x',()=>2);
  assert.equal(r.match('GET','/x').route.method,'ALL');
  assert.equal(r.match('POST','/x').route.method,'POST');
});

test('indexed router matches thousands of exact routes',()=>{
  const r=new Router();
  for(let i=0;i<10000;i++)r.add('GET','/r'+i,()=>i);
  assert.equal(r.match('GET','/r9999').route.pattern,'/r9999');
  assert.equal(r.match('GET','/missing'),null);
});

test('route cache invalidates on add',()=>{
  const r=new Router();
  r.add('GET','/*',()=>1);
  assert.equal(r.match('GET','/a').route.pattern,'/*');
  r.add('GET','/a',()=>2);
  assert.equal(r.match('GET','/a').route.pattern,'/a');
});
