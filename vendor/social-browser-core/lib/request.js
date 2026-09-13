'use strict';

const { URL } = require('url');
const { parseMultipart } = require('./multipart');

function parseCookies(header = '') {
  const out = {};
  for (const chunk of header.split(';')) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    const k = chunk.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(chunk.slice(i + 1).trim()); }
    catch { out[k] = chunk.slice(i + 1).trim(); }
  }
  return out;
}

async function readBody(req, options = {}) {
  const ctype = String(req.headers['content-type'] || '').toLowerCase();
  if (ctype.startsWith('multipart/form-data')) {
    const parsed = await parseMultipart(req, options);
    req.files = parsed.files;
    req.multipart = parsed;
    return parsed.fields;
  }
  const max = Number(options.maxBodyBytes || 10 * 1024 * 1024);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  req.rawBody = raw;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (!raw.length) return {};
  if (type === 'application/json' || type.endsWith('+json')) {
    try { return JSON.parse(raw.toString('utf8')); }
    catch {
      const err = new Error('Invalid JSON body');
      err.statusCode = 400;
      throw err;
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const out = {};
    const p = new URLSearchParams(raw.toString('utf8'));
    for (const [k, v] of p) {
      if (Object.hasOwn(out, k)) out[k] = [].concat(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  if (type.startsWith('text/')) return raw.toString('utf8');
  return raw;
}


function parseBrowserIdentity(req) {
  const xBrowserHeader = String(req.headers?.['x-browser'] || '').trim();
  const browserToken = String(req.headers?.['x-browser-token'] || '').trim();

  req.browserToken = browserToken;

  if (xBrowserHeader) {
    const firstDot = xBrowserHeader.indexOf('.');
    req.browserHeader = xBrowserHeader;
    req.browserName = firstDot >= 0 ? xBrowserHeader.slice(0, firstDot).trim() : '';
    req.browserID = firstDot >= 0 ? xBrowserHeader.slice(firstDot + 1).trim() : xBrowserHeader;
    req.browserUUID = String(req.browserID || '').split('_').pop() || '';
    req.browserIDShort = req.browserUUID;
    req.browserFullID = req.browserID;
    req.browserCanonicalID = req.browserUUID;
    req.browserDetected = true;
    req.isSocialBrowser = /^(?:social|social browser)$/i.test(req.browserName || '');
    req.browserAuth = {
      detected: true,
      socialBrowser: req.isSocialBrowser,
      tokenPresent: !!req.browserToken,
      browserHeader: req.browserHeader,
      browserName: req.browserName,
      browserID: req.browserID,
      browserUUID: req.browserUUID,
      browserIDShort: req.browserIDShort,
      browserFullID: req.browserFullID,
      browserCanonicalID: req.browserCanonicalID,
    };
  } else {
    req.browserHeader = '';
    req.browserName = '';
    req.browserID = '';
    req.browserUUID = '';
    req.browserIDShort = '';
    req.browserFullID = '';
    req.browserCanonicalID = '';
    req.browserDetected = false;
    req.isSocialBrowser = false;
    req.browserAuth = {
      detected: false,
      socialBrowser: false,
      tokenPresent: !!req.browserToken,
    };
  }

  return req.browserAuth;
}

function enhanceRequest(req, options = {}) {
  const proto = req.socket.encrypted ? 'https:' : 'http:';
  const host = req.headers.host || 'localhost';
  const u = new URL(req.url || '/', `${proto}//${host}`);
  req.protocol = proto.slice(0, -1);
  req.host = host;
  req.hostname = u.hostname;
  req.path = u.pathname;
  req.pathname = u.pathname;
  req.query = Object.fromEntries(u.searchParams.entries());
  req.params = {};
  req.cookies = parseCookies(req.headers.cookie);
  req.ip = req.socket.remoteAddress || '';
  req.originalUrl = req.url;
  req.requestId = req.headers['x-request-id'] || (globalThis.crypto?.randomUUID?.() || require('crypto').randomBytes(12).toString('hex'));
  const controller = new AbortController();
  req.abortController = controller;
  req.abortSignal = controller.signal;

  // Node.js 24+ exposes IncomingMessage.signal as a getter-only property.
  // Never assign to it. Reuse the native signal when present and mirror
  // native/request aborts into Core's controller. On older Node versions,
  // expose Core's signal as req.signal without mutating a getter-only API.
  let nativeSignal = null;
  try { nativeSignal = req.signal || null; } catch {}
  if (nativeSignal && typeof nativeSignal.addEventListener === 'function') {
    if (nativeSignal.aborted) {
      try { controller.abort(nativeSignal.reason); } catch {}
    } else {
      nativeSignal.addEventListener('abort', () => {
        try { controller.abort(nativeSignal.reason); } catch {}
      }, { once:true });
    }
  } else {
    try {
      Object.defineProperty(req, 'signal', {
        value: controller.signal,
        configurable: true,
        enumerable: false,
        writable: false
      });
    } catch {}
  }
  req.on('aborted',()=>{try{controller.abort()}catch{}});
  req.on('close',()=>{if(!req.complete)try{controller.abort()}catch{}});

  req.baseUrl = '';
  req.secure = !!req.socket.encrypted;
  req.xhr = String(req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
  req.accepts = (type) => String(req.headers.accept || '*/*').includes(type) || String(req.headers.accept || '').includes('*/*');
  req.param = (name, fallback) => req.params?.[name] ?? req.body?.[name] ?? req.query?.[name] ?? fallback;
  req.getUserAgent = () => req.headers['user-agent'] || '';
  parseBrowserIdentity(req);
  req.get = (name) => req.headers[String(name).toLowerCase()];
  req.header = req.get;
  req.is = (type) => String(req.headers['content-type'] || '').includes(type);
  return req;
}

module.exports = { enhanceRequest, readBody, parseCookies, parseBrowserIdentity };
