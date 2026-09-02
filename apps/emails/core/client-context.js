'use strict';

function headerValue(req, name) {
    const headers = req?.headers || {};
    const wanted = String(name || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(headers, wanted)) return headers[wanted];
    const key = Object.keys(headers).find((item) => String(item).toLowerCase() === wanted);
    return key ? headers[key] : '';
}

function isSocialBrowserRequest(req) {
    const value = headerValue(req, 'x-browser');
    if (Array.isArray(value)) return value.some((item) => String(item || '').trim().length > 0);
    return String(value || '').trim().length > 0;
}

function getClientContext(req) {
    return {
        done: true,
        isSocialBrowser: isSocialBrowserRequest(req),
    };
}

module.exports = {
    headerValue,
    isSocialBrowserRequest,
    getClientContext,
};
