'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function iso() {
    return new Date().toISOString();
}

function safeId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 160);
}

function atomicWriteJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
        fs.renameSync(tmp, filePath);
    } catch (_) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
        fs.renameSync(tmp, filePath);
    }
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return clone(fallback);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return clone(fallback);
    }
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytes = 0;
        do {
            bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytes > 0) hash.update(buffer.subarray(0, bytes));
        } while (bytes > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function walkFiles(root, out) {
    if (!fs.existsSync(root)) return out;
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) out.push(full);
        }
    }
    return out;
}

function directoryStats(root) {
    const result = { bytes: 0, files: 0 };
    for (const filePath of walkFiles(root, [])) {
        try {
            const stat = fs.statSync(filePath);
            result.bytes += stat.size;
            result.files += 1;
        } catch (_) {}
    }
    return result;
}

function removeEmptyParents(filePath, stopDir) {
    let dir = path.dirname(filePath);
    const stop = path.resolve(stopDir);
    while (dir.startsWith(stop) && dir !== stop) {
        try {
            if (fs.readdirSync(dir).length) return;
            fs.rmdirSync(dir);
        } catch (_) { return; }
        dir = path.dirname(dir);
    }
}

function emailDomains(value) {
    const matches = String(value || '').match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|localhost)/gi) || [];
    return Array.from(new Set(matches.map((email) => String(email.split('@').pop() || '').toLowerCase()).filter(Boolean)));
}

function mergeDeep(base, patch) {
    const result = clone(base || {});
    for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) result[key] = mergeDeep(result[key], value);
        else result[key] = clone(value);
    }
    return result;
}

const DEFAULT_CONFIG = {
    enabled: true,
    backup: {
        enabled: true,
        intervalHours: 24,
        keepLast: 14,
        maxAgeDays: 30,
        verifyAfterCreate: true,
    },
    storage: {
        maxBytes: 20 * 1024 * 1024 * 1024,
        warningPercent: 80,
        criticalPercent: 90,
        emergencyPercent: 95,
        hardStopPercent: 98,
        minFreeBytes: 512 * 1024 * 1024,
    },
    retention: {
        messagesDays: 30,
        auditDays: 30,
        trackingDays: 30,
        completedSchedulesDays: 30,
        cancelledSchedulesDays: 7,
    },
    emergency: {
        autoCleanup: true,
        messagesDays: 7,
        auditDays: 7,
        trackingDays: 7,
        completedSchedulesDays: 7,
        cancelledSchedulesDays: 2,
    },
    maintenance: {
        intervalMinutes: 15,
    },
};

class EmailBackupStorageManager {
    constructor(options) {
        options = options || {};
        if (!options.emailService) throw new Error('emailService is required');
        this.emailService = options.emailService;
        this.monitor = options.monitor || null;
        this.scheduler = options.scheduler || null;
        this.rootDir = path.resolve(options.rootDir || path.join(process.cwd(), 'localStorage'));
        this.backupDir = path.resolve(options.backupDir || path.join(this.rootDir, 'email-backups'));
        this.controlDir = path.resolve(options.controlDir || path.join(this.rootDir, 'email-storage'));
        this.configPath = path.join(this.controlDir, 'config.json');
        this.statePath = path.join(this.controlDir, 'state.json');
        this.historyPath = path.join(this.controlDir, 'history.json');
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this.alertWebhook = String(options.alertWebhook || process.env.EMAIL_OPS_ALERT_WEBHOOK || '').trim();
        ensureDir(this.rootDir);
        ensureDir(this.backupDir);
        ensureDir(this.controlDir);
        this.config = mergeDeep(DEFAULT_CONFIG, readJson(this.configPath, {}));
        this.state = mergeDeep({
            startedAt: iso(),
            lastBackupAt: null,
            lastBackupId: null,
            lastBackupError: null,
            lastMaintenanceAt: null,
            lastCleanupAt: null,
            lastRestoreAt: null,
            restartRequired: false,
            writeBlocked: false,
            alerts: [],
            previewTokens: {},
        }, readJson(this.statePath, {}));
        this.history = Array.isArray(readJson(this.historyPath, [])) ? readJson(this.historyPath, []).slice(-576) : [];
        this.timer = null;
        this.running = false;
        this._lastStorageReport = null;
        this._lastStorageReportAt = 0;
        this._persistConfig();
        this._persistState();
    }

    setScheduler(scheduler) {
        this.scheduler = scheduler || null;
        return this;
    }

    _persistConfig() {
        atomicWriteJson(this.configPath, this.config);
    }

    _persistState() {
        this.state.alerts = Array.isArray(this.state.alerts) ? this.state.alerts.slice(0, 200) : [];
        const tokens = this.state.previewTokens && typeof this.state.previewTokens === 'object' ? this.state.previewTokens : {};
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const [token, item] of Object.entries(tokens)) if (Date.parse(item?.expiresAt || 0) < cutoff) delete tokens[token];
        this.state.previewTokens = tokens;
        atomicWriteJson(this.statePath, this.state);
    }

    _persistHistory() {
        this.history = this.history.slice(-576);
        atomicWriteJson(this.historyPath, this.history);
    }

    getConfig() {
        return clone(this.config);
    }

    updateConfig(patch) {
        const next = mergeDeep(this.config, patch || {});
        const clampPercent = (value, fallback) => Math.max(1, Math.min(Number(value || fallback), 100));
        next.backup.intervalHours = Math.max(1, Math.min(Number(next.backup.intervalHours || 24), 24 * 30));
        next.backup.keepLast = Math.max(1, Math.min(Number(next.backup.keepLast || 14), 365));
        next.backup.maxAgeDays = Math.max(1, Math.min(Number(next.backup.maxAgeDays || 30), 3650));
        next.storage.maxBytes = Math.max(100 * 1024 * 1024, Number(next.storage.maxBytes || DEFAULT_CONFIG.storage.maxBytes));
        next.storage.warningPercent = clampPercent(next.storage.warningPercent, 80);
        next.storage.criticalPercent = Math.max(next.storage.warningPercent, clampPercent(next.storage.criticalPercent, 90));
        next.storage.emergencyPercent = Math.max(next.storage.criticalPercent, clampPercent(next.storage.emergencyPercent, 95));
        next.storage.hardStopPercent = Math.max(next.storage.emergencyPercent, clampPercent(next.storage.hardStopPercent, 98));
        next.storage.minFreeBytes = Math.max(64 * 1024 * 1024, Number(next.storage.minFreeBytes || DEFAULT_CONFIG.storage.minFreeBytes));
        for (const key of Object.keys(DEFAULT_CONFIG.retention)) next.retention[key] = Math.max(1, Math.min(Number(next.retention[key] || DEFAULT_CONFIG.retention[key]), 3650));
        for (const key of Object.keys(DEFAULT_CONFIG.emergency).filter((key) => key !== 'autoCleanup')) next.emergency[key] = Math.max(1, Math.min(Number(next.emergency[key] || DEFAULT_CONFIG.emergency[key]), 3650));
        next.maintenance.intervalMinutes = Math.max(5, Math.min(Number(next.maintenance.intervalMinutes || 15), 1440));
        this.config = next;
        this._persistConfig();
        if (this.timer) this.start();
        return this.getConfig();
    }

    _managedSources() {
        const values = [
            'email-files',
            'email-schedules',
            'email-deliverability',
            'email-unsubscribe',
            'email-abuse-policy.json',
            'vip-email-list.json',
            path.join('email-storage', 'config.json'),
        ];
        return values.filter((relative) => fs.existsSync(path.join(this.rootDir, relative)));
    }

    _backupPath(id) {
        return path.join(this.backupDir, safeId(id));
    }

    async _copySource(relative, destinationRoot, manifestFiles) {
        const source = path.join(this.rootDir, relative);
        if (!fs.existsSync(source)) return;
        const stat = fs.statSync(source);
        const destination = path.join(destinationRoot, relative);
        if (stat.isFile()) {
            ensureDir(path.dirname(destination));
            fs.copyFileSync(source, destination);
            const copied = fs.statSync(destination);
            manifestFiles.push({ path: relative.replace(/\\/g, '/'), size: copied.size, mtimeMs: copied.mtimeMs, sha256: sha256File(destination) });
            return;
        }
        for (const filePath of walkFiles(source, [])) {
            const rel = path.relative(this.rootDir, filePath);
            const target = path.join(destinationRoot, rel);
            ensureDir(path.dirname(target));
            fs.copyFileSync(filePath, target);
            const copied = fs.statSync(target);
            manifestFiles.push({ path: rel.replace(/\\/g, '/'), size: copied.size, mtimeMs: copied.mtimeMs, sha256: sha256File(target) });
        }
    }

    async createBackup(args) {
        args = args || {};
        if (this.running) throw new Error('Another backup or restore operation is already running');
        this.running = true;
        const createdAt = iso();
        const id = createdAt.replace(/[:.]/g, '-') + '_' + crypto.randomBytes(4).toString('hex');
        const staging = path.join(this.backupDir, '.staging-' + id);
        const finalDir = this._backupPath(id);
        const dataDir = path.join(staging, 'data');
        ensureDir(dataDir);
        try {
            const files = [];
            const sources = this._managedSources();
            for (const relative of sources) await this._copySource(relative, dataDir, files);
            const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
            const manifest = {
                format: 'social-browser-email-backup-v1',
                id,
                createdAt,
                reason: String(args.reason || 'manual').slice(0, 160),
                label: String(args.label || '').slice(0, 160),
                sourceRoot: this.rootDir,
                sources,
                fileCount: files.length,
                totalBytes,
                files,
            };
            atomicWriteJson(path.join(staging, 'manifest.json'), manifest);
            fs.renameSync(staging, finalDir);
            this.state.lastBackupAt = createdAt;
            this.state.lastBackupId = id;
            this.state.lastBackupError = null;
            this._persistState();
            let validation = null;
            if (this.config.backup.verifyAfterCreate !== false) validation = await this.validateBackup(id);
            if (args.skipPrune !== true) await this.pruneBackups();
            this.monitor?.increment?.('backupsCreated');
            await this.emailService.store.audit('email_backup_created', { id, createdAt, reason: manifest.reason, files: files.length, bytes: totalBytes, valid: validation?.valid !== false });
            return { backup: this._backupSummary(manifest, finalDir), validation };
        } catch (error) {
            this.state.lastBackupError = String(error?.message || error);
            this._persistState();
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
            this._alert('error', 'backup_failed', 'Automatic email backup failed', { error: this.state.lastBackupError });
            throw error;
        } finally {
            this.running = false;
        }
    }

    _backupSummary(manifest, dir) {
        return {
            id: manifest.id,
            createdAt: manifest.createdAt,
            reason: manifest.reason || '',
            label: manifest.label || '',
            fileCount: Number(manifest.fileCount || 0),
            totalBytes: Number(manifest.totalBytes || 0),
            path: dir,
        };
    }

    listBackups() {
        const items = [];
        if (!fs.existsSync(this.backupDir)) return { count: 0, backups: [] };
        for (const entry of fs.readdirSync(this.backupDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const dir = path.join(this.backupDir, entry.name);
            const manifest = readJson(path.join(dir, 'manifest.json'), null);
            if (manifest && manifest.id) items.push(this._backupSummary(manifest, dir));
        }
        items.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
        return { count: items.length, backups: items };
    }

    async validateBackup(id) {
        const dir = this._backupPath(id);
        const manifest = readJson(path.join(dir, 'manifest.json'), null);
        if (!manifest) throw new Error('Backup not found');
        const missing = [];
        const changed = [];
        let checked = 0;
        let bytes = 0;
        for (const item of manifest.files || []) {
            const filePath = path.join(dir, 'data', item.path);
            if (!fs.existsSync(filePath)) { missing.push(item.path); continue; }
            const stat = fs.statSync(filePath);
            bytes += stat.size;
            checked += 1;
            if (stat.size !== Number(item.size || 0) || sha256File(filePath) !== item.sha256) changed.push(item.path);
        }
        const valid = missing.length === 0 && changed.length === 0 && checked === Number(manifest.fileCount || 0);
        return { valid, id: manifest.id, checked, bytes, missing, changed, expectedFiles: Number(manifest.fileCount || 0), expectedBytes: Number(manifest.totalBytes || 0) };
    }

    async restorePreview(id, options) {
        options = options || {};
        const validation = await this.validateBackup(id);
        if (!validation.valid) throw new Error('Backup validation failed. Restore is blocked.');
        const dir = this._backupPath(id);
        const manifest = readJson(path.join(dir, 'manifest.json'), null);
        const current = new Map();
        for (const relative of manifest.sources || []) {
            const source = path.join(this.rootDir, relative);
            if (!fs.existsSync(source)) continue;
            const stat = fs.statSync(source);
            if (stat.isFile()) current.set(relative.replace(/\\/g, '/'), { size: stat.size });
            else for (const filePath of walkFiles(source, [])) current.set(path.relative(this.rootDir, filePath).replace(/\\/g, '/'), { size: fs.statSync(filePath).size });
        }
        const backupPaths = new Set((manifest.files || []).map((item) => item.path));
        let overwriteFiles = 0;
        let createFiles = 0;
        let removeFiles = 0;
        for (const item of manifest.files || []) {
            if (current.has(item.path)) overwriteFiles += 1;
            else createFiles += 1;
        }
        for (const item of current.keys()) if (!backupPaths.has(item)) removeFiles += 1;
        const storage = this.storageReport({ force: true });
        const safetyBackupEstimatedBytes = Number(storage.managedBytes || 0);
        const freeBytes = Number(storage.disk?.freeBytes || 0);
        if (storage.disk && freeBytes < safetyBackupEstimatedBytes + Number(this.config.storage.minFreeBytes || 0)) throw new Error('Not enough free disk space to create the mandatory pre-restore safety backup');
        const token = crypto.randomBytes(18).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        this.state.previewTokens[token] = { type: 'restore', id, expiresAt };
        this._persistState();
        return {
            dryRun: true,
            backup: this._backupSummary(manifest, dir),
            validation,
            changes: { overwriteFiles, createFiles, removeFiles, backupFiles: manifest.fileCount, backupBytes: manifest.totalBytes },
            confirmToken: token,
            expiresAt,
            restartRequiredAfterRestore: true,
            safetyBackupEstimatedBytes,
            diskFreeBytes: storage.disk?.freeBytes || null,
            warning: 'Executing restore replaces managed email data with this snapshot. A safety backup is created first.',
        };
    }

    async restore(id, args) {
        args = args || {};
        if (this.running) throw new Error('Another backup or restore operation is already running');
        const token = String(args.confirmToken || '');
        const preview = this.state.previewTokens[token];
        if (!preview || preview.type !== 'restore' || preview.id !== id || Date.parse(preview.expiresAt || 0) < Date.now()) throw new Error('A fresh restore preview and valid confirmToken are required');
        if (args.confirm !== true) throw new Error('confirm=true is required to execute restore');
        const validation = await this.validateBackup(id);
        if (!validation.valid) throw new Error('Backup validation failed. Restore is blocked.');
        this.running = true;
        try {
            const safety = await this._createBackupWhileLocked({ reason: 'pre-restore-safety', label: 'Automatic safety snapshot before restore ' + id, skipPrune: true });
            const dir = this._backupPath(id);
            const manifest = readJson(path.join(dir, 'manifest.json'), null);
            for (const relative of manifest.sources || []) {
                const target = path.join(this.rootDir, relative);
                try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
            }
            for (const item of manifest.files || []) {
                const source = path.join(dir, 'data', item.path);
                const target = path.join(this.rootDir, item.path);
                ensureDir(path.dirname(target));
                fs.copyFileSync(source, target);
            }
            delete this.state.previewTokens[token];
            this.state.lastRestoreAt = iso();
            this.state.restartRequired = true;
            this._persistState();
            this.monitor?.increment?.('restoresCompleted');
            await this.emailService.store.audit('email_restore_completed', { backupId: id, safetyBackupId: safety.backup.id, restartRequired: true });
            this._alert('warning', 'restore_completed', 'Email data restore completed; service restart required', { backupId: id, safetyBackupId: safety.backup.id });
            return { restored: true, backupId: id, safetyBackup: safety.backup, restartRequired: true, restoredFiles: Number(manifest.fileCount || 0), restoredBytes: Number(manifest.totalBytes || 0) };
        } finally {
            this.running = false;
        }
    }

    async _createBackupWhileLocked(args) {
        const previous = this.running;
        this.running = false;
        try { return await this.createBackup(args); }
        finally { this.running = previous; }
    }

    _diskInfo() {
        try {
            if (typeof fs.statfsSync !== 'function') return null;
            const stat = fs.statfsSync(this.rootDir);
            const blockSize = Number(stat.bsize || 0);
            const totalBytes = Number(stat.blocks || 0) * blockSize;
            const freeBytes = Number(stat.bavail || stat.bfree || 0) * blockSize;
            return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes), usedPercent: totalBytes ? (totalBytes - freeBytes) / totalBytes * 100 : 0 };
        } catch (_) {
            return null;
        }
    }

    storageReport(options) {
        options = options || {};
        if (options.force !== true && this._lastStorageReport && Date.now() - this._lastStorageReportAt < 30000) return clone(this._lastStorageReport);
        const categories = {};
        const categoryPaths = {
            messages: path.join(this.rootDir, 'email-files', 'messages'),
            attachments: path.join(this.rootDir, 'email-files', 'attachments'),
            tracking: path.join(this.rootDir, 'email-files', 'tracking'),
            audit: path.join(this.rootDir, 'email-files', 'audit'),
            schedules: path.join(this.rootDir, 'email-schedules'),
            deliverability: path.join(this.rootDir, 'email-deliverability'),
            unsubscribe: path.join(this.rootDir, 'email-unsubscribe'),
            backups: this.backupDir,
            operations: this.controlDir,
        };
        let managedBytes = 0;
        let managedFiles = 0;
        for (const [name, dir] of Object.entries(categoryPaths)) {
            const stats = directoryStats(dir);
            categories[name] = stats;
            if (name !== 'backups') {
                managedBytes += stats.bytes;
                managedFiles += stats.files;
            }
        }
        const domains = {};
        for (const doc of this.emailService.store.messageValues()) {
            const found = emailDomains([doc.to, doc.cc].join(','));
            const bytes = Buffer.byteLength(JSON.stringify(doc || {}), 'utf8');
            const attachmentBytes = (Array.isArray(doc.attachments) ? doc.attachments : []).reduce((sum, item) => sum + Math.max(0, Number(item?.size || 0)), 0);
            for (const domain of found.length ? found : ['unknown']) {
                if (!domains[domain]) domains[domain] = { messages: 0, messageBytes: 0, attachmentBytes: 0 };
                domains[domain].messages += 1;
                domains[domain].messageBytes += bytes;
                domains[domain].attachmentBytes += attachmentBytes;
            }
        }
        const maxBytes = Math.max(1, Number(this.config.storage.maxBytes || DEFAULT_CONFIG.storage.maxBytes));
        const quotaPercent = managedBytes / maxBytes * 100;
        const disk = this._diskInfo();
        let level = 'healthy';
        if (quotaPercent >= this.config.storage.hardStopPercent || (disk && disk.freeBytes <= this.config.storage.minFreeBytes / 2)) level = 'blocked';
        else if (quotaPercent >= this.config.storage.emergencyPercent || (disk && disk.freeBytes <= this.config.storage.minFreeBytes)) level = 'emergency';
        else if (quotaPercent >= this.config.storage.criticalPercent) level = 'critical';
        else if (quotaPercent >= this.config.storage.warningPercent) level = 'warning';
        const report = {
            level,
            managedBytes,
            managedFiles,
            maxBytes,
            quotaPercent: Math.round(quotaPercent * 100) / 100,
            disk,
            categories,
            domains,
            writeBlocked: this.state.writeBlocked === true,
            config: clone(this.config.storage),
            timestamp: iso(),
        };
        this._lastStorageReport = clone(report);
        this._lastStorageReportAt = Date.now();
        return report;
    }

    _oldFiles(root, days) {
        const cutoff = Date.now() - Math.max(1, Number(days || 1)) * 86400000;
        const files = [];
        for (const filePath of walkFiles(root, [])) {
            try {
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs < cutoff) files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
            } catch (_) {}
        }
        return files;
    }

    cleanupPreview(args) {
        args = args || {};
        const emergency = args.emergency === true;
        const rules = emergency ? this.config.emergency : this.config.retention;
        const cutoff = Date.now() - Number(rules.messagesDays || 30) * 86400000;
        const messageGuids = [];
        let messageBytes = 0;
        let attachmentBytes = 0;
        for (const doc of this.emailService.store.messageValues()) {
            const time = Date.parse(doc?.date || doc?._fileStore?.createdAt || 0);
            if (!Number.isFinite(time) || time >= cutoff) continue;
            if (this.emailService.isVipMessage?.(doc) || this.emailService.store.isProtectedMessage?.(doc)) continue;
            messageGuids.push(String(doc.guid));
            messageBytes += Buffer.byteLength(JSON.stringify(doc || {}), 'utf8');
            attachmentBytes += (Array.isArray(doc.attachments) ? doc.attachments : []).reduce((sum, item) => sum + Math.max(0, Number(item?.size || 0)), 0);
        }
        const audit = this._oldFiles(path.join(this.rootDir, 'email-files', 'audit'), rules.auditDays);
        const tracking = this._oldFiles(path.join(this.rootDir, 'email-files', 'tracking'), rules.trackingDays);
        const schedulePreview = this.scheduler?.prunePreview?.({ completedDays: rules.completedSchedulesDays, cancelledDays: rules.cancelledSchedulesDays }) || { count: 0, ids: [], bytes: 0 };
        const backupPreview = this._backupPrunePreview();
        const token = crypto.randomBytes(18).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        this.state.previewTokens[token] = {
            type: 'cleanup',
            expiresAt,
            emergency,
            messageGuids,
            auditFiles: audit.map((item) => item.path),
            trackingFiles: tracking.map((item) => item.path),
            scheduleIds: schedulePreview.ids || [],
        };
        this._persistState();
        const reclaimBytes = messageBytes + attachmentBytes + audit.reduce((sum, item) => sum + item.size, 0) + tracking.reduce((sum, item) => sum + item.size, 0) + Number(schedulePreview.bytes || 0) + Number(backupPreview.bytes || 0);
        return {
            dryRun: true,
            emergency,
            rules: clone(rules),
            candidates: {
                messages: messageGuids.length,
                messageBytes,
                attachmentBytes,
                auditFiles: audit.length,
                auditBytes: audit.reduce((sum, item) => sum + item.size, 0),
                trackingFiles: tracking.length,
                trackingBytes: tracking.reduce((sum, item) => sum + item.size, 0),
                schedules: Number(schedulePreview.count || 0),
                scheduleBytes: Number(schedulePreview.bytes || 0),
                backups: Number(backupPreview.count || 0),
                backupBytes: Number(backupPreview.bytes || 0),
            },
            estimatedReclaimBytes: reclaimBytes,
            protectedMessagesPreserved: true,
            confirmToken: token,
            expiresAt,
        };
    }

    async cleanupExecute(args) {
        args = args || {};
        const token = String(args.confirmToken || '');
        const preview = this.state.previewTokens[token];
        if (!preview || preview.type !== 'cleanup' || Date.parse(preview.expiresAt || 0) < Date.now()) throw new Error('A fresh cleanup preview and valid confirmToken are required');
        if (args.confirm !== true) throw new Error('confirm=true is required to execute cleanup');
        const deletedMessages = preview.messageGuids.length ? await this.emailService.store.deleteMessages(preview.messageGuids) : { deleted: [], notFound: [] };
        let deletedAudit = 0;
        let deletedTracking = 0;
        for (const filePath of preview.auditFiles || []) {
            try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); deletedAudit += 1; removeEmptyParents(filePath, path.join(this.rootDir, 'email-files', 'audit')); } } catch (_) {}
        }
        for (const filePath of preview.trackingFiles || []) {
            try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); deletedTracking += 1; removeEmptyParents(filePath, path.join(this.rootDir, 'email-files', 'tracking')); } } catch (_) {}
        }
        const schedules = this.scheduler?.pruneByIds ? this.scheduler.pruneByIds(preview.scheduleIds || []) : { deleted: [] };
        const backups = await this.pruneBackups();
        delete this.state.previewTokens[token];
        this.state.lastCleanupAt = iso();
        this._persistState();
        this.monitor?.increment?.('storageCleanups');
        await this.emailService.store.audit('email_storage_cleanup', { emergency: !!preview.emergency, messages: deletedMessages.deleted.length, audit: deletedAudit, tracking: deletedTracking, schedules: schedules.deleted?.length || 0, backups: backups.deleted?.length || 0 });
        return {
            cleaned: true,
            emergency: !!preview.emergency,
            messages: deletedMessages,
            deletedAuditFiles: deletedAudit,
            deletedTrackingFiles: deletedTracking,
            schedules,
            backups,
            report: this.storageReport(),
        };
    }

    _backupPrunePreview() {
        const list = this.listBackups().backups;
        if (!list.length) return { count: 0, ids: [], bytes: 0 };
        const keep = Math.max(1, Number(this.config.backup.keepLast || 14));
        const cutoff = Date.now() - Math.max(1, Number(this.config.backup.maxAgeDays || 30)) * 86400000;
        const ids = [];
        let bytes = 0;
        list.forEach((item, index) => {
            if (index === 0) return;
            const expiredByCount = index >= keep;
            const expiredByAge = Date.parse(item.createdAt || 0) < cutoff;
            if (!expiredByCount && !expiredByAge) return;
            ids.push(item.id);
            bytes += Number(item.totalBytes || 0);
        });
        return { count: ids.length, ids, bytes };
    }

    async pruneBackups() {
        const preview = this._backupPrunePreview();
        const deleted = [];
        for (const id of preview.ids) {
            try { fs.rmSync(this._backupPath(id), { recursive: true, force: true }); deleted.push(id); } catch (_) {}
        }
        return { deleted, count: deleted.length };
    }

    canAcceptInbound() {
        const report = this.storageReport();
        const freshDisk = this._diskInfo();
        if (freshDisk) report.disk = freshDisk;
        const blocked = report.level === 'blocked' || (freshDisk && freshDisk.freeBytes <= Math.max(64 * 1024 * 1024, Number(this.config.storage.minFreeBytes || 0) / 2));
        if (this.state.writeBlocked !== blocked) {
            this.state.writeBlocked = blocked;
            this._persistState();
        }
        return blocked ? { allowed: false, reason: 'Temporary mail storage is critically low. Try again later.', report } : { allowed: true, report };
    }

    async runMaintenance(args) {
        args = args || {};
        const reportBefore = this.storageReport({ force: true });
        this.state.lastMaintenanceAt = iso();
        let backup = null;
        let cleanup = null;
        const emergencyBefore = reportBefore.level === 'emergency' || reportBefore.level === 'blocked';
        const dueBackup = this.config.backup.enabled !== false && (!this.state.lastBackupAt || Date.now() - Date.parse(this.state.lastBackupAt) >= Number(this.config.backup.intervalHours || 24) * 3600000);
        if (dueBackup && args.skipBackup !== true && !emergencyBefore) {
            try { backup = await this.createBackup({ reason: 'automatic-maintenance' }); }
            catch (error) { this._alert('error', 'backup_failed', 'Automatic backup failed', { error: String(error?.message || error) }); }
        } else if (dueBackup && emergencyBefore) {
            this._alert('warning', 'backup_deferred_low_space', 'Automatic backup deferred because storage is critically low', { level: reportBefore.level });
        }
        if ((emergencyBefore || args.forceCleanup === true) && this.config.emergency.autoCleanup !== false) {
            try {
                const preview = this.cleanupPreview({ emergency: true });
                cleanup = await this.cleanupExecute({ confirm: true, confirmToken: preview.confirmToken });
            } catch (error) {
                this._alert('error', 'emergency_cleanup_failed', 'Emergency storage cleanup failed', { error: String(error?.message || error) });
            }
        } else {
            try { await this.pruneBackups(); } catch (_) {}
        }
        this._lastStorageReport = null;
        const reportAfter = this.storageReport({ force: true });
        this.state.writeBlocked = reportAfter.level === 'blocked';
        this._persistState();
        if (['warning', 'critical', 'emergency', 'blocked'].includes(reportAfter.level)) this._alert(reportAfter.level === 'warning' ? 'warning' : 'error', 'storage_' + reportAfter.level, 'Email storage is ' + reportAfter.level, { quotaPercent: reportAfter.quotaPercent, managedBytes: reportAfter.managedBytes, diskFreeBytes: reportAfter.disk?.freeBytes || null });
        this._sample(reportAfter);
        return { maintained: true, backup, cleanup, before: reportBefore, after: reportAfter };
    }

    _sample(report) {
        const sample = {
            date: iso(),
            level: report.level,
            managedBytes: report.managedBytes,
            quotaPercent: report.quotaPercent,
            diskFreeBytes: report.disk?.freeBytes || null,
            messageCount: this.emailService.store.messages?.size || 0,
            backupCount: this.listBackups().count,
            alerts: this.state.alerts.length,
        };
        this.history.push(sample);
        this._persistHistory();
    }

    historyList(limit) {
        const max = Math.max(1, Math.min(Number(limit || 144), 576));
        return clone(this.history.slice(-max));
    }

    _alert(level, type, message, details) {
        const recent = this.state.alerts?.[0];
        const now = Date.now();
        if (recent && recent.type === type && now - Date.parse(recent.date || 0) < 15 * 60 * 1000) return recent;
        const item = { id: crypto.randomUUID(), date: iso(), level, type, message, details: clone(details || {}) };
        this.state.alerts = [item].concat(Array.isArray(this.state.alerts) ? this.state.alerts : []).slice(0, 200);
        this._persistState();
        this.monitor?.increment?.('operationalAlerts');
        this.monitor?.error?.('operations', message, details || {});
        this._sendAlertWebhook(item);
        return item;
    }

    _sendAlertWebhook(item) {
        if (!this.alertWebhook) return;
        try {
            const url = new URL(this.alertWebhook);
            const client = url.protocol === 'https:' ? https : http;
            const body = Buffer.from(JSON.stringify({ source: 'social-temp-mail', alert: item }), 'utf8');
            const req = client.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length }, timeout: 5000 }, (res) => res.resume());
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.end(body);
        } catch (_) {}
    }

    alerts(args) {
        args = args || {};
        const level = String(args.level || '').toLowerCase();
        const limit = Math.max(1, Math.min(Number(args.limit || 100), 200));
        let items = Array.isArray(this.state.alerts) ? this.state.alerts : [];
        if (level) items = items.filter((item) => item.level === level);
        return { count: Math.min(items.length, limit), total: items.length, alerts: clone(items.slice(0, limit)) };
    }

    status() {
        const report = this.storageReport();
        const backups = this.listBackups();
        return {
            enabled: this.config.enabled !== false,
            running: this.running,
            restartRequired: this.state.restartRequired === true,
            lastBackupAt: this.state.lastBackupAt,
            lastBackupId: this.state.lastBackupId,
            lastBackupError: this.state.lastBackupError,
            lastMaintenanceAt: this.state.lastMaintenanceAt,
            lastCleanupAt: this.state.lastCleanupAt,
            lastRestoreAt: this.state.lastRestoreAt,
            storage: report,
            backups: { count: backups.count, latest: backups.backups[0] || null },
            alerts: this.alerts({ limit: 20 }),
            history: this.historyList(72),
            config: this.getConfig(),
            timestamp: iso(),
        };
    }

    start() {
        if (this.timer) clearInterval(this.timer);
        const interval = Math.max(5, Number(this.config.maintenance.intervalMinutes || 15)) * 60000;
        this.timer = setInterval(() => this.runMaintenance().catch((error) => this.logger('Email operations maintenance failed: ' + (error?.message || error))), interval);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        setTimeout(() => this.runMaintenance().catch((error) => this.logger('Initial email operations maintenance failed: ' + (error?.message || error))), 1500).unref?.();
        return this;
    }

    close() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

function createEmailBackupStorageManager(options) {
    return new EmailBackupStorageManager(options);
}

module.exports = { EmailBackupStorageManager, createEmailBackupStorageManager, DEFAULT_CONFIG };
