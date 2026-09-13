'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, randomId } = require('./utils');

function parseHeaderParams(value = '') {
  const out = {};
  for (const part of value.split(';').slice(1)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0,i).trim().toLowerCase();
    let v = part.slice(i+1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1,-1);
    out[k] = v;
  }
  return out;
}

async function parseMultipart(req, options = {}) {
  const contentType = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw Object.assign(new Error('Missing multipart boundary'), {statusCode:400});
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const maxBodyBytes = Number(options.maxBodyBytes || 20 * 1024 * 1024);
  const maxFileBytes = Number(options.maxFileBytes || 50 * 1024 * 1024);
  const cwd = path.resolve(options.cwd || process.cwd());
  const requestedUploadDir=options.uploadDir
    ? (path.isAbsolute(options.uploadDir)?path.resolve(options.uploadDir):path.resolve(cwd,options.uploadDir))
    : path.join(cwd,'.social-browser','uploads');
  const uploadDir = ensureDir(requestedUploadDir);

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) throw Object.assign(new Error('Multipart body too large'), {statusCode:413});
    chunks.push(chunk);
  }
  const all = Buffer.concat(chunks);
  const parts = [];
  let start = 0;
  while (true) {
    let i = all.indexOf(boundary, start);
    if (i < 0) break;
    let j = all.indexOf(boundary, i + boundary.length);
    if (j < 0) break;
    let part = all.subarray(i + boundary.length, j);
    if (part.subarray(0,2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0,-2);
    if (part.length) parts.push(part);
    start = j;
  }

  const fields = {};
  const files = [];
  for (const part of parts) {
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep < 0) continue;
    const rawHeaders = part.subarray(0, sep).toString('utf8');
    const body = part.subarray(sep + 4);
    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const x = line.indexOf(':');
      if (x > 0) headers[line.slice(0,x).trim().toLowerCase()] = line.slice(x+1).trim();
    }
    const disp = headers['content-disposition'] || '';
    const params = parseHeaderParams(disp);
    if (!params.name) continue;

    if (params.filename !== undefined) {
      if (body.length > maxFileBytes) throw Object.assign(new Error('Uploaded file too large'), {statusCode:413});
      const safe = path.basename(params.filename || 'upload.bin').replace(/[^\w.\- ]+/g,'_');
      const stored = `${Date.now()}-${randomId(6)}-${safe}`;
      const target = path.join(uploadDir, stored);
      fs.writeFileSync(target, body);
      files.push({
        field: params.name,
        name: params.filename,
        storedName: stored,
        path: target,
        size: body.length,
        type: headers['content-type'] || 'application/octet-stream'
      });
    } else {
      const value = body.toString('utf8');
      if (Object.hasOwn(fields, params.name)) fields[params.name] = [].concat(fields[params.name], value);
      else fields[params.name] = value;
    }
  }

  return { fields, files };
}

module.exports = { parseMultipart };
