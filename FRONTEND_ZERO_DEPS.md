# Frontend Zero-Dependencies Rule

This project applies the Social Browser zero-dependencies principle to the **email website UI only**.

## Allowed backend dependencies

The backend remains based on the existing `isite` platform and may use normal server-side packages such as:

- `isite` (existing sibling/platform dependency)
- `smtp-server`
- `mailparser`
- `sendmail`

The frontend rule must not be used as a reason to rewrite or duplicate stable iSite/server functionality.

## Frontend rule

Email UI authored in this repository must use:

- Native HTML
- Project-owned CSS
- Vanilla browser JavaScript
- Native `fetch`, DOM, Clipboard and Web APIs
- iSite server-side template directives (`x-import`, `x-permission`, `x-features`) where useful

It must not depend on:

- Angular / AngularJS
- Bootstrap
- jQuery
- React / Vue or another UI framework
- third-party table/export UI bundles
- Angular-era `i-button`, `i-control`, or `i-content` controls in the email pages

## Current implementation

- `site_files/css/zero-ui.css` contains the project-owned UI primitives.
- `site_files/js/app.js` contains small project-owned DOM/request/modal helpers.
- `site_files/js/navbar.js` is vanilla JavaScript.
- `apps/emails/site_files/js/index.js` is the vanilla email UI controller.
- Email templates use standard inputs, textareas, buttons, tables and native DOM rendering.
- The legacy `site_files/js/export` third-party bundle was removed because it was unused.
- `/x-css/bootstrap-5-support.css` and `/x-js/bootstrap-5-support.js` are no longer loaded.

## Regression guard

Run:

```bash
npm test
```

The first test is `tests/frontend-zero-deps.js`. It fails when active project frontend HTML/JS reintroduces Angular, Bootstrap, jQuery, or the Angular-era email UI components.

## iSite authentication boundary

Authentication/session authorization remains owned by iSite. The email UI uses iSite server-side permission/template directives and does not reimplement account/session logic in the email application.
