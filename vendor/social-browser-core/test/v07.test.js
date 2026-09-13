'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

test('differential harness is shipped',()=>{
  assert.equal(fs.existsSync(path.join(__dirname,'..','scripts','differential-isite.js')),true);
});
