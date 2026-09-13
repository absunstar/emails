# Social Browser x-browser Login

The email site uses the `x-browser` request header as the only browser-login signal.

There is no dependency on any external website or remote authentication service. The current request header is the complete login source.

## Login rule

- Non-empty `x-browser` header: logged in as a Social Browser user.
- Missing or empty `x-browser` header: guest.

A current Social Browser request normally sends a value shaped like `social.<browser-id>`. The full header value is used as the browser identity and the part after the first dot is exposed as the browser UUID/id.

`GET /api/v2/browser-auth/status` reads the header on the current request and returns the transient login state. It also mirrors the browser identity into `req.session.user` for local iSite compatibility, but the session is not the source of authentication. Every privileged browser check still requires the current request to contain `x-browser`.

The public temp-mail address book and the 10/100 address limits remain browser-side `localStorage` behavior.
