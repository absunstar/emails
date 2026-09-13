'use strict';
const fs = require('fs');
const p = require('../package.json');

const deps = Object.keys(p.dependencies || {});
const optional = Object.keys(p.optionalDependencies || {});
const peers = Object.keys(p.peerDependencies || {});

if (deps.length || optional.length || peers.length) {
  console.error({deps, optional, peers});
  process.exit(1);
}

// A lockfile is allowed and recommended for reproducible CI/release metadata.
// With zero external runtime dependencies it should contain only the root package.
if (fs.existsSync('package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync('package-lock.json','utf8'));
  const packages = Object.keys(lock.packages || {}).filter(Boolean);
  const lockDeps = Object.keys(lock.dependencies || {});
  if (packages.length || lockDeps.length) {
    console.error({unexpectedLockedPackages: packages, unexpectedLockDependencies: lockDeps});
    process.exit(1);
  }
}

console.log('PASS: @social-browser/core has zero external runtime dependencies.');
