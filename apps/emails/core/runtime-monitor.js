'use strict';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function iso() {
    return new Date().toISOString();
}

class EmailRuntimeMonitor {
    constructor(options) {
        options = options || {};
        this.startedAt = iso();
        this.components = {
            site: { status: 'starting', updatedAt: this.startedAt },
            smtp: { status: 'starting', updatedAt: this.startedAt },
            mcp: { status: 'starting', updatedAt: this.startedAt },
            scheduler: { status: 'starting', updatedAt: this.startedAt },
            storage: { status: 'starting', updatedAt: this.startedAt },
        };
        this.counters = {
            smtpAccepted: 0,
            smtpRejected: 0,
            incomingStored: 0,
            outgoingSent: 0,
            outgoingFailed: 0,
            sseConnections: 0,
            sseEvents: 0,
            feedbackEvents: 0,
            unsubscribeEvents: 0,
        };
        this.errors = [];
        this.maxErrors = Math.max(20, Math.min(Number(options.maxErrors || 100), 500));
        this.lastLoopAt = Date.now();
        this.eventLoopLagMs = 0;
        this.timer = setInterval(() => {
            const now = Date.now();
            this.eventLoopLagMs = Math.max(0, now - this.lastLoopAt - 10000);
            this.lastLoopAt = now;
        }, 10000);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    component(name, status, details) {
        const key = String(name || '').trim();
        if (!key) return;
        this.components[key] = Object.assign({}, this.components[key] || {}, details || {}, { status: String(status || 'unknown'), updatedAt: iso() });
    }

    increment(name, amount) {
        const key = String(name || '').trim();
        if (!key) return;
        this.counters[key] = Number(this.counters[key] || 0) + Math.max(1, Number(amount || 1));
    }

    error(component, error, details) {
        const item = {
            date: iso(),
            component: String(component || 'runtime'),
            message: String(error?.message || error || 'Unknown error').slice(0, 2000),
            details: details && typeof details === 'object' ? clone(details) : null,
        };
        this.errors.unshift(item);
        if (this.errors.length > this.maxErrors) this.errors.length = this.maxErrors;
        return item;
    }

    publicSnapshot() {
        const uptimeSeconds = Math.max(0, Math.round(process.uptime()));
        const smtp = this.components.smtp || {};
        const site = this.components.site || {};
        const storage = this.components.storage || {};
        const storageBlocked = ['blocked', 'error'].includes(String(storage.status || '').toLowerCase());
        const storageDegraded = ['warning', 'critical', 'emergency'].includes(String(storage.status || '').toLowerCase());
        const ready = site.status === 'ready' && smtp.status === 'listening' && !storageBlocked;
        const status = ready ? (storageDegraded ? 'degraded' : 'ready') : 'degraded';
        return {
            ok: ready,
            status,
            startedAt: this.startedAt,
            uptimeSeconds,
            components: {
                site: site.status || 'unknown',
                smtp: smtp.status || 'unknown',
                mcp: this.components.mcp?.status || 'unknown',
                scheduler: this.components.scheduler?.status || 'unknown',
                storage: this.components.storage?.status || 'unknown',
            },
            timestamp: iso(),
        };
    }

    async snapshot(options) {
        options = options || {};
        const memory = process.memoryUsage();
        let scheduler = null;
        let deliverability = null;
        let mail = null;
        let protection = null;
        let operations = null;
        try { scheduler = options.scheduler?.status?.() || null; } catch (error) { this.error('scheduler', error); }
        try { deliverability = options.deliverability?.status?.() || null; } catch (error) { this.error('deliverability', error); }
        try { mail = options.service?.stats ? await options.service.stats({ isAdmin: true, allowVip: true }) : null; } catch (error) { this.error('mail-store', error); }
        try { protection = options.policy?.status?.() || null; } catch (error) { this.error('abuse-policy', error); }
        try { operations = options.operationsManager?.status?.() || null; } catch (error) { this.error('storage', error); }
        if (scheduler) this.component('scheduler', scheduler.enabled === false ? 'disabled' : 'running', { total: scheduler.total, counts: scheduler.counts, next: scheduler.next?.sendAtUtc || null });
        if (operations?.storage) this.component('storage', operations.storage.level || 'unknown', { managedBytes: operations.storage.managedBytes, quotaPercent: operations.storage.quotaPercent, backupCount: operations.backups?.count || 0 });
        return {
            public: this.publicSnapshot(),
            process: {
                pid: process.pid,
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                uptimeSeconds: Math.max(0, Math.round(process.uptime())),
                eventLoopLagMs: Math.round(this.eventLoopLagMs),
                memory: {
                    rss: memory.rss,
                    heapTotal: memory.heapTotal,
                    heapUsed: memory.heapUsed,
                    external: memory.external,
                },
            },
            components: clone(this.components),
            counters: clone(this.counters),
            scheduler,
            deliverability,
            mail,
            protection,
            operations,
            recentErrors: clone(this.errors.slice(0, 50)),
            timestamp: iso(),
        };
    }

    close() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

function createEmailRuntimeMonitor(options) {
    return new EmailRuntimeMonitor(options);
}

module.exports = { EmailRuntimeMonitor, createEmailRuntimeMonitor };
