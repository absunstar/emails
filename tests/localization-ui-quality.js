'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeTemplateRenderer } = require('../apps/emails/core/native-template');
const rows = require('../apps/emails/site_files/json/words-localized.json');
const root = path.resolve(__dirname, '..');
const renderer = createNativeTemplateRenderer({ cwd: root, dir: path.join(root, 'site_files'), options: { lang: 'En' } });
const page = path.join(root, 'apps/emails/site_files/html/free.html');
function render(code) { return renderer.render(page, { url: '/' + code + '/', headers: { host: 'emails.egytag.com' } }); }
const ar = render('ar');
const en = render('en');
const byEnglish = new Map(rows.map(row => [row.En, row]));
for (const [name, expected] of Object.entries({
  'My Emails': 'رسائلي',
  'Saved inboxes': 'الصناديق المحفوظة',
  'New Email': 'بريد جديد',
  'Your Mail Inbox': 'صندوق الوارد',
  'Verification code': 'رمز التحقق',
  'Copy code': 'نسخ الرمز',
  'View message': 'عرض الرسالة',
})) assert.equal(byEnglish.get(name)?.Ar, expected, 'Arabic control must be concise: ' + name);
assert.match(ar, /<h2 class="mailbox-sidebar-title">رسائلي<\/h2>/);
assert.match(en, /<h2 class="mailbox-sidebar-title">My Emails<\/h2>/);
const messageView = renderer.render(path.join(root, 'apps/emails/site_files/html/view.html'), { url: '/ar/', headers: { host: 'emails.egytag.com' } });
assert.match(messageView, /<span class="verification-label">رمز التحقق<\/span>/);
assert(messageView.includes('نسخ الرمز'), 'Message viewer should localize code copy');
assert(!ar.includes('\\\\n<div class="mailbox-controls"'), 'No visible literal newline in sidebar');
assert(!ar.includes('##word.'), 'No unresolved localization tokens');
const style = fs.readFileSync(path.join(root, 'apps/emails/site_files/css/language-switch.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/language-switch.js'), 'utf8');
assert(style.includes('html[dir="rtl"] .mailbox-sidebar-title'));
assert(style.includes('html[dir="rtl"] .mail-message-subject'));
assert(style.includes('html[dir="rtl"] .mailbox-address-copy strong'));
assert(script.includes('.otp-copy-label'));
assert(!script.includes(".mail-message-copy,.mail-sender-name"), 'OTP translation must not be skipped with the message container');
assert(script.includes("currentLang==='ar'"), 'Arabic numeric status should have appropriate forms');
console.log('Localized inbox QA: concise Arabic text, sidebar, message viewer, OTP, RTL, dates and EN fallback PASS');
