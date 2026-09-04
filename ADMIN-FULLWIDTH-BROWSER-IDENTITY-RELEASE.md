# Social Temp Mail Admin UI update — 2026-09-04

- Admin dashboard now uses the available page width instead of a 1540px cap.
- Sender and recipient email text is larger and easier to read.
- Signed-in Social Browser identity is shown directly in the top navigation, including version when supplied by the browser/server request context and a shortened browser ID.
- Account details menu shows full browser ID, version, and platform when available.
- Added explicit Sign out / Sign in browser-auth endpoints and UI controls.
- Signing out suppresses automatic X-Browser session recreation for the current web session until the user explicitly signs in again.
- Admin browser gating respects the signed-out state.
- Full npm test suite passes.
