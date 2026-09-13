'use strict';
const { createSite } = require('./lib/site');

// Core-wide native String pattern helpers are installed at module bootstrap time.
// This guarantees helpers are available to startup/bootstrap code before the first
// Site instance is created (for example Social Browser main.js).
const escapePattern = value => String(value ?? '').replace(/[\/\\^$*+?.()\[\]{}]/g, '\\$&');
const nativePatternTest = (input, pattern, flags = 'gium') => {
  try { return new RegExp(pattern, flags).test(String(input)); } catch { return false; }
};
const nativePatternLike = (input, value) => {
  if (typeof value === 'number') value = String(value);
  else if (typeof value !== 'string') return false;
  input = String(input);
  return value.split('|').some(part => {
    const source = part.split('*').map(escapePattern).join('.*');
    try { return new RegExp('^' + source + '$', 'ium').test(input); } catch { return false; }
  });
};
const nativePatternContains = (input, value = '') => {
  if (typeof value === 'number') value = String(value);
  else if (typeof value !== 'string') return false;
  input = String(input);
  return value.split('|').some(part => part && nativePatternTest(input, '^.*' + escapePattern(part) + '.*$', 'ium'));
};
const installNativeStringPatterns = () => {
  const defs = {
    test(pattern, flags = 'gium') { return nativePatternTest(this, pattern, flags); },
    like(value) { return nativePatternLike(this, value); },
    contains(value = '') { return nativePatternContains(this, value); },
    contain(value = '') { return nativePatternContains(this, value); },
  };
  for (const [name, fn] of Object.entries(defs)) {
    if (!Object.getOwnPropertyDescriptor(String.prototype, name)) {
      Object.defineProperty(String.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
    }
  }
};
installNativeStringPatterns();

function socialBrowserCore(options = {}) {
  return createSite(options);
}

socialBrowserCore.createSite = createSite;
socialBrowserCore.version = '6.10.3';
socialBrowserCore.packageName = '@social-browser/core';

module.exports = socialBrowserCore;
