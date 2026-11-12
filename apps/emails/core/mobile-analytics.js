'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_EVENTS = new Set([
    'app_open', 'mailbox_create_success', 'mailbox_create_failure',
    'mailbox_open', 'inbox_load_success', 'inbox_load_failure',
    'first_message_seen', 'message_open',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(date) { return date.toISOString().slice(0, 10); }
function validInstallationId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9_-]{20,80}$/.test(id);
}

function createMobileAnalytics({ baseDir, now = () => new Date(), persistDelayMs = 1000 } = {}) {
    if (!baseDir) throw new Error('mobile_analytics_directory_required');
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const dataFile = path.join(baseDir, 'events.json');
    const secretFile = path.join(baseDir, 'hmac.key');
    if (!fs.existsSync(secretFile)) {
        try {
            fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    const secret = fs.readFileSync(secretFile);
    if (secret.length < 32) throw new Error('mobile_analytics_secret_invalid');
    let state = { installations: {}, days: {} };
    if (fs.existsSync(dataFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            if (raw && typeof raw === 'object' && raw.installations && raw.days) state = raw;
        } catch (error) {
            // Never silently replace a damaged production metrics file.
            throw new Error('mobile_analytics_storage_corrupt: ' + error.message);
        }
    }

    let timer = null;
    function flush() {
        if (timer) clearTimeout(timer);
        timer = null;
        const tmp = dataFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, dataFile);
    }
    function schedule() {
        if (timer) return;
        timer = setTimeout(flush, persistDelayMs);
        timer.unref?.();
    }
    function digest(installationId) {
        return crypto.createHmac('sha256', secret).update(installationId).digest('hex');
    }
    function prune() {
        const cutoff = new Date(now().getTime() - 90 * DAY_MS);
        const date = dayOf(cutoff);
        for (const [id, record] of Object.entries(state.installations)) {
            if (!record || record.lastDay < date) delete state.installations[id];
        }
        for (const key of Object.keys(state.days)) {
            if (key < date) delete state.days[key];
        }
    }
    function track(input) {
        if (!input || !ALLOWED_EVENTS.has(input.event) ||
            !validInstallationId(input.installationId)) {
            return { done: false, code: 'invalid_event' };
        }
        const today = dayOf(now());
        const id = digest(input.installationId);
        const user = state.installations[id] || {
            firstDay: today, lastDay: today, activeDays: [], eventDay: today, eventCount: 0,
        };
        if (user.eventDay !== today) {
            user.eventDay = today;
            user.eventCount = 0;
        }
        if (user.eventCount >= 250) return { done: false, code: 'daily_event_limit' };
        user.eventCount++;
        user.lastDay = today;
        const daily = state.days[today] || { events: {}, activeInstallations: 0 };
        daily.events[input.event] = (daily.events[input.event] || 0) + 1;
        if (input.event === 'app_open' && !user.activeDays.includes(today)) {
            user.activeDays.push(today);
            daily.activeInstallations += 1;
        }
        state.installations[id] = user;
        state.days[today] = daily;
        prune();
        schedule();
        return { done: true };
    }
    function erase(input) {
        if (!input || !validInstallationId(input.installationId)) {
            return { done: false, code: 'invalid_installation_id' };
        }
        delete state.installations[digest(input.installationId)];
        schedule();
        return { done: true };
    }
    function summary({ periodDays = 28 } = {}) {
        const days = Math.min(90, Math.max(1, Number(periodDays) || 28));
        const today = now();
        const series = [];
        const totals = {};
        for (let offset = days - 1; offset >= 0; offset--) {
            const date = dayOf(new Date(today.getTime() - offset * DAY_MS));
            const record = state.days[date] || { events: {}, activeInstallations: 0 };
            series.push({ date, activeInstallations: record.activeInstallations || 0, events: { ...record.events } });
            for (const [name, count] of Object.entries(record.events)) {
                totals[name] = (totals[name] || 0) + count;
            }
        }
        // Only opted-in installations are included. These are activation
        // milestones, not Google Play acquisition or all-user retention rates.
        function cohort(dayOffset) {
            let eligible = 0;
            let returned = 0;
            const latestEligible = dayOf(new Date(today.getTime() - dayOffset * DAY_MS));
            for (const user of Object.values(state.installations)) {
                if (user.firstDay > latestEligible) continue;
                const first = Date.parse(user.firstDay + 'T00:00:00Z');
                const target = dayOf(new Date(first + dayOffset * DAY_MS));
                eligible++;
                if (user.activeDays.includes(target)) returned++;
            }
            return { eligible, returned, rate: eligible ? returned / eligible : null };
        }
        return {
            done: true, scope: 'consented_installations_only',
            periodDays: days, totals, series, d1: cohort(1), d7: cohort(7),
            trackedInstallations: Object.keys(state.installations).length,
            excludedData: ['email', 'message_contents', 'ip_address', 'raw_installation_id'],
        };
    }
    return { track, erase, summary, flush };
}

module.exports = { createMobileAnalytics, ALLOWED_EVENTS, validInstallationId };
