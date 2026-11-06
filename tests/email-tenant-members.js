'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMailTenantRegistry } = require('../apps/emails/core/tenant-registry');
const { hasPermission } = require('../apps/emails/core/tenant-access');

(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-members-'));
  const registry = createMailTenantRegistry({ filePath: path.join(root, 'registry.json') });
  const orgA = registry.createOrganization({ name: 'Org A' });
  const orgB = registry.createOrganization({ name: 'Org B' });

  const inviteA = registry.createInvitation({ organizationId: orgA.id, email: 'person@example.com', name: 'Person', role: 'operator' });
  assert(inviteA.secret.startsWith('emi_'));
  assert.equal(inviteA.invitation.status, 'pending');

  const raw = fs.readFileSync(path.join(root, 'registry.json'), 'utf8');
  assert(!raw.includes(inviteA.secret), 'Invitation secret must never be persisted in plaintext');

  const acceptedA = registry.acceptInvitation(inviteA.secret, {
    authProvider: 'x-browser',
    subject: 'social.browser-user-1',
    displayName: 'Browser User',
  });
  assert.equal(acceptedA.member.organizationId, orgA.id);
  assert.equal(acceptedA.member.role, 'operator');
  assert.equal(acceptedA.member.authProvider, 'x-browser');
  assert.equal(acceptedA.member.subject, 'social.browser-user-1');
  assert.equal(registry.listInvitations({ organizationId: orgA.id })[0].status, 'accepted');

  const principalA = registry.principalForIdentity('x-browser', 'social.browser-user-1', orgA.id);
  assert.equal(principalA.organizationId, orgA.id);
  assert.equal(principalA.role, 'operator');
  assert(hasPermission(principalA, 'mail.send'));
  assert(!hasPermission(principalA, 'tenant.write'));

  const inviteB = registry.createInvitation({ organizationId: orgB.id, role: 'viewer', name: 'Second org' });
  registry.acceptInvitation(inviteB.secret, { authProvider: 'x-browser', subject: 'social.browser-user-1', displayName: 'Browser User' });
  const memberships = registry.membershipsForIdentity('x-browser', 'social.browser-user-1');
  assert.equal(memberships.length, 2);

  const principalB = registry.principalForIdentity('x-browser', 'social.browser-user-1', orgB.id);
  assert.equal(principalB.organizationId, orgB.id);
  assert.equal(principalB.role, 'viewer');

  const updated = registry.updateMember(acceptedA.member.id, { role: 'organization_admin' });
  assert.equal(updated.role, 'organization_admin');
  assert(hasPermission(registry.principalForIdentity('x-browser', 'social.browser-user-1', orgA.id), 'tenant.write'));

  registry.updateMember(acceptedA.member.id, { status: 'disabled' });
  const afterDisable = registry.membershipsForIdentity('x-browser', 'social.browser-user-1');
  assert.equal(afterDisable.length, 1);
  assert.equal(afterDisable[0].organizationId, orgB.id);

  const pending = registry.createInvitation({ organizationId: orgA.id, role: 'viewer' });
  const revoked = registry.revokeInvitation(pending.invitation.id);
  assert.equal(revoked.status, 'revoked');
  assert.throws(() => registry.acceptInvitation(pending.secret, { authProvider:'x-browser', subject:'other' }), /not found|active/i);

  registry.removeMember(acceptedA.member.id);
  assert(!registry.listMembers({ organizationId: orgA.id }).some(x => x.id === acceptedA.member.id));

  fs.rmSync(root, { recursive: true, force: true });
  console.log('tenant members and invitations tests passed');
})();