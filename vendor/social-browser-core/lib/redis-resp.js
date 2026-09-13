'use strict';
const net=require('net');

function encodeResp(args){
  const list=[].concat(args||[]);
  let out=`*${list.length}\r\n`;
  for(const a of list){const b=Buffer.from(String(a));out+=`$${b.length}\r\n${b.toString()}\r\n`}
  return Buffer.from(out);
}
function parseResp(buffer,offset=0){
  if(offset>=buffer.length)return null;
  const type=String.fromCharCode(buffer[offset]);
  const lineEnd=buffer.indexOf('\r\n',offset);if(lineEnd<0)return null;
  const line=buffer.slice(offset+1,lineEnd).toString();
  if(type==='+'||type==='-'||type===':')return {value:type===':'?Number(line):line,next:lineEnd+2,type};
  if(type==='$'){
    const n=Number(line);if(n<0)return {value:null,next:lineEnd+2,type};
    const start=lineEnd+2,end=start+n;if(buffer.length<end+2)return null;
    return {value:buffer.slice(start,end).toString(),next:end+2,type};
  }
  if(type==='*'){
    const n=Number(line);if(n<0)return {value:null,next:lineEnd+2,type};
    const arr=[];let pos=lineEnd+2;
    for(let i=0;i<n;i++){const x=parseResp(buffer,pos);if(!x)return null;arr.push(x.value);pos=x.next}
    return {value:arr,next:pos,type};
  }
  throw new Error('Unknown RESP type');
}
class RedisRespClient{
  constructor(options={}){this.options=options;this.socket=null;this.buffer=Buffer.alloc(0);this.waiters=[]}
  connect(options={}){
    const o={host:'127.0.0.1',port:6379,...this.options,...options};
    return new Promise((res,rej)=>{this.socket=net.connect(o.port,o.host,res);this.socket.on('data',d=>this._onData(d));this.socket.on('error',rej)});
  }
  _onData(d){
    this.buffer=Buffer.concat([this.buffer,d]);
    while(this.waiters.length){
      const x=parseResp(this.buffer,0);if(!x)break;
      this.buffer=this.buffer.subarray(x.next);
      this.waiters.shift().resolve(x.value);
    }
  }
  command(...args){
    const p=new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
    this.socket.write(encodeResp(args));return p;
  }
  get(k){return this.command('GET',k)}
  set(k,v){return this.command('SET',k,v)}
  del(k){return this.command('DEL',k)}
  expire(k,seconds){return this.command('EXPIRE',k,seconds)}
  pexpire(k,ms){return this.command('PEXPIRE',k,ms)}
  ttl(k){return this.command('TTL',k)}
  persist(k){return this.command('PERSIST',k)}
  ping(){return this.command('PING')}
  publish(ch,msg){return this.command('PUBLISH',ch,msg)}
  multi(){return this.command('MULTI')}
  exec(){return this.command('EXEC')}
  discard(){return this.command('DISCARD')}
  quit(){const p=this.command('QUIT');p.finally(()=>this.socket?.end());return p}
}
module.exports={RedisRespClient,encodeResp,parseResp};
