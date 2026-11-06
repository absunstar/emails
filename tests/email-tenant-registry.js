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
registry.removeSender(sender.id);
assert.equal(registry.removeDomain(domain.id).deleted,true);

const reloaded=createMailTenantRegistry({filePath:path.join(root,'registry.json'),instanceConfig:fakeInstance});
assert(reloaded.listOrganizations().some(x=>x.id===acme.id));
console.log('mail tenant registry tests passed');