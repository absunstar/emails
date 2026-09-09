'use strict';

const { normalizeAddressList } = require('./core/email-service');
const { normalizeHostname } = require('./core/domain');
const { analyzeEmailHtml } = require('./core/message-tools');

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function runner() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = { ok: true, value: await worker(items[index], index) };
            } catch (error) {
                results[index] = { ok: false, error: error?.message || String(error) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, () => runner()));
    return results;
}

function createEmailMcpService(options) {
    options = options || {};
    const emailService = options.emailService;
    const abusePolicy = options.abusePolicy || null;
    const scheduler = options.scheduler || null;
    const deliverability = options.deliverability || null;
    const operationsManager = options.operationsManager || null;
    if (!emailService) throw new Error('Shared email service is required');

    function requestedDomain(args) {
        const domain = normalizeHostname(args && args.domain);
        return domain || '';
    }

    function readContext(args) {
        const domain = requestedDomain(args);
        return {
            isAdmin: true,
            allowVip: true,
            ...(domain ? { domain } : {}),
            source: 'mcp-manager',
            maxLimit: 5000,
        };
    }

    function adminContext(args) {
        return readContext(args);
    }

    function enforceOutboundRate(scope, mode) {
        if (!abusePolicy || typeof abusePolicy.outboundHit !== 'function') return;
        const key = 'mcp:SOCIALBROWERMANAGER';
        const hit = abusePolicy.outboundHit(key, mode || 'mcp');
        if (!hit.allowed) {
            const error = new Error('MCP outgoing email rate limit reached. Try again later.');
            error.retryAfterMs = Number(hit.retryAfterMs || 0);
            throw error;
        }
    }

    function enforceAdminRate(scope, expensive) {
        if (!abusePolicy || typeof abusePolicy.httpHit !== 'function') return;
        const key = 'mcp:' + String(scope?.ip || scope?.client || 'SOCIALBROWERMANAGER');
        const hit = abusePolicy.httpHit(expensive ? 'expensive' : 'admin', key);
        if (!hit.allowed) throw new Error('MCP admin rate limit reached. Try again later.');
    }

    function policyRequired() {
        if (!abusePolicy) throw new Error('Abuse policy service is not available');
        return abusePolicy;
    }

    function schedulerRequired() {
        if (!scheduler) throw new Error('Email scheduler service is not available');
        return scheduler;
    }

    function deliverabilityRequired() {
        if (!deliverability) throw new Error('Email deliverability service is not available');
        return deliverability;
    }

    function operationsRequired() {
        if (!operationsManager) throw new Error('Email backup and storage manager is not available');
        return operationsManager;
    }

    function policyListName(name) {
        const policy = policyRequired();
        const value = String(name || '').trim();
        const config = policy.getConfig();
        if (!value || !Object.prototype.hasOwnProperty.call(config.lists || {}, value)) {
            throw new Error('Unknown policy list: ' + value);
        }
        return value;
    }

    function policyLimitPath(group, key) {
        const policy = policyRequired();
        const config = policy.getConfig();
        const g = String(group || '').trim();
        const k = String(key || '').trim();
        if (!config.limits || !config.limits[g] || !Object.prototype.hasOwnProperty.call(config.limits[g], k)) {
            throw new Error('Unknown policy limit: ' + g + '.' + k);
        }
        return { group: g, key: k };
    }

    function extractRemoteAssets(html) {
        const source = String(html || '');
        const images = [];
        const links = [];
        const imageRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
        const linkRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
        let match;
        while ((match = imageRe.exec(source))) {
            const url = String(match[1] || match[2] || match[3] || '').trim();
            if (/^https?:\/\//i.test(url) && !images.includes(url)) images.push(url);
            if (images.length >= 200) break;
        }
        while ((match = linkRe.exec(source))) {
            const url = String(match[1] || match[2] || match[3] || '').trim();
            if (/^https?:\/\//i.test(url) && !links.includes(url)) links.push(url);
            if (links.length >= 500) break;
        }
        return { images, links };
    }

    return {
        store: emailService.store,

        async capabilities(scope) {
            enforceAdminRate(scope, false);
            const policy = abusePolicy ? abusePolicy.getConfig() : null;
            return {
                manager: true,
                scope: 'global-admin',
                storage: 'json-files-only',
                maxMessages: emailService.store.maxMessages,
                customFolders: emailService.listAdminFolders(),
                vipCount: emailService.listVip().length,
                policyEnabled: !!policy?.enabled,
                capabilities: [
                    'global-search', 'advanced-filters', 'pagination', 'sorting', 'read', 'read-many', 'favorites', 'folders', 'bulk-update',
                    'send', 'bulk-send', 'reply', 'forward', 'attachments', 'eml-export', 'remote-image-analysis', 'tracking-pixel-analysis',
                    'vip-management', 'delete', 'bulk-delete', 'delete-matching', 'mailbox-statuses', 'statistics',
                    'security-policy-read', 'security-policy-update', 'security-policy-rules', 'security-policy-limits', 'security-policy-test', 'security-activity',
                    'scheduled-send', 'scheduled-bulk-send', 'schedule-list', 'schedule-update', 'schedule-cancel', 'schedule-send-now', 'schedule-retry',
                    'deliverability-status', 'deliverability-preflight', 'deliverability-config', 'per-domain-throttling', 'provider-throttling', 'warmup-ramp',
                    'bounce-suppression', 'unsubscribe-suppression', 'complaint-suppression', 'delivery-circuit-breaker',
                    'automatic-backup', 'backup-validation', 'disaster-recovery-preview', 'disaster-recovery-restore', 'disk-quota', 'message-limit-control', 'retention-cleanup', 'emergency-low-space-mode', 'operational-alerts', 'storage-history',
                ],
            };
        },

        async search(args, scope) {
            enforceAdminRate(scope, true);
            args = args || {};
            const requestedLimit = Math.max(1, Math.min(Number(args.limit || 50), 500));
            const result = await emailService.search(Object.assign({}, args, {
                includeBody: !!args.includeBody,
                limit: requestedLimit,
                offset: Math.max(0, Number(args.offset || 0)),
            }), readContext(args));
            return Object.assign({ domain: requestedDomain(args) || null }, result);
        },

        async read(guid, scope) {
            enforceAdminRate(scope, false);
            return emailService.read(guid, adminContext());
        },

        async readMany(guids, scope) {
            enforceAdminRate(scope, false);
            return emailService.readMany(guids, adminContext());
        },

        async mailboxStatuses(args, scope) {
            enforceAdminRate(scope, true);
            return emailService.mailboxStatuses(args.addresses || [], { allowVip: true, maxAddresses: 100 });
        },

        async stats(args, scope) {
            enforceAdminRate(scope, true);
            const result = await emailService.stats(readContext(args || {}));
            return Object.assign({ domain: requestedDomain(args || {}) || null }, result);
        },

        async send(args, scope) {
            enforceOutboundRate(scope, 'mcp');
            return emailService.send(args);
        },

        async sendBulk(args, scope) {
            const items = Array.isArray(args.messages) ? args.messages : [];
            const configuredMax = Number(abusePolicy?.getConfig?.()?.limits?.outbound?.bulkMaxMessages || 100);
            if (!items.length) throw new Error('messages are required');
            if (items.length > configuredMax) throw new Error('Bulk send is limited to ' + configuredMax + ' messages per request');
            const concurrency = Math.max(1, Math.min(Number(args.concurrency || 3), 10));
            const results = await runWithConcurrency(items, concurrency, async (message) => {
                enforceOutboundRate(scope, 'mcp');
                return emailService.send(message);
            });
            const sent = results.filter((item) => item.ok).length;
            const failed = results.length - sent;
            await emailService.store.audit('mcp_email_send_bulk', { requested: items.length, sent, failed, concurrency });
            return { requested: items.length, sent, failed, results };
        },

        async reply(args, scope) {
            enforceOutboundRate(scope, 'mcp');
            return emailService.reply(args, adminContext());
        },

        async forward(args, scope) {
            enforceOutboundRate(scope, 'mcp');
            return emailService.forward(args, adminContext());
        },

        async schedule(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().schedule(args, scope);
        },

        async scheduleBulk(args, scope) {
            enforceAdminRate(scope, true);
            return schedulerRequired().scheduleBulk(args, scope);
        },

        async schedulesList(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().list(args || {});
        },

        async scheduleGet(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().get(args.id, args.includeBody !== false);
        },

        async scheduleUpdate(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().update(args.id, args);
        },

        async scheduleCancel(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().cancel(args.id);
        },

        async scheduleSendNow(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().sendNow(args.id);
        },

        async scheduleRetry(args, scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().retry(args.id, args || {});
        },

        async schedulerStatus(scope) {
            enforceAdminRate(scope, false);
            return schedulerRequired().status();
        },

        async deliverabilityStatus(scope) {
            enforceAdminRate(scope, false);
            return deliverabilityRequired().status();
        },

        async deliverabilityPreflight(args, scope) {
            enforceAdminRate(scope, false);
            return deliverabilityRequired().preflightReport(args.from || '', args.to || args.recipients || []);
        },

        async deliverabilityConfigGet(scope) {
            enforceAdminRate(scope, false);
            return { config: deliverabilityRequired().getConfig() };
        },

        async deliverabilityConfigUpdate(args, scope) {
            enforceAdminRate(scope, true);
            const result = deliverabilityRequired().updateConfig(args.config || {});
            await emailService.store.audit('mcp_deliverability_config_update', { updatedAt: result.updatedAt });
            return { updated: true, config: result };
        },

        async suppressionsList(args, scope) {
            enforceAdminRate(scope, true);
            return deliverabilityRequired().listSuppressions(args || {});
        },

        async suppressionAdd(args, scope) {
            enforceAdminRate(scope, false);
            const item = deliverabilityRequired().addSuppression(args.email, args.type, args.reason || '', 'mcp-manager');
            await emailService.store.audit('mcp_email_suppression_add', { email: item.email, type: item.type });
            return { added: true, item };
        },

        async suppressionRemove(args, scope) {
            enforceAdminRate(scope, false);
            const result = deliverabilityRequired().removeSuppression(args.email);
            await emailService.store.audit('mcp_email_suppression_remove', { email: result.email, removed: result.removed });
            return result;
        },

        async deliveryFeedbackReport(args, scope) {
            enforceAdminRate(scope, false);
            const result = deliverabilityRequired().reportFeedback(args || {});
            await emailService.store.audit('mcp_delivery_feedback', { email: result.email, type: result.type, suppressed: result.suppressed });
            return result;
        },

        async operationsStatus(scope) {
            enforceAdminRate(scope, false);
            return operationsRequired().status();
        },

        async backupCreate(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().createBackup(args || {});
        },

        async backupsList(scope) {
            enforceAdminRate(scope, false);
            return operationsRequired().listBackups();
        },

        async backupValidate(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().validateBackup(args.id);
        },

        async restorePreview(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().restorePreview(args.id, args || {});
        },

        async restoreExecute(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().restore(args.id, args || {});
        },

        async storageReport(scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().storageReport();
        },

        async storageConfigGet(scope) {
            enforceAdminRate(scope, false);
            return { config: operationsRequired().getConfig() };
        },

        async storageConfigUpdate(args, scope) {
            enforceAdminRate(scope, true);
            const config = operationsRequired().updateConfig(args.config || {});
            await emailService.store.audit('mcp_storage_config_update', { updatedAt: new Date().toISOString() });
            return { updated: true, config };
        },

        async storageMessageLimitGet(scope) {
            enforceAdminRate(scope, false);
            return { limit: emailService.store.getMessageLimit ? emailService.store.getMessageLimit() : { maxMessages: emailService.store.maxMessages, messageCount: emailService.store.messages?.size || 0 } };
        },

        async storageMessageLimitSet(args, scope) {
            enforceAdminRate(scope, true);
            const next = Math.floor(Number(args.maxMessages));
            if (!Number.isFinite(next) || next < 1 || next > 1000000) throw new Error('maxMessages must be between 1 and 1000000');
            const currentCount = Number(emailService.store.messages?.size || 0);
            if (next < currentCount && args.confirm !== true) {
                throw new Error('The requested limit is below the current stored message count (' + currentCount + '). Set confirm=true to allow this change. Oldest non-protected messages may be removed when cleanup runs.');
            }
            const result = await emailService.store.setMessageLimit(next, { source: 'mcp-manager', managed: true, cleanupNow: args.cleanupNow === true });
            await emailService.store.audit('mcp_storage_message_limit_set', { previousMaxMessages: result.previousMaxMessages, maxMessages: result.maxMessages, cleanupNow: args.cleanupNow === true, deleted: result.cleanup?.deleted?.length || 0 });
            return { updated: true, limit: result };
        },

        async cleanupPreview(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().cleanupPreview(args || {});
        },

        async cleanupExecute(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().cleanupExecute(args || {});
        },

        async maintenanceRun(args, scope) {
            enforceAdminRate(scope, true);
            return operationsRequired().runMaintenance(args || {});
        },

        async operationsAlerts(args, scope) {
            enforceAdminRate(scope, false);
            return operationsRequired().alerts(args || {});
        },

        async operationsHistory(args, scope) {
            enforceAdminRate(scope, false);
            return { history: operationsRequired().historyList(args?.limit || 144) };
        },

        async update(args, scope) {
            enforceAdminRate(scope, false);
            return emailService.update(args.guid, args.patch || {}, adminContext());
        },

        async updateBulk(args, scope) {
            enforceAdminRate(scope, true);
            const guids = Array.from(new Set((args.guids || []).map(String)));
            const updated = [];
            const notFound = [];
            for (const guid of guids) {
                const doc = await emailService.update(guid, args.patch || {}, adminContext());
                if (doc) updated.push(guid);
                else notFound.push(guid);
            }
            return { updatedCount: updated.length, updated, notFound };
        },

        async setRead(guids, read, scope) {
            enforceAdminRate(scope, false);
            return emailService.setRead(guids, read, adminContext());
        },

        async delete(guid, scope) {
            enforceAdminRate(scope, false);
            return emailService.delete(guid, adminContext());
        },

        async deleteMany(guids, scope) {
            enforceAdminRate(scope, true);
            return emailService.deleteMany(guids, adminContext());
        },

        async deleteMatching(args, scope) {
            enforceAdminRate(scope, true);
            return emailService.deleteMatching(args || {}, adminContext(args));
        },

        async attachmentRead(args, scope) {
            enforceAdminRate(scope, true);
            const result = await emailService.readAttachment(args.guid, args.attachmentId, adminContext());
            const maxBytes = Math.max(1, Math.min(Number(args.maxBytes || 20 * 1024 * 1024), 25 * 1024 * 1024));
            if (result.content.length > maxBytes) throw new Error('Attachment exceeds maxBytes. Size: ' + result.content.length);
            return {
                guid: args.guid,
                attachment: result.meta,
                size: result.content.length,
                encoding: 'base64',
                contentBase64: result.content.toString('base64'),
            };
        },

        async emlExport(args, scope) {
            enforceAdminRate(scope, true);
            const result = await emailService.exportEml(args.guid, adminContext());
            const maxBytes = Math.max(1, Math.min(Number(args.maxBytes || 25 * 1024 * 1024), 40 * 1024 * 1024));
            if (result.content.length > maxBytes) throw new Error('EML exceeds maxBytes. Size: ' + result.content.length);
            return {
                guid: args.guid,
                filename: String(result.message.subject || 'message').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) + '.eml',
                size: result.content.length,
                encoding: 'base64',
                contentBase64: result.content.toString('base64'),
            };
        },

        async analyze(guid, scope) {
            enforceAdminRate(scope, true);
            const message = (await emailService.read(guid, adminContext())).message;
            const summary = analyzeEmailHtml(message.html || '');
            const assets = extractRemoteAssets(message.html || '');
            return {
                guid,
                subject: message.subject,
                remoteImages: summary.remoteImages,
                trackingPixels: summary.trackingPixels,
                externalLinks: summary.externalLinks,
                imageUrls: assets.images,
                linkUrls: assets.links,
                attachments: message.attachments || [],
            };
        },

        async vipList(scope) {
            enforceAdminRate(scope, false);
            return { count: emailService.listVip().length, entries: emailService.listVip() };
        },

        async vipSet(args, scope) {
            enforceAdminRate(scope, false);
            if (args.vip === false) return { vip: false, result: await emailService.removeVip(args.email) };
            return { vip: true, result: await emailService.setVip({ email: args.email, vip: true, source: 'mcp-manager' }) };
        },

        async foldersList(scope) {
            enforceAdminRate(scope, false);
            return { folders: emailService.listAdminFolders() };
        },

        async folderCreate(name, scope) {
            enforceAdminRate(scope, false);
            return emailService.addAdminFolder(name);
        },

        async policyGet(scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            return { config: policy.getConfig(), defaults: policy.getDefaults(), status: policy.status(), path: policy.filePath };
        },

        async policyExport(scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            return { format: 'social-browser-email-policy-v1', exportedAt: new Date().toISOString(), config: policy.getConfig() };
        },

        async policyImport(config, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const result = policy.update(config || {});
            await emailService.store.audit('mcp_policy_import', { updatedAt: result.updatedAt });
            return { imported: true, config: result, status: policy.status() };
        },

        async policyUpdate(config, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const result = policy.update(config || {});
            await emailService.store.audit('mcp_policy_update', { updatedAt: result.updatedAt });
            return { config: result, status: policy.status() };
        },

        async policyReset(scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const result = policy.reset();
            await emailService.store.audit('mcp_policy_reset', { updatedAt: result.updatedAt });
            return { config: result, status: policy.status() };
        },

        async policyStatus(scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            return policy.status();
        },

        async policyTest(args, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const type = String(args.type || '').toLowerCase();
            const value = String(args.value || '');
            let result;
            if (type === 'ip') result = policy.checkIp(value);
            else if (type === 'to') result = policy.checkAddress('to', value);
            else if (type === 'subject') result = policy.checkSubject(value);
            else if (type === 'ignore') result = policy.shouldIgnore(args.from || value, args.subject || '');
            else if (type === 'outbound') result = policy.checkOutbound(args.from || '', args.to || value);
            else result = policy.checkAddress('from', value);
            return { type: type || 'from', value, result };
        },

        async policyRuleAdd(args, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const name = policyListName(args.list);
            const config = policy.getConfig();
            const list = config.lists[name];
            const value = String(args.value || '').trim();
            if (!value) throw new Error('Rule value is required');
            if (!list.values.some((item) => String(item).toLowerCase() === value.toLowerCase())) list.values.push(value);
            if (args.enabled !== undefined) list.enabled = !!args.enabled;
            const result = policy.update({ lists: { [name]: list } });
            await emailService.store.audit('mcp_policy_rule_add', { list: name, value });
            return { list: name, rule: result.lists[name], status: policy.status() };
        },

        async policyRuleRemove(args, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const name = policyListName(args.list);
            const config = policy.getConfig();
            const value = String(args.value || '').trim();
            const before = config.lists[name].values.length;
            config.lists[name].values = config.lists[name].values.filter((item) => String(item).toLowerCase() !== value.toLowerCase());
            const result = policy.update({ lists: { [name]: config.lists[name] } });
            await emailService.store.audit('mcp_policy_rule_remove', { list: name, value });
            return { list: name, removed: before !== result.lists[name].values.length, rule: result.lists[name], status: policy.status() };
        },

        async policyListSetEnabled(args, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const name = policyListName(args.list);
            const config = policy.getConfig();
            config.lists[name].enabled = !!args.enabled;
            const result = policy.update({ lists: { [name]: config.lists[name] } });
            await emailService.store.audit('mcp_policy_list_toggle', { list: name, enabled: !!args.enabled });
            return { list: name, rule: result.lists[name], status: policy.status() };
        },

        async policyLimitSet(args, scope) {
            enforceAdminRate(scope, true);
            const policy = policyRequired();
            const target = policyLimitPath(args.group, args.key);
            const config = policy.getConfig();
            const current = config.limits[target.group][target.key];
            let value = args.value;
            if (typeof current === 'boolean') value = !!value;
            else {
                value = Number(value);
                if (!Number.isFinite(value)) throw new Error('Limit value must be numeric');
            }
            const patch = { limits: { [target.group]: { [target.key]: value } } };
            const result = policy.update(patch);
            await emailService.store.audit('mcp_policy_limit_set', { group: target.group, key: target.key, value });
            return { group: target.group, key: target.key, value: result.limits[target.group][target.key], status: policy.status() };
        },

        normalizeAddressList,
    };
}

module.exports = {
    createEmailMcpService,
};
