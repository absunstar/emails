'use strict';

const { headerValue } = require('./client-context');

const SESSION_USER_SOURCE = 'x-browser';
const SESSION_SIGNED_OUT_KEY = 'browser_auth_signed_out';

function text(value, max) {
    const output = String(value == null ? '' : value).trim();
    return max ? output.slice(0, max) : output;
}

function browserHeader(req) {
    const value = headerValue(req, 'x-browser');
    if (Array.isArray(value)) return text(value.find((item) => text(item)) || '', 1024);
    return text(value, 1024);
}

function parseBrowserHeader(value) {
    const raw = text(value, 1024);
    if (!raw) return null;
    const separator = raw.indexOf('.');
    const brand = separator > 0 ? text(raw.slice(0, separator), 120) : 'social';
    const id = separator > 0 ? text(raw.slice(separator + 1), 512) : raw;
    return {
        raw,
        brand: brand || 'social',
        id: id || raw,
    };
}

function browserIdentity(req) {
    return parseBrowserHeader(browserHeader(req));
}

function firstHeader(req, names) {
    for (const name of names) {
        const value = headerValue(req, name);
        const output = Array.isArray(value) ? value.find((item) => text(item)) : value;
        if (text(output)) return text(output, 120);
    }
    return '';
}

function browserVersion(req) {
    const direct = text(req?.browserVersion || req?.browser?.version || req?.socialBrowserVersion, 120);
    if (direct) return direct;
    const header = firstHeader(req, [
        'x-browser-version',
        'x-social-browser-version',
        'x-browser-app-version',
        'x-app-version',
        'x-client-version',
    ]);
    if (header) return header;
    const ua = text(headerValue(req, 'user-agent'), 512);
    const match = ua.match(/(?:Social[\s_-]?Browser|SocialBrowser)[\/\s-]+([0-9][0-9A-Za-z._-]*)/i);
    return match ? text(match[1], 120) : '';
}

function browserPlatform(req) {
    return firstHeader(req, ['sec-ch-ua-platform', 'x-browser-platform', 'x-platform']).replace(/^"|"$/g, '');
}

function isSignedOut(req) {
    return req?.session?.[SESSION_SIGNED_OUT_KEY] === true;
}

function clearBrowserSession(req) {
    req.session = req.session || {};
    if (req.session.user_source === SESSION_USER_SOURCE || req.session.user?.authProvider === 'x-browser') {
        req.session.user = null;
        req.session.user_id = null;
        req.session.user_source = null;
        req.session.user_auth_method = null;
        req.session.$userLoadedAt = 0;
    }
    req.session.$save?.();
}

function sessionUserFromBrowser(req) {
    const identity = browserIdentity(req);
    if (!identity) return null;
    const browserName = text(req?.browserName, 120) || (identity.brand.toLowerCase() === 'social' ? 'Social Browser' : identity.brand);
    return {
        id: identity.raw,
        browserID: identity.raw,
        browserUUID: identity.id,
        browserBrand: identity.brand,
        profile: {
            name: browserName,
            displayName: browserName,
        },
        permissions: [],
        roles: [],
        status: 'active',
        browserOnly: true,
        authProvider: 'x-browser',
    };
}

function syncSession(req, options) {
    req.session = req.session || {};
    const force = options?.force === true;
    if (isSignedOut(req) && !force) {
        clearBrowserSession(req);
        return null;
    }
    const user = sessionUserFromBrowser(req);
    if (user) {
        req.session[SESSION_SIGNED_OUT_KEY] = false;
        req.session.user = user;
        req.session.user_id = user.id;
        req.session.user_source = SESSION_USER_SOURCE;
        req.session.user_auth_method = 'browser-header';
        req.session.$userLoadedAt = Date.now();
        req.session.$save?.();
        return user;
    }
    clearBrowserSession(req);
    return null;
}

function createBrowserAuth() {
    function browserData(req, user) {
        const identity = browserIdentity(req);
        return {
            detected: !!identity,
            browserName: user?.profile?.displayName || text(req?.browserName, 120) || (identity?.brand?.toLowerCase() === 'social' ? 'Social Browser' : (identity?.brand || '')),
            browserID: identity?.raw || '',
            browserUUID: identity?.id || '',
            brand: identity?.brand || '',
            version: browserVersion(req),
            platform: browserPlatform(req),
        };
    }

    function status(req) {
        const user = syncSession(req);
        const browser = browserData(req, user);
        return {
            done: true,
            loggedIn: !!user,
            signedOut: isSignedOut(req),
            user,
            browser,
        };
    }

    function signOut(req) {
        req.session = req.session || {};
        req.session[SESSION_SIGNED_OUT_KEY] = true;
        clearBrowserSession(req);
        return { done: true, loggedIn: false, signedOut: true, browser: browserData(req, null) };
    }

    function signIn(req) {
        req.session = req.session || {};
        req.session[SESSION_SIGNED_OUT_KEY] = false;
        const user = syncSession(req, { force: true });
        const browser = browserData(req, user);
        return { done: true, loggedIn: !!user, signedOut: false, user, browser, error: user ? '' : 'Social Browser was not detected.' };
    }

    return {
        status,
        signIn,
        signOut,
        isSignedOut,
        syncSession,
        browserHeader,
        browserIdentity,
    browserVersion,
        browserVersion,
        sessionUserFromBrowser,
    };
}

module.exports = {
    SESSION_USER_SOURCE,
    SESSION_SIGNED_OUT_KEY,
    text,
    browserHeader,
    parseBrowserHeader,
    browserIdentity,
    browserVersion,
    sessionUserFromBrowser,
    syncSession,
    createBrowserAuth,
};
