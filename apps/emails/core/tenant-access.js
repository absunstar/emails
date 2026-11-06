'use strict';

const ROLE_PERMISSIONS = Object.freeze({
  super_admin: ['*'],
  organization_admin: [
    'mail.read','mail.write','mail.send',
    'campaign.read','campaign.write','schedule.read','schedule.write',
    'deliverability.read','deliverability.write',
    'tenant.read','tenant.write','sender.read','sender.write',
  ],
  operator: [
    'mail.read','mail.write','mail.send',
    'campaign.read','campaign.write','schedule.read','schedule.write',
    'deliverability.read','sender.read','tenant.read',
  ],
  viewer: [
    'mail.read','campaign.read','schedule.read','deliverability.read','sender.read','tenant.read',
  ],
});

function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[String(role || '').trim()] || [])];
}

function hasPermission(principal, permission) {
  if (!principal) return false;
  const permissions = new Set(Array.isArray(principal.permissions) ? principal.permissions : permissionsForRole(principal.role));
  return permissions.has('*') || permissions.has(permission);
}

function httpPermission(pathname, method) {
  const p = String(pathname || '');
  const write = String(method || 'GET').toUpperCase() !== 'GET';

  if (/\/admin\/(?:instance|policy|operations)\//.test(p)) return 'instance.admin';
  if (/\/admin\/deliverability\/config/.test(p)) return 'instance.admin';

  if (/\/admin\/organizations\/(?:create|add|delete)/.test(p)) return 'instance.admin';
  if (/\/admin\/organizations\/update/.test(p)) return 'tenant.write';
  if (/\/admin\/access-keys\/(?:create|revoke)/.test(p)) return 'tenant.write';
  if (/\/admin\/access-keys\/list/.test(p)) return 'tenant.write';
  if (/\/admin\/(?:members|invitations)\/(?:create|update|delete|remove|revoke)/.test(p)) return 'tenant.write';
  if (/\/admin\/(?:members|invitations)\/list/.test(p)) return 'tenant.write';
  if (/\/admin\/(?:domains|senders|sender-pools)\/(?:add|update|delete|verify)/.test(p)) return 'sender.write';
  if (/\/admin\/(?:organizations|domains|senders|sender-pools)\//.test(p)) return 'tenant.read';

  if (/\/admin\/campaigns\/(?:create|update|start|pause|resume|stop|delete)/.test(p)) return 'campaign.write';
  if (/\/admin\/campaigns\//.test(p)) return 'campaign.read';

  if (/\/admin\/schedules\/(?:create|update|cancel|send-now|retry)/.test(p)) return 'schedule.write';
  if (/\/admin\/schedules\//.test(p)) return 'schedule.read';

  if (/\/admin\/deliverability\/(?:suppressions\/add|suppressions\/remove|feedback)/.test(p)) return 'deliverability.write';
  if (/\/admin\/deliverability\//.test(p)) return 'deliverability.read';

  if (/\/admin\/(?:send|reply|forward)/.test(p)) return 'mail.send';
  if (/\/admin\/(?:update|bulk-update|delete|bulk-delete|folder\/create|vip)/.test(p)) return 'mail.write';
  if (/\/admin\//.test(p)) return write ? 'mail.read' : 'mail.read';
  return '';
}

function mcpPermission(name) {
  const n = String(name || '');
  if (n === 'email_capabilities') return 'tenant.read';
  if (/^email_(?:instance|policy|backup|backups|restore|storage|operations)/.test(n)) return 'instance.admin';
  if (/^email_organization_(?:create|delete)/.test(n)) return 'instance.admin';
  if (/^email_organization_update/.test(n)) return 'tenant.write';
  if (/^email_access_key_(?:create|revoke)/.test(n)) return 'tenant.write';
  if (/^email_access_keys_list/.test(n)) return 'tenant.write';
  if (/^email_(?:member_(?:update|delete)|invitation_(?:create|revoke))/.test(n)) return 'tenant.write';
  if (/^email_(?:members_list|invitations_list)/.test(n)) return 'tenant.write';
  if (/^email_(?:domain|sender|sender_pool)_(?:add|update|delete|verify)/.test(n)) return 'sender.write';
  if (/^email_(?:tenants_status|organizations_list|domains_list|senders_list|sender_pools_list|sender_readiness|sender_pool_readiness)/.test(n)) return 'tenant.read';

  if (/^email_campaign_(?:create|update|start|pause|resume|stop|delete)/.test(n)) return 'campaign.write';
  if (/^email_campaign/.test(n)) return 'campaign.read';

  if (/^email_schedule(?:_|$)/.test(n) && !/^email_schedules_list$/.test(n)) return n === 'email_scheduler_status' ? 'schedule.read' : 'schedule.write';
  if (/^email_(?:schedules_list|scheduler_status)/.test(n)) return 'schedule.read';

  if (/^email_(?:suppression_add|suppression_remove|delivery_feedback_report|deliverability_config_update)/.test(n)) return n === 'email_deliverability_config_update' ? 'instance.admin' : 'deliverability.write';
  if (/^email_(?:deliverability|suppressions_list)/.test(n)) return 'deliverability.read';

  if (/^email_(?:send|send_bulk|reply|forward)/.test(n)) return 'mail.send';
  if (/^email_(?:update|update_bulk|set_read|delete|delete_bulk|delete_matching|folder_create|vip_set)/.test(n)) return 'mail.write';
  if (/^email_(?:search|read|read_many|stats|mailbox_statuses|attachment_read|eml_export|analyze|vip_list|folders_list)/.test(n)) return 'mail.read';
  return 'instance.admin';
}

module.exports = { ROLE_PERMISSIONS, permissionsForRole, hasPermission, httpPermission, mcpPermission };
