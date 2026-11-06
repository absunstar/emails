'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function merge(base, patch) {
    const out = clone(base);
    if (!isObject(patch)) return out;
    for (const [key, value] of Object.entries(patch)) {
        if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
        else if (value !== undefined) out[key] = clone(value);
    }
    return out;
}
function text(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function origin(value, fallback) {
    const v = text(value, 1000).replace(/\/+$/, '');
    if (!v) return fallback;
    try {
        const u = new URL(v);
        if (!['http:', 'https:'].includes(u.protocol)) return fallback;
        return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
    } catch (_) { return fallback; }
}
function hostname(value, fallback) {
    const v = text(value, 253).toLowerCase();
    return /^[a-z0-9.-]+$/.test(v) && !v.startsWith('.') && !v.endsWith('.') ? v : fallback;
}
function domains(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
    return [...new Set(list.map(v => hostname(v, '')).filter(Boolean))];
}
function bool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
function integer(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function atomicWrite(file, data) {
    ensureDir(path.dirname(file));
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
}
function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function defaultConfig() {
    return {
        schemaVersion: 1,
        instance: {
            id: '',
            name: 'Social Mail',
            edition: 'self-hosted',
        },
        network: {
            publicOrigin: 'https://emails.social-browser.com',
            smtpHostname: 'emails.egytag.com',
            mailDomains: [],
        },
        brand: {
            productName: 'Social Mail',
            companyName: 'Social Browser',
            websiteUrl: 'https://social-browser.com/',
            supportUrl: '',
            logoUrl: '/images/social-browser-brand-icon.png',
            downloads: {
                windows: 'https://social-browser.com/download-windows-latest',
                linux: 'https://social-browser.com/download-linux-latest',
            },
            socialBrowserLogin: {
                enabled: true,
                label: 'Login by Social Browser',
            },
        },
        mcp: {
            name: 'social-browser-email',
            title: 'Social Browser Email Manager',
            secret: '',
            bearerToken: '',
            host: '127.0.0.1',
            port: 60026,
        },
        features: {
            socialBrowserLogin: true,
            campaigns: true,
            mcp: true,
            temporaryMail: true,
        },
        updatedAt: '',
    };
}

function sanitize(input, current) {
    const base = merge(defaultConfig(), current || {});
    const next = merge(base, input || {});
    if (!next.instance.id) next.instance.id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    next.instance.name = text(next.instance.name, 160) || 'Social Mail';
    next.instance.edition = text(next.instance.edition, 80) || 'self-hosted';

    next.network.publicOrigin = origin(next.network.publicOrigin, base.network.publicOrigin);
    next.network.smtpHostname = hostname(next.network.smtpHostname, base.network.smtpHostname);
    next.network.mailDomains = domains(next.network.mailDomains);

    next.brand.productName = text(next.brand.productName, 160) || 'Social Mail';
    next.brand.companyName = text(next.brand.companyName, 160);
    next.brand.websiteUrl = origin(next.brand.websiteUrl, base.brand.websiteUrl);
    next.brand.supportUrl = next.brand.supportUrl ? origin(next.brand.supportUrl, '') : '';
    next.brand.logoUrl = text(next.brand.logoUrl, 1000) || base.brand.logoUrl;
    next.brand.downloads.windows = text(next.brand.downloads?.windows, 1000);
    next.brand.downloads.linux = text(next.brand.downloads?.linux, 1000);
    next.brand.socialBrowserLogin.enabled = bool(next.brand.socialBrowserLogin?.enabled, true);
    next.brand.socialBrowserLogin.label = text(next.brand.socialBrowserLogin?.label, 160) || 'Login by Social Browser';

    next.mcp.name = text(next.mcp.name, 120) || 'social-mail';
    next.mcp.title = text(next.mcp.title, 160) || (next.brand.productName + ' MCP');
    next.mcp.secret = text(next.mcp.secret, 512);
    next.mcp.bearerToken = text(next.mcp.bearerToken, 2048);
    next.mcp.host = text(next.mcp.host, 253) || '127.0.0.1';
    next.mcp.port = integer(next.mcp.port, 60026, 1, 65535);

    for (const key of ['socialBrowserLogin', 'campaigns', 'mcp', 'temporaryMail']) {
        next.features[key] = bool(next.features[key], base.features[key]);
    }
    next.updatedAt = new Date().toISOString();
    return next;
}

function createEmailInstanceConfig(options = {}) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const filePath = path.resolve(options.filePath || process.env.EMAIL_INSTANCE_CONFIG || path.join(cwd, 'localStorage', 'email-instance', 'config.json'));
    const saved = readJson(filePath);
    let config = sanitize(saved || {}, defaultConfig());
    if (!saved) config.mcp.secret = crypto.randomBytes(32).toString('base64url');
    if (!saved || !saved.instance?.id) atomicWrite(filePath, config);

    function envOverlay(base) {
        const patch = {};
        const set = (group, key, value) => {
            if (value === undefined || value === null || value === '') return;
            patch[group] = patch[group] || {};
            patch[group][key] = value;
        };
        set('instance', 'name', process.env.EMAIL_INSTANCE_NAME);
        set('network', 'publicOrigin', process.env.EMAIL_PUBLIC_ORIGIN);
        set('network', 'smtpHostname', process.env.SMTP_HOSTNAME);
        if (process.env.EMAIL_MAIL_DOMAINS) set('network', 'mailDomains', process.env.EMAIL_MAIL_DOMAINS);
        set('brand', 'productName', process.env.EMAIL_PRODUCT_NAME);
        set('brand', 'companyName', process.env.EMAIL_COMPANY_NAME);
        set('brand', 'websiteUrl', process.env.EMAIL_BRAND_WEBSITE);
        set('brand', 'supportUrl', process.env.EMAIL_SUPPORT_URL);
        set('brand', 'logoUrl', process.env.EMAIL_BRAND_LOGO);
        patch.mcp = {};
        if (process.env.EMAIL_MCP_NAME) patch.mcp.name = process.env.EMAIL_MCP_NAME;
        if (process.env.EMAIL_MCP_TITLE) patch.mcp.title = process.env.EMAIL_MCP_TITLE;
        if (process.env.EMAIL_MCP_SECRET) patch.mcp.secret = process.env.EMAIL_MCP_SECRET;
        if (process.env.EMAIL_MCP_BEARER_TOKEN) patch.mcp.bearerToken = process.env.EMAIL_MCP_BEARER_TOKEN;
        if (process.env.EMAIL_MCP_HOST) patch.mcp.host = process.env.EMAIL_MCP_HOST;
        if (process.env.EMAIL_MCP_PORT) patch.mcp.port = Number(process.env.EMAIL_MCP_PORT);
        if (!Object.keys(patch.mcp).length) delete patch.mcp;
        const effective = sanitize(patch, base);
        effective.updatedAt = base.updatedAt;
        return effective;
    }

    function get() { return envOverlay(config); }
    function getPublic() {
        const value = get();
        const safe = clone(value);
        if (safe.mcp) {
            safe.mcp.secretConfigured = !!safe.mcp.secret;
            safe.mcp.bearerTokenConfigured = !!safe.mcp.bearerToken;
            delete safe.mcp.secret;
            delete safe.mcp.bearerToken;
        }
        safe.auth = {
            localAdminConfigured: !!String(process.env.EMAIL_ADMIN_PASSWORD || '').trim(),
            localAdminUsername: String(process.env.EMAIL_ADMIN_USERNAME || 'admin').trim() || 'admin',
            socialBrowserLoginEnabled: safe.features?.socialBrowserLogin !== false,
        };
        safe.configPath = filePath;
        return safe;
    }
    function update(patch) {
        config = sanitize(patch || {}, config);
        atomicWrite(filePath, config);
        return {
            config: getPublic(),
            restartRequired: true,
            restartReasons: ['network identity', 'SMTP hostname', 'MCP identity/endpoint', 'branding/runtime providers may be loaded at process start'],
        };
    }
    function applyProcessEnv() {
        const value = config;
        const set = (name, v) => { if ((process.env[name] === undefined || process.env[name] === '') && v !== undefined && v !== null && v !== '') process.env[name] = String(v); };
        set('EMAIL_INSTANCE_NAME', value.instance.name);
        set('EMAIL_PUBLIC_ORIGIN', value.network.publicOrigin);
        set('SMTP_HOSTNAME', value.network.smtpHostname);
        if (value.network.mailDomains.length) set('EMAIL_MAIL_DOMAINS', value.network.mailDomains.join(','));
        set('EMAIL_PRODUCT_NAME', value.brand.productName);
        set('EMAIL_COMPANY_NAME', value.brand.companyName);
        set('EMAIL_BRAND_WEBSITE', value.brand.websiteUrl);
        set('EMAIL_SUPPORT_URL', value.brand.supportUrl);
        set('EMAIL_BRAND_LOGO', value.brand.logoUrl);
        set('EMAIL_MCP_NAME', value.mcp.name);
        set('EMAIL_MCP_TITLE', value.mcp.title);
        set('EMAIL_MCP_SECRET', value.mcp.secret);
        set('EMAIL_MCP_BEARER_TOKEN', value.mcp.bearerToken);
        set('EMAIL_MCP_HOST', value.mcp.host);
        set('EMAIL_MCP_PORT', value.mcp.port);
        return get();
    }
    return { filePath, get, getPublic, update, applyProcessEnv };
}

module.exports = { createEmailInstanceConfig, defaultConfig, sanitize };
