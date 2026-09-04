'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createBrowserAuth, parseBrowserHeader, browserIdentity } = require('../apps/emails/core/browser-auth');
const { isBrowserSession, browserRequestID } = require('../apps/emails/core/access');

const parsed = parseBrowserHeader('social.test_uuid');
assert.deepStrictEqual(parsed, { raw: 'social.test_uuid', brand: 'social', id: 'test_uuid' });
assert.strictEqual(parseBrowserHeader(''), null);

const auth = createBrowserAuth();
const req = {
    headers: { 'x-browser': 'social.test_uuid' },
    session: { $save() {} },
};
const status = auth.status(req);
assert.strictEqual(status.done, true);
assert.strictEqual(status.loggedIn, true);
assert.strictEqual(status.browser.detected, true);
assert.strictEqual(status.browser.browserID, 'social.test_uuid');
assert.strictEqual(status.browser.browserUUID, 'test_uuid');
assert.strictEqual(status.user.id, 'social.test_uuid');
assert.strictEqual(status.user.authProvider, 'x-browser');
assert.strictEqual(req.session.user_source, 'x-browser');
assert.strictEqual(req.session.user_auth_method, 'browser-header');
assert.strictEqual(isBrowserSession(req), true);
assert.strictEqual(browserRequestID(req), 'social.test_uuid');
assert.strictEqual(browserIdentity(req).id, 'test_uuid');

const versionReq = { headers: { 'x-browser': 'social.test_version', 'x-browser-version': '2026.09.15' }, session: { $save() {} } };
const versionStatus = auth.status(versionReq);
assert.strictEqual(versionStatus.browser.version, '2026.09.15');
const signedOut = auth.signOut(versionReq);
assert.strictEqual(signedOut.loggedIn, false);
assert.strictEqual(auth.status(versionReq).loggedIn, false);
assert.strictEqual(auth.status(versionReq).browser.detected, true);
assert.strictEqual(auth.signIn(versionReq).loggedIn, true);

const stale = { headers: {}, session: { user: { id: 'social.old', authProvider: 'x-browser' }, user_source: 'x-browser', $save() {} } };
const staleStatus = auth.status(stale);
assert.strictEqual(staleStatus.loggedIn, false);
assert.strictEqual(stale.session.user, null);
assert.strictEqual(isBrowserSession(stale), false);

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps', 'emails', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'apps', 'emails', 'core', 'browser-auth.js'), 'utf8');
const login = fs.readFileSync(path.join(root, 'apps', 'emails', 'site_files', 'html', 'login.html'), 'utf8');
const scripts = fs.readFileSync(path.join(root, 'site_files', 'html', 'scripts.html'), 'utf8');
const navbar = fs.readFileSync(path.join(root, 'site_files', 'html', 'navbar', 'index.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'apps', 'emails', 'site_files', 'html', 'index.html'), 'utf8');
assert(/\/api\/v2\/browser-auth\/status/.test(app));
assert(!/\/auth\/social-browser\/(?:start|callback)/.test(app));
assert(/\/api\/v2\/browser-auth\/signout/.test(app));
assert(/\/api\/v2\/browser-auth\/signin/.test(app));
assert(!/handoff|exchange|x-browser-token|social-browser\.com/i.test(backend));
assert(/href=["']https:\/\/social-browser\.com\/["']/.test(login));
assert(!/x-browser|x-browser-token|header|handoff|exchange|token/i.test(login));
const loginJs = fs.readFileSync(path.join(root, 'site_files', 'js', 'login.js'), 'utf8');
assert(!/x-browser-token|handoff|exchange|token/i.test(loginJs));
assert(/Download Social Browser/.test(login + loginJs));
assert(/How it works/.test(login));
assert(/Open this website again/.test(login));
assert(/Up to 100 saved inboxes/.test(login));
assert(/Reply &amp; Forward/.test(login));
assert(/Back to Temp Mail/.test(login));
assert(!/loadLocalApp\(['\"]security['\"]\)/.test(server));
assert(!/security\/(?:login|register|logout)_modal\.html/.test(scripts));
assert(!/x-permission=["']!?login["']/.test(navbar + admin));

console.log('x-browser-only login tests passed');
