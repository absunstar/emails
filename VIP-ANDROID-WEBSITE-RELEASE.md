# VIP Temp Mail Android — direct website download

Current direct website release: **5.2.6+18**, 2026-10-18.

- Public landing page: https://emails.egytag.com/free
- Direct versioned URL: https://emails.egytag.com/downloads/VIP-Temp-Mail-5.2.6+18-play-signed.apk
- Stable URL: https://emails.egytag.com/downloads/vip-temp-mail-latest.apk
- On-disk APK: downloads/VIP-Temp-Mail-5.2.6+18-play-signed.apk (not tracked in Git)
- Google Play generated *universal APK* SHA-256: `e38ebd0db7841af074bc8ddb961df819ebf0c051a087c326cb8f11ff972b8607`
- Google Play **App Signing** certificate SHA-256: `6E:34:86:40:A4:6A:18:39:6C:1C:E3:E5:33:D5:3B:F6:C5:26:87:BA:F3:C1:5B:EB:70:7C:B2:B7:3D:35:9D:4E`
- Source AAB: `absunstar/vip-temp-mail`, branch `feature/android-vitals-performance-20261018`, version `5.2.6+18`.

This APK comes from the Google Play generated APK service, **not** the upload-key signed Flutter APK. Preserve the Google Play signing certificate for update-in-place compatibility. Play production remains at **5.2.5+17** until a separately approved rollout. Uploading the bundle to Google Play to generate an APK did not update the production track.

The landing page button is in `apps/emails/site_files/html/free.html`. Update `tests/direct-mobile-download.js` alongside it. The Nginx stable-URL 302 is defined in `/etc/nginx/sites-enabled/emails.conf` (not Git tracked), and `downloads/vip-temp-mail-latest.apk` should point to the same version for filesystem consumers. On deploy, run `nginx -t` and reload Nginx; reload only PM2 `mail-server` if HTML is cached by the template renderer. Preserve older versioned APKs. Do not place private Google Play credentials in Git.

Validate with `node tests/direct-mobile-download.js`, HTTP 200 on the versioned APK, HTTP 302 on the stable link, SHA-256 check, and that `/free` includes the new release version. Test update-in-place on a Play-installed Android device before recommending it as fully field-proven.
