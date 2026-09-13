# Native Core template import fix — 2026-09-13

## Symptom
The public temp-mail page rendered, but the inbox showed `Cannot read properties of undefined (reading 'post')`.

## Root cause
The bundled Native Core legacy template parser did not resolve one-part `x-import` assets correctly when `site.dir` already pointed at the project `site_files` directory. As a result, shared imports such as `app.js`, `browser-auth.js`, `navbar.js`, and `zero-ui.css` were omitted. The email controller loaded, but `window.SBUI` was undefined, so `ui.post(...)` failed.

## Fix
`vendor/social-browser-core/compat/isite/html-parser.js` now resolves imports against:
- the nearest current app-local `site_files/<type>` root;
- the canonical project `site.dir/<type>` root;
- `cwd/site_files/<type>` as a fallback;
- the existing compatibility candidates.

This keeps Native Core authoritative and does not re-enable iSite runtime compatibility.

## Regression
Added `tests/native-core-template-assets.js`, covering global JS/CSS imports and the app-local email controller import.
