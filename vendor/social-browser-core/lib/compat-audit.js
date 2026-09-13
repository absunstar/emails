'use strict';

function auditObject(target, expectedNames=[]) {
  const present=[], missing=[], types={};
  for (const name of expectedNames) {
    if (name in target) { present.push(name); types[name]=typeof target[name]; }
    else missing.push(name);
  }
  return {present,missing,types,coverage:expectedNames.length?present.length/expectedNames.length:1};
}

function auditSite(site, matrix={}) {
  return {
    site:auditObject(site,matrix.site||[]),
    collection:site.connectCollection ? auditObject(site.connectCollection('__compat_audit__'),matrix.collection||[]) : null,
    responseExpected:matrix.response||[],
    requestExpected:matrix.request||[]
  };
}

module.exports = { auditObject, auditSite };
