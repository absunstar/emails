'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html', 'free.html'),
  'utf8'
);

assert(html.includes('mobile-download-actions'), 'Android download action group is missing');
assert(
  html.includes('https://play.google.com/store/apps/details?id=com.egytag.mails'),
  'Google Play link is missing'
);
assert(
  html.includes('/downloads/VIP-Temp-Mail-5.2.4+16-play-signed.apk'),
  'versioned Play-signed APK download link is missing'
);
assert(html.includes('Download APK'), 'direct APK button label is missing');
assert(html.includes('Google Play-signed build'), 'Play-signed direct-download label is missing');
assert(html.includes('v5.2.4'), 'direct APK version label is missing');
assert(html.includes('Updates Play install'), 'Play-install compatibility label is missing');

console.log('Direct Android download CTA contract passed');
