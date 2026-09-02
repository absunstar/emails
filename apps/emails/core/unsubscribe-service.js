'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function normalizeEmail(value) {
    const match = String(value || '').trim().toLowerCase().match(/[a-z0-9._%+-]+@(?:[a-z0-9.-]+\.[a-z]{2,}|localhost)/i);
    return match ? match[0] : '';
}

function base64url(value) {
    return Buffer.from(String(value || ''), 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function unbase64url(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    return Buffer.from(text, 'base64').toString('utf8');
}

function safeEqual(a, b) {
    const one = Buffer.from(String(a || ''));
    const two = Buffer.from(String(b || ''));
    return one.length === two.length && crypto.timingSafeEqual(one, two);
}

class EmailUnsubscribeService {
    constructor(options) {
        options = options || {};
        this.deliverability = options.deliverability || null;
        this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'localStorage', 'email-unsubscribe'));
        this.secretPath = path.join(this.baseDir, 'secret.key');
        this.publicOrigin = String(options.publicOrigin || process.env.EMAIL_PUBLIC_ORIGIN || 'https://emails.social-browser.com').replace(/\/+$/, '');
        this.monitor = options.monitor || null;
        ensureDir(this.baseDir);
        this.secret = String(options.secret || process.env.EMAIL_UNSUBSCRIBE_SECRET || '').trim();
        if (!this.secret) {
            try { this.secret = fs.readFileSync(this.secretPath, 'utf8').trim(); } catch (_) {}
        }
        if (!this.secret) {
            this.secret = crypto.randomBytes(48).toString('base64url');
            fs.writeFileSync(this.secretPath, this.secret + '\n', { encoding: 'utf8', mode: 0o600 });
        }
    }

    createToken(email) {
        const normalized = normalizeEmail(email);
        if (!normalized) throw new Error('Valid email is required');
        const payload = base64url('v1|' + normalized);
        const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
        return payload + '.' + sig;
    }

    verifyToken(token) {
        const text = String(token || '').trim();
        const parts = text.split('.');
        if (parts.length !== 2) return null;
        const expected = crypto.createHmac('sha256', this.secret).update(parts[0]).digest('base64url');
        if (!safeEqual(parts[1], expected)) return null;
        let decoded = '';
        try { decoded = unbase64url(parts[0]); } catch (_) { return null; }
        const match = decoded.match(/^v1\|(.+)$/);
        const email = normalizeEmail(match?.[1] || '');
        return email || null;
    }

    urlFor(email) {
        return this.publicOrigin + '/api/emails/unsubscribe?token=' + encodeURIComponent(this.createToken(email));
    }

    headersFor(email) {
        const url = this.urlFor(email);
        return {
            'List-Unsubscribe': '<' + url + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
    }

    unsubscribeToken(token, source) {
        const email = this.verifyToken(token);
        if (!email) throw new Error('Invalid unsubscribe token');
        if (!this.deliverability || typeof this.deliverability.reportFeedback !== 'function') throw new Error('Deliverability service is unavailable');
        const result = this.deliverability.reportFeedback({ email, type: 'unsubscribe', reason: 'One-click unsubscribe', source: source || 'one-click-unsubscribe' });
        this.monitor?.increment?.('unsubscribeEvents');
        return result;
    }
}

function createEmailUnsubscribeService(options) {
    return new EmailUnsubscribeService(options);
}

module.exports = { EmailUnsubscribeService, createEmailUnsubscribeService, normalizeEmail };
