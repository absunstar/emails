(function () {
    'use strict';
    const root = document.querySelector('[data-browser-login-page]');
    if (!root) return;
    const q = (selector) => root.querySelector(selector);
    const button = q('[data-browser-login]');
    const message = q('[data-browser-message]');
    const download = q('[data-browser-download]');
    const note = q('[data-browser-note]');
    const copyButton = q('[data-copy-page-link]');
    const copyLabel = q('[data-copy-label]');
    const params = new URLSearchParams(location.search);
    const next = ((value) => value && value[0] === '/' && value[1] !== '/' ? value : '/')(params.get('next') || '/');
    const originalCopy = 'Copy this page link';
    const translate = (value) => (window.__emailUITranslation || {})[value] || value;
    const toast = (text, settings) => {
        if (!window.SBUI || !SBUI.toast) return;
        const options = Object.assign({}, settings);
        if (options.title) options.title = translate(options.title);
        SBUI.toast(translate(text), options);
    };
    function setButtonLabel(value) {
        const label = button && button.querySelector('[data-button-label]');
        if (label) label.textContent = translate(value);
    }
    function setState(name) {
        root.classList.remove('is-checking', 'needs-browser', 'is-ready', 'has-error');
        root.classList.add(name);
    }
    function showGuestActions() {
        if (download) download.hidden = false;
        if (copyButton) copyButton.hidden = false;
        if (button) button.hidden = false;
        if (note) note.hidden = false;
    }
    function hideGuestActions() {
        if (download) download.hidden = false;
        if (copyButton) copyButton.hidden = false;
        if (button) button.hidden = true;
        if (note) note.hidden = false;
    }
    async function refresh(manual) {
        setState('is-checking');
        hideGuestActions();
        if (button) {
            button.disabled = true;
            button.classList.add('is-busy');
        }
        setButtonLabel('Checking…');
        if (message) message.textContent = translate('Checking whether this page is already open in Social Browser…');
        try {
            if (!window.SBBrowserAuth) throw new Error('browser_auth_unavailable');
            let timeout;
            const timedOut = new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('browser_auth_timeout')), 8500);
            });
            let status;
            try {
                status = await Promise.race([
                    SBBrowserAuth.signIn ? SBBrowserAuth.signIn() : SBBrowserAuth.status(),
                    timedOut,
                ]);
            } finally {
                clearTimeout(timeout);
            }
            if (status && status.loggedIn) {
                setState('is-ready');
                if (message) message.textContent = translate('Social Browser is ready. Continuing…');
                toast('Continuing to the requested page.', { type: 'success', title: 'Social Browser is ready', duration: 1500 });
                location.replace(next);
                return;
            }
            setState('needs-browser');
            if (message) message.textContent = translate('Open this same page in Social Browser to continue.');
            showGuestActions();
            setButtonLabel(manual ? 'Check Again' : 'I opened it — Check Again');
            if (manual) toast('This page is not open in Social Browser yet.', { type: 'info', title: 'Open the page in Social Browser', duration: 2600 });
        } catch (error) {
            setState('has-error');
            if (message) message.textContent = translate('We could not complete the check. Open this page in Social Browser and try again.');
            showGuestActions();
            setButtonLabel('Try Again');
            toast('We could not complete the check. Please try again.', { type: 'error', title: 'Check failed' });
        } finally {
            if (button) {
                button.disabled = false;
                button.classList.remove('is-busy');
            }
        }
    }
    if (button) button.addEventListener('click', () => refresh(true));
    if (copyButton) copyButton.addEventListener('click', async () => {
        try {
            const ok = window.SBUI && SBUI.copy ? await SBUI.copy(location.href) : false;
            if (!ok) throw new Error('copy_failed');
            if (copyLabel) copyLabel.textContent = translate('Copied');
            copyButton.classList.add('is-success');
            toast('Page link copied. Open it in Social Browser.', { type: 'success', title: 'Link copied' });
            setTimeout(() => {
                if (copyLabel) copyLabel.textContent = translate(originalCopy);
                copyButton.classList.remove('is-success');
            }, 1500);
        } catch (_) {
            toast('Could not copy the page link.', { type: 'error', title: 'Copy failed' });
        }
    });
    if (download) download.addEventListener('click', () => {
        toast('Opening the official Windows download.', { type: 'info', title: 'Download Social Browser', duration: 1800 });
    });
    refresh(false);
})();
