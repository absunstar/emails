'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isSocialBrowserRequest, getClientContext } = require('../apps/emails/core/client-context');

assert.strictEqual(isSocialBrowserRequest({ headers: { 'x-browser': 'Social Browser' } }), true);
assert.strictEqual(isSocialBrowserRequest({ headers: { 'X-Browser': '1' } }), true);
assert.strictEqual(isSocialBrowserRequest({ headers: { 'x-browser': '' } }), false);
assert.strictEqual(isSocialBrowserRequest({ headers: {} }), false);
assert.deepStrictEqual(getClientContext({ headers: { 'x-browser': 'anything' } }), { done: true, isSocialBrowser: true });
assert.deepStrictEqual(getClientContext({ headers: {} }), { done: true, isSocialBrowser: false });

const frontend = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'js', 'index.js'), 'utf8');
const freeHtml = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html', 'free.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'app.js'), 'utf8');

assert(/GUEST_ADDRESS_LIMIT\s*=\s*10/.test(frontend), 'Guest limit must be 10 addresses');
assert(/SOCIAL_BROWSER_ADDRESS_LIMIT\s*=\s*100/.test(frontend), 'Social Browser limit must be 100 addresses');
assert(/localStorage\.getItem\(addressStorageKey\(\)\)/.test(frontend), 'Address book must load from localStorage');
assert(/localStorage\.setItem\(addressStorageKey\(\)/.test(frontend), 'Address book must save to localStorage');
assert(/\/api\/emails\/client-context/.test(frontend), 'Page must receive browser capability signal from the server');
assert(/x-browser/.test(fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'core', 'client-context.js'), 'utf8')), 'Social Browser detection must use x-browser header');
assert(!/window\.SOCIALBROWSER[^\n]*(?:addressLimit|isSocialBrowser|canRemoveAddress)/.test(frontend), 'Free address limits must not detect Social Browser from window.SOCIALBROWSER');
assert(/data-address-list/.test(freeHtml), 'Free page must render the saved-address side list');
assert(/data-limit-alert/.test(freeHtml), 'Free page must show a dedicated limit-reached alert');
assert(/state\.addressBook\.addresses\.length === state\.client\.addressLimit/.test(frontend), 'Limit alert must trigger when the final available address is added');
assert(/showLimitAlert\(message\)/.test(frontend), 'Attempts beyond the limit must also show the limit alert');
assert(/https:\/\/social-browser\.com\//.test(freeHtml), 'Guest limit alert must link to the Social Browser website');
assert(!/data-mail-address[^>]*\sreadonly(?:\s|=|>)/i.test(freeHtml), 'Temp-mail address field must allow manual typing');
assert(/View Messages/.test(freeHtml), 'Inbox action should clearly support viewing a typed mailbox');
assert(/if \(mode === 'free' && !addressEntry\(email\) && !addAddress\(email\)\) return;/.test(frontend), 'Viewing a new mailbox must add it to the local address book before loading messages');
assert(/const at = email\.lastIndexOf\('@'\)/.test(frontend), 'A complete manually entered email address must preserve its explicit domain');
assert(/ui\.post\('\/api\/emails\/view', \{ guid, to: mailbox \}\)/.test(frontend), 'Viewing a message from a manually entered mailbox must preserve the mailbox scope');
assert(/mailboxInput\.addEventListener\('keydown'/.test(frontend), 'Manual mailbox entry should support Enter to view messages');
assert(!/input\.readOnly\s*=\s*true/.test(frontend), 'Free mailbox input must not be forced back to read-only');
assert(/data-action="remove-address"/.test(frontend), 'Social Browser must be able to remove locally saved addresses');
assert(!/data-action="delete-visible"/.test(freeHtml), 'Free temp-mail page must not expose server message deletion');
assert(/(?:site\.onPOST|onPost)\('\/api\/emails\/client-context'/.test(app), 'Server must expose the x-browser capability signal endpoint');
assert(!/ADDRESS_LIMIT|GUEST_ADDRESS_LIMIT|SOCIAL_BROWSER_ADDRESS_LIMIT/.test(app), 'Server app must not own browser-side address quota state');

console.log('Client local address-book and x-browser signal tests passed');
