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
assert(app.includes("requestedMailbox ? 'id+mailbox+domain' : 'legacy-id+domain'"), 'View API must preserve id-only legacy mobile lookup');
assert(app.includes("for (const key of ['from', 'to', 'cc', 'subject', 'text', 'html', 'date'"), 'View API must expose top-level legacy message aliases');
assert(app.includes("response.resolvedBy = requestedMailbox ? 'id+mailbox+domain' : 'legacy-id+domain'"), 'View API must trust canonical id within the deployment domain');
assert(app.includes('service.store.getMessagesById'), 'View API must support duplicate legacy numeric ids');
assert(app.includes("candidates = all.filter((item) => idLike(item.id, input.id))"), 'View API must use like-compatible id matching when the id index misses');
assert(app.includes("typeof left.like === 'function'"), 'View API must prefer String.like when available');
assert(app.includes('response.mailboxHeaderMismatch = true'), 'Mailbox/header mismatch must be diagnostic only, not a view blocker');
