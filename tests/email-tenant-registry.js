'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMailTenantRegistry } = require('../apps/emails/core/tenant-registry');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'mail-tenants-'));
const fakeInstance={get(){return {instance:{name:'Test Mail'},network:{mailDomains:['existing.example']}};}};
const registry=createMailTenantRegistry({filePath:path.join(root,'registry.json'),instanceConfig:fakeInstance});

const orgs=registry.listOrganizations();
assert.equal(orgs.length,1);
assert.equal(orgs[0].isDefault,true);
assert.equal(registry.listDomains().length,1);
assert.equal(registry.listDomains()[0].domain,'existing.example');

const acme=registry.createOrganization({name:'Acme Corp'});
const domain=registry.addDomain({organizationId:acme.id,domain:'acme.example',dkimSelector:'mail'});
assert.equal(domain.organizationId,acme.id);
assert.throws(()=>registry.addDomain({organizationId:acme.id,domain:'acme.example'}),/already exists/);
assert.throws(()=>registry.addSender({email:'sales@unknown.example'}),/not registered/);

const sender=registry.addSender({domainId:domain.id,email:'sales@acme.example',displayName:'Acme Sales',tags:['sales','primary']});
assert.equal(sender.organizationId,acme.id);
assert.equal(sender.domainId,domain.id);
assert.equal(registry.resolveSender('sales@acme.example').id,sender.id);
assert.equal(registry.resolveOrganizationByDomain('acme.example').id,acme.id);

assert.throws(()=>registry.removeDomain(domain.id),/Remove sender identities/);
const sender2=registry.addSender({domainId:domain.id,email:'support@acme.example',displayName:'Acme Support'});
const pool=registry.addSenderPool({organizationId:acme.id,name:'Primary Pool',senderIds:[sender.id,sender2.id],mode:'rotate'});
assert.equal(pool.senderIds.length,2);
assert.equal(registry.listSenderPools({organizationId:acme.id})[0].id,pool.id);
assert.equal(registry.senderPoolReadiness(pool.id).total,2);
assert.throws(()=>registry.removeSender(sender.id),/sender pools/);
registry.removeSenderPool(pool.id);
registry.removeSender(sender2.id);
registry.removeSender(sender.id);
assert.equal(registry.removeDomain(domain.id).deleted,true);

const reloaded=createMailTenantRegistry({filePath:path.join(root,'registry.json'),instanceConfig:fakeInstance});
assert(reloaded.listOrganizations().some(x=>x.id===acme.id));
console.log('mail tenant registry tests passed');