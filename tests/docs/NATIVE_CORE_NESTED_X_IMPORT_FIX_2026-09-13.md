# Native Core nested x-import fix — 2026-09-13

## Problem
The public Temp Mail page rendered an empty `<nav class="sitebar"></nav>` after the Native Core migration. The shared navbar uses `x-import="navbar/index.html"`, but the embedded Core resolver only searched canonical project/app `site_files` roots for single-file imports. Nested imports skipped those roots.

As a result the Social Browser sign-in entry, account state, and user menu were absent even though `scripts.html`, `browser-auth.js`, and `navbar.js` loaded correctly.

## Fix
Updated the bundled `vendor/social-browser-core/compat/isite/html-parser.js` content resolver so two-part and deeper imports resolve against:

- the current app-local `site_files/<ext>/...` root,
- the project canonical `site_files/<ext>/...` root,
- the existing legacy/application candidates.

This preserves one resolver/source of truth rather than adding page-specific workarounds.

## Regression coverage
`tests/native-core-template-assets.js` now verifies that the rendered public page contains:

- the full `navbar/index.html` markup,
- `Sign in with Social Browser`,
- the browser-auth scripts,
- app-local nested message-view imports,
- no empty navbar caused by unresolved nested imports.

Browser auth, Native Core runtime, message-view contract, and frontend zero-dependency tests also pass.
