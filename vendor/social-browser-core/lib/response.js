'use strict';

const fs = require('fs');
const path = require('path');

const mime = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.xml':'application/xml; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.pdf':'application/pdf',
  '.zip':'application/zip','.woff':'font/woff','.woff2':'font/woff2'
};

function enhanceResponse(res, site) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (name, value) => {
    if (typeof name === 'object') for (const [k,v] of Object.entries(name)) res.setHeader(k,v);
    else res.setHeader(name, value);
    return res;
  };
  res.header = res.set;
  res.get = (name) => res.getHeader(name);
  res.remove = (name) => { res.removeHeader(name); return res; };
  res.links = (links={}) => {
    const value=Object.entries(links).map(([rel,url])=>`<${url}>; rel="${rel}"`).join(', ');
    if(value)res.setHeader('Link',value);
    return res;
  };
  res.append = (name,value) => {
    const prev = res.getHeader(name);
    res.setHeader(name, prev == null ? value : [].concat(prev,value));
    return res;
  };
  res.location = (value) => { res.setHeader('Location', String(value)); return res; };
  res.vary = (field) => {
    const prev = String(res.getHeader('Vary') || '').split(',').map(x=>x.trim()).filter(Boolean);
    if (!prev.includes(field)) prev.push(field);
    res.setHeader('Vary', prev.join(', '));
    return res;
  };
  res.type = (value) => {
    const ext = value.startsWith('.') ? value : `.${value}`;
    res.setHeader('Content-Type', mime[ext] || value);
    return res;
  };
  res.json = (data) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
    return res;
  };
  res.txt = (data) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(String(data ?? ''));
    return res;
  };
  res.send = (data) => {
    if (Buffer.isBuffer(data)) return res.end(data);
    if (data !== null && typeof data === 'object') return res.json(data);
    if (!res.headersSent) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(String(data ?? ''));
    return res;
  };
  res.sendStatus = (code) => {
    res.statusCode = code;
    res.end(String(code));
    return res;
  };
  res.redirect = (code, location) => {
    if (location === undefined) { location = code; code = 302; }
    res.statusCode = code;
    res.setHeader('Location', String(location));
    res.end();
    return res;
  };
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.expires) parts.push(`Expires=${new Date(opts.expires).toUTCString()}`);
    if (opts.path !== false) parts.push(`Path=${opts.path || '/'}`);
    if (opts.httpOnly !== false) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : parts.join('; '));
    return res;
  };
  res.clearCookie = (name, opts={}) => res.cookie(name, '', {...opts, expires:new Date(0), maxAge:0});
  res.download = (file, downloadName=null) => {
    try {
      const stat = site.fileCache?.statSync?site.fileCache.statSync(file):fs.statSync(file);
      if (!stat.isFile()) {
        res.statusCode = 404;
        res.end();
        return res;
      }
      const size = stat.size;
      const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const lastModified = stat.mtime.toUTCString();
      const reqHeaders = res.req?.headers || {};

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      if (downloadName) res.attachment(downloadName);

      const ifNoneMatch = reqHeaders['if-none-match'];
      if (ifNoneMatch && String(ifNoneMatch).split(/\s*,\s*/).includes(etag)) {
        res.statusCode = 304;
        res.removeHeader('Content-Length');
        res.end();
        return res;
      }

      let startByte = 0;
      let endByte = size - 1;
      let partial = false;
      const range = reqHeaders.range;
      const ifRange = reqHeaders['if-range'];
      const canUseRange = !ifRange || ifRange === etag || ifRange === lastModified;

      if (range && canUseRange) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (match) {
          if (match[1] === '' && match[2] !== '') {
            const suffix = Number(match[2]);
            if (suffix > 0) {
              startByte = Math.max(0, size - suffix);
              endByte = size - 1;
              partial = true;
            }
          } else {
            startByte = match[1] === '' ? 0 : Number(match[1]);
            endByte = match[2] === '' ? size - 1 : Number(match[2]);
            if (!Number.isFinite(startByte) || !Number.isFinite(endByte) ||
                startByte < 0 || endByte < startByte || startByte >= size) {
              res.statusCode = 416;
              res.setHeader('Content-Range', `bytes */${size}`);
              res.setHeader('Content-Length', '0');
              res.end();
              return res;
            }
            endByte = Math.min(endByte, size - 1);
            partial = true;
          }
        }
      }

      if (partial) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${size}`);
        res.setHeader('Content-Length', String(endByte - startByte + 1));
        if(site.fileCache&&size<=site.fileCache.maxEntryBytes){res.end(site.fileCache.getBufferSync(file).subarray(startByte,endByte+1));return res}
        fs.createReadStream(file, { start:startByte, end:endByte }).pipe(res);
        return res;
      }

      res.statusCode = res.statusCode || 200;
      res.setHeader('Content-Length', String(size));
      if(site.fileCache&&size<=site.fileCache.maxEntryBytes){res.end(site.fileCache.getBufferSync(file));return res}
      fs.createReadStream(file).pipe(res);
      return res;
    } catch (err) {
      if (!res.headersSent) res.statusCode = err?.code === 'ENOENT' ? 404 : 500;
      if (!res.writableEnded) res.end();
      return res;
    }
  };
  res.sendFile = (file) => res.file(file);
  res.attachment = (name='download') => {
    res.setHeader('Content-Disposition', `attachment; filename="${String(name).replaceAll('"','')}"`);
    return res;
  };
  res.file = (file) => {
    const stat = site.fileCache?.statSync?site.fileCache.statSync(file):fs.statSync(file);
    const ext=path.extname(file).toLowerCase();
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    const compressible=/\.(?:css|js|mjs|cjs|json|xml|svg|txt)$/i.test(file);
    if(site.fileCache&&compressible&&stat.size<=site.fileCache.maxEntryBytes&&!res.req?.headers?.range){
      const packed=site.fileCache.selectCompressedSync?.(file,res.req?.headers?.['accept-encoding']);
      if(packed?.buffer){
        res.setHeader('Content-Encoding',packed.encoding);
        res.setHeader('Vary','Accept-Encoding');
        res.setHeader('Content-Length',packed.buffer.length);
        res.end(packed.buffer);return res;
      }
    }
    res.setHeader('Content-Length', stat.size);
    if(site.fileCache&&stat.size<=site.fileCache.maxEntryBytes){res.end(site.fileCache.getBufferSync(file));return res}
    fs.createReadStream(file).pipe(res);
    return res;
  };
  res.render = (file, data = {}) => site.render(file, data, res);
  return res;
}

module.exports = { enhanceResponse, mime };
