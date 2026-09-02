'use strict';

const crypto = require('crypto');
const { headerValue } = require('./client-context');

function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function wildcardToRegExp(pattern) {
    let escaped = String(pattern || '').trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
}

function xBrowserValue(req) {
    const value = headerValue(req, 'x-browser');
    if (Array.isArray(value)) return String(value.find((item) => String(item || '').trim()) || '').trim();
    return String(value || '').trim();
}

function browserRequestID(req) {
    return xBrowserValue(req) || String(req?.browserFullID || req?.browserID || '').trim();
}

function isBrowserSession(req) {
    return !!xBrowserValue(req);
}

function isAdminRequest(req) {
    const configuredSecret = String(process.env.EMAIL_ADMIN_SECRET || '').trim();
    if (!configuredSecret) return false;
    const headerSecret = String(req?.headers?.['x-email-admin-secret'] || '').trim();
    const auth = String(req?.headers?.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    return safeEqual(headerSecret, configuredSecret) || safeEqual(bearer, configuredSecret);
}

function isTrustedBrowserId(browserID, patterns) {
    if (!browserID) return false;
    const list = String(patterns || '*test*|*vip*|*developer*')
        .split('|')
        .map((v) => v.trim())
        .filter(Boolean);
    return list.some((pattern) => wildcardToRegExp(pattern).test(String(browserID)));
}

function hasVipAccess(req, patterns) {
    return isAdminRequest(req) || isTrustedBrowserId(browserRequestID(req), patterns);
}

module.exports = {
    safeEqual,
    wildcardToRegExp,
    xBrowserValue,
    browserRequestID,
    isAdminRequest,
    isBrowserSession,
    isTrustedBrowserId,
    hasVipAccess,
};
