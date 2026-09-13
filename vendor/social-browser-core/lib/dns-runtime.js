'use strict';
const dns=require('dns');
const dgram=require('dgram');

function parseQuestion(buf){
  if(buf.length<12)return null;
  let off=12,labels=[];
  while(off<buf.length){
    const n=buf[off++];if(n===0)break;if(off+n>buf.length)return null;labels.push(buf.subarray(off,off+n).toString());off+=n;
  }
  if(off+4>buf.length)return null;
  return {name:labels.join('.'),type:buf.readUInt16BE(off),class:buf.readUInt16BE(off+2),end:off+4};
}
function namePointer(offset=12){return Buffer.from([0xC0,offset&0xFF])}
function buildAResponse(query,ip,ttl=60){
  const q=parseQuestion(query);if(!q)return null;
  const parts=String(ip).split('.').map(Number);if(parts.length!==4||parts.some(x=>x<0||x>255||!Number.isFinite(x)))return null;
  const head=Buffer.alloc(12);query.copy(head,0,0,2);head.writeUInt16BE(0x8180,2);head.writeUInt16BE(1,4);head.writeUInt16BE(1,6);
  const question=query.subarray(12,q.end);
  const ans=Buffer.alloc(16);namePointer().copy(ans,0);ans.writeUInt16BE(1,2);ans.writeUInt16BE(1,4);ans.writeUInt32BE(ttl,6);ans.writeUInt16BE(4,10);Buffer.from(parts).copy(ans,12);
  return Buffer.concat([head,question,ans]);
}
class DnsCache{
  constructor(options={}){this.max=Math.max(10,Number(options.max||10000));this.defaultTtlMs=Math.max(1000,Number(options.defaultTtlMs||60000));this.map=new Map()}
  get(k){const x=this.map.get(k);if(!x)return null;if(x.expires<Date.now()){this.map.delete(k);return null}this.map.delete(k);this.map.set(k,x);return x.value}
  set(k,v,ttlMs=this.defaultTtlMs){if(this.map.has(k))this.map.delete(k);this.map.set(k,{value:v,expires:Date.now()+ttlMs});while(this.map.size>this.max)this.map.delete(this.map.keys().next().value)}
  clear(){this.map.clear()}
}
class DnsRuntime{
  constructor(options={}){this.cache=new DnsCache(options.cache||{});this.resolver=options.resolver||dns.promises}
  async lookup(host,options={}){
    const key=JSON.stringify([host,options]);const hit=this.cache.get(key);if(hit)return hit;
    const v=await this.resolver.lookup(host,options);this.cache.set(key,v,options.ttlMs);return v;
  }
  async resolve4(host){const key='A:'+host,hit=this.cache.get(key);if(hit)return hit;const v=await this.resolver.resolve4(host);this.cache.set(key,v);return v}
  createServer(options={}){
    const sock=dgram.createSocket(options.type||'udp4'),records=options.records||{};
    sock.on('message',(msg,rinfo)=>{
      const q=parseQuestion(msg);if(!q)return;
      const value=typeof records==='function'?records(q.name,q.type):records[q.name];
      if(q.type===1&&value){const res=buildAResponse(msg,Array.isArray(value)?value[0]:value,options.ttl||60);if(res)sock.send(res,rinfo.port,rinfo.address)}
      else if(options.forward){
        const up=dgram.createSocket('udp4');
        up.once('message',res=>{sock.send(res,rinfo.port,rinfo.address);up.close()});
        up.send(msg,53,options.forward);
      }
    });
    return sock;
  }
}
module.exports={DnsRuntime,DnsCache,parseQuestion,buildAResponse};
