'use strict';
(() => {
  const q = (s) => document.querySelector(s);
  const status = q('[data-status]');
  const accept = q('[data-accept]');
  const login = q('[data-login]');
  const params = new URLSearchParams(location.search);
  const token = String(params.get('token') || '').trim();
  const setStatus = (text, type) => {
    status.textContent = text;
    status.className = 'status' + (type ? ' ' + type : '');
  };
  async function json(url, body) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json();
  }
  async function boot() {
    try {
      const config = await json('/api/v2/instance/public');
      const product = config?.config?.brand?.productName || config?.config?.instance?.name || '';
      if (product) q('[data-product]').textContent = product;
    } catch (_) {}
    if (!token) {
      setStatus('This invitation link is missing its token.', 'error');
      return;
    }
    const next = '/join?token=' + encodeURIComponent(token);
    login.href = '/login?next=' + encodeURIComponent(next);
    let auth;
    try { auth = await json('/api/v2/browser-auth/status'); } catch (_) {}
    if (!auth?.loggedIn) {
      setStatus('Sign in with Social Browser on this device before accepting the invitation.');
      login.hidden = false;
      return;
    }
    setStatus('Social Browser detected. You can now accept this organization invitation.');
    accept.hidden = false;
  }
  accept.addEventListener('click', async () => {
    accept.disabled = true;
    setStatus('Accepting invitation…');
    try {
      const result = await json('/api/v2/tenant/invitations/accept', { token });
      if (!result?.done) throw new Error(result?.error || 'Unable to accept invitation.');
      setStatus('Invitation accepted. Opening your organization workspace…', 'success');
      setTimeout(() => location.replace('/admin'), 350);
    } catch (error) {
      setStatus(error.message || 'Unable to accept invitation.', 'error');
      accept.disabled = false;
    }
  });
  boot();
})();