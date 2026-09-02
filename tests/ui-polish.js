const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const free = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/free.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/login.html'), 'utf8');
const loginJs = fs.readFileSync(path.join(root, 'site_files/js/login.js'), 'utf8');
function assert(value, message) { if (!value) throw new Error(message); }
assert(free.includes('class="hero-title"') && free.includes('hero-title-line'), 'Homepage hero line-height fix is missing');
assert(free.includes('mailbox-pref-btn:after') && free.includes('mailbox-pref-btn.is-on:before'), 'Preference toggle treatment is missing');
assert(free.includes('livePulseQuiet 10s'), 'Live status pulse should be periodic instead of continuous');

assert(free.includes('max-width:none') && free.includes('padding:6px 10px 52px'), 'Desktop homepage should use the available page width with compact outer spacing');
assert(free.includes('grid-template-columns:clamp(320px,22vw,390px) minmax(0,1fr)'), 'Wide homepage workspace should scale its sidebar without constraining the main inbox');
assert(login.includes('browser-login-download') && login.includes('Download Social Browser'), 'Primary Social Browser download CTA is missing');
assert(login.includes('data-copy-page-link') && login.includes('Copy this page link'), 'Copy-page action is missing from login');
assert(login.includes('How it works') && login.includes('What you unlock'), 'Login guidance hierarchy is incomplete');
assert(login.includes('Back to Temp Mail'), 'Back to Temp Mail action is missing');
assert(!login.includes('Continue securely in Social Browser'), 'Old login hierarchy is still present');
assert(loginJs.includes("SBUI.copy(location.href)"), 'Login page link copy behavior is missing');
assert(loginJs.includes("SBUI.toast('Page link copied."), 'Login copy feedback is missing');
assert(loginJs.includes("setState('needs-browser')") && loginJs.includes("setState('is-ready')"), 'Login visual states are missing');
console.log('Homepage and login UI polish checks passed');
