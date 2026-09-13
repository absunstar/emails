'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('..');

test('built-in security profiles expose conservative limits',()=>{
 const site=core();
 for(const name of ['login','otp','passwordReset','api','upload']){
   assert.equal(typeof site.securityProfile(name),'function');
 }
 assert.throws(()=>site.securityProfile('unknown'));
});
