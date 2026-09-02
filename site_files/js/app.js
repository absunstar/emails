(function () {
    'use strict';

    const SBUI = (window.SBUI = window.SBUI || {});

    SBUI.q = (selector, root) => (root || document).querySelector(selector);
    SBUI.qa = (selector, root) => Array.from((root || document).querySelectorAll(selector));

    SBUI.show = function (target) {
        const el = typeof target === 'string' ? SBUI.q(target) : target;
        if (!el) return;
        if (window.site && typeof site.showModal === 'function' && el.classList.contains('modal')) {
            site.showModal('#' + el.id);
            return;
        }
        el.hidden = false;
        el.classList.add('is-open');
    };

    SBUI.hide = function (target) {
        const el = typeof target === 'string' ? SBUI.q(target) : target;
        if (!el) return;
        if (window.site && typeof site.hideModal === 'function' && el.classList.contains('modal')) {
            site.hideModal('#' + el.id);
            return;
        }
        el.hidden = true;
        el.classList.remove('is-open');
    };

    SBUI.post = async function (url, data) {
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(data || {}),
        });
        const text = await response.text();
        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (error) {
            payload = { done: false, error: text || 'Invalid server response' };
        }
        if (!response.ok && payload.done !== false) payload.done = false;
        return payload;
    };

    SBUI.copy = async function (text) {
        const value = String(text || '');
        if (window.SOCIALBROWSER && typeof SOCIALBROWSER.copy === 'function') {
            SOCIALBROWSER.copy(value);
            return true;
        }
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            return true;
        }
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    };



    SBUI.toast = function (message, options) {
        const settings = typeof options === 'string' ? { type: options } : (options || {});
        const text = String(message || '').trim();
        if (!text) return null;
        let host = SBUI.q('[data-sb-toast-host]');
        if (!host) {
            host = document.createElement('div');
            host.className = 'sb-toast-host';
            host.setAttribute('data-sb-toast-host', '');
            host.setAttribute('aria-live', 'polite');
            host.setAttribute('aria-atomic', 'false');
            document.body.appendChild(host);
        }
        const type = ['success', 'error', 'warning', 'info'].includes(settings.type) ? settings.type : 'info';
        const toast = document.createElement('div');
        toast.className = 'sb-toast sb-toast-' + type;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const icon = type === 'success'
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>'
            : type === 'error'
                ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9 9 6 6M15 9l-6 6"></path></svg>'
                : type === 'warning'
                    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"></path><path d="M12 9v5M12 17h.01"></path></svg>'
                    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>';
        const title = String(settings.title || (type === 'success' ? 'Done' : type === 'error' ? 'Something went wrong' : type === 'warning' ? 'Attention' : 'Info'));
        toast.innerHTML = '<span class="sb-toast-icon">' + icon + '</span><span class="sb-toast-copy"><strong>' + SBUI.escape(title) + '</strong><span>' + SBUI.escape(text) + '</span></span><button class="sb-toast-close" type="button" aria-label="Dismiss notification">×</button><span class="sb-toast-progress"></span>';
        host.appendChild(toast);
        const close = () => {
            if (toast.dataset.closing === '1') return;
            toast.dataset.closing = '1';
            toast.classList.add('is-leaving');
            setTimeout(() => toast.remove(), 180);
        };
        toast.querySelector('.sb-toast-close').addEventListener('click', close);
        requestAnimationFrame(() => toast.classList.add('is-visible'));
        const duration = Math.max(1200, Number(settings.duration || (type === 'error' ? 5200 : 3400)));
        toast.style.setProperty('--toast-duration', duration + 'ms');
        if (settings.sticky !== true) setTimeout(close, duration);
        return toast;
    };

    SBUI.escape = function (value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    SBUI.dateTime = function (value) {
        if (!value) return '';
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    };

    document.addEventListener('click', function (event) {
        const close = event.target.closest('[data-modal-close]');
        if (close) {
            event.preventDefault();
            SBUI.hide(close.getAttribute('data-modal-close'));
        }
        if (event.target.classList && event.target.classList.contains('modal')) SBUI.hide(event.target);
    });

    document.addEventListener('DOMContentLoaded', function () {
        document.body.classList.add('sb-ready');
    });
})();
