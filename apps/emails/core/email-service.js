'use strict';

const crypto = require('crypto');
const path = require('path');
const { EmailFileStore } = require('./json-store');
const { messageBelongsToDomain } = require('./domain');
const { buildEml } = require('./message-tools');

function extractAddresses(value) {
    return String(value || '').match(/[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|localhost)/gi) || [];
}

function normalizeAddressList(value) {
    const raw = Array.isArray(value) ? value : [value];
    const result = [];
    for (const item of raw) {
        for (const address of extractAddresses(item)) {
            const normalized = address.toLowerCase();
            if (!result.includes(normalized)) result.push(normalized);
        }
    }
    return result;
}

function normalizeEmail(value) {
    const addresses = extractAddresses(value);
    return (addresses[0] || String(value || '')).trim().toLowerCase();
}

function contains(value, query) {
    return String(value || '').toLowerCase().includes(String(query || '').toLowerCase());
}

function toIsoDate(value, fallback) {
    if (!value) return fallback || new Date().toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? (fallback || new Date().toISOString()) : date.toISOString();
}

function makeGuid(prefix) {
    return (prefix || 'mail') + '-' + Date.now().toString(36) + '-' + crypto.randomUUID();
}

function safeMessage(doc, includeBody) {
    if (!doc) return null;
    const result = {
        id: doc.id,
        guid: doc.guid,
        messageId: doc.messageId || '',
        from: doc.from || '',
        to: doc.to || '',
        cc: doc.cc || '',
        subject: doc.subject || '',
        date: doc.date || null,
        folder: doc.folder || '',
        status: doc.status || '',
        read: !!doc.read,
        favorite: !!doc.favorite,
        replyTo: doc.replyTo || '',
        inReplyTo: doc.inReplyTo || '',
        attachments: Array.isArray(doc.attachments) ? doc.attachments.map((item) => ({
            id: item.id,
            filename: item.filename || '',
            contentType: item.contentType || 'application/octet-stream',
            contentDisposition: item.contentDisposition || 'attachment',
            contentId: item.contentId || '',
            size: Number(item.size || 0),
            checksum: item.checksum || '',
            related: !!item.related,
        })) : [],
        hasAttachments: Array.isArray(doc.attachments) && doc.attachments.length > 0,
    };
    if (includeBody) {
        result.text = doc.text || '';
        result.html = doc.html || '';
    }
    return result;
}

function dateValue(value) {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
}

function matchesSearch(doc, args) {
    args = args || {};
    if (args.folder && doc.folder !== args.folder) return false;
    if (args.status && doc.status !== args.status) return false;
    if (args.favorite !== undefined && !!doc.favorite !== !!args.favorite) return false;
    if (args.hasAttachments !== undefined && ((Array.isArray(doc.attachments) && doc.attachments.length > 0) !== !!args.hasAttachments)) return false;
    if (args.read !== undefined && !!doc.read !== !!args.read) return false;
    if (args.from && !contains(doc.from, args.from)) return false;
    if (args.toExact) {
        const target = normalizeEmail(args.toExact);
        if (!target || !normalizeAddressList([doc.to, doc.cc]).includes(target)) return false;
    } else if (args.to && !contains(doc.to, args.to)) return false;
    if (args.subject && !contains(doc.subject, args.subject)) return false;
    if (args.text && !contains(doc.text, args.text) && !contains(doc.html, args.text)) return false;
    if (args.html && !contains(doc.html, args.html)) return false;
    if (args.query || args.search) {
        const query = args.query || args.search;
        if (![doc.from, doc.to, doc.cc, doc.subject, doc.text, doc.html].some((v) => contains(v, query))) return false;
    }
    if (args.after) {
        const after = new Date(args.after).getTime();
        if (!Number.isNaN(after) && dateValue(doc.date) < after) return false;
    }
    if (args.before) {
        const before = new Date(args.before).getTime();
        if (!Number.isNaN(before) && dateValue(doc.date) > before) return false;
    }
    return true;
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const count = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
    const runners = Array.from({ length: count }, async () => {
        while (true) {
            const index = cursor++;
            if (index >= items.length) return;
            try {
                results[index] = { ok: true, result: await worker(items[index], index) };
            } catch (error) {
                results[index] = { ok: false, error: error?.message || String(error) };
            }
        }
    });
    await Promise.all(runners);
    return results;
}

function createEmailService(options) {
    options = options || {};
    const logger = typeof options.logger === 'function' ? options.logger : () => {};
    const sendmail = options.sendmail;
    const abusePolicy = options.abusePolicy || null;
    const deliverability = options.deliverability || null;
    if (typeof sendmail !== 'function') throw new Error('sendmail function is required');

    let store;
    function isVipAddress(value) {
        const addresses = extractAddresses(value).map((v) => v.toLowerCase());
        if (!addresses.length || !store) return false;
        const vip = Array.isArray(store.vipEntries) ? store.vipEntries : store.listVip();
        return vip.some((entry) => {
            const protectedEmail = String(entry.email || '').trim().toLowerCase();
            if (!protectedEmail) return false;
            return addresses.some((address) => address === protectedEmail || address.includes(protectedEmail));
        });
    }

    function isVipMessage(doc) {
        return !!doc && (isVipAddress(doc.to) || isVipAddress(doc.cc));
    }

    store = new EmailFileStore({
        baseDir: options.dataDir || path.join(process.cwd(), 'localStorage', 'email-files'),
        vipPath: options.vipPath || path.join(process.cwd(), 'localStorage', 'vip-email-list.json'),
        maxMessages: Number(options.maxMessages || process.env.EMAIL_MAX_MESSAGES || 10000),
        logger,
        isProtectedMessage: isVipMessage,
    });

    async function deliver(message) {
        return new Promise((resolve, reject) => {
            sendmail(message, (err, reply) => {
                if (err) return reject(err);
                resolve(reply);
            });
        });
    }

    async function searchRaw(args, context) {
        args = args || {};
        const domain = context && context.domain;
        const matches = [];
        for (const doc of store.messageValues()) {
            if (domain && !messageBelongsToDomain(doc, domain)) continue;
            if (!matchesSearch(doc, args)) continue;
            matches.push(doc);
        }
        const allowedSortFields = new Set(['date', 'id', 'from', 'to', 'subject', 'folder', 'status']);
        const sortBy = allowedSortFields.has(String(args.sortBy || '')) ? String(args.sortBy) : 'date';
        const direction = String(args.sortDir || '').toLowerCase() === 'asc' ? 1 : -1;
        matches.sort((a, b) => {
            let av;
            let bv;
            if (sortBy === 'date') {
                av = dateValue(a.date);
                bv = dateValue(b.date);
            } else if (sortBy === 'id') {
                av = Number(a.id || 0);
                bv = Number(b.id || 0);
            } else {
                av = String(a[sortBy] || '').toLowerCase();
                bv = String(b[sortBy] || '').toLowerCase();
            }
            if (av < bv) return -1 * direction;
            if (av > bv) return 1 * direction;
            return (Number(a.id || 0) - Number(b.id || 0)) * direction;
        });
        return matches;
    }

    async function sendOne(args, auditAction) {
        const recipients = normalizeAddressList(args.to);
        if (!recipients.length) throw new Error('No valid recipient address found');
        const fromAddresses = normalizeAddressList(args.from);
        if (!fromAddresses.length) throw new Error('No valid sender address found');
        const ccRecipients = normalizeAddressList(args.cc);
        if (abusePolicy && typeof abusePolicy.checkOutbound === 'function') {
            for (const recipient of recipients.concat(ccRecipients)) {
                const decision = abusePolicy.checkOutbound(fromAddresses[0], recipient);
                if (!decision.allowed) throw new Error(decision.reason || 'Outbound message blocked by server policy');
            }
        }
        const allRecipients = recipients.concat(ccRecipients);
        if (deliverability && typeof deliverability.preflight === 'function') {
            const decision = deliverability.preflight(fromAddresses[0], allRecipients);
            if (!decision.allowed) {
                const error = new Error(decision.reason || 'Outbound message paused by deliverability policy');
                error.code = decision.code || 'DELIVERABILITY_BLOCKED';
                error.retryAfterMs = Number(decision.retryAfterMs || 0);
                error.permanent = decision.permanent === true;
                error.deliverability = decision;
                throw error;
            }
        }

        const doc = {
            guid: makeGuid('sent'),
            messageId: '',
            folder: 'sending',
            status: 'sending',
            read: true,
            from: args.from,
            to: recipients.join(', '),
            cc: Array.isArray(args.cc) ? normalizeAddressList(args.cc).join(', ') : (args.cc || ''),
            subject: String(args.subject || ''),
            text: args.text || '',
            html: args.html || '',
            replyTo: args.replyTo || '',
            inReplyTo: args.inReplyTo || '',
            date: new Date().toISOString(),
        };
        await store.saveMessage(doc);

        try {
            const reply = await deliver({
                from: doc.from,
                to: doc.to,
                cc: doc.cc || undefined,
                subject: doc.subject,
                text: doc.text || undefined,
                html: doc.html || undefined,
                replyTo: doc.replyTo || undefined,
                inReplyTo: doc.inReplyTo || undefined,
            });
            doc.folder = 'send';
            doc.status = 'sent';
            doc.transportReply = typeof reply === 'string' ? reply : '';
            await store.saveMessage(doc);
            if (deliverability && typeof deliverability.recordSuccess === 'function') deliverability.recordSuccess(allRecipients);
            await store.audit(auditAction || 'email_send', { guid: doc.guid, from: doc.from, to: doc.to, subject: doc.subject, success: true });
            return { sent: true, guid: doc.guid, from: doc.from, to: doc.to, subject: doc.subject, date: doc.date };
        } catch (error) {
            doc.folder = 'send';
            doc.status = 'failed';
            doc.error = error?.message || String(error);
            await store.saveMessage(doc);
            if (deliverability && typeof deliverability.recordFailure === 'function') deliverability.recordFailure(allRecipients, error);
            await store.audit(auditAction || 'email_send', { guid: doc.guid, from: doc.from, to: doc.to, subject: doc.subject, success: false, error: doc.error });
            throw error;
        }
    }

    function requireAdmin(context) {
        if (!context || context.isAdmin !== true) throw new Error('Admin permission is required for manual deletion');
    }

    const service = {
        store,

        isVipAddress,
        isVipMessage,
        safeMessage,

        async ingestIncoming(message) {
            if (!message) return null;
            const guid = String(message.guid || makeGuid('in'));
            const existing = await store.getMessage(guid);
            if (existing) return safeMessage(existing, false);
            const attachments = await store.saveAttachments(guid, message.attachments);
            const doc = {
                guid,
                messageId: message.messageId || '',
                folder: 'inbox',
                status: 'received',
                read: !!message.read,
                from: message.from || '',
                to: message.to || '',
                cc: message.cc || '',
                subject: message.subject || '',
                text: message.text || '',
                html: message.html || '',
                replyTo: message.replyTo || '',
                inReplyTo: message.inReplyTo || '',
                date: toIsoDate(message.date),
                attachments,
            };
            const saved = await store.saveMessage(doc);
            if (deliverability && typeof deliverability.ingestFeedback === 'function') {
                try { deliverability.ingestFeedback(message); } catch (error) { logger('Deliverability feedback detection failed: ' + (error?.message || error)); }
            }
            if (saved.cleanup?.deleted?.length) {
                await store.audit('automatic_cleanup', {
                    reason: 'message-count-exceeded',
                    limit: store.maxMessages,
                    deletedCount: saved.cleanup.deleted.length,
                    deleted: saved.cleanup.deleted,
                    protectedCount: saved.cleanup.protectedCount,
                });
            }
            return safeMessage(saved.message, false);
        },

        async search(args, context) {
            args = args || {};
            context = context || {};
            const startedAt = Date.now();
            const limit = Math.max(1, Math.min(Number(args.limit || 25), Number(context.maxLimit || 1000)));
            let matches = await searchRaw(args, context);
            const blockedVip = context.allowVip ? [] : matches.filter((doc) => isVipMessage(doc));
            if (!context.allowVip) matches = matches.filter((doc) => !isVipMessage(doc));
            const offset = Math.max(0, Number(args.offset || 0));
            const list = matches.slice(offset, offset + limit).map((doc) => safeMessage(doc, !!args.includeBody));
            return {
                count: list.length,
                totalMatches: matches.length,
                blockedVipCount: blockedVip.length,
                scannedCount: store.messages.size,
                durationMs: Date.now() - startedAt,
                messages: list,
            };
        },

        async read(guid, context) {
            context = context || {};
            const doc = await store.getMessage(guid);
            if (!doc) throw new Error('Email not found');
            if (context.domain && !messageBelongsToDomain(doc, context.domain)) {
                const error = new Error('Email not found');
                error.code = 'DOMAIN_SCOPE';
                throw error;
            }
            if (isVipMessage(doc) && !context.allowVip) {
                const error = new Error('VIP email access is required');
                error.code = 'VIP_REQUIRED';
                throw error;
            }
            return { message: safeMessage(doc, true) };
        },

        async readMany(guids, context) {
            context = context || {};
            const unique = Array.from(new Set((guids || []).map(String)));
            const messages = [];
            const notFound = [];
            const blockedVip = [];
            const outsideDomain = [];
            for (const guid of unique) {
                const doc = await store.getMessage(guid);
                if (!doc) {
                    notFound.push(guid);
                    continue;
                }
                if (context.domain && !messageBelongsToDomain(doc, context.domain)) {
                    outsideDomain.push(guid);
                    continue;
                }
                if (isVipMessage(doc) && !context.allowVip) {
                    blockedVip.push(guid);
                    continue;
                }
                messages.push(safeMessage(doc, true));
            }
            return { count: messages.length, messages, notFound, blockedVip, outsideDomain };
        },

        async mailboxStatuses(addresses, context) {
            context = context || {};
            const normalized = Array.from(new Set(normalizeAddressList(addresses))).slice(0, Math.max(1, Math.min(Number(context.maxAddresses || 100), 100)));
            const wanted = new Set(normalized);
            const map = new Map(normalized.map((email) => [email, { email, count: 0, protected: false, latest: null }]));
            for (const doc of store.messageValues()) {
                const recipients = normalizeAddressList([doc.to, doc.cc]).filter((email) => wanted.has(email));
                if (!recipients.length) continue;
                const protectedMessage = isVipMessage(doc) && !context.allowVip;
                for (const email of recipients) {
                    const item = map.get(email);
                    if (!item) continue;
                    if (protectedMessage) {
                        item.protected = true;
                        continue;
                    }
                    item.count += 1;
                    if (!item.latest || dateValue(doc.date) > dateValue(item.latest.date)) {
                        item.latest = safeMessage(doc, false);
                    }
                }
            }
            return { items: normalized.map((email) => map.get(email)) };
        },

        async readAttachment(guid, attachmentId, context) {
            const message = (await service.read(guid, context)).message;
            const meta = (message.attachments || []).find((item) => String(item.id) === String(attachmentId));
            if (!meta) throw new Error('Attachment not found');
            const content = await store.getAttachment(guid, meta.id);
            if (!content) throw new Error('Attachment not found');
            return { meta, content };
        },

        async exportEml(guid, context) {
            const message = (await service.read(guid, context)).message;
            const content = await buildEml(message, (attachmentId) => store.getAttachment(guid, attachmentId));
            return { message, content };
        },

        async send(args) {
            return sendOne(args, 'email_send');
        },

        async sendBulk(args) {
            const items = Array.isArray(args.messages) ? args.messages : [];
            const concurrency = Math.max(1, Math.min(Number(args.concurrency || 3), 10));
            const results = await runWithConcurrency(items, concurrency, (message) => sendOne(message, 'email_send_bulk_item'));
            const sent = results.filter((r) => r.ok).length;
            const failed = results.length - sent;
            await store.audit('email_send_bulk', { requested: items.length, sent, failed, concurrency });
            return { requested: items.length, sent, failed, results };
        },

        async reply(args, context) {
            const original = (await service.read(args.guid, context)).message;
            const originalSenders = normalizeAddressList(original.from);
            if (!originalSenders.length) throw new Error('Original email has no valid sender address');
            let subject = String(original.subject || '').trim();
            if (!/^re\s*:/i.test(subject)) subject = 'Re: ' + subject;
            return sendOne({
                from: args.from,
                to: originalSenders,
                subject,
                text: args.text || '',
                html: args.html || '',
                inReplyTo: original.messageId || '',
            }, 'email_reply');
        },

        async forward(args, context) {
            const original = (await service.read(args.guid, context)).message;
            let subject = String(original.subject || '').trim();
            if (!/^fwd?\s*:/i.test(subject)) subject = 'Fwd: ' + subject;
            const text = [String(args.text || '').trim(), '', '---------- Forwarded message ----------', 'From: ' + original.from, 'To: ' + original.to, 'Date: ' + original.date, 'Subject: ' + original.subject, '', original.text || ''].join('\n');
            const html = String(args.html || '').trim() + '<hr><p><strong>Forwarded message</strong></p><p><strong>From:</strong> ' + String(original.from || '') + '<br><strong>To:</strong> ' + String(original.to || '') + '<br><strong>Date:</strong> ' + String(original.date || '') + '<br><strong>Subject:</strong> ' + String(original.subject || '') + '</p>' + (original.html || '');
            return sendOne({
                from: args.from,
                to: args.to,
                subject,
                text,
                html,
            }, 'email_forward');
        },

        async update(guid, patch, context) {
            context = context || {};
            const doc = await store.getMessage(guid);
            if (!doc) return null;
            if (context.domain && !messageBelongsToDomain(doc, context.domain)) return null;
            if (isVipMessage(doc) && !context.allowVip) throw new Error('VIP email access is required');
            const allowed = {};
            for (const key of ['subject', 'text', 'html', 'folder', 'read', 'status', 'favorite']) {
                if (patch && patch[key] !== undefined) allowed[key] = patch[key];
            }
            const updated = await store.updateMessage(guid, allowed);
            await store.audit('email_update', { guid: String(guid), fields: Object.keys(allowed) });
            return updated ? safeMessage(updated, true) : null;
        },

        async setRead(guids, read, context) {
            context = context || {};
            const unique = Array.from(new Set((guids || []).map(String)));
            const updated = [];
            const notFound = [];
            const blockedVip = [];
            const outsideDomain = [];
            for (const guid of unique) {
                const doc = await store.getMessage(guid);
                if (!doc) {
                    notFound.push(guid);
                    continue;
                }
                if (context.domain && !messageBelongsToDomain(doc, context.domain)) {
                    outsideDomain.push(guid);
                    continue;
                }
                if (isVipMessage(doc) && !context.allowVip) {
                    blockedVip.push(guid);
                    continue;
                }
                await store.updateMessage(guid, { read: !!read });
                updated.push(guid);
            }
            await store.audit('email_set_read', { read: !!read, updated, notFound, blockedVip, outsideDomain });
            return { read: !!read, updatedCount: updated.length, updated, notFound, blockedVip, outsideDomain };
        },

        async delete(guid, context) {
            requireAdmin(context);
            const doc = await store.getMessage(guid);
            if (!doc || (context.domain && !messageBelongsToDomain(doc, context.domain))) return { deleted: false, guid: String(guid), notFound: true };
            const result = await store.deleteMessage(guid);
            await store.audit('email_delete', { guid: String(guid), deleted: !!result.deleted, admin: true });
            return { deleted: !!result.deleted, guid: String(guid), notFound: !!result.notFound };
        },

        async deleteMany(guids, context) {
            requireAdmin(context);
            const unique = Array.from(new Set((guids || []).map(String)));
            let selected = unique;
            const outsideDomain = [];
            if (context.domain) {
                selected = [];
                for (const guid of unique) {
                    const doc = await store.getMessage(guid);
                    if (doc && messageBelongsToDomain(doc, context.domain)) selected.push(guid);
                    else if (doc) outsideDomain.push(guid);
                }
            }
            const result = await store.deleteMessages(selected);
            await store.audit('email_delete_bulk', { requested: unique.length, deleted: result.deleted, notFound: result.notFound, outsideDomain, admin: true });
            return { requested: unique.length, deletedCount: result.deleted.length, deleted: result.deleted, notFound: result.notFound, outsideDomain };
        },

        async deleteMatching(args, context) {
            requireAdmin(context);
            args = args || {};
            const hasFilter = ['query', 'search', 'from', 'to', 'toExact', 'subject', 'text', 'html', 'folder', 'status', 'after', 'before'].some((key) => args[key] !== undefined && args[key] !== '') || args.read !== undefined || args.favorite !== undefined || args.hasAttachments !== undefined;
            if (!hasFilter) throw new Error('At least one search filter is required for bulk delete');
            const maxDelete = Math.max(1, Math.min(Number(args.maxDelete || 100), 5000));
            const matches = await searchRaw(args, context);
            const selected = matches.slice(0, maxDelete);
            if (args.confirm !== true) {
                return {
                    preview: true,
                    totalMatches: matches.length,
                    candidateCount: selected.length,
                    candidates: selected.map((doc) => safeMessage(doc, false)),
                    message: 'Call again with confirm=true to delete these matching messages.',
                };
            }
            const guids = selected.map((doc) => String(doc.guid));
            const result = await store.deleteMessages(guids);
            await store.audit('email_delete_matching', { filters: args, totalMatches: matches.length, maxDelete, deleted: result.deleted, admin: true });
            return { preview: false, totalMatches: matches.length, deletedCount: result.deleted.length, deleted: result.deleted, capped: matches.length > maxDelete };
        },

        async setVip(entry) {
            return store.setVip(entry);
        },

        async removeVip(email) {
            return store.removeVip(email);
        },

        listVip() {
            return store.listVip();
        },

        listAdminFolders() {
            return store.listAdminFolders();
        },

        async addAdminFolder(name) {
            return store.addAdminFolder(name);
        },

        async trackMailboxAccess(name, ip) {
            return store.trackMailboxAccess(name, ip);
        },

        async stats(context) {
            context = context || {};
            const folders = {};
            let total = 0;
            let vipCount = 0;
            let read = 0;
            let unread = 0;
            let favorite = 0;
            let attachments = 0;
            let failed = 0;
            for (const doc of store.messageValues()) {
                if (context.domain && !messageBelongsToDomain(doc, context.domain)) continue;
                const vip = isVipMessage(doc);
                if (vip) vipCount += 1;
                if (vip && !context.allowVip) continue;
                total += 1;
                folders[doc.folder || 'unknown'] = (folders[doc.folder || 'unknown'] || 0) + 1;
                if (doc.read) read += 1;
                else unread += 1;
                if (doc.favorite) favorite += 1;
                if (Array.isArray(doc.attachments) && doc.attachments.length) attachments += 1;
                if (doc.status === 'failed') failed += 1;
            }
            return {
                total,
                storedTotal: store.messages.size,
                vipCount,
                read,
                unread,
                favorite,
                attachments,
                failed,
                folders,
                maxMessages: store.maxMessages,
                storage: 'json-files-only',
                dataDir: store.baseDir,
            };
        },
    };

    return service;
}

module.exports = {
    createEmailService,
    extractAddresses,
    normalizeAddressList,
    normalizeEmail,
    safeMessage,
    matchesSearch,
};
