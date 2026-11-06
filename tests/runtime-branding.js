'use strict';
const assert = require('assert');
const { applyInstanceBranding } = require('../apps/emails/core/native-template');
const instance = {
  instance: { id: 'x', name: 'Acme Mail', edition: 'enterprise' },
  network: { publicOrigin: 'https://mail.acme.example' },
  brand: {
    productName: 'Acme Mail', companyName: 'Acme Corp', websiteUrl: 'https://acme.example', supportUrl: 'https://support.acme.example', logoUrl: '/assets/acme.svg',
    downloads: { windows: 'https://downloads.acme.example/windows', linux: 'https://downloads.acme.example/linux' },
    socialBrowserLogin: { enabled: false },
  },
  features: { socialBrowserLogin: false }
};
const input = '<html><head><title>Social Temp Mail | Egytag</title></head><body><img src="/images/social-browser-brand-icon.png"><a data-browser-download href="https://social-browser.com/download-windows-latest">Win</a><a href="https://social-browser.com/">Social Browser</a><a href="/login?next=%2Fadmin">Login by Social Browser</a><button data-browser-signin>Sign in</button></body></html>';
const out = applyInstanceBranding(input, instance);
assert(out.includes('/assets/acme.svg'));
assert(out.includes('https://downloads.acme.example/windows'));
assert(out.includes('https://acme.example/'));
assert(out.includes('| Acme Corp'));
assert(!out.includes('data-browser-signin'));
assert(!out.includes('/login?next='));
assert(out.includes('window.__emailInstance='));
console.log('runtime branding tests passed');
