const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
function assert(value, message) { if (!value) throw new Error(message); }
assert(frontend.includes('response.doc || response.message || (Array.isArray(response.list) ? response.list[0] : null)'), 'Message viewer must accept doc/message/list API response shapes');
assert(frontend.includes("if (!mail) throw new Error(response.error || 'Email not found')"), 'Message viewer must fail explicitly when no message payload exists');
assert(app.includes('response.doc = doc;') && app.includes('response.message = doc;') && app.includes('response.list = [doc];'), 'View API must expose canonical and compatibility single-message response keys');
console.log('Message view API/UI contract checks passed');
assert(app.includes("const requestedMailbox = normalizeEmail(input.email || input.to || '')"), 'View API must support mailbox-scoped new mobile clients');
assert(app.includes("requestedMailbox ? 'id+mailbox' : 'legacy-id'"), 'View API must preserve id-only legacy mobile lookup');
assert(app.includes("response.resolvedBy = 'mailbox-id-fallback'"), 'View API must include mailbox fallback for migrated stores');
assert(app.includes("for (const key of ['from', 'to', 'cc', 'subject', 'text', 'html', 'date'"), 'View API must expose top-level legacy message aliases');
