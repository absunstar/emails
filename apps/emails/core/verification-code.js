'use strict';

// A bounded text-only hint for public inbox cards; never expose message bodies in list responses.
function detectVerificationCode(message) {
    const mail = message || {};
    const html = String(mail.html || '').slice(0, 20000)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    const source = [mail.subject, String(mail.text || '').slice(0, 16000), html]
        .join(' ').replace(/\s+/g, ' ').slice(0, 32000);
    const match = source.match(/(?:verification|verify|security|confirmation|confirm|login|sign[ -]?in|otp|passcode|one[ -]?time|code|pin|رمز|كود|تأكيد)[^\r\n]{0,55}?\b([0-9]{4,8}|(?=[a-z0-9]{5,9}\b)(?=[a-z0-9]*[0-9])[a-z0-9]{5,9})\b/i);
    return match ? match[1] : '';
}

module.exports = { detectVerificationCode };
