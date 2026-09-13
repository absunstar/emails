'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v10-compat-'))}

test('iSite user provider API exists only when compat is enabled',()=>{
 const core=aisite({cwd:tmp()});
 assert.equal(core.security.userProviders,undefined);
 const legacy=aisite({cwd:tmp(),compatibility:'isite'});
 assert.ok(legacy.security.userProviders instanceof Map);
 assert.equal(typeof legacy.security.registerUserProvider,'function');
 assert.equal(typeof legacy.security.getSessionUser,'function');
 assert.equal(typeof legacy.security.setSessionUser,'function');
 assert.equal(typeof legacy.security.clearSessionUser,'function');
});

test('iSite external session provider maps to core identity',async()=>{
 const site=aisite({cwd:tmp(),compatibility:'isite'});
 site.security.registerUserProvider('social-browser-json',(id,cb)=>cb(null,{id,email:id+'@example.test'}));
 const session={user_id:'acc_demo',user_source:'social-browser-json'};
 const u=await site.security.getSessionUser(session);
 assert.equal(u.id,'acc_demo');
 assert.equal(u.email,'acc_demo@example.test');
});
