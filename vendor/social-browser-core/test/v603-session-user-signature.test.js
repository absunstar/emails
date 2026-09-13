'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const create=require('..');

test('iSite setSessionUser accepts request + options and persists canonical session', async()=>{
  const site=create({compatibility:'isite'});
  let saves=0;
  const req={session:{$save:async()=>{saves++}}};
  const user={id:'acc_123',accountId:'acc_123',email:'user@example.test'};
  await site.security.setSessionUser(req,user,{source:'social-browser-json',authMethod:'browser'});
  assert.equal(req.session.user,user);
  assert.equal(req.session.user_id,'acc_123');
  assert.equal(req.session.user_source,'social-browser-json');
  assert.equal(req.session.user_auth_method,'browser');
  assert.deepEqual(req.session.identityRef,{provider:'social-browser-json',id:'acc_123'});
  assert.ok(req.session.$userLoadedAt>0);
  assert.equal(saves,1);
});

test('iSite setSessionUser keeps legacy session + source signature', async()=>{
  const site=create({compatibility:'isite'});
  const session={};
  await site.security.setSessionUser(session,{id:'legacy_1'},'legacy-provider');
  assert.equal(session.user_id,'legacy_1');
  assert.equal(session.user_source,'legacy-provider');
});

test('iSite user provider supports current object-shaped identity callback', async()=>{
  const site=create({compatibility:'isite'});
  site.security.registerUserProvider('social-browser-json',({id},done)=>done(null,{id,email:id+'@example.test'}));
  const user=await site.security.getSessionUser({user_id:'acc_77',user_source:'social-browser-json'});
  assert.equal(user.id,'acc_77');
});
