'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('apps/emails/site_files/html/free.html', 'utf8');
const view = fs.readFileSync('apps/emails/site_files/html/view.html', 'utf8');
const modal = fs.readFileSync('apps/emails/site_files/html/view_modal.html', 'utf8');
const script = fs.readFileSync('apps/emails/site_files/js/index.js', 'utf8');
const findFunction = (name) => {
    const start = script.indexOf('    function ' + name + '(');
    assert(start !== -1, 'Missing ' + name);
    const end = script.indexOf('\n    }\n', start);
    assert(end > start, 'Function boundary missing for ' + name);
    return script.slice(start, end + 6).trim();
};
assert.match(html, /data-inbox-search/);
assert.match(html, /data-inbox-sort/);
for (const filter of ['all', 'codes', 'attachments']) assert(html.includes('data-inbox-filter="' + filter + '"'));
assert.match(html, /data-inbox-alert[^>]*hidden[^>]*role="status" aria-live="polite"/);
assert.match(modal, /data-inbox-navigation[^>]*aria-label="Navigate messages" hidden/);
assert.match(view, /data-otp-card/);
assert.match(script, /const codeBadge = otp \?/);
assert.match(script, /\+ badgeRow \+/);
assert.match(script, /updateMessageNavigation\(guid\)/);
assert.match(script, /generation !== state\.loadGeneration/);
assert.match(script, /pendingLiveRefresh/);
const matchOtpCode = vm.runInNewContext('(' + findFunction('matchOtpCode') + ')');
assert.equal(matchOtpCode('Your verification code is 482193'), '482193');
assert.equal(matchOtpCode('Your OTP is 9472. Do not share it.'), '9472');
assert.equal(matchOtpCode('Security code: A12B34 is ready'), 'A12B34');
assert.equal(matchOtpCode('Order shipped on 2026-10-31'), '');
assert.equal(matchOtpCode('Your monthly newsletter #482193'), '');
assert.equal(matchOtpCode('Please verify your account, no digits here.'), '');
const state = { list: [
    { guid: 'a', date: '2026-10-31', from: 'z@example.com', subject: 'Your verification code is 123456' },
    { guid: 'b', date: '2026-10-30', from: 'a@example.com', subject: 'Attached document', hasAttachments: true },
    { guid: 'c', date: '2026-10-29', from: 'y@example.com', subject: 'Newsletter' },
], inboxFilter: 'all', inboxSort: 'newest' };
let search = '';
const visible = vm.runInNewContext('(' + findFunction('visibleInboxMessages') + ')', {
    state, mode: 'free', q: () => ({ value: search }), matchOtpCode,
});
assert.equal(visible().map(x => x.guid).join(','), 'a,b,c');
state.inboxFilter = 'codes';
assert.equal(visible().map(x => x.guid).join(','), 'a');
state.inboxFilter = 'attachments';
assert.equal(visible().map(x => x.guid).join(','), 'b');
state.inboxFilter = 'all';
state.inboxSort = 'oldest';
assert.equal(visible().map(x => x.guid).join(','), 'c,b,a');
state.inboxSort = 'sender';
assert.equal(visible().map(x => x.guid).join(','), 'b,c,a');
search = 'newsletter';
assert.equal(visible().map(x => x.guid).join(','), 'c');
assert.equal(state.list.map(x => x.guid).join(','), 'a,b,c', 'Original server order must remain unchanged');
const context = {
    matchOtpCode,
    stripHtml: html => html.replace(/<[^>]+>/g, ''),
    URL,
    DOMParser: class { parseFromString(html) { return {querySelectorAll: () => Array.from(html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g), m => ({getAttribute: () => m[1], textContent: m[2]}))}; } },
};
const extractVerification = vm.runInNewContext('(' + findFunction('extractVerification') + ')', context);
const result = extractVerification({ subject: 'Your security code is 731924', text: 'Open https://example.com/activate?token=abc', html: '<p>Welcome</p><a href="https://accounts.example.org/confirm?id=3">Confirm account</a>' });
assert.equal(result.code, '731924');
assert.equal(result.links.length, 2);
assert.equal(result.links[0].domain, 'accounts.example.org');
assert.equal(result.links[1].domain, 'example.com');
assert(!result.links.some(x => x.href.startsWith('javascript:')));
const unsafe = extractVerification({subject:'Your code is 123456',text:'',html:'<a href="javascript:alert(1)">Verify account</a><a href="https://me:pass@example.com/verify">Confirm account</a>'});
assert.equal(unsafe.links.length, 0);
console.log('Smart Inbox 2.0: OTP detection, safe links, search, filters, sorting, navigation and race guards PASS');
