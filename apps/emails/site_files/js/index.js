(function () {
    'use strict';

    const root = document.querySelector('[data-email-app]');
    if (!root) return;

    const ui = window.SBUI;
    const mode = root.getAttribute('data-email-app') || 'free';
    const GUEST_ADDRESS_LIMIT = 10;
    const SOCIAL_BROWSER_ADDRESS_LIMIT = 100;
    const ADDRESS_BOOK_VERSION = 2;
    const LIVE_POLL_MS = 10000;
    const LIVE_RECONCILE_MS = 60000;

    const state = {
        list: [],
        count: 0,
        busy: false,
        polling: false,
        pollReady: false,
        pollTimer: null,
        liveSource: null,
        liveMode: 'poll',
        liveReconnectTimer: null,
        currentWhere: {},
        currentEmail: null,
        currentMailbox: '',
        activeNewCount: 0,
        minEmailLength: location.pathname.includes('vip') ? 6 : 8,
        maxEmailLength: location.pathname.includes('vip') ? 10 : 14,
        sidebarSearch: '',
        sidebarSort: 'recent',
        client: {
            isSocialBrowser: false,
            addressLimit: GUEST_ADDRESS_LIMIT,
            canRemoveAddress: false,
        },
        preferences: {
            notifications: false,
            sound: false,
        },
        addressBook: {
            version: ADDRESS_BOOK_VERSION,
            active: '',
            addresses: [],
        },
    };

    const q = (selector, base) => (base || root).querySelector(selector);
    const qa = (selector, base) => Array.from((base || root).querySelectorAll(selector));

    function toast(message, type, title, options) {
        if (ui && typeof ui.toast === 'function') return ui.toast(message, Object.assign({ type: type || 'info', title: title || '' }, options || {}));
        return null;
    }

    function setError(message, selector, silent) {
        const text = message || '';
        const el = document.querySelector(selector || '[data-email-error]');
        if (el) el.textContent = text;
        if (text && !silent) toast(text, 'error');
    }

    function loadingIcon() {
        return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4v6h-6"></path></svg>';
    }

    function checkIcon() {
        return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>';
    }

    function setBusy(button, busy, busyText) {
        if (!button) return;
        if (busy) {
            if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.classList.add('is-busy');
            button.setAttribute('aria-busy', 'true');
            if (busyText) button.innerHTML = loadingIcon() + '<span>' + escape(busyText) + '</span>';
        } else {
            button.disabled = false;
            button.classList.remove('is-busy');
            button.removeAttribute('aria-busy');
            if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }
    }

    function flashButton(button, label, type) {
        if (!button) return;
        const original = button.dataset.originalHtml || button.innerHTML;
        const className = type === 'error' ? 'is-action-error' : 'is-action-success';
        button.classList.add(className);
        if (label) button.innerHTML = (type === 'error' ? '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6M15 9l-6 6"></path></svg>' : checkIcon()) + '<span>' + escape(label) + '</span>';
        setTimeout(() => {
            button.classList.remove(className);
            if (!button.disabled) button.innerHTML = original;
        }, 1450);
    }

    async function copyWithFeedback(button, value, message) {
        const text = String(value || '').trim();
        if (!text) {
            flashButton(button, 'Nothing to copy', 'error');
            toast('There is nothing to copy yet.', 'warning', 'Nothing to copy');
            return false;
        }
        try {
            const copied = await ui.copy(text);
            if (!copied) throw new Error('Copy failed');
            flashButton(button, 'Copied');
            toast(message || 'Copied to clipboard.', 'success', 'Copied');
            return true;
        } catch (error) {
            flashButton(button, 'Copy failed', 'error');
            toast(error.message || 'Unable to copy to the clipboard.', 'error', 'Copy failed');
            return false;
        }
    }

    const commonSecondLevelSuffixes = new Set(['ac', 'co', 'com', 'edu', 'gov', 'go', 'mil', 'net', 'ne', 'nom', 'or', 'org', 'sch']);

    function currentDomain() {
        const host = String(location.hostname || '').trim().toLowerCase().replace(/\.$/, '');
        if (!host || host === 'localhost' || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
        const labels = host.split('.').filter(Boolean);
        if (labels.length <= 2) return host;
        const tld = labels[labels.length - 1];
        const second = labels[labels.length - 2];
        if (tld.length === 2 && commonSecondLevelSuffixes.has(second) && labels.length >= 3) return labels.slice(-3).join('.');
        return labels.slice(-2).join('.');
    }

    function randomNumber(min, max) {
        return Math.floor(Math.random() * (max - min) + min);
    }

    function makeId() {
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        const numbers = '0123456789';
        const length = randomNumber(state.minEmailLength, state.maxEmailLength + 1);
        let result = '';
        const first = randomNumber(4, 7);
        for (let i = 0; i < first; i += 1) result += letters.charAt(Math.floor(Math.random() * letters.length));
        result += ['.', '', '_', '', '-'][randomNumber(0, 5)] || '';
        const last = randomNumber(4, 7);
        for (let i = 0; i < last; i += 1) result += letters.charAt(Math.floor(Math.random() * letters.length));
        const remaining = Math.max(0, length - first - last);
        if (remaining) {
            result += ['.', '', '_', '', '-'][randomNumber(0, 5)] || '';
            for (let i = 0; i < remaining; i += 1) result += numbers.charAt(Math.floor(Math.random() * numbers.length));
        }
        return result;
    }

    function normalizeMailbox(value) {
        const email = String(value || '').trim().toLowerCase();
        if (!email) return '';
        const at = email.lastIndexOf('@');
        let local = email;
        let domain = currentDomain();
        if (at >= 0) {
            local = email.slice(0, at).trim();
            domain = email.slice(at + 1).trim().replace(/\.$/, '');
        }
        if (!local || !domain || /\s/.test(local) || /\s/.test(domain)) return '';
        if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return '';
        if (domain !== 'localhost' && !/^[a-z0-9.-]+$/i.test(domain)) return '';
        return local + '@' + domain;
    }

    function escape(value) {
        return ui ? ui.escape(value) : String(value || '');
    }

    function relativeTime(value) {
        const time = Number(value || 0);
        if (!time) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
        if (seconds < 10) return 'now';
        if (seconds < 60) return seconds + 's ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm ago';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    function formatBytes(value) {
        const bytes = Math.max(0, Number(value || 0));
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function addressStorageKey() {
        return 'social-temp-mail.address-book.v1.' + currentDomain();
    }

    function preferenceStorageKey() {
        return 'social-temp-mail.preferences.v1.' + currentDomain();
    }

    function emptyAddressBook() {
        return { version: ADDRESS_BOOK_VERSION, active: '', addresses: [] };
    }

    function readPreferences() {
        try {
            const saved = JSON.parse(localStorage.getItem(preferenceStorageKey()) || '{}');
            state.preferences.notifications = !!saved.notifications;
            state.preferences.sound = !!saved.sound;
        } catch (_) {
            state.preferences.notifications = false;
            state.preferences.sound = false;
        }
        updatePreferenceButtons();
    }

    function savePreferences() {
        try {
            localStorage.setItem(preferenceStorageKey(), JSON.stringify(state.preferences));
        } catch (_) {
        }
        updatePreferenceButtons();
    }

    function updatePreferenceButtons() {
        const notification = q('[data-notification-button]');
        const sound = q('[data-sound-button]');
        if (notification) {
            const label = notification.querySelector('[data-button-label]');
            if (label) label.textContent = state.preferences.notifications ? 'Notifications On' : 'Notifications';
            notification.classList.toggle('is-on', state.preferences.notifications);
            notification.setAttribute('aria-pressed', state.preferences.notifications ? 'true' : 'false');
        }
        if (sound) {
            const label = sound.querySelector('[data-button-label]');
            if (label) label.textContent = state.preferences.sound ? 'Sound On' : 'Sound';
            sound.classList.toggle('is-on', state.preferences.sound);
            sound.setAttribute('aria-pressed', state.preferences.sound ? 'true' : 'false');
        }
    }

    function readAddressBook() {
        if (mode !== 'free') return;
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(addressStorageKey()) || 'null');
        } catch (_) {
            saved = null;
        }
        if (!saved || !Array.isArray(saved.addresses)) saved = emptyAddressBook();
        const seen = new Set();
        const addresses = [];
        for (const item of saved.addresses) {
            const email = normalizeMailbox(typeof item === 'string' ? item : item?.email);
            if (!email || seen.has(email)) continue;
            seen.add(email);
            addresses.push({
                email,
                label: String(item?.label || ''),
                createdAt: Number(item?.createdAt || Date.now()),
                lastCheckedAt: Number(item?.lastCheckedAt || 0),
                messageCount: Math.max(0, Number(item?.messageCount || 0)),
                unreadCount: Math.max(0, Number(item?.unreadCount || 0)),
                lastMessageAt: Number(item?.lastMessageAt || 0),
                lastMessageSubject: String(item?.lastMessageSubject || ''),
                lastMessageFrom: String(item?.lastMessageFrom || ''),
            });
        }
        state.addressBook = {
            version: ADDRESS_BOOK_VERSION,
            active: normalizeMailbox(saved.active),
            addresses: addresses.slice(0, state.client.addressLimit),
        };
        if (!state.addressBook.addresses.some((item) => item.email === state.addressBook.active)) state.addressBook.active = state.addressBook.addresses[0]?.email || '';
        saveAddressBook();
    }

    function saveAddressBook() {
        if (mode !== 'free') return;
        try {
            localStorage.setItem(addressStorageKey(), JSON.stringify(state.addressBook));
        } catch (_) {
        }
    }

    function addressEntry(email) {
        return state.addressBook.addresses.find((item) => item.email === normalizeMailbox(email));
    }

    function limitReachedMessage() {
        return state.client.isSocialBrowser
            ? 'You have reached the 100-address limit for this browser. Remove a saved address before adding another one.'
            : 'You reached the 10 saved-email limit. Use Social Browser to unlock 100 saved emails and address removal.';
    }

    function showLimitAlert(message) {
        const box = q('[data-limit-alert]');
        const text = q('[data-limit-alert-message]');
        const cta = q('[data-limit-alert-cta]');
        if (text) text.textContent = message || limitReachedMessage();
        if (cta) cta.hidden = state.client.isSocialBrowser;
        if (box) {
            box.hidden = false;
            box.classList.add('is-open');
        }
    }

    function hideLimitAlert() {
        const box = q('[data-limit-alert]');
        if (!box) return;
        box.classList.remove('is-open');
        box.hidden = true;
    }

    function showUpgrade(message) {
        const panel = q('[data-upgrade-panel]');
        const text = q('[data-upgrade-message]');
        if (text) text.textContent = message || 'Unlock 100 saved emails plus address removal, reply and forward with Social Browser.';
        if (panel) panel.hidden = false;
    }

    function hideUpgrade() {
        const panel = q('[data-upgrade-panel]');
        if (panel) panel.hidden = state.client.isSocialBrowser;
    }

    function updateClientBadges() {
        const tier = q('[data-browser-tier]');
        const usage = q('[data-address-usage]');
        const usageCard = q('[data-address-usage-card]');
        const progress = q('[data-address-progress]');
        const count = state.addressBook.addresses.length;
        const limit = Math.max(1, state.client.addressLimit);
        const percent = Math.min(100, Math.round(count / limit * 100));
        if (tier) tier.textContent = state.client.isSocialBrowser ? 'Social Browser' : 'Guest';
        if (usage) usage.textContent = count + ' / ' + limit;
        if (progress) progress.style.width = percent + '%';
        if (usageCard) usageCard.classList.toggle('is-near-limit', percent >= 80);
        qa('[data-browser-send-action]').forEach((button) => { button.hidden = !state.client.isSocialBrowser; });
    }

    function sortedAddresses() {
        const query = state.sidebarSearch.trim().toLowerCase();
        const list = state.addressBook.addresses.filter((item) => !query || [item.email, item.label, item.lastMessageSubject, item.lastMessageFrom].some((value) => String(value || '').toLowerCase().includes(query)));
        if (state.sidebarSort === 'unread') return list.sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0) || Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0));
        if (state.sidebarSort === 'created') return list.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        return list.sort((a, b) => Math.max(Number(b.lastMessageAt || 0), Number(b.lastCheckedAt || 0), Number(b.createdAt || 0)) - Math.max(Number(a.lastMessageAt || 0), Number(a.lastCheckedAt || 0), Number(a.createdAt || 0)));
    }

    function renderAddressSidebar() {
        if (mode !== 'free') return;
        const host = q('[data-address-list]');
        if (!host) return;
        updateClientBadges();
        const items = sortedAddresses();
        if (!items.length) {
            host.innerHTML = '<div class="mailbox-address-empty">' + (state.addressBook.addresses.length ? 'No addresses match your search.' : 'No saved addresses yet.') + '</div>';
            return;
        }
        host.innerHTML = items.map((item) => {
            const originalIndex = state.addressBook.addresses.findIndex((entry) => entry.email === item.email) + 1;
            const active = item.email === state.addressBook.active;
            const unread = Math.max(0, Number(item.unreadCount || 0));
            const remove = state.client.canRemoveAddress ? '<button class="mailbox-address-remove" type="button" data-action="remove-address" data-email="' + escape(item.email) + '" title="Remove address from this browser" aria-label="Remove ' + escape(item.email) + '"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m8 11 1 8h6l1-8"></path></svg></button>' : '';
            const status = item.lastMessageAt ? (escape(item.lastMessageSubject || 'New message') + ' · ' + relativeTime(item.lastMessageAt)) : (Number(item.messageCount || 0) + ' message' + (Number(item.messageCount || 0) === 1 ? '' : 's') + (item.lastCheckedAt ? ' · checked ' + relativeTime(item.lastCheckedAt) : ''));
            return '<div class="mailbox-address-item' + (active ? ' is-active' : '') + (unread ? ' has-unread' : '') + '"><button class="mailbox-address-select" type="button" data-action="select-address" data-email="' + escape(item.email) + '"><span class="mailbox-address-index">' + originalIndex + '</span><span class="mailbox-address-copy"><strong>' + escape(item.label || item.email) + '</strong>' + (item.label ? '<small>' + escape(item.email) + '</small>' : '') + '<small>' + status + '</small></span>' + (unread ? '<span class="mailbox-unread">' + unread + '</span>' : '<span></span>') + '</button>' + remove + '</div>';
        }).join('');
    }

    function addAddress(email, options) {
        if (mode !== 'free') return false;
        const normalized = normalizeMailbox(email);
        if (!normalized) return false;
        const existing = addressEntry(normalized);
        if (existing) {
            if (options?.activate !== false) state.addressBook.active = normalized;
            saveAddressBook();
            renderAddressSidebar();
            return true;
        }
        if (state.addressBook.addresses.length >= state.client.addressLimit) {
            const message = limitReachedMessage();
            showUpgrade(message);
            if (!options?.silentLimit) showLimitAlert(message);
            return false;
        }
        const now = Date.now();
        state.addressBook.addresses.unshift({ email: normalized, label: '', createdAt: now, lastCheckedAt: 0, messageCount: 0, unreadCount: 0, lastMessageAt: 0, lastMessageSubject: '', lastMessageFrom: '' });
        if (options?.activate !== false) state.addressBook.active = normalized;
        saveAddressBook();
        renderAddressSidebar();
        if (state.pollReady) scheduleLiveReconnect();
        if (state.addressBook.addresses.length === state.client.addressLimit) {
            const message = limitReachedMessage();
            showUpgrade(message);
            if (!options?.silentLimit) showLimitAlert(message);
        }
        return true;
    }

    function updateAddressMeta(email, count, options) {
        if (mode !== 'free') return;
        const item = addressEntry(email);
        if (!item) return;
        item.lastCheckedAt = Date.now();
        item.messageCount = Math.max(0, Number(count || 0));
        if (options?.markRead !== false) item.unreadCount = 0;
        if (options?.latest) {
            item.lastMessageAt = new Date(options.latest.date || 0).getTime() || item.lastMessageAt;
            item.lastMessageSubject = options.latest.subject || item.lastMessageSubject;
            item.lastMessageFrom = options.latest.from || item.lastMessageFrom;
        }
        saveAddressBook();
        renderAddressSidebar();
    }

    async function removeAddress(email) {
        if (!state.client.canRemoveAddress) {
            showUpgrade('Remove saved addresses and free up inbox slots with Social Browser.');
            toast('Open this site in Social Browser to remove saved addresses.', 'info', 'Address removal');
            return;
        }
        const normalized = normalizeMailbox(email);
        const index = state.addressBook.addresses.findIndex((item) => item.email === normalized);
        if (index < 0) return;
        state.addressBook.addresses.splice(index, 1);
        if (state.addressBook.active === normalized) state.addressBook.active = state.addressBook.addresses[Math.min(index, state.addressBook.addresses.length - 1)]?.email || '';
        saveAddressBook();
        renderAddressSidebar();
        if (state.pollReady) scheduleLiveReconnect();
        toast(normalized + ' was removed from My Emails.', 'success', 'Address removed');
        const input = q('[data-mail-address]');
        if (!state.addressBook.active) {
            if (input) input.value = '';
            state.list = [];
            state.count = 0;
            render();
            return;
        }
        if (input) input.value = state.addressBook.active;
        await loadAll({ to: state.addressBook.active }, 500, { markRead: true });
    }

    async function selectAddress(email) {
        const normalized = normalizeMailbox(email);
        if (!addressEntry(normalized)) return;
        state.addressBook.active = normalized;
        saveAddressBook();
        renderAddressSidebar();
        const input = q('[data-mail-address]');
        if (input) input.value = normalized;
        const loaded = await loadAll({ to: normalized }, 500, { markRead: true });
        if (loaded) toast('Showing messages for ' + normalized + '.', 'info', 'Inbox switched', { duration: 1800 });
    }

    async function loadClientContext() {
        try {
            const response = await ui.post('/api/emails/client-context', {});
            state.client.isSocialBrowser = !!response?.isSocialBrowser;
        } catch (_) {
            state.client.isSocialBrowser = false;
        }
        state.client.addressLimit = state.client.isSocialBrowser ? SOCIAL_BROWSER_ADDRESS_LIMIT : GUEST_ADDRESS_LIMIT;
        state.client.canRemoveAddress = state.client.isSocialBrowser;
        hideUpgrade();
        updateClientBadges();
    }

    function render() {
        const listHost = q('[data-email-list]');
        if (!listHost) return;
        if (mode === 'free') renderAddressSidebar();
        const filterText = String(q('[data-search-text]')?.value || '').trim().toLowerCase();
        const items = filterText ? state.list.filter((mail) => [mail.from, mail.to, mail.subject, mail.folder].some((value) => String(value || '').toLowerCase().includes(filterText))) : state.list;
        const count = q('[data-email-count]');
        if (count) count.textContent = String(state.count);
        if (mode === 'free') {
            if (!items.length) {
                listHost.innerHTML = '<div class="empty-inbox"><span class="empty-inbox-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m4 7 8 6 8-6"></path></svg></span><strong>No messages yet</strong><span>Keep this page open. New messages will appear automatically, and verification codes will be highlighted for you.</span></div>';
                return;
            }
            listHost.innerHTML = items.map((mail, index) => {
                const isNew = index < state.activeNewCount;
                const attachmentBadge = mail.hasAttachments || (mail.attachments && mail.attachments.length) ? '<span class="mail-attachment-badge">Attachment</span>' : '';
                const newBadge = isNew ? '<span class="mail-new-badge">New</span>' : '';
                return '<article class="sb-mail-card mail-message-card' + (isNew ? ' is-new' : '') + '" data-guid="' + escape(mail.guid) + '"><span class="mail-message-icon"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m4 7 8 6 8-6"></path></svg></span><div class="mail-message-copy"><div class="sb-mail-meta">' + escape(mail.from) + '</div><div class="sb-mail-subject">' + escape(mail.subject || '(No subject)') + '</div><div class="mail-message-date">' + escape(ui.dateTime(mail.date)) + '</div></div><div class="mail-message-actions-side"><div class="sb-actions">' + newBadge + attachmentBadge + '</div><button class="sb-btn sb-btn-small" type="button" data-action="view" data-guid="' + escape(mail.guid) + '"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg><span>View Message</span></button></div></article>';
            }).join('');
            return;
        }
        listHost.innerHTML = items.map((mail, index) => '<tr data-guid="' + escape(mail.guid) + '"><td>' + (index + 1) + '</td><td><div class="sb-mail-meta">' + escape(mail.from) + '</div><div style="font-size:12px;color:#94a3b8">' + escape(ui.dateTime(mail.date)) + '</div><div class="sb-actions"><button class="sb-btn sb-btn-small" data-action="search-value" data-value="' + escape(mail.from) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"></circle><path d="m15 15 5 5"></path></svg><span>All Mails</span></button></div></td><td><div class="sb-mail-meta">' + escape(mail.to) + '</div><div class="sb-actions"><button class="sb-btn sb-btn-success sb-btn-small" data-action="vip" data-value="' + escape(mail.to) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.4c0 4.8 3.1 8.1 7.5 9.6 4.4-1.5 7.5-4.8 7.5-9.6V6L12 3Z"></path><path d="m9 12 2 2 4-4"></path></svg><span>VIP</span></button><button class="sb-btn sb-btn-ghost sb-btn-small" data-action="normal" data-value="' + escape(mail.to) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"></path></svg><span>Normal</span></button><button class="sb-btn sb-btn-small" data-action="search-value" data-value="' + escape(mail.to) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6"></circle><path d="m15 15 5 5"></path></svg><span>All Mails</span></button></div></td><td><div class="sb-mail-subject">' + escape(mail.subject || '(No subject)') + '</div><div style="color:#f59e0b">Folder: ' + escape(mail.folder || '') + '</div><button class="sb-btn sb-btn-small" data-action="view" data-guid="' + escape(mail.guid) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg><span>View</span></button></td><td><button class="sb-btn sb-btn-danger sb-btn-small" data-action="delete" data-guid="' + escape(mail.guid) + '" type="button"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m6 7 1 13h10l1-13"></path></svg><span>Delete</span></button></td></tr>').join('');
    }

    async function loadAll(where, limit, options) {
        if (state.busy) return false;
        state.busy = true;
        setError('');
        state.currentWhere = where || {};
        try {
            const response = await ui.post('/api/emails/all', { where: state.currentWhere, exactTo: mode === 'free' && !!state.currentWhere.to, limit: Math.max(1, Math.min(Number(limit || 500), 5000)), select: { id: 1, guid: 1, from: 1, to: 1, subject: 1, date: 1, folder: 1, attachments: 1 } });
            if (response.isVIP) setError('Some VIP emails are protected and are not shown.');
            if (!response.done) throw new Error(response.error || 'Unable to load emails');
            state.list = Array.isArray(response.list) ? response.list : [];
            state.count = Number(response.count || state.list.length);
            if (mode === 'free' && state.currentWhere.to) {
                const latest = state.list[0] || null;
                updateAddressMeta(state.currentWhere.to, state.count, { markRead: options?.markRead !== false, latest });
                if (options?.newCount !== undefined) state.activeNewCount = Math.max(0, Number(options.newCount || 0));
                else if (!options?.background) state.activeNewCount = 0;
            }
            render();
            return true;
        } catch (error) {
            setError(error.message || String(error), undefined, !!options?.background);
            return false;
        } finally {
            state.busy = false;
        }
    }

    function stripHtml(value) {
        const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
        return doc.body?.textContent || '';
    }

    function extractVerification(mail) {
        const source = [mail?.subject || '', mail?.text || '', stripHtml(mail?.html || '')].join('\n').replace(/\s+/g, ' ');
        const patterns = [/(?:verification|verify|security|confirmation|login|sign[ -]?in|otp|passcode|code|pin)[^a-z0-9]{0,24}([a-z0-9]{4,10})\b/i, /\b(\d{4,8})\b/];
        let code = '';
        for (const pattern of patterns) {
            const match = source.match(pattern);
            if (match && match[1]) {
                code = match[1];
                break;
            }
        }
        const links = [];
        if (mail?.html) {
            const doc = new DOMParser().parseFromString(mail.html, 'text/html');
            Array.from(doc.querySelectorAll('a[href]')).forEach((anchor) => {
                const href = String(anchor.getAttribute('href') || '').trim();
                const label = String(anchor.textContent || '').trim().replace(/\s+/g, ' ');
                if (!(href.startsWith('http:') || href.startsWith('https:'))) return;
                if (!/(verify|confirm|activate|sign|login|continue|approve|validate|complete)/i.test(label + ' ' + href)) return;
                if (!links.some((item) => item.href === href)) links.push({ href, label: label || 'Open verification link' });
            });
        }
        return { code, links: links.slice(0, 4) };
    }

    function renderVerification(mail) {
        const host = document.querySelector('[data-verification-tools]');
        if (!host) return;
        const info = extractVerification(mail);
        const code = document.querySelector('[data-verification-code]');
        const links = document.querySelector('[data-verification-links]');
        if (code) code.textContent = info.code || '';
        if (links) links.innerHTML = info.links.map((item) => '<a href="' + escape(item.href) + '" target="_blank" rel="noopener noreferrer" data-action="open-verification-link"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"></path></svg><span>' + escape(item.label) + '</span></a>').join('');
        host.hidden = !info.code && !info.links.length;
    }

    function renderPrivacy(mail) {
        const summary = document.querySelector('[data-privacy-summary]');
        const button = document.querySelector('[data-action="load-remote-images"]');
        const privacy = mail?.privacy || {};
        const remote = Number(privacy.remoteImages || 0);
        const trackers = Number(privacy.trackingPixels || 0);
        if (summary) summary.textContent = remote ? (remote + ' remote image' + (remote === 1 ? '' : 's') + ' blocked' + (trackers ? ' · ' + trackers + ' possible tracker' + (trackers === 1 ? '' : 's') : '')) : 'No remote images detected.';
        if (button) {
            button.hidden = remote === 0;
            button.dataset.remoteState = 'blocked';
            const label = button.querySelector('[data-button-label]');
            if (label) label.textContent = 'Load Remote Images';
        }
    }

    function renderAttachments(mail, mailbox) {
        const host = document.querySelector('[data-attachments]');
        const list = document.querySelector('[data-attachment-list]');
        const count = document.querySelector('[data-attachment-count]');
        const attachments = Array.isArray(mail?.attachments) ? mail.attachments : [];
        if (!host || !list) return;
        host.hidden = attachments.length === 0;
        if (count) count.textContent = attachments.length ? '(' + attachments.length + ')' : '';
        list.innerHTML = attachments.map((item) => {
            const url = '/api/emails/attachment?guid=' + encodeURIComponent(mail.guid) + '&id=' + encodeURIComponent(item.id) + '&email=' + encodeURIComponent(mailbox);
            return '<div class="mail-attachment-row"><span><strong>' + escape(item.filename || 'attachment') + '</strong> · ' + escape(formatBytes(item.size)) + '</span><a class="sb-btn sb-btn-small sb-btn-ghost" href="' + escape(url) + '" data-action="download-attachment" data-filename="' + escape(item.filename || 'attachment') + '"><svg class="ui-icon ui-icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m8 11 4 4 4-4"></path><path d="M5 19h14"></path></svg><span>Download</span></a></div>';
        }).join('');
    }

    function viewFrameUrl(remote) {
        const mail = state.currentEmail;
        if (!mail) return '';
        return location.origin + '/viewEmail?guid=' + encodeURIComponent(mail.guid) + '&to=' + encodeURIComponent(state.currentMailbox) + '&remote=' + (remote ? '1' : '0');
    }

    async function viewEmail(guid) {
        setError('', '[data-view-error]');
        try {
            const listed = state.list.find((item) => String(item.guid) === String(guid));
            const mailbox = normalizeMailbox(state.currentWhere?.to || listed?.to || q('[data-mail-address]')?.value || '');
            const response = await ui.post('/api/emails/view', { guid, to: mailbox });
            if (!response.done) throw new Error(response.error || 'Email not found');
            const mail = response.doc || response.message || (Array.isArray(response.list) ? response.list[0] : null);
            if (response.isVIP && !mail) throw new Error('VIP Email Protected');
            if (!mail) throw new Error(response.error || 'Email not found');
            state.currentEmail = mail;
            state.currentMailbox = mailbox;
            document.querySelector('[data-view-from]').textContent = mail?.from || '';
            document.querySelector('[data-view-to]').textContent = mail?.to || '';
            document.querySelector('[data-view-subject]').textContent = mail?.subject || '';
            const frame = document.querySelector('#div-message');
            if (frame) frame.src = viewFrameUrl(false);
            renderVerification(mail);
            renderPrivacy(mail);
            renderAttachments(mail, mailbox);
            const replyFrom = document.querySelector('[data-reply-from]');
            const forwardFrom = document.querySelector('[data-forward-from]');
            if (replyFrom) replyFrom.value = mailbox;
            if (forwardFrom) forwardFrom.value = mailbox;
            document.querySelector('[data-reply-panel]')?.setAttribute('hidden', '');
            document.querySelector('[data-forward-panel]')?.setAttribute('hidden', '');
            updateClientBadges();
            ui.show('#viewEmailModal');
        } catch (error) {
            setError(error.message || String(error), '[data-view-error]');
            ui.show('#viewEmailModal');
        }
    }

    async function deleteEmail(guid) {
        const mail = state.list.find((item) => String(item.guid) === String(guid));
        if (!confirm('Delete this email permanently?\n\n' + (mail?.subject || guid))) return;
        const response = await ui.post('/api/emails/delete', { guid });
        if (!response.done) return setError(response.error || 'Delete failed');
        state.list = state.list.filter((item) => String(item.guid) !== String(guid));
        state.count = Math.max(0, state.count - 1);
        render();
        toast('The message was permanently deleted.', 'success', 'Message deleted');
    }

    async function deleteMatching(where) {
        if (!confirm('Delete all matching emails permanently? This action requires Admin permission.')) return;
        const response = await ui.post('/api/emails/delete-all', { where: where || {} });
        if (!response.done) return setError(response.error || 'Bulk delete failed');
        const deletedCount = Number(response.result?.count || 0);
        toast('Deleted ' + deletedCount + ' matching message' + (deletedCount === 1 ? '' : 's') + '.', 'success', 'Bulk delete complete');
        await loadAll(state.currentWhere, 500);
    }

    async function setVip(email, vip) {
        const endpoint = vip ? '/api/emails/set-vip' : '/api/emails/set-normal';
        const response = await ui.post(endpoint, { email, vip: true });
        if (!response.done) {
            setError(response.error || 'VIP update failed');
            return false;
        }
        return true;
    }

    async function setAllProfilesVip(vip) {
        const sb = window.SOCIALBROWSER;
        const sessions = sb?.var?.session_list;
        if (!Array.isArray(sessions) || !sessions.length) return toast('The Social Browser profile list is not available.', 'warning', 'Profiles unavailable');
        const domain = currentDomain();
        let done = 0;
        for (const session of sessions) {
            const local = String(session.display || '').split('@')[0].trim();
            if (!local) continue;
            await setVip(local + '@' + domain, vip);
            done += 1;
        }
        toast((vip ? 'VIP enabled for ' : 'VIP removed from ') + done + ' profile email' + (done === 1 ? '' : 's') + '.', 'success', vip ? 'VIP enabled' : 'VIP removed');
    }

    function searchFormData() {
        const form = document.querySelector('[data-search-form]');
        if (!form) return { where: {}, limit: 500 };
        const data = new FormData(form);
        const where = {};
        ['from', 'to', 'subject', 'text'].forEach((key) => {
            const value = String(data.get(key) || '').trim();
            if (value) where[key] = value;
        });
        return { where, limit: Number(data.get('limit') || 500) };
    }

    async function sendEmail() {
        const form = document.querySelector('[data-send-form]');
        if (!form || !form.reportValidity()) return;
        const data = Object.fromEntries(new FormData(form).entries());
        data.source = 'isite';
        setError('', '[data-send-error]');
        const response = await ui.post('/api/emails/add', data);
        if (!response.done) return setError(response.error || 'Send failed', '[data-send-error]');
        ui.hide('#addEmailModal');
        form.reset();
        if (response.doc) {
            state.list.unshift(response.doc);
            state.count += 1;
            render();
        }
        toast('The email was sent successfully.', 'success', 'Email sent');
    }

    async function checkInbox(button) {
        const input = q('[data-mail-address]');
        if (!input) return;
        const email = normalizeMailbox(input.value);
        if (!email) return toast('Enter, choose, or create a valid email address first.', 'warning', 'Email address required');
        if (mode === 'free' && !addressEntry(email) && !addAddress(email)) return;
        state.addressBook.active = email;
        saveAddressBook();
        input.value = email;
        renderAddressSidebar();
        setBusy(button, true, 'Refreshing…');
        const loaded = await loadAll({ to: email }, 500, { markRead: true });
        setBusy(button, false);
        if (loaded) {
            flashButton(button, 'Updated');
            toast(state.count ? ('Found ' + state.count + ' message' + (state.count === 1 ? '' : 's') + ' in this inbox.') : 'Inbox checked. No messages yet.', 'success', 'Inbox refreshed');
        }
    }

    async function generateEmail(button) {
        const input = q('[data-mail-address]');
        if (!input) return;
        if (mode === 'free' && state.addressBook.addresses.length >= state.client.addressLimit) {
            const message = limitReachedMessage();
            showUpgrade(message);
            showLimitAlert(message);
            return;
        }
        setBusy(button, true, 'Generating…');
        input.value = '';
        input.classList.add('empty-animate');
        await new Promise((resolve) => setTimeout(resolve, 250));
        const email = makeId() + '@' + currentDomain();
        input.value = email;
        input.classList.remove('empty-animate');
        setBusy(button, false);
        if (mode === 'free') addAddress(email);
        state.list = [];
        state.count = 0;
        state.activeNewCount = 0;
        render();
        flashButton(button, 'Created');
        toast(email + ' is ready to use.', 'success', 'New email created');
    }

    function playSound() {
        if (!state.preferences.sound) return;
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            const context = new AudioContextClass();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 720;
            gain.gain.value = 0.035;
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.12);
            oscillator.onended = () => context.close();
        } catch (_) {
        }
    }

    function notifyNewMail(email, item, delta) {
        playSound();
        const latest = item.latest || {};
        toast((latest.subject ? latest.subject + ' · ' : '') + delta + ' new message' + (delta === 1 ? '' : 's') + ' for ' + email + '.', 'success', 'New mail arrived', { duration: 4400 });
        if (!state.preferences.notifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const note = new Notification('New temporary email', { body: email + '\n' + (latest.subject || (delta + ' new message' + (delta === 1 ? '' : 's'))) });
        note.onclick = function () {
            window.focus();
            selectAddress(email);
            note.close();
        };
    }

    async function pollAllInboxes() {
        if (mode !== 'free' || state.polling || !state.addressBook.addresses.length) return;
        state.polling = true;
        try {
            const addresses = state.addressBook.addresses.map((item) => item.email);
            const response = await ui.post('/api/emails/inboxes/status', { addresses });
            if (!response.done) throw new Error(response.error || 'Live inbox check failed');
            let refreshActive = false;
            let activeDelta = 0;
            for (const status of response.items || []) {
                const item = addressEntry(status.email);
                if (!item || status.protected) continue;
                const oldCount = Math.max(0, Number(item.messageCount || 0));
                const newCount = Math.max(0, Number(status.count || 0));
                const delta = Math.max(0, newCount - oldCount);
                item.messageCount = newCount;
                item.lastCheckedAt = Date.now();
                if (status.latest) {
                    item.lastMessageAt = new Date(status.latest.date || 0).getTime() || item.lastMessageAt;
                    item.lastMessageSubject = status.latest.subject || item.lastMessageSubject;
                    item.lastMessageFrom = status.latest.from || item.lastMessageFrom;
                }
                if (delta > 0 && state.pollReady) {
                    item.unreadCount = Math.max(0, Number(item.unreadCount || 0)) + delta;
                    notifyNewMail(item.email, status, delta);
                    if (item.email === state.addressBook.active && document.visibilityState === 'visible') {
                        refreshActive = true;
                        activeDelta = delta;
                    }
                }
            }
            saveAddressBook();
            renderAddressSidebar();
            const lastPoll = q('[data-last-poll]');
            if (lastPoll) lastPoll.textContent = 'Checked now';
            state.pollReady = true;
            if (refreshActive && !state.busy) await loadAll({ to: state.addressBook.active }, 500, { markRead: true, background: true, newCount: activeDelta });
        } catch (error) {
            const lastPoll = q('[data-last-poll]');
            if (lastPoll) lastPoll.textContent = 'Retrying…';
        } finally {
            state.polling = false;
        }
    }

    function setLiveLabel(text) {
        const lastPoll = q('[data-last-poll]');
        if (lastPoll) lastPoll.textContent = text || '';
    }

    function setPollingInterval(ms) {
        if (state.pollTimer) clearInterval(state.pollTimer);
        state.pollTimer = setInterval(pollAllInboxes, Math.max(5000, Number(ms || LIVE_POLL_MS)));
    }

    function closeLiveSource() {
        if (state.liveSource) {
            try { state.liveSource.close(); } catch (_) {}
        }
        state.liveSource = null;
    }

    async function applyLiveMail(payload) {
        const message = payload?.message || {};
        const matched = Array.isArray(payload?.matched) ? payload.matched : [];
        let refreshActive = false;
        for (const email of matched) {
            const item = addressEntry(email);
            if (!item) continue;
            item.messageCount = Math.max(0, Number(item.messageCount || 0)) + 1;
            item.unreadCount = Math.max(0, Number(item.unreadCount || 0)) + 1;
            item.lastCheckedAt = Date.now();
            item.lastMessageAt = new Date(message.date || Date.now()).getTime() || Date.now();
            item.lastMessageSubject = message.subject || item.lastMessageSubject;
            item.lastMessageFrom = message.from || item.lastMessageFrom;
            notifyNewMail(item.email, { latest: message }, 1);
            if (item.email === state.addressBook.active && document.visibilityState === 'visible') refreshActive = true;
        }
        saveAddressBook();
        renderAddressSidebar();
        setLiveLabel('Live push');
        if (refreshActive && !state.busy) await loadAll({ to: state.addressBook.active }, 500, { markRead: true, background: true, newCount: 1 });
    }

    function connectLiveSse() {
        closeLiveSource();
        if (mode !== 'free' || typeof EventSource === 'undefined' || !state.addressBook.addresses.length) {
            state.liveMode = 'poll';
            setPollingInterval(LIVE_POLL_MS);
            setLiveLabel('Live polling');
            return;
        }
        const addresses = state.addressBook.addresses.map((item) => item.email).join(',');
        const source = new EventSource('/api/emails/live?addresses=' + encodeURIComponent(addresses));
        state.liveSource = source;
        source.addEventListener('ready', function () {
            if (state.liveSource !== source) return;
            state.liveMode = 'sse';
            setPollingInterval(LIVE_RECONCILE_MS);
            setLiveLabel('Live push');
        });
        source.addEventListener('mail', async function (event) {
            if (state.liveSource !== source) return;
            try { await applyLiveMail(JSON.parse(event.data || '{}')); } catch (_) {}
        });
        source.onerror = function () {
            if (state.liveSource !== source) return;
            closeLiveSource();
            state.liveMode = 'poll';
            setPollingInterval(LIVE_POLL_MS);
            setLiveLabel('Reconnecting…');
            if (state.liveReconnectTimer) clearTimeout(state.liveReconnectTimer);
            state.liveReconnectTimer = setTimeout(connectLiveSse, 12000);
        };
    }

    function scheduleLiveReconnect() {
        if (state.liveReconnectTimer) clearTimeout(state.liveReconnectTimer);
        state.liveReconnectTimer = setTimeout(connectLiveSse, 250);
    }

    function startLivePolling() {
        setPollingInterval(LIVE_POLL_MS);
        pollAllInboxes();
        connectLiveSse();
    }

    async function toggleNotifications() {
        if (typeof Notification === 'undefined') return toast('Browser notifications are not supported here.', 'warning', 'Notifications unavailable');
        if (state.preferences.notifications) {
            state.preferences.notifications = false;
            savePreferences();
            toast('Desktop notifications are now off.', 'info', 'Notifications disabled');
            return;
        }
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission !== 'granted') return toast('Notification permission was not granted.', 'warning', 'Notifications not enabled');
        state.preferences.notifications = true;
        savePreferences();
        toast('You will be notified when new mail arrives.', 'success', 'Notifications enabled');
    }

    function toggleSound() {
        state.preferences.sound = !state.preferences.sound;
        savePreferences();
        if (state.preferences.sound) playSound();
        toast(state.preferences.sound ? 'A sound will play when new mail arrives.' : 'New mail sounds are now off.', state.preferences.sound ? 'success' : 'info', state.preferences.sound ? 'Sound enabled' : 'Sound disabled');
    }

    function setDataToolStatus(message, error) {
        const status = q('[data-data-tool-status]');
        if (!status) return;
        status.textContent = message || '';
        status.style.color = error ? '#fca5a5' : '#86efac';
    }

    function exportAddresses() {
        const payload = { format: 'social-temp-mail-address-book', version: ADDRESS_BOOK_VERSION, exportedAt: new Date().toISOString(), domain: currentDomain(), active: state.addressBook.active, addresses: state.addressBook.addresses };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'temp-mail-addresses-' + currentDomain().replace(/[^a-z0-9.-]/gi, '_') + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDataToolStatus('Backup downloaded. Keep the file somewhere safe if you want to restore this list later.');
        toast('Your saved email list was exported as a local backup.', 'success', 'Backup downloaded');
    }

    function importedAddressEntries(value) {
        if (Array.isArray(value)) return { active: '', entries: value.map((item) => typeof item === 'string' ? { email: item } : item).filter((item) => item && item.email) };
        if (value && Array.isArray(value.addresses)) return { active: normalizeMailbox(value.active), entries: value.addresses.map((item) => typeof item === 'string' ? { email: item } : item).filter((item) => item && item.email) };
        return { active: '', entries: [] };
    }

    async function importAddresses(file) {
        if (!file) return;
        const text = await file.text();
        let imported = { active: '', entries: [] };
        try {
            imported = importedAddressEntries(JSON.parse(text));
        } catch (_) {
            imported.entries = text.split(/[\r\n,;\s]+/).filter(Boolean).map((email) => ({ email }));
        }
        let added = 0;
        let skipped = 0;
        for (const source of imported.entries) {
            const email = normalizeMailbox(source.email);
            if (!email || addressEntry(email)) {
                skipped += 1;
                continue;
            }
            if (state.addressBook.addresses.length >= state.client.addressLimit) break;
            if (!addAddress(email, { activate: false, silentLimit: true })) continue;
            const item = addressEntry(email);
            if (item && source && typeof source === 'object') {
                item.label = String(source.label || '');
                item.createdAt = Number(source.createdAt || item.createdAt || Date.now());
                item.lastCheckedAt = Number(source.lastCheckedAt || 0);
                item.messageCount = Math.max(0, Number(source.messageCount || 0));
                item.unreadCount = Math.max(0, Number(source.unreadCount || 0));
                item.lastMessageAt = Number(source.lastMessageAt || 0);
                item.lastMessageSubject = String(source.lastMessageSubject || '');
                item.lastMessageFrom = String(source.lastMessageFrom || '');
            }
            added += 1;
        }
        if (imported.active && addressEntry(imported.active)) state.addressBook.active = imported.active;
        saveAddressBook();
        renderAddressSidebar();
        if (state.addressBook.addresses.length >= state.client.addressLimit && imported.entries.length > added + skipped) showLimitAlert(limitReachedMessage());
        const importMessage = 'Imported ' + added + ' address' + (added === 1 ? '' : 'es') + (skipped ? '. Skipped ' + skipped + ' duplicate or invalid entr' + (skipped === 1 ? 'y.' : 'ies.') : '.') + (imported.active && addressEntry(imported.active) ? ' Active address restored.' : '');
        setDataToolStatus(importMessage);
        toast(importMessage, added ? 'success' : 'info', added ? 'Import complete' : 'Nothing imported');
        pollAllInboxes();
    }

    function showQr() {
        const email = normalizeMailbox(q('[data-mail-address]')?.value || '');
        if (!email) return toast('Enter or choose a valid email address first.', 'warning', 'Email address required');
        const image = q('[data-qr-image]');
        const label = q('[data-qr-email]');
        if (image) image.src = '/api/emails/qr?email=' + encodeURIComponent(email);
        if (label) label.textContent = email;
        ui.show('#mailQrModal');
        toast('Scan the QR code to move this email address to another device.', 'info', 'QR code ready', { duration: 2400 });
    }

    function downloadEml() {
        if (!state.currentEmail) return;
        const link = document.createElement('a');
        link.href = '/api/emails/eml?guid=' + encodeURIComponent(state.currentEmail.guid) + '&email=' + encodeURIComponent(state.currentMailbox);
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast('The EML download has started.', 'success', 'Message download');
    }

    function toggleRemoteImages(button) {
        if (!state.currentEmail) return;
        const frame = document.querySelector('#div-message');
        const allow = button.dataset.remoteState !== 'loaded';
        if (frame) frame.src = viewFrameUrl(allow);
        button.dataset.remoteState = allow ? 'loaded' : 'blocked';
        const label = button.querySelector('[data-button-label]');
        if (label) label.textContent = allow ? 'Block Remote Images' : 'Load Remote Images';
        toast(allow ? 'Remote images are now visible for this message.' : 'Remote images are blocked again.', allow ? 'warning' : 'success', allow ? 'Remote images loaded' : 'Privacy protection restored');
    }

    function showCompose(type) {
        const reply = document.querySelector('[data-reply-panel]');
        const forward = document.querySelector('[data-forward-panel]');
        if (reply) reply.hidden = type !== 'reply';
        if (forward) forward.hidden = type !== 'forward';
    }

    async function sendReply(button) {
        if (!state.currentEmail || !state.client.isSocialBrowser) return;
        const text = String(document.querySelector('[data-reply-text]')?.value || '').trim();
        if (!text) return toast('Write a reply before sending.', 'warning', 'Reply is empty');
        setBusy(button, true, 'Sending…');
        const response = await ui.post('/api/emails/reply', { guid: state.currentEmail.guid, from: state.currentMailbox, text });
        setBusy(button, false);
        if (!response.done) return setError(response.error || 'Reply failed', '[data-view-error]');
        const area = document.querySelector('[data-reply-text]');
        if (area) area.value = '';
        showCompose('');
        flashButton(button, 'Sent');
        toast('Your reply was sent from this temporary mailbox.', 'success', 'Reply sent');
    }

    async function sendForward(button) {
        if (!state.currentEmail || !state.client.isSocialBrowser) return;
        const to = normalizeMailbox(document.querySelector('[data-forward-to]')?.value || '');
        const text = String(document.querySelector('[data-forward-text]')?.value || '').trim();
        if (!to) return toast('Enter a valid destination email.', 'warning', 'Destination required');
        setBusy(button, true, 'Sending…');
        const response = await ui.post('/api/emails/forward', { guid: state.currentEmail.guid, from: state.currentMailbox, to, text });
        setBusy(button, false);
        if (!response.done) return setError(response.error || 'Forward failed', '[data-view-error]');
        const toInput = document.querySelector('[data-forward-to]');
        const textInput = document.querySelector('[data-forward-text]');
        if (toInput) toInput.value = '';
        if (textInput) textInput.value = '';
        showCompose('');
        flashButton(button, 'Sent');
        toast('The message was forwarded successfully.', 'success', 'Message forwarded');
    }

    root.addEventListener('click', async function (event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.getAttribute('data-action');
        try {
            if (action === 'generate-email') return generateEmail(button);
            if (action === 'copy-email') return copyWithFeedback(button, q('[data-mail-address]')?.value || '', 'Email address copied to clipboard.');
            if (action === 'check-inbox') return checkInbox(button);
            if (action === 'select-address') return selectAddress(button.dataset.email);
            if (action === 'remove-address') return removeAddress(button.dataset.email);
            if (action === 'dismiss-limit-alert') return hideLimitAlert();
            if (action === 'toggle-notifications') return toggleNotifications();
            if (action === 'toggle-sound') return toggleSound();
            if (action === 'open-data-tools') { setDataToolStatus(''); return ui.show('#mailDataModal'); }
            if (action === 'export-addresses') return exportAddresses();
            if (action === 'import-addresses') return q('[data-address-import-file]')?.click();
            if (action === 'show-qr') return showQr();
            if (action === 'copy-qr-email') return copyWithFeedback(button, q('[data-qr-email]')?.textContent || '', 'Email address copied from the QR panel.');
            if (action === 'view') return viewEmail(button.dataset.guid);
            if (action === 'copy-verification-code') return copyWithFeedback(button, document.querySelector('[data-verification-code]')?.textContent || '', 'Verification code copied to clipboard.');
            if (action === 'load-remote-images') return toggleRemoteImages(button);
            if (action === 'download-eml') return downloadEml();
            if (action === 'download-attachment') return toast((button.dataset.filename || 'Attachment') + ' download started.', 'success', 'Attachment download');
            if (action === 'open-verification-link') return toast('Opening the verification link in a new tab.', 'info', 'Verification link', { duration: 1800 });
            if (action === 'show-reply') return showCompose('reply');
            if (action === 'show-forward') return showCompose('forward');
            if (action === 'cancel-compose') return showCompose('');
            if (action === 'send-reply') return sendReply(button);
            if (action === 'send-forward') return sendForward(button);
            if (action === 'delete') return deleteEmail(button.dataset.guid);
            if (action === 'new-email') return ui.show('#addEmailModal');
            if (action === 'send-email') return sendEmail();
            if (action === 'open-search') return ui.show('#SearchModal');
            if (action === 'load-all') return loadAll({}, 500);
            if (action === 'smart-search') return loadAll({ search: q('[data-search-text]')?.value || '' }, 500);
            if (action === 'search-value') return loadAll({ search: button.dataset.value || '' }, 500);
            if (action === 'vip') { const updated = await setVip(button.dataset.value, true); if (!updated) return; flashButton(button, 'VIP'); return toast('This email is now protected as VIP.', 'success', 'VIP enabled'); }
            if (action === 'normal') { const updated = await setVip(button.dataset.value, false); if (!updated) return; flashButton(button, 'Normal'); return toast('VIP protection was removed for this email.', 'success', 'Set as normal'); }
            if (action === 'all-profiles-vip') return setAllProfilesVip(true);
            if (action === 'all-profiles-normal') return setAllProfilesVip(false);
            if (action === 'delete-visible') return deleteMatching(state.currentWhere);
            if (action === 'run-search') {
                const search = searchFormData();
                ui.hide('#SearchModal');
                return loadAll(search.where, search.limit);
            }
            if (action === 'delete-matching') {
                const search = searchFormData();
                return deleteMatching(search.where);
            }
            if (action === 'clear-search') {
                const form = document.querySelector('[data-search-form]');
                form?.reset();
                const limit = form?.querySelector('[name="limit"]');
                if (limit) limit.value = '500';
                toast('Search filters were cleared.', 'info', 'Filters cleared', { duration: 1600 });
            }
        } catch (error) {
            setError(error.message || String(error));
        }
    });

    const localSearch = q('[data-search-text]');
    if (localSearch) localSearch.addEventListener('input', render);

    const addressSearch = q('[data-address-search]');
    if (addressSearch) addressSearch.addEventListener('input', function () { state.sidebarSearch = addressSearch.value || ''; renderAddressSidebar(); });

    const addressSort = q('[data-address-sort]');
    if (addressSort) addressSort.addEventListener('change', function () { state.sidebarSort = addressSort.value || 'recent'; renderAddressSidebar(); });

    const importFile = q('[data-address-import-file]');
    if (importFile) importFile.addEventListener('change', async function () {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (!file) return;
        try {
            setDataToolStatus('Importing…');
            await importAddresses(file);
        } catch (error) {
            const message = error.message || 'Unable to import this file.';
            setDataToolStatus(message, true);
            toast(message, 'error', 'Import failed');
        }
    });

    const mailboxInput = q('[data-mail-address]');
    if (mailboxInput) {
        mailboxInput.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const button = q('[data-action="check-inbox"]');
            checkInbox(button);
        });
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') pollAllInboxes();
    });

    async function initFree() {
        await loadClientContext();
        readPreferences();
        readAddressBook();
        const input = q('[data-mail-address]');
        const queryEmail = normalizeMailbox(new URLSearchParams(location.search).get('email'));
        if (queryEmail) addAddress(queryEmail);
        if (!state.addressBook.addresses.length) addAddress(makeId() + '@' + currentDomain());
        const active = queryEmail && addressEntry(queryEmail) ? queryEmail : state.addressBook.active || state.addressBook.addresses[0]?.email || '';
        state.addressBook.active = active;
        saveAddressBook();
        if (input) {
            input.value = active;
            input.placeholder = 'name@' + currentDomain();
        }
        renderAddressSidebar();
        if (active) await loadAll({ to: active }, 500, { markRead: true });
        else render();
        state.pollReady = true;
        startLivePolling();
    }

    async function init() {
        if (mode === 'admin') {
            try {
                const status = window.SBBrowserAuth ? await SBBrowserAuth.status() : null;
                if (!status || !status.loggedIn) {
                    location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
                    return;
                }
            } catch (_) {
                location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
                return;
            }
            await loadClientContext();
            await loadAll({}, 500);
            return;
        }
        await initFree();
    }

    init();
})();
