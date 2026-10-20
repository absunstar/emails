'use strict';
const assert = require('node:assert/strict');
const { acceptedEnvelopeRecipients } = require('../apps/emails/core/smtp-recipient');
assert.deepEqual(acceptedEnvelopeRecipients({ envelope: { rcptTo: [
 {address:'Owner@social-browser.com'},{address:'owner@social-browser.com'},{address:'info@kids-browser.com'}] } }),
 ['owner@social-browser.com','info@kids-browser.com']);
assert.deepEqual(acceptedEnvelopeRecipients({envelope:{rcptTo:[]}}),[]);
assert.deepEqual(acceptedEnvelopeRecipients({envelope:{rcptTo:[{address:'not-an-email'},{address:''}]}}),[]);
assert.deepEqual(acceptedEnvelopeRecipients(null),[]);
console.log('smtp recipient envelope routing OK');
