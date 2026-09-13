'use strict';

const http=require('http');
const https=require('https');
const http2=require('http2');
const net=require('net');
const tls=require('tls');
const dgram=require('dgram');
const dns=require('dns');
const {EventEmitter}=require('events');
const {URL}=require('url');
const crypto=require('crypto');

function normalizeListen(options={}){
  if(typeof options==='number')return {port:options};
  return {...options};
}

function wsAccept(key){
  return crypto.createHash('sha1').update(String(key)+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeWsFrame(data,opcode=1){
  const payload=Buffer.isBuffer(data)?data:Buffer.from(String(data));
  const len=payload.length;
  let head;
  if(len<126){head=Buffer.allocUnsafe(2);head[0]=0x80|opcode;head[1]=len}
  else if(len<=0xffff){head=Buffer.allocUnsafe(4);head[0]=0x80|opcode;head[1]=126;head.writeUInt16BE(len,2)}
  else{head=Buffer.allocUnsafe(10);head[0]=0x80|opcode;head[1]=127;head.writeBigUInt64BE(BigInt(len),2)}
  return Buffer.concat([head,payload]);
}

function decodeWsFrames(buffer){
  const out=[];let off=0;
  while(off+2<=buffer.length){
    const b0=buffer[off],b1=buffer[off+1],masked=!!(b1&0x80);
    let len=b1&0x7f,head=2;
    if(len===126){if(off+4>buffer.length)break;len=buffer.readUInt16BE(off+2);head=4}
    else if(len===127){if(off+10>buffer.length)break;len=Number(buffer.readBigUInt64BE(off+2));head=10}
    const maskLen=masked?4:0;
    if(off+head+maskLen+len>buffer.length)break;
    let p=off+head,mask;
    if(masked){mask=buffer.subarray(p,p+4);p+=4}
    const payload=Buffer.from(buffer.subarray(p,p+len));
    if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
    out.push({fin:!!(b0&0x80),opcode:b0&0xf,payload});
    off=p+len;
  }
  return {frames:out,rest:buffer.subarray(off)};
}

class WebSocketPeer extends EventEmitter{
  constructor(socket){super();this.socket=socket;this.buffer=Buffer.alloc(0);this.closed=false;
    socket.on('data',b=>this._onData(b));socket.on('close',()=>{this.closed=true;this.emit('close')});socket.on('error',e=>this.emit('error',e));
  }
  _onData(b){
    this.buffer=Buffer.concat([this.buffer,b]);
    const x=decodeWsFrames(this.buffer);this.buffer=x.rest;
    for(const f of x.frames){
      if(f.opcode===1)this.emit('message',f.payload.toString('utf8'));
      else if(f.opcode===2)this.emit('message',f.payload);
      else if(f.opcode===8){this.close()}
      else if(f.opcode===9)this.socket.write(encodeWsFrame(f.payload,10));
    }
  }
  send(data){if(!this.closed)this.socket.write(encodeWsFrame(data,Buffer.isBuffer(data)?2:1))}
  close(){if(this.closed)return;this.closed=true;try{this.socket.write(encodeWsFrame(Buffer.alloc(0),8))}catch{};try{this.socket.end()}catch{}}
}

class ProtocolRuntime extends EventEmitter{
  constructor(options={}){super();this.options=options;this.servers=new Set()}
  http(handler,options={}){
    const s=http.createServer(handler);this.servers.add(s);return s;
  }
  https(handler,options={}){
    const s=https.createServer(options,handler);this.servers.add(s);return s;
  }
  http2(handler,options={}){
    const secure=!!(options.key&&options.cert);
    const s=secure?http2.createSecureServer(options):http2.createServer(options);
    if(handler)s.on('stream',(stream,headers)=>handler(stream,headers));
    this.servers.add(s);return s;
  }
  tcp(handler,options={}){
    const s=net.createServer(handler);this.servers.add(s);return s;
  }
  tls(handler,options={}){
    const s=tls.createServer(options,handler);this.servers.add(s);return s;
  }
  udp(handler,options={}){
    const type=options.type||'udp4',s=dgram.createSocket(type);
    if(handler)s.on('message',handler);this.servers.add(s);return s;
  }
  ws(handler,options={}){
    const server=options.server||http.createServer();
    server.on('upgrade',(req,socket)=>{
      const key=req.headers['sec-websocket-key'];
      if(!key){socket.destroy();return}
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket','Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAccept(key)}`,'',''
      ].join('\r\n'));
      const peer=new WebSocketPeer(socket);
      handler?.(peer,req);
      this.emit('wsConnection',peer,req);
    });
    if(!options.server)this.servers.add(server);
    return server;
  }
  wss(handler,options={}){
    const server=options.server||https.createServer(options);
    return this.ws(handler,{...options,server});
  }
  connectTcp(options){return net.connect(options)}
  connectTls(options){return tls.connect(options)}
  dnsLookup(host,options){return dns.promises.lookup(host,options)}
  fetch(url,options={}){
    const u=new URL(url),lib=u.protocol==='https:'?https:http;
    return new Promise((resolve,reject)=>{
      const req=lib.request(u,{method:options.method||'GET',headers:options.headers||{}},res=>{
        const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({
          status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),
          text(){return this.body.toString('utf8')},
          json(){return JSON.parse(this.text())}
        }));
      });
      req.on('error',reject);
      if(options.body!=null)req.write(options.body);
      req.end();
    });
  }
  closeAll(){
    for(const s of this.servers)try{s.close?.()}catch{}
    this.servers.clear();
  }
}

module.exports={ProtocolRuntime,WebSocketPeer,encodeWsFrame,decodeWsFrames,wsAccept};
