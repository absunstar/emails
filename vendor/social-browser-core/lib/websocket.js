'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

function acceptKey(key) {
  return crypto.createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2); head[0] = 0x80 | opcode; head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len,2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len),2);
  }
  return Buffer.concat([head,payload]);
}

function decodeFrames(buffer,options={}) {
  const maxFrameBytes=Math.max(1024,Number(options.maxFrameBytes||8*1024*1024));
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset], b1 = buffer[offset+1];
    const fin = !!(b0 & 0x80);
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buffer.length) break;
      len = buffer.readUInt16BE(pos); pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) break;
      const n = buffer.readBigUInt64BE(pos); pos += 8;
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      len = Number(n);
    }
    if(len>maxFrameBytes)throw Object.assign(new Error('WebSocket frame too large'),{code:'WS_FRAME_TOO_LARGE',size:len,maxFrameBytes});
    let mask = null;
    if (masked) {
      if (pos + 4 > buffer.length) break;
      mask = buffer.subarray(pos,pos+4); pos += 4;
    }
    if (pos + len > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(pos,pos+len));
    if (mask) for (let i=0;i<payload.length;i++) payload[i] ^= mask[i%4];
    frames.push({fin,opcode,payload});
    offset = pos + len;
  }
  return {frames, rest:buffer.subarray(offset)};
}

class WSConnection extends EventEmitter {
  constructor(socket, req, options={}) {
    super();
    this.maxFrameBytes=Math.max(1024,Number(options.maxFrameBytes||8*1024*1024));
    this.maxBufferBytes=Math.max(this.maxFrameBytes,Number(options.maxBufferBytes||16*1024*1024));
    this.socket = socket;
    this.req = req;
    this.open = true;
    this.buffer = Buffer.alloc(0);

    socket.on('data', chunk => {
      try {
        if(this.buffer.length+chunk.length>this.maxBufferBytes)
          throw Object.assign(new Error('WebSocket receive buffer too large'),{code:'WS_BUFFER_TOO_LARGE'});
        this.buffer = Buffer.concat([this.buffer,chunk]);
        const parsed = decodeFrames(this.buffer,{maxFrameBytes:this.maxFrameBytes});
        this.buffer = parsed.rest;
        for (const f of parsed.frames) this._frame(f);
      } catch (e) { this.emit('error',e); this.close(1011,'decode error'); }
    });
    this._closedEmitted=false;
    const markClosed=()=>{
      this.open=false;
      if(this._closedEmitted)return;
      this._closedEmitted=true;
      this.emit('close');
    };
    socket.on('end',markClosed);
    socket.on('close',markClosed);
    socket.on('error', e => this.emit('error',e));
  }

  _frame(f) {
    if (f.opcode === 0x8) { this.close(); return; }
    if (f.opcode === 0x9) { this.socket.write(encodeFrame(f.payload,0xA)); return; }
    if (f.opcode === 0xA) { this.emit('pong',f.payload); return; }
    if (f.opcode === 0x1) this.emit('message',f.payload.toString('utf8'),false);
    else if (f.opcode === 0x2) this.emit('message',f.payload,true);
  }

  send(data) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(data, Buffer.isBuffer(data) ? 0x2 : 0x1));
    return true;
  }

  json(data) { return this.send(JSON.stringify(data)); }
  ping(data='') { if(this.open) this.socket.write(encodeFrame(data,0x9)); }

  close(code=1000, reason='') {
    if (!this.open) return;
    this.open = false;
    const reasonBuf = Buffer.from(String(reason));
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code,0); reasonBuf.copy(payload,2);
    try { this.socket.end(encodeFrame(payload,0x8)); } catch { try { this.socket.destroy(); } catch {} }
  }
}

function handleUpgrade(req, socket, head, handler, options={}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }
  const response = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n'
  ].join('\r\n');
  socket.write(response);
  const ws = new WSConnection(socket, req, options);
  if (head?.length) socket.unshift(head);
  handler(ws, req);
}

module.exports = { WSConnection, handleUpgrade, acceptKey, encodeFrame, decodeFrames };
