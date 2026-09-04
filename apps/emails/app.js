'use strict';

const path = require('path');
const { createEmailService, extractAddresses, normalizeEmail } = require('./core/email-service');
const { isAdminRequest, isBrowserSession, hasVipAccess, isTrustedBrowserId, browserRequestID } = require('./core/access');
const { requestDomain, apiDomain, addressBelongsToDomain, messageBelongsToDomain, mailboxForDomain } = require('./core/domain');
const { getClientContext } = require('./core/client-context');
const { createBrowserAuth } = require('./core/browser-auth');
const { analyzeEmailHtml, sanitizeEmailHtml, qrSvg } = require('./core/message-tools');
const { createEmailAbusePolicy } = require('./core/abuse-policy');
const { createEmailDeliverabilityEngine } = require('./core/deliverability-engine');
const { createEmailRuntimeMonitor } = require('./core/runtime-monitor');
const { createEmailBackupStorageManager } = require('./core/backup-storage-manager');
const { createEmailUnsubscribeService } = require('./core/unsubscribe-service');

module.exports = function init(site) {
    const sendmail = require('sendmail')();
    const policy = site.emailAbusePolicy || createEmailAbusePolicy({
        filePath: process.env.EMAIL_POLICY_FILE || path.join(site.cwd, 'localStorage', 'email-abuse-policy.json'),
        initial: {
            blockFrom: process.env.EMAIL_BLOCK_FROM,
            allowFrom: process.env.EMAIL_ALLOW_FROM,
            blockFromDomains: process.env.EMAIL_BLOCK_FROM_DOMAINS,
            allowFromDomains: process.env.EMAIL_ALLOW_FROM_DOMAINS,
            blockTo: process.env.EMAIL_BLOCK_TO,
            allowTo: process.env.EMAIL_ALLOW_TO,
            blockToDomains: process.env.EMAIL_BLOCK_TO_DOMAINS,
            allowToDomains: process.env.EMAIL_ALLOW_TO_DOMAINS,
            blockIPs: process.env.EMAIL_BLOCK_IPS,
            allowIPs: process.env.EMAIL_ALLOW_IPS,
            blockSubject: process.env.EMAIL_BLOCK_SUBJECT,
            ignoreFrom: process.env.EMAIL_IGNORE_FROM,
            ignoreSubject: process.env.EMAIL_IGNORE_SUBJECT,
            blockOutboundFrom: process.env.EMAIL_BLOCK_OUTBOUND_FROM,
            allowOutboundFrom: process.env.EMAIL_ALLOW_OUTBOUND_FROM,
            blockOutboundTo: process.env.EMAIL_BLOCK_OUTBOUND_TO,
            allowOutboundTo: process.env.EMAIL_ALLOW_OUTBOUND_TO,
            blockOutboundDomains: process.env.EMAIL_BLOCK_OUTBOUND_DOMAINS,
            allowOutboundDomains: process.env.EMAIL_ALLOW_OUTBOUND_DOMAINS,
        },
    });
    site.emailAbusePolicy = policy;
    site.emailDeliverability = site.emailDeliverability || createEmailDeliverabilityEngine({
        baseDir: process.env.EMAIL_DELIVERABILITY_DIR || path.join(site.cwd, 'localStorage', 'email-deliverability'),
        logger: (message) => site.log(message),
    });
    site.emailRuntimeMonitor = site.emailRuntimeMonitor || createEmailRuntimeMonitor();
    site.emailUnsubscribe = site.emailUnsubscribe || createEmailUnsubscribeService({
        deliverability: site.emailDeliverability,
        baseDir: process.env.EMAIL_UNSUBSCRIBE_DIR || path.join(site.cwd, 'localStorage', 'email-unsubscribe'),
        publicOrigin: process.env.EMAIL_PUBLIC_ORIGIN || 'https://emails.social-browser.com',
        monitor: site.emailRuntimeMonitor,
    });
    const service = site.emailService || createEmailService({
        sendmail,
        dataDir: path.join(site.cwd, 'localStorage', 'email-files'),
        vipPath: path.join(site.cwd, 'localStorage', 'vip-email-list.json'),
        maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 10000),
        logger: (message) => site.log(message),
        abusePolicy: policy,
        deliverability: site.emailDeliverability,
        unsubscribe: site.emailUnsubscribe,
        monitor: site.emailRuntimeMonitor,
    });
    site.emailService = service;
    site.emailStore = service.store;
    const scheduler = site.emailScheduler || null;
    site.emailOperationsManager = site.emailOperationsManager || createEmailBackupStorageManager({
        emailService: service,
        monitor: site.emailRuntimeMonitor,
        scheduler,
        rootDir: path.join(site.cwd, 'localStorage'),
        backupDir: process.env.EMAIL_BACKUP_DIR || path.join(site.cwd, 'localStorage', 'email-backups'),
        controlDir: process.env.EMAIL_STORAGE_CONTROL_DIR || path.join(site.cwd, 'localStorage', 'email-storage'),
        alertWebhook: process.env.EMAIL_OPS_ALERT_WEBHOOK || '',
        logger: (message) => site.log(message),
    });
    if (scheduler) site.emailOperationsManager.setScheduler(scheduler);
    if (!site.emailOperationsManager.timer) site.emailOperationsManager.start();
    const operationsManager = site.emailOperationsManager;
    const deliverability = site.emailDeliverability;
    const runtimeMonitor = site.emailRuntimeMonitor;
    const unsubscribe = site.emailUnsubscribe;
    site.trustedBrowserIDs = process.env.EMAIL_TRUSTED_BROWSER_IDS || '*test*|*vip*|*developer*';
    const browserAuth = site.emailBrowserAuth || createBrowserAuth(site);
    site.emailBrowserAuth = browserAuth;

    function clientIp(req) {
        const direct = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || '').trim();
        if (process.env.EMAIL_TRUST_PROXY === 'true') {
            const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
            if (forwarded) return forwarded;
        }
        return direct || 'unknown';
    }

    function requestBodyBytes(req) {
        const declared = Number(req?.headers?.['content-length'] || 0);
        if (Number.isFinite(declared) && declared > 0) return declared;
        try { return Buffer.byteLength(JSON.stringify(body(req) || {})); } catch (_) { return 0; }
    }

    function rateLimited(res, result) {
        res.status(429);
        if (result?.retryAfterMs && typeof res.set === 'function') res.set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        res.json({ done: false, error: 'Too many requests. Try again shortly.', retryAfterMs: Number(result?.retryAfterMs || 0) });
        return false;
    }

    function guardHttp(req, res, buckets) {
        const ip = clientIp(req);
        const adminRequest = (Array.isArray(buckets) ? buckets : [buckets || 'api']).includes('admin') && admin(req);
        const ipCheck = adminRequest ? { allowed: true } : policy.checkIp(ip);
        if (!ipCheck.allowed) {
            policy.metrics.httpPolicyBlocked += 1;
            policy.record('http_ip_blocked', { ip, rule: ipCheck.rule, reason: ipCheck.reason });
            res.status(403);
            res.json({ done: false, error: 'Request blocked by server policy.' });
            return false;
        }
        const httpLimits = policy.getConfig().limits.http;
        if (httpLimits.enabled && requestBodyBytes(req) > httpLimits.maxBodyBytes) {
            policy.metrics.httpPolicyBlocked += 1;
            policy.record('http_body_too_large', { ip, bytes: requestBodyBytes(req), limit: httpLimits.maxBodyBytes });
            res.status(413);
            res.json({ done: false, error: 'Request body is too large.' });
            return false;
        }
        const identity = browserRequestID(req) || ip;
        for (const bucket of (Array.isArray(buckets) ? buckets : [buckets || 'api'])) {
            const result = policy.httpHit(bucket, bucket === 'admin' || bucket === 'expensive' ? identity : ip);
            if (!result.allowed) return rateLimited(res, result);
        }
        return true;
    }

    function routeName(route) {
        if (typeof route === 'string') return route;
        return String(route?.name || '');
    }

    function postBuckets(name) {
        if (name.includes('/admin/list') || name.includes('/admin/summary') || name.includes('/admin/policy/test')) return ['admin', 'expensive'];
        if (name.includes('/admin/')) return ['admin'];
        if (name.includes('/inboxes/status') || name.endsWith('/view')) return ['inbox'];
        if (name.endsWith('/all')) return ['expensive'];
        return ['api'];
    }

    function onPost(route, handler) {
        const name = routeName(route);
        return site.onPOST(route, function guardedPost(req, res) {
            if (!guardHttp(req, res, postBuckets(name))) return;
            return handler(req, res);
        });
    }

    function outboundAllowed(req, mode) {
        const type = mode === 'admin' || mode === true ? 'admin' : (mode === 'api' ? 'api' : 'browser');
        if (type === 'browser' && !isBrowserSession(req)) return false;
        const key = browserRequestID(req) || clientIp(req) || type;
        return policy.outboundHit(key, type).allowed;
    }

    function safeFilename(value, fallback) {
        const text = String(value || fallback || 'download').replace(/[\r\n\x00-\x1f\x7f<>:\"/\\|?*]+/g, '_').trim();
        return text.slice(0, 160) || String(fallback || 'download');
    }

    function messageRecipientMatches(message, address) {
        const email = normalizeEmail(address);
        if (!email) return false;
        return extractAddresses([message?.to, message?.cc].join(',')).map((item) => item.toLowerCase()).includes(email);
    }

    // Compatibility only: older UI/code may read this property. The canonical
    // source remains localStorage/vip-email-list.json managed by EmailFileStore.
    Object.defineProperty(site, 'vipEmailList', {
        configurable: true,
        enumerable: true,
        get() { return service.listVip(); },
        set() {},
    });
    site.vipEmailListPath = service.store.vipPath;
    site.trackEmail = function (email) {
        if (email && email.name && email.ip) {
            service.trackMailboxAccess(email.name, email.ip).catch((error) => site.log('Email tracking error: ' + (error?.message || error)));
        }
    };

    function body(req) {
        if (req?.body && typeof req.body === 'object' && Object.keys(req.body).length) return req.body;
        if (req?.data && typeof req.data === 'object') return req.data;
        return {};
    }

    const adminBrowserIDs = process.env.EMAIL_ADMIN_BROWSER_IDS || '*test*|*admin*|*dev*';

    function adminBrowser(req) {
        if (browserAuth.isSignedOut(req)) return false;
        return isBrowserSession(req) && isTrustedBrowserId(browserRequestID(req), adminBrowserIDs);
    }

    function admin(req) {
        if (isAdminRequest(req)) return true;
        return adminBrowser(req);
    }

    function vipAccess(req) {
        return hasVipAccess(req, site.trustedBrowserIDs);
    }

    function canManageVip(req) {
        return admin(req) || isTrustedBrowserId(browserRequestID(req), site.trustedBrowserIDs);
    }

    function adminDenied(res) {
        res.json({ done: false, error: 'Admin permission is required' });
    }

    function adminGlobalContext(extra) {
        return Object.assign({
            isAdmin: true,
            allowVip: true,
            maxLimit: 5000,
            source: 'admin-dashboard',
        }, extra || {});
    }

    function cleanFolder(value) {
        const folder = String(value || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
        return folder || 'inbox';
    }

    function currentDomain(req) {
        return requestDomain(req);
    }

    function readContext(req, extra, domain) {
        return Object.assign({
            allowVip: vipAccess(req),
            domain: domain || currentDomain(req),
            maxLimit: 5000,
        }, extra || {});
    }

    function adminContext(req, extra, domain) {
        return Object.assign({
            isAdmin: true,
            allowVip: true,
            domain: domain || currentDomain(req),
            source: 'website-api',
        }, extra || {});
    }

    site.onGET({
        name: 'login',
        path: __dirname + '/site_files/html/login.html',
        parser: 'html css js',
        compress: true,
        overwrite: true,
    });

    site.onGET({ name: '/api/v2/browser-auth/status', overwrite: true }, (req, res) => {
        if (!guardHttp(req, res, ['api'])) return;
        res.json(browserAuth.status(req));
    });

    onPost('/api/v2/browser-auth/signin', (req, res) => {
        res.json(browserAuth.signIn(req));
    });

    onPost('/api/v2/browser-auth/signout', (req, res) => {
        res.json(browserAuth.signOut(req));
    });


    site.onGET({ name: '/health', overwrite: true }, (req, res) => {
        const snapshot = runtimeMonitor.publicSnapshot();
        if (!snapshot.ok) res.status(503);
        res.json(snapshot);
    });

    site.onGET({ name: '/ready', overwrite: true }, (req, res) => {
        const snapshot = runtimeMonitor.publicSnapshot();
        if (!snapshot.ok) res.status(503);
        res.json({ ready: snapshot.ok, status: snapshot.status, components: snapshot.components, timestamp: snapshot.timestamp });
    });

    site.onGET({ name: '/api/emails/unsubscribe', overwrite: true }, (req, res) => {
        const token = String(req?.query?.token || '').trim();
        const email = unsubscribe.verifyToken(token);
        if (!email) {
            res.status(400);
            return res.sendHTML('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invalid unsubscribe link</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:20px"><h1>Invalid unsubscribe link</h1><p>This link is invalid or incomplete.</p><a href="/">Back to Social Temp Mail</a></body></html>');
        }
        const safeEmail = email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const safeToken = token.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return res.sendHTML('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:20px;color:#172033"><h1>Unsubscribe</h1><p>Stop future outreach email to <strong>' + safeEmail + '</strong>.</p><form method="post" action="/api/emails/unsubscribe?token=' + encodeURIComponent(safeToken) + '"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="padding:10px 16px;border:0;border-radius:8px;background:#0f766e;color:white;font-weight:700">Unsubscribe</button></form><p style="margin-top:24px"><a href="/">Back to Social Temp Mail</a></p></body></html>');
    });

    site.onGET({ name: '/api/emails/live', overwrite: true }, (req, res) => {
        if (!guardHttp(req, res, ['inbox'])) return;
        const domain = currentDomain(req);
        const requested = String(req?.query?.addresses || '').split(',').map((item) => normalizeEmail(item)).filter(Boolean);
        const addresses = Array.from(new Set(requested.filter((email) => addressBelongsToDomain(email, domain)))).slice(0, 100);
        if (!addresses.length) {
            res.status(400);
            return res.json({ done: false, error: 'At least one valid mailbox address is required.' });
        }
        const raw = res?.res || res?.response || res;
        if (!raw || typeof raw.write !== 'function') {
            res.status(501);
            return res.json({ done: false, error: 'Streaming response is unavailable on this runtime.' });
        }
        if (typeof raw.writeHead === 'function') raw.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        else {
            if (typeof raw.setHeader === 'function') {
                raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                raw.setHeader('Cache-Control', 'no-cache, no-transform');
                raw.setHeader('Connection', 'keep-alive');
                raw.setHeader('X-Accel-Buffering', 'no');
            }
            raw.statusCode = 200;
        }
        const wanted = new Set(addresses);
        runtimeMonitor.increment('sseConnections');
        raw.write('event: ready\ndata: ' + JSON.stringify({ done: true, addresses, mode: 'sse' }) + '\n\n');
        const unsubscribeEvent = service.subscribe((event) => {
            if (!event || event.type !== 'incoming') return;
            const matched = (event.recipients || []).filter((email) => wanted.has(String(email || '').toLowerCase()));
            if (!matched.length) return;
            runtimeMonitor.increment('sseEvents');
            raw.write('event: mail\ndata: ' + JSON.stringify({ matched, message: event.message }) + '\n\n');
        });
        const keepalive = setInterval(() => {
            try { raw.write(': keepalive\n\n'); } catch (_) {}
        }, 20000);
        if (typeof keepalive.unref === 'function') keepalive.unref();
        const sourceReq = req?.req || req;
        const cleanup = () => {
            clearInterval(keepalive);
            try { unsubscribeEvent(); } catch (_) {}
        };
        if (sourceReq && typeof sourceReq.once === 'function') {
            sourceReq.once('close', cleanup);
            sourceReq.once('aborted', cleanup);
        }
        if (raw && typeof raw.once === 'function') raw.once('close', cleanup);
    });

    site.onGET({ name: 'admin', overwrite: true }, (req, res) => {
        if (!adminBrowser(req)) {
            res.status(403);
            return res.sendHTML('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin access required</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#dbeafe;font-family:Arial,sans-serif}.box{width:min(520px,calc(100% - 36px));padding:28px;border:1px solid #223a59;border-radius:18px;background:#0d1829;text-align:center}.box h1{margin:0 0 10px;color:#fff}.box p{color:#91a9c5;line-height:1.6}.box a{display:inline-block;margin-top:10px;padding:10px 14px;border-radius:10px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700}</style></head><body><div class="box"><h1>Admin access required</h1><p>This dashboard is available only from an authorized Social Browser environment.</p><a href="/">Back to Temp Mail</a></div></body></html>');
        }
        return res.render(__dirname + '/site_files/html/index.html', {}, { parser: 'html css js', compress: true });
    });

    site.onGET({
        name: ['', 'free', 'vip'],
        path: __dirname + '/site_files/html/free.html',
        parser: 'html css js',
        compress: true,
    });

    site.onGET({ name: 'temporary-email', path: __dirname + '/site_files/html/seo/temporary-email.html', parser: 'html css js', compress: true, overwrite: true });
    site.onGET({ name: 'disposable-email', path: __dirname + '/site_files/html/seo/disposable-email.html', parser: 'html css js', compress: true, overwrite: true });
    site.onGET({ name: 'verification-code-email', path: __dirname + '/site_files/html/seo/verification-code-email.html', parser: 'html css js', compress: true, overwrite: true });
    site.onGET({ name: 'temp-email-for-testing', path: __dirname + '/site_files/html/seo/temp-email-for-testing.html', parser: 'html css js', compress: true, overwrite: true });
    site.onGET({ name: 'multiple-temporary-inboxes', path: __dirname + '/site_files/html/seo/multiple-temporary-inboxes.html', parser: 'html css js', compress: true, overwrite: true });
    site.onGET({ name: 'developer-temp-mail', path: __dirname + '/site_files/html/seo/developer-temp-mail.html', parser: 'html css js', compress: true, overwrite: true });

    site.onGET({
        name: ['privacy'],
        path: __dirname + '/site_files/html/privacy.html',
        compress: false,
    });


    onPost('/api/emails/unsubscribe', async (req, res) => {
        const data = body(req);
        const token = String(req?.query?.token || data.token || '').trim();
        try {
            const result = unsubscribe.unsubscribeToken(token, 'public-one-click');
            await service.store.audit('email_unsubscribe', { email: result.email, source: 'public-one-click' });
            const accept = String(req?.headers?.accept || '').toLowerCase();
            if (accept.includes('text/html')) return res.sendHTML('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head><body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:20px;color:#172033"><h1>You are unsubscribed</h1><p>This address has been added to the suppression list and will not receive future outreach email from this service.</p><a href="/">Back to Social Temp Mail</a></body></html>');
            res.json({ done: true, unsubscribed: true, email: result.email });
        } catch (error) {
            res.status(400);
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/feedback', async (req, res) => {
        const configuredToken = String(process.env.EMAIL_FEEDBACK_TOKEN || '').trim();
        if (!configuredToken) {
            res.status(503);
            return res.json({ done: false, error: 'Feedback webhook is disabled until EMAIL_FEEDBACK_TOKEN is configured.' });
        }
        const data = body(req);
        const supplied = String(req?.headers?.['x-email-feedback-token'] || data.token || req?.query?.token || '').trim();
        if (supplied !== configuredToken) {
            res.status(403);
            return res.json({ done: false, error: 'Invalid feedback token.' });
        }
        const sourceEvents = Array.isArray(data.events) ? data.events : [data];
        const results = [];
        for (const source of sourceEvents.slice(0, 500)) {
            const email = normalizeEmail(source.email || source.recipient || source.address || source.originalRecipient || '');
            let type = String(source.type || source.event || source.feedbackType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (type === 'bounce') type = String(source.status || '').startsWith('5') || source.hard === true ? 'hard_bounce' : 'soft_bounce';
            if (['spam', 'abuse', 'complaint_received'].includes(type)) type = 'complaint';
            if (['unsubscribed', 'opt_out', 'optout'].includes(type)) type = 'unsubscribe';
            if (['delivery', 'delivered_message'].includes(type)) type = 'delivered';
            try {
                const result = deliverability.reportFeedback({
                    email,
                    type,
                    reason: source.reason || source.description || '',
                    source: source.source || source.provider || 'feedback-webhook',
                });
                results.push({ ok: true, result });
                runtimeMonitor.increment('feedbackEvents');
            } catch (error) {
                results.push({ ok: false, email, type, error: error?.message || String(error) });
            }
        }
        await service.store.audit('email_feedback_webhook', { received: sourceEvents.length, accepted: results.filter((item) => item.ok).length });
        res.json({ done: true, received: sourceEvents.length, accepted: results.filter((item) => item.ok).length, results });
    });

    onPost('/api/emails/client-context', (req, res) => {
        res.json(getClientContext(req));
    });

    onPost('/api/emails/inboxes/status', async (req, res) => {
        const data = body(req);
        const addresses = Array.isArray(data.addresses) ? data.addresses.slice(0, 100) : [];
        try {
            const result = await service.mailboxStatuses(addresses, { allowVip: vipAccess(req), maxAddresses: 100 });
            res.json({ done: true, items: result.items });
        } catch (error) {
            res.json({ done: false, items: [], error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/reply', async (req, res) => {
        const data = body(req);
        if (!isBrowserSession(req)) return res.json({ done: false, error: 'This feature is available in Social Browser.' });
        if (!data.guid || !data.from || (!data.text && !data.html)) return res.json({ done: false, error: 'Reply fields are required.' });
        try {
            const context = readContext(req, null, apiDomain(req, data.from));
            const original = (await service.read(data.guid, context)).message;
            if (!messageRecipientMatches(original, data.from)) return res.json({ done: false, error: 'Sender address must match the mailbox that received this message.' });
            if (!outboundAllowed(req)) return res.json({ done: false, error: 'Hourly sending limit reached. Try again later.' });
            const result = await service.reply({ guid: data.guid, from: normalizeEmail(data.from), text: data.text || '', html: data.html || '' }, context);
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/forward', async (req, res) => {
        const data = body(req);
        if (!isBrowserSession(req)) return res.json({ done: false, error: 'This feature is available in Social Browser.' });
        if (!data.guid || !data.from || !data.to) return res.json({ done: false, error: 'Forward fields are required.' });
        try {
            const context = readContext(req, null, apiDomain(req, data.from));
            const original = (await service.read(data.guid, context)).message;
            if (!messageRecipientMatches(original, data.from)) return res.json({ done: false, error: 'Sender address must match the mailbox that received this message.' });
            if (!outboundAllowed(req)) return res.json({ done: false, error: 'Hourly sending limit reached. Try again later.' });
            const result = await service.forward({ guid: data.guid, from: normalizeEmail(data.from), to: data.to, text: data.text || '', html: data.html || '' }, context);
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost({ name: '/api/emails/add', require: { features: [] } }, async (req, res) => {
        const response = { done: false };
        const doc = body(req);
        if (doc.source !== 'isite') {
            response.error = 'You Are Not Authorized';
            return res.json(response);
        }
        if (!doc.from || !doc.to || !doc.subject || (!doc.message && !doc.text && !doc.html)) {
            response.error = 'Invalid Email Fields Request';
            return res.json(response);
        }
        if (!outboundAllowed(req, 'api')) {
            response.error = 'API sending limit reached. Try again later.';
            return res.json(response);
        }
        try {
            const result = await service.send({
                from: doc.from,
                to: doc.to,
                cc: doc.cc,
                subject: doc.subject,
                text: doc.text || (!doc.html ? doc.message : ''),
                html: doc.html || doc.message || '',
                replyTo: doc.replyTo,
            });
            response.done = true;
            response.result = result;
            response.doc = (await service.read(result.guid, { allowVip: true, domain: apiDomain(req, doc.from, doc.email) })).message;
        } catch (error) {
            response.error = error?.message || String(error);
        }
        res.json(response);
    });

    onPost('/api/emails/update', async (req, res) => {
        const response = { done: false };
        if (!isBrowserSession(req) && !admin(req)) return res.json(response);
        const doc = body(req);
        if (!doc.guid) return res.json(response);
        try {
            const updated = await service.update(doc.guid, doc, readContext(req, null, apiDomain(req, doc.email, doc.to, doc.from)));
            response.done = !!updated;
            response.doc = updated;
            if (!updated) response.error = 'Email not found';
        } catch (error) {
            response.error = error?.message || String(error);
        }
        res.json(response);
    });

    onPost('/api/emails/set-vip', async (req, res) => {
        if (!canManageVip(req)) return adminDenied(res);
        const doc = body(req);
        try {
            const domain = apiDomain(req, doc.email);
            doc.email = mailboxForDomain(doc.email, domain);
            const saved = await service.setVip(doc);
            res.json({ done: true, doc: saved });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/set-normal', async (req, res) => {
        if (!canManageVip(req)) return adminDenied(res);
        const doc = body(req);
        try {
            const domain = apiDomain(req, doc.email);
            const result = await service.removeVip(mailboxForDomain(doc.email, domain));
            res.json({ done: true, doc: result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/delete', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const guid = body(req).guid;
        if (!guid) return res.json({ done: false, error: 'guid is required' });
        try {
            const data = body(req);
            const result = await service.delete(guid, adminContext(req, null, apiDomain(req, data.email, data.to, data.from)));
            res.json({ done: !!result.deleted, result, error: result.notFound ? 'Email not found' : undefined });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/view', async (req, res) => {
        const input = body(req);
        const response = {
            done: false,
            list: [],
            browserID: req.browserID,
            toEmail: input.to,
            index: input.index,
            guid: input.guid,
            id: input.id,
        };
        const context = readContext(req, { maxLimit: 1000 }, apiDomain(req, input.email, input.to, input.from));
        try {
            let doc = null;
            if (input.guid) {
                try {
                    doc = (await service.read(String(input.guid), context)).message;
                } catch (error) {
                    if (error.code === 'VIP_REQUIRED') {
                        response.done = true;
                        response.isVIP = true;
                        return res.json(response);
                    }
                    if (error.message !== 'Email not found') throw error;
                }
            } else if (input.id !== undefined && input.id !== null && input.id !== '') {
                const all = await service.store.listMessages();
                let raw = all.find((item) => String(item.id) === String(input.id));
                if (raw) {
                    if (context.domain && !messageBelongsToDomain(raw, context.domain)) raw = null;
                }
                if (raw) {
                    if (service.isVipMessage(raw) && !context.allowVip) {
                        response.done = true;
                        response.isVIP = true;
                        return res.json(response);
                    }
                    doc = service.safeMessage(raw, true);
                }
            } else if (input.to) {
                const found = await service.search({ toExact: input.to, limit: 1000, includeBody: true }, context);
                response.isVIP = found.blockedVipCount > 0;
                if (found.messages.length) doc = found.messages[0];
            }

            response.done = true;
            if (doc) {
                doc.privacy = analyzeEmailHtml(doc.html || '');
                response.doc = doc;
                response.message = doc;
                response.list = [doc];
                response.isVIP = service.isVipAddress(doc.to) && !context.allowVip;
            } else if (!response.isVIP) {
                response.error = 'Not Found Any Email Message';
            }
        } catch (error) {
            response.error = error?.message || String(error);
        }
        res.json(response);
    });

    onPost('/api/emails/all', async (req, res) => {
        const data = body(req);
        const where = data.where || {};
        const limit = Math.max(1, Math.min(Number(data.limit || 500), 5000));
        const context = readContext(req, { maxLimit: 5000 }, apiDomain(req, data.email, where.email, where.to, where.from));
        const args = {
            from: where.from,
            to: data.exactTo ? undefined : where.to,
            toExact: data.exactTo ? where.to : undefined,
            subject: where.subject,
            text: where.text,
            html: where.html,
            search: where.search,
            folder: where.folder,
            limit,
            includeBody: !!(data.select && (data.select.text || data.select.html)),
        };
        try {
            const result = await service.search(args, context);
            const response = {
                done: true,
                list: result.messages,
                count: result.totalMatches,
                isVIP: result.blockedVipCount > 0,
                storage: 'json-files-only',
            };
            res.json(response);
            if (where.to) site.trackEmail({ name: where.to, ip: req.ip });
        } catch (error) {
            res.json({ done: false, list: [], count: 0, error: error?.message || String(error) });
        }
    });

    site.onGET({ name: '/viewEmail' }, async (req, res) => {
        if (!guardHttp(req, res, ['inbox'])) return;
        try {
            const guid = String(req.query?.guid || '');
            const mailbox = String(req.query?.email || req.query?.to || '');
            if (!guid) return res.sendHTML('<h1>Email Not Exists</h1>');
            const result = await service.read(guid, admin(req) ? adminGlobalContext({ maxLimit: 1 }) : readContext(req, { maxLimit: 1 }, apiDomain(req, req.query?.email, req.query?.to, req.query?.from)));
            const doc = result.message;
            const html = doc.html || ('<pre>' + String(doc.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
            res.sendHTML(sanitizeEmailHtml(html, { allowRemoteImages: String(req.query?.remote || '') === '1', attachments: doc.attachments, guid, mailbox }));
        } catch (error) {
            if (error.code === 'VIP_REQUIRED') return res.sendHTML('<h1>VIP Email Protected</h1>');
            res.sendHTML('<h1>Email Not Exists</h1>');
        }
    });

    site.onGET({ name: '/api/emails/attachment' }, async (req, res) => {
        if (!guardHttp(req, res, ['api'])) return;
        try {
            const guid = String(req.query?.guid || '');
            const id = String(req.query?.id || '');
            const mailbox = String(req.query?.email || req.query?.to || '');
            if (!guid || !id) return res.status(400).send('Attachment request is incomplete');
            const result = await service.readAttachment(guid, id, admin(req) ? adminGlobalContext({ maxLimit: 1 }) : readContext(req, { maxLimit: 1 }, apiDomain(req, mailbox)));
            const filename = safeFilename(result.meta.filename, 'attachment.bin');
            res.set('Content-Type', result.meta.contentType || 'application/octet-stream');
            res.set('Content-Disposition', (result.meta.contentDisposition === 'inline' ? 'inline' : 'attachment') + '; filename="' + filename.replace(/"/g, '') + '"');
            res.set('Cache-Control', 'private, max-age=300');
            res.end(result.content);
        } catch (error) {
            res.status(404).send('Attachment not found');
        }
    });

    site.onGET({ name: '/api/emails/eml' }, async (req, res) => {
        if (!guardHttp(req, res, ['api'])) return;
        try {
            const guid = String(req.query?.guid || '');
            const mailbox = String(req.query?.email || req.query?.to || '');
            if (!guid) return res.status(400).send('Email guid is required');
            const result = await service.exportEml(guid, admin(req) ? adminGlobalContext({ maxLimit: 1 }) : readContext(req, { maxLimit: 1 }, apiDomain(req, mailbox)));
            const subject = safeFilename(result.message.subject || 'email', 'email');
            res.set('Content-Type', 'message/rfc822');
            res.set('Content-Disposition', 'attachment; filename="' + subject.replace(/"/g, '') + '.eml"');
            res.set('Cache-Control', 'private, no-store');
            res.end(result.content);
        } catch (error) {
            res.status(404).send('Email not found');
        }
    });

    site.onGET({ name: '/api/emails/qr' }, (req, res) => {
        if (!guardHttp(req, res, ['api'])) return;
        try {
            const email = normalizeEmail(req.query?.email || '');
            if (!email || !email.includes('@')) return res.status(400).send('Valid email is required');
            const svg = qrSvg(email);
            res.set('Content-Type', 'image/svg+xml; charset=utf-8');
            res.set('Cache-Control', 'private, max-age=300');
            res.end(svg);
        } catch (error) {
            res.status(400).send(error?.message || 'Unable to create QR');
        }
    });

    onPost('/api/emails/delete-all', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const where = data.where || {};
        const limit = Math.max(1, Math.min(Number(data.limit || where.limit || 10), 5000));
        try {
            const found = await service.search({
                from: where.from,
                to: where.to,
                subject: where.subject,
                text: where.text,
                html: where.html,
                search: where.search,
                folder: where.folder,
                limit,
            }, { allowVip: true, maxLimit: 5000, domain: apiDomain(req, data.email, where.email, where.to, where.from) });
            const guids = found.messages.slice(0, limit).map((doc) => String(doc.guid));
            const result = await service.deleteMany(guids, adminContext(req, null, apiDomain(req, data.email, where.email, where.to, where.from)));
            res.json({ done: true, result: { count: result.deletedCount, deleted: result.deleted, notFound: result.notFound } });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/summary', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const stats = await service.stats(adminGlobalContext());
            res.json({
                done: true,
                browserID: browserRequestID(req),
                stats,
                vip: service.listVip(),
                folders: service.listAdminFolders(),
                storage: 'json-files-only',
            });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/list', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const limit = Math.max(1, Math.min(Number(data.limit || 50), 250));
        const offset = Math.max(0, Number(data.offset || 0));
        const args = {
            query: data.query || data.search || '',
            from: data.from || '',
            to: data.to || '',
            subject: data.subject || '',
            folder: data.folder && data.folder !== 'all' ? data.folder : undefined,
            status: data.status && data.status !== 'all' ? data.status : undefined,
            read: data.read === true || data.read === 'read' ? true : data.read === false || data.read === 'unread' ? false : undefined,
            favorite: data.favorite === true || data.favorite === 'true' ? true : undefined,
            hasAttachments: data.hasAttachments === true || data.hasAttachments === 'true' ? true : undefined,
            after: data.after || undefined,
            before: data.before || undefined,
            sortBy: ['date', 'id', 'from', 'to', 'subject', 'folder', 'status'].includes(String(data.sortBy || '')) ? String(data.sortBy) : 'date',
            sortDir: String(data.sortDir || '').toLowerCase() === 'asc' ? 'asc' : 'desc',
            limit,
            offset,
            includeBody: false,
        };
        try {
            const result = await service.search(args, adminGlobalContext({ maxLimit: 5000 }));
            res.json({
                done: true,
                list: result.messages,
                count: result.totalMatches,
                offset,
                limit,
                hasMore: offset + result.messages.length < result.totalMatches,
                scannedCount: result.scannedCount,
                durationMs: result.durationMs,
                sortBy: args.sortBy,
                sortDir: args.sortDir,
            });
        } catch (error) {
            res.json({ done: false, list: [], count: 0, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/folder/create', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const rawName = String(body(req).name || '').trim();
        if (!rawName) return res.json({ done: false, error: 'Folder name is required' });
        const name = cleanFolder(rawName);
        try {
            const result = await service.addAdminFolder(name);
            res.json({ done: true, result, folders: service.listAdminFolders() });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/message', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const guid = String(body(req).guid || '');
        if (!guid) return res.json({ done: false, error: 'Email guid is required' });
        try {
            const doc = (await service.read(guid, adminGlobalContext())).message;
            doc.privacy = analyzeEmailHtml(doc.html || '');
            doc.vip = service.isVipMessage(doc);
            res.json({ done: true, doc });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/update', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const guid = String(data.guid || '');
        if (!guid) return res.json({ done: false, error: 'Email guid is required' });
        const patch = {};
        if (data.favorite !== undefined) patch.favorite = !!data.favorite;
        if (data.read !== undefined) patch.read = !!data.read;
        if (data.folder !== undefined) patch.folder = cleanFolder(data.folder);
        if (data.status !== undefined) patch.status = String(data.status || '').trim().slice(0, 40);
        try {
            const doc = await service.update(guid, patch, adminGlobalContext());
            res.json({ done: !!doc, doc, error: doc ? undefined : 'Email not found' });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/bulk-update', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const guids = Array.from(new Set((Array.isArray(data.guids) ? data.guids : []).map(String))).slice(0, 5000);
        if (!guids.length) return res.json({ done: false, error: 'Select at least one email' });
        const patch = {};
        if (data.favorite !== undefined) patch.favorite = !!data.favorite;
        if (data.read !== undefined) patch.read = !!data.read;
        if (data.folder !== undefined) patch.folder = cleanFolder(data.folder);
        if (data.status !== undefined) patch.status = String(data.status || '').trim().slice(0, 40);
        try {
            const updated = [];
            const notFound = [];
            for (const guid of guids) {
                const doc = await service.update(guid, patch, adminGlobalContext());
                if (doc) updated.push(guid);
                else notFound.push(guid);
            }
            res.json({ done: true, updatedCount: updated.length, updated, notFound });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/delete', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const guid = String(body(req).guid || '');
        if (!guid) return res.json({ done: false, error: 'Email guid is required' });
        try {
            const result = await service.delete(guid, adminGlobalContext());
            res.json({ done: !!result.deleted, result, error: result.notFound ? 'Email not found' : undefined });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/bulk-delete', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const guids = Array.from(new Set((Array.isArray(body(req).guids) ? body(req).guids : []).map(String))).slice(0, 5000);
        if (!guids.length) return res.json({ done: false, error: 'Select at least one email' });
        try {
            const result = await service.deleteMany(guids, adminGlobalContext());
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/send', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        if (!data.from || !data.to || (!data.text && !data.html)) return res.json({ done: false, error: 'From, To and message content are required' });
        if (!outboundAllowed(req, 'admin')) return res.json({ done: false, error: 'Admin sending limit reached. Try again later.' });
        try {
            const result = await service.send({
                from: data.from,
                to: data.to,
                cc: data.cc || '',
                subject: data.subject || '',
                text: data.text || '',
                html: data.html || '',
                replyTo: data.replyTo || '',
            });
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/reply', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        if (!data.guid || (!data.text && !data.html)) return res.json({ done: false, error: 'Reply content is required' });
        if (!outboundAllowed(req, 'admin')) return res.json({ done: false, error: 'Admin sending limit reached. Try again later.' });
        try {
            const original = (await service.read(String(data.guid), adminGlobalContext())).message;
            const fallbackFrom = extractAddresses(original.to)[0] || normalizeEmail(original.to);
            const from = normalizeEmail(data.from || fallbackFrom);
            if (!from) return res.json({ done: false, error: 'A valid From address is required' });
            const result = await service.reply({ guid: String(data.guid), from, text: data.text || '', html: data.html || '' }, adminGlobalContext());
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/forward', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        if (!data.guid || !data.to) return res.json({ done: false, error: 'Destination email is required' });
        if (!outboundAllowed(req, 'admin')) return res.json({ done: false, error: 'Admin sending limit reached. Try again later.' });
        try {
            const original = (await service.read(String(data.guid), adminGlobalContext())).message;
            const fallbackFrom = extractAddresses(original.to)[0] || normalizeEmail(original.to);
            const from = normalizeEmail(data.from || fallbackFrom);
            if (!from) return res.json({ done: false, error: 'A valid From address is required' });
            const result = await service.forward({ guid: String(data.guid), from, to: data.to, text: data.text || '', html: data.html || '' }, adminGlobalContext());
            res.json({ done: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/vip', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const email = normalizeEmail(data.email || '');
        if (!email) return res.json({ done: false, error: 'Email address is required' });
        try {
            if (data.vip === false) {
                const result = await service.removeVip(email);
                return res.json({ done: true, vip: false, result });
            }
            const result = await service.setVip({ email, vip: true, source: 'admin-dashboard' });
            res.json({ done: true, vip: true, result });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });


    onPost('/api/emails/admin/policy/get', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        res.json({ done: true, config: policy.getConfig(), defaults: policy.getDefaults(), status: policy.status(), path: policy.filePath });
    });

    onPost('/api/emails/admin/policy/update', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const data = body(req);
            const config = policy.update(data.config && typeof data.config === 'object' ? data.config : data);
            await service.store.audit('admin_policy_update', { browser: browserRequestID(req) || '', ip: clientIp(req), updatedAt: config.updatedAt });
            res.json({ done: true, config, status: policy.status() });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/policy/reset', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const config = policy.reset();
            await service.store.audit('admin_policy_reset', { browser: browserRequestID(req) || '', ip: clientIp(req), updatedAt: config.updatedAt });
            res.json({ done: true, config, status: policy.status() });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/policy/test', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        const type = String(data.type || '').toLowerCase();
        const value = String(data.value || '');
        let result;
        if (type === 'ip') result = policy.checkIp(value);
        else if (type === 'to') result = policy.checkAddress('to', value);
        else if (type === 'subject') result = policy.checkSubject(value);
        else if (type === 'ignore') result = policy.shouldIgnore(data.from || value, data.subject || '');
        else result = policy.checkAddress('from', value);
        res.json({ done: true, type: type || 'from', value, result });
    });


    onPost('/api/emails/admin/schedules/status', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        res.json({ done: true, status: scheduler.status() });
    });

    onPost('/api/emails/admin/schedules/list', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        try { res.json({ done: true, result: scheduler.list(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/schedules/get', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        try { res.json({ done: true, task: scheduler.get(String(body(req).id || ''), true) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/schedules/create', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        try {
            const task = await scheduler.schedule(body(req), { client: 'admin-dashboard' });
            res.json({ done: true, task });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/schedules/update', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        const data = body(req);
        try {
            const task = await scheduler.update(String(data.id || ''), data);
            res.json({ done: true, task });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/schedules/cancel', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        try { res.json({ done: true, task: await scheduler.cancel(String(body(req).id || '')) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/schedules/send-now', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        try { res.json({ done: true, task: await scheduler.sendNow(String(body(req).id || '')) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/schedules/retry', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        if (!scheduler) return res.json({ done: false, error: 'Scheduler service is unavailable.' });
        const data = body(req);
        try { res.json({ done: true, task: await scheduler.retry(String(data.id || ''), data) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/deliverability/status', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        res.json({
            done: true,
            status: deliverability.status(),
            config: deliverability.getConfig(),
            feedbackWebhookEnabled: !!String(process.env.EMAIL_FEEDBACK_TOKEN || '').trim(),
            feedbackEndpoint: '/api/emails/feedback',
            inboundArfDetection: true,
            inboundDsnDetection: true,
            oneClickUnsubscribe: true,
        });
    });

    onPost('/api/emails/admin/deliverability/config', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        try {
            const config = data.config ? deliverability.updateConfig(data.config) : deliverability.getConfig();
            if (data.config) await service.store.audit('admin_deliverability_config_update', { browser: browserRequestID(req) || '', updatedAt: config.updatedAt });
            res.json({ done: true, config, status: deliverability.status() });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/deliverability/preflight', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        try { res.json({ done: true, result: deliverability.preflightReport(data.from || '', data.to || data.recipients || []) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/deliverability/suppressions/list', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: deliverability.listSuppressions(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/deliverability/suppressions/add', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        try {
            const item = deliverability.addSuppression(data.email, data.type || 'manual', data.reason || '', 'admin-dashboard');
            await service.store.audit('admin_suppression_add', { email: item.email, type: item.type });
            res.json({ done: true, item });
        } catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/deliverability/suppressions/remove', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const result = deliverability.removeSuppression(body(req).email);
            await service.store.audit('admin_suppression_remove', result);
            res.json({ done: true, result });
        } catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/deliverability/feedback', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        try {
            const result = deliverability.reportFeedback({ email: data.email, type: data.type, reason: data.reason || '', source: 'admin-dashboard' });
            runtimeMonitor.increment('feedbackEvents');
            await service.store.audit('admin_delivery_feedback', result);
            res.json({ done: true, result, status: deliverability.status() });
        } catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/health', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const snapshot = await runtimeMonitor.snapshot({ scheduler, deliverability, service, policy, operationsManager });
            res.json({ done: true, snapshot });
        } catch (error) {
            res.json({ done: false, error: error?.message || String(error) });
        }
    });

    onPost('/api/emails/admin/operations/status', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, status: operationsManager.status() }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/config', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try {
            const data = body(req);
            const config = data.config ? operationsManager.updateConfig(data.config) : operationsManager.getConfig();
            if (data.config) await service.store.audit('admin_storage_config_update', { browser: browserRequestID(req) || '', updatedAt: new Date().toISOString() });
            res.json({ done: true, config, status: operationsManager.status() });
        } catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/backup/create', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: await operationsManager.createBackup(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/backups/list', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: operationsManager.listBackups() }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/backup/validate', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: await operationsManager.validateBackup(String(body(req).id || '')) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/restore/preview', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: await operationsManager.restorePreview(String(body(req).id || ''), body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/restore/execute', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        const data = body(req);
        try { res.json({ done: true, result: await operationsManager.restore(String(data.id || ''), data) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/storage/report', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, report: operationsManager.storageReport() }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/cleanup/preview', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: operationsManager.cleanupPreview(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/cleanup/execute', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: await operationsManager.cleanupExecute(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/maintenance/run', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: await operationsManager.runMaintenance(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/alerts', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, result: operationsManager.alerts(body(req)) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost('/api/emails/admin/operations/history', async (req, res) => {
        if (!admin(req)) return adminDenied(res);
        try { res.json({ done: true, history: operationsManager.historyList(body(req).limit || 144) }); }
        catch (error) { res.json({ done: false, error: error?.message || String(error) }); }
    });

    onPost({ name: '/generate-new-email' }, (req, res) => {
        let result = '';
        const characters = 'abcdefghijklmnopqrstuvwxyz';
        const numbers = '0123456789';
        const length = site.random(8, 16);
        let counter = 0;
        const first = site.random(4, 6);
        while (counter < first) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
            counter += 1;
        }
        result += ['.', '', '_', '', '-'][site.random(0, 4)] || '';
        counter = 0;
        const last = site.random(4, 6);
        while (counter < last) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
            counter += 1;
        }
        if (length > first + last) {
            result += ['.', '', '_', '', '-'][site.random(0, 4)] || '';
            counter = 0;
            while (counter < length - (first + last)) {
                result += numbers.charAt(Math.floor(Math.random() * numbers.length));
                counter += 1;
            }
        }
        const domain = currentDomain(req);
        if (!domain) return res.json({ done: false, error: 'Unable to determine current mail domain' });
        result += '@' + domain;
        res.json({ done: true, email: result, domain });
    });
};
