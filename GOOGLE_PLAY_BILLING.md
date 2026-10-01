# Google Play Billing verification

The email backend supports server-side verification for VIP Temp Mail's one-time Google Play product.

Configuration:

```text
GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL=<service-account-email>
GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY=<private-key>
GOOGLE_PLAY_PACKAGE_NAME=com.egytag.mails
GOOGLE_PLAY_PRO_PRODUCT_ID=vip_temp_mail_pro_lifetime
GOOGLE_PLAY_BILLING_ENFORCE=true
```

Keep `GOOGLE_PLAY_BILLING_ENFORCE` unset/false until the service account is granted Android Publisher API access in Google Play Console.

When enforcement is disabled, the backend preserves compatibility with the already-published mobile client while still issuing mailbox-specific ownership tokens. When enabled, Pro mailbox generation and server-side message deletion require a purchase token that verifies successfully with Google Play.

The backend never stores a plaintext Google Play purchase token. Successful verifications are cached in memory for a short period and the app's old embedded Pro API key is no longer required by new clients.
