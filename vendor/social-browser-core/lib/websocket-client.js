'use strict';
const net=require('net');
const tls=require('tls');
const crypto=require('crypto');
const {EventEmitter}=require('events');
const {URL}=require('url');

function encFrame(data,opcode=1,mask=true){
  const payload=Buffer.isBuffer(data)?data:Buffer.from(String(data));
  let head,len=payload.length;
  if(len<126){head=Buffer.alloc(mask?6:2);head[0]=0x80|opcode;head[1]=(mask?0x80:0)|len}
  else if(len<=0xffff){head=Buffer.alloc(mask?8:4);head[0]=0x80|opcode;head[1]=(mask?0x80:0)|126;head.writeUInt16BE(len,2)}
  else{head=Buffer.alloc(mask?14:10);head[0]=0x80|opcode;head[1]=(mask?0x80:0)|127;head.writeBigUInt64BE(BigInt(len),2)}
  if(!mask)return Buffer.concat([head,payload]);
  const mo=head.length-4,maskKey=crypto.randomBytes(4);maskKey.copy(head,mo);
  const out=Buffer.from(payload);for(let i=0;i<out.length;i++)out[i]^=maskKey[i&3];
  return Buffer.concat([head,out]);
}
function parseFrames(buffer){
  const out=[];let off=0;
  while(off+2<=buffer.length){
    const b0=buffer[off],b1=buffer[off+1];let len=b1&127,head=2;
    if(len===126){if(off+4>buffer.length)break;len=buffer.readUInt16BE(off+2);head=4}
    else if(len===127){if(off+10>buffer.length)break;len=Number(buffer.readBigUInt64BE(off+2));head=10}
    const masked=!!(b1&128),maskLen=masked?4:0;
    if(off+head+maskLen+len>buffer.length)break;
    let p=off+head,mask;
    if(masked){mask=buffer.subarray(p,p+4);p+=4}
    const payload=Buffer.from(buffer.subarray(p,p+len));
    if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
    out.push({opcode:b0&15,payload});off=p+len;
  }
  return {frames:out,rest:buffer.subarray(off)};
}
class WebSocketClient extends EventEmitter{
  constructor(options={}){super();this.options=options;this.socket=null;this.buffer=Buffer.alloc(0);this.connected=false}
  connect(url,options={}){
    const u=new URL(url),secure=u.protocol==='wss:',port=Number(u.port|| (secure?443:80));
    const key=crypto.randomBytes(16).toString('base64');
    return new Promise((resolve,reject)=>{
      const sock=secure?tls.connect({host:u.hostname,port,servername:u.hostname,rejectUnauthorized:options.rejectUnauthorized!==false})
                       :net.connect(port,u.hostname);
      this.socket=sock;
      let head='';
      const onData=d=>{
        head+=d.toString('binary');
        const i=head.indexOf('\r\n\r\n');if(i<0)return;
        sock.off('data',onData);
        const headers=head.slice(0,i);
        if(!/^HTTP\/1\.[01] 101 /.test(headers)){reject(new Error('WebSocket upgrade failed'));sock.destroy();return}
        const rest=Buffer.from(head.slice(i+4),'binary');if(rest.length)this._onData(rest);
        sock.on('data',x=>this._onData(x));
        this.connected=true;this.emit('open');resolve(this);
      };
      sock.on('data',onData);sock.once('error',reject);
      sock.once('connect',()=>{
        const path=(u.pathname||'/')+(u.search||'');
        const lines=[`GET ${path} HTTP/1.1`,`Host: ${u.host}`,'Upgrade: websocket','Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,'Sec-WebSocket-Version: 13',...Object.entries(options.headers||{}).map(([k,v])=>`${k}: ${v}`),'',''];
        sock.write(lines.join('\r\n'));
      });
    });
  }
  _onData(d){
    this.buffer=Buffer.concat([this.buffer,d]);const x=parseFrames(this.buffer);this.buffer=x.rest;
    for(const f of x.frames){
      if(f.opcode===1)this.emit('message',f.payload.toString());
      else if(f.opcode===2)this.emit('message',f.payload);
      else if(f.opcode===8){this.connected=false;this.socket.end();this.emit('close')}
      else if(f.opcode===9)this.socket.write(encFrame(f.payload,10,true));
    }
  }
  send(data){this.socket.write(encFrame(data,Buffer.isBuffer(data)?2:1,true))}
  ping(data=''){this.socket.write(encFrame(data,9,true))}
  close(){if(!this.socket)return;this.socket.write(encFrame(Buffer.alloc(0),8,true));this.socket.end()}
}
module.exports={WebSocketClient};
