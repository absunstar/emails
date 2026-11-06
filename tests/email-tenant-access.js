'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMailTenantRegistry } = require('../apps/emails/core/tenant-registry');
const { permissionsForRole, hasPermission, httpPermission, mcpPermission } = require('../apps/emails/core/tenant-access');

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-tenant-access-'));
  const registry = createMailTenantRegistry({ filePath: path.join(root, 'registry.json') });
  const org = registry.createOrganization({ name: 'Tenant A' });

  const viewer = registry.createAccessKey({ organizationId: org.id, name: 'Viewer', role: 'viewer' });
  const operator = registry.createAccessKey({ organizationId: org.id, name: 'Operator', role: 'operator' });
  const admin = registry.createAccessKey({ organizationId: org.id, name: 'Admin', role: 'organization_admin' });

  const disk = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const raw = JSON.stringify(disk);
  assert(!raw.includes(viewer.secret), 'Plaintext access-key secret must never be persisted');
  assert(disk.accessKeys.every((k) => typeof k.secretHash === 'string' && k.secretHash.length === 64));

  const viewerPrincipal = registry.authenticateAccessKey(viewer.secret);
  assert(viewerPrincipal && viewerPrincipal.organizationId === org.id);
  assert(hasPermission(viewerPrincipal, 'mail.read'));
  assert(!hasPermission(viewerPrincipal, 'mail.write'));
  assert(!hasPermission(viewerPrincipal, 'mail.send'));
  assert(!hasPermission(viewerPrincipal, 'instance.admin'));

  const operatorPrincipal = registry.authenticateAccessKey(operator.secret);
  assert(hasPermission(operatorPrincipal, 'mail.send'));
  assert(hasPermission(operatorPrincipal, 'campaign.write'));
  assert(!hasPermission(operatorPrincipal, 'tenant.write'));
  assert(!hasPermission(operatorPrincipal, 'instance.admin'));

  const adminPrincipal = registry.authenticateAccessKey(admin.secret);
  assert(hasPermission(adminPrincipal, 'tenant.write'));
  assert(hasPermission(adminPrincipal, 'sender.write'));
  assert(!hasPermission(adminPrincipal, 'instance.admin'));

  assert.equal(httpPermission('/api/emails/admin/summary', 'POST'), 'mail.read');
  assert.equal(httpPermission('/api/emails/admin/campaigns/create', 'POST'), 'campaign.write');
  assert.equal(httpPermission('/api/emails/admin/instance/update', 'POST'), 'instance.admin');
  assert.equal(mcpPermission('email_search'), 'mail.read');
  assert.equal(mcpPermission('email_send'), 'mail.send');
  assert.equal(mcpPermission('email_access_key_create'), 'tenant.write');
  assert.equal(mcpPermission('email_instance_update'), 'instance.admin');

  registry.revokeAccessKey(viewer.key.id);
  assert.equal(registry.authenticateAccessKey(viewer.secret), null);

  assert.deepEqual(permissionsForRole('viewer').sort(), ['campaign.read','deliverability.read','mail.read','schedule.read','sender.read','tenant.read'].sort());

  fs.rmSync(root, { recursive: true, force: true });
  console.log('tenant access key and RBAC tests passed');
})();