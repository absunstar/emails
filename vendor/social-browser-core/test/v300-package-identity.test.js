'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

test('@social-browser/core package identity is canonical',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8'));
  assert.equal(pkg.name,'@social-browser/core');
  assert.equal(pkg.version,'6.10.2');
});

test('root export exposes createSite and canonical metadata',()=>{
  const core=require('..');
  assert.equal(typeof core,'function');
  assert.equal(typeof core.createSite,'function');
  assert.equal(core.version,'6.10.2');
  assert.equal(core.packageName,'@social-browser/core');
  const site=core();
  assert.equal(site.version,'6.10.2');
  assert.equal(site.packageName,'@social-browser/core');
});
