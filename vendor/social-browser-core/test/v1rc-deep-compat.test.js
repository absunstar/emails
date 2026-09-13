
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('iSite v14 security tracked surface exists',()=>{
 const site=aisite({compatibility:'isite'}),s=site.security;
 const f=['addKey','addPermissions','addRole','addRoles','addUser','addUserPermission','cacheUser','deleteRole','deleteUser','editeRole','findCachedUser','getUser','getUserFinger','getUserPermissions','getUserRoles','getUsers','handleUser','indexUser','isUserExists','isUserHasPermission','isUserHasPermissions','isUserHasRole','isUserHasRoles','isUserLogin','loadAllRoles','loadAllUsers','login','logout','rebuildRoleIndexes','rebuildUserIndexes','register','removeRole','removeUserFinger','updateRole','updateUser'];
 for(const n of f)assert.equal(typeof s[n],'function',n);
 assert.strictEqual(s.deleteRole,s.removeRole);
 assert.strictEqual(s.editeRole,s.updateRole);
});

test('iSite v14 sessions tracked surface exists',()=>{
 const site=aisite({compatibility:'isite'}),s=site.sessions;
 for(const n of ['attach','handleSessions','indexSession','invalidateUser','loadAll','push','rebuildIndexes','replaceList','save','saveAll'])assert.equal(typeof s[n],'function',n);
 assert.ok(Array.isArray(s.list));assert.equal(typeof s.path,'string');
});

test('iSite v14 mongodb alias identity groups match',()=>{
 const site=aisite({compatibility:'isite'}),m=site.mongodb;
 assert.strictEqual(m.delete,m.deleteMany);
 assert.strictEqual(m.find,m.findMany);
 assert.strictEqual(m.insert,m.insertMany);
 assert.strictEqual(m.update,m.updateMany);
});
