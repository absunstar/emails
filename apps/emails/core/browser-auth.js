'use strict';

const { headerValue } = require('./client-context');

const SESSION_USER_SOURCE = 'x-browser';

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

function syncSession(req) {
    req.session = req.session || {};
    const user = sessionUserFromBrowser(req);
    if (user) {
        req.session.user = user;
        req.session.user_id = user.id;
        req.session.user_source = SESSION_USER_SOURCE;
        req.session.user_auth_method = 'browser-header';
        req.session.$userLoadedAt = Date.now();
        req.session.$save?.();
        return user;
    }
    if (req.session.user_source === SESSION_USER_SOURCE || req.session.user?.authProvider === 'x-browser') {
        req.session.user = null;
        req.session.user_id = null;
        req.session.user_source = null;
        req.session.user_auth_method = null;
        req.session.$userLoadedAt = 0;
        req.session.$save?.();
    }
    return null;
}

function createBrowserAuth() {
    function status(req) {
        const user = syncSession(req);
        const identity = browserIdentity(req);
        return {
            done: true,
            loggedIn: !!identity,
            user: user,
            browser: {
                detected: !!identity,
                browserName: user?.profile?.displayName || '',
                browserID: identity?.raw || '',
                browserUUID: identity?.id || '',
                brand: identity?.brand || '',
            },
        };
    }

    return {
        status,
        syncSession,
        browserHeader,
        browserIdentity,
        sessionUserFromBrowser,
    };
}

module.exports = {
    SESSION_USER_SOURCE,
    text,
    browserHeader,
    parseBrowserHeader,
    browserIdentity,
    sessionUserFromBrowser,
    syncSession,
    createBrowserAuth,
};
