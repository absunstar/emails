'use strict';

/**
 * Runtime mail-domain helpers for shared-host / multi-domain deployments.
 *
 * No mail domain is configured. Website/MCP requests derive their default mail
 * domain from the request Host. Subdomains collapse to the registrable/root mail
 * domain, e.g. xxx.yyyy.domain.com -> domain.com.
 *
 * Legacy/mobile API compatibility is different by design: when an API request
 * explicitly carries a mailbox address, the domain in that email address has
 * priority over the HTTP Host. This keeps old integrations working even when
 * they call the API through a different host.
 */

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
    'ac', 'co', 'com', 'edu', 'gov', 'go', 'mil', 'net', 'ne', 'nom', 'or', 'org', 'sch',
]);

function normalizeHostname(value) {
    let host = String(value || '').trim().toLowerCase();
    if (!host) return '';

    host = host.split(',')[0].trim();

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
        try {
            host = new URL(host).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    }

    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        if (end > 0) host = host.slice(1, end);
    } else {
        host = host.replace(/:\d+$/, '');
    }

    return host.replace(/\.$/, '');
}

function isIPv4(host) {
    const parts = String(host || '').split('.');
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function mailDomainFromHostname(value) {
    const host = normalizeHostname(value);
    if (!host) return '';
    if (host === 'localhost' || isIPv4(host) || host.includes(':')) return host;

    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;

    const tld = labels[labels.length - 1];
    const second = labels[labels.length - 2];

    // Common ccTLD structures such as domain.co.uk, domain.com.eg,
    // domain.com.au, domain.com.sa, etc. This is intentionally an internal
    // heuristic rather than an external public-suffix dependency.
    if (tld.length === 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(second) && labels.length >= 3) {
        return labels.slice(-3).join('.');
    }

    return labels.slice(-2).join('.');
}

function requestHostname(req) {
    const headerHost = req?.headers?.host;
    return normalizeHostname(headerHost || req?.hostname || req?.host || '');
}

function requestDomain(req) {
    return mailDomainFromHostname(requestHostname(req));
}

function extractMailboxAddresses(value) {
    return String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:\[[^\]\s]+\]|[A-Z0-9.-]+)/gi) || [];
}

function addressDomain(address) {
    const text = String(address || '').trim();
    const at = text.lastIndexOf('@');
    if (at < 0) return '';
    return normalizeHostname(text.slice(at + 1).replace(/^\[|\]$/g, ''));
}

/**
 * Resolve API mailbox scope.
 *
 * Candidate values are intentionally supplied by the caller in semantic
 * priority order. The first explicit email address wins. Only when no explicit
 * address exists do we fall back to the root mail domain derived from Host.
 * Client-supplied `domain` fields are deliberately not used here.
 */
function apiDomain(req, ...candidateValues) {
    for (const value of candidateValues) {
        const addresses = extractMailboxAddresses(value);
        if (!addresses.length) continue;
        const domain = addressDomain(addresses[0]);
        if (domain) return domain;
    }
    return requestDomain(req);
}

function addressBelongsToDomain(value, domain) {
    const target = normalizeHostname(domain);
    if (!target) return false;
    return extractMailboxAddresses(value).some((address) => addressDomain(address) === target);
}

function messageBelongsToDomain(doc, domain) {
    const target = normalizeHostname(domain);
    if (!target || !doc) return false;

    const folder = String(doc.folder || '').toLowerCase();
    if (folder === 'inbox' || folder === 'received') {
        return addressBelongsToDomain(doc.to, target) || addressBelongsToDomain(doc.cc, target);
    }
    if (folder === 'send' || folder === 'sending' || folder === 'sent') {
        return addressBelongsToDomain(doc.from, target);
    }

    return addressBelongsToDomain(doc.to, target) ||
        addressBelongsToDomain(doc.cc, target) ||
        addressBelongsToDomain(doc.from, target);
}

function mailboxForDomain(value, domain) {
    const target = normalizeHostname(domain);
    if (!target) return '';

    let local = String(value || '').trim().toLowerCase();
    const extracted = extractMailboxAddresses(local);
    if (extracted.length) local = extracted[0].split('@')[0];
    else if (local.includes('@')) local = local.split('@')[0];

    local = local.trim();
    if (!local) return '';
    return local + '@' + target;
}

module.exports = {
    normalizeHostname,
    mailDomainFromHostname,
    requestHostname,
    requestDomain,
    extractMailboxAddresses,
    addressDomain,
    apiDomain,
    addressBelongsToDomain,
    messageBelongsToDomain,
    mailboxForDomain,
};
