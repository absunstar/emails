'use strict';
const net=require('net');
const tls=require('tls');

function encRemaining(n){const a=[];do{let d=n%128;n=Math.floor(n/128);if(n>0)d|=128;a.push(d)}while(n>0);return Buffer.from(a)}
function packet(type,flags,payload){return Buffer.concat([Buffer.from([(type<<4)|flags]),encRemaining(payload.length),payload])}
function encStr(s){const b=Buffer.from(String(s));const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b])}

function createMqttBroker(options={}){
  const clients=new Set(),subs=new Map(),retained=new Map(),sessions=new Map(),qos2Pending=new WeakMap();

  function deliver(topic,body,retain=false){
    if(retain){if(body.length)retained.set(topic,Buffer.from(body));else retained.delete(topic)}
    const payload=Buffer.concat([encStr(topic),body]);
    for(const c of subs.get(topic)||[])if(!c.destroyed)c.write(packet(3,0,payload));
  }

  const onClient=socket=>{
    clients.add(socket);let buf=Buffer.alloc(0),session=null,clientId='';
    qos2Pending.set(socket,new Map());

    socket.on('close',()=>{
      clients.delete(socket);
      for(const set of subs.values())set.delete(socket);
      qos2Pending.delete(socket);
    });

    socket.on('data',d=>{
      buf=Buffer.concat([buf,d]);
      while(buf.length>=2){
        let mul=1,rem=0,i=1,b;
        do{if(i>=buf.length)return;b=buf[i++];rem+=(b&127)*mul;mul*=128}while(b&128);
        if(buf.length<i+rem)return;
        const head=buf[0],type=head>>4,p=buf.subarray(i,i+rem);buf=buf.subarray(i+rem);

        if(type===1){
          try{
            let off=0;const protoLen=p.readUInt16BE(off);off+=2+protoLen;off++;const flags=p[off++];off+=2;
            const idLen=p.readUInt16BE(off);off+=2;clientId=p.subarray(off,off+idLen).toString();
            const clean=!!(flags&0x02),existing=sessions.get(clientId);
            const present=!clean&&!!existing;
            if(clean||!existing)sessions.set(clientId,{topics:new Set()});
            session=sessions.get(clientId);
            for(const topic of session.topics){if(!subs.has(topic))subs.set(topic,new Set());subs.get(topic).add(socket)}
            socket.write(Buffer.from([0x20,0x02,present?1:0,0x00]));
          }catch{socket.write(Buffer.from([0x20,0x02,0x00,0x02]))}
        }else if(type===8){
          const id=p.readUInt16BE(0);let off=2,granted=[];
          while(off+2<=p.length){
            const n=p.readUInt16BE(off);off+=2;const topic=p.subarray(off,off+n).toString();off+=n;const qos=Math.min(2,p[off++]||0);granted.push(qos);
            if(!subs.has(topic))subs.set(topic,new Set());subs.get(topic).add(socket);session?.topics.add(topic);
            if(retained.has(topic)){const body=retained.get(topic);socket.write(packet(3,0,Buffer.concat([encStr(topic),body])))}
          }
          socket.write(Buffer.concat([Buffer.from([0x90,2+granted.length,id>>8,id&255]),Buffer.from(granted)]));
        }else if(type===3){
          const n=p.readUInt16BE(0),topic=p.subarray(2,2+n).toString();
          const qos=(head>>1)&3,retain=!!(head&1);
          let off=2+n,packetId=0;
          if(qos>0){packetId=p.readUInt16BE(off);off+=2}
          const body=Buffer.from(p.subarray(off));
          if(qos===0){
            deliver(topic,body,retain);options.onPublish?.(topic,body,socket,{qos,retain});
          }else if(qos===1){
            deliver(topic,body,retain);options.onPublish?.(topic,body,socket,{qos,retain});
            socket.write(Buffer.from([0x40,0x02,packetId>>8,packetId&255]));
          }else if(qos===2){
            qos2Pending.get(socket).set(packetId,{topic,body,retain});
            socket.write(Buffer.from([0x50,0x02,packetId>>8,packetId&255]));
          }
        }else if(type===6){
          const id=p.readUInt16BE(0),pending=qos2Pending.get(socket)?.get(id);
          if(pending){
            qos2Pending.get(socket).delete(id);
            deliver(pending.topic,pending.body,pending.retain);
            options.onPublish?.(pending.topic,pending.body,socket,{qos:2,retain:pending.retain});
          }
          socket.write(Buffer.from([0x70,0x02,id>>8,id&255]));
        }else if(type===12){
          socket.write(Buffer.from([0xD0,0]));
        }else if(type===14){
          socket.end();
        }
      }
    });
  };

  const server=options.tls?tls.createServer(options.tls,onClient):net.createServer(onClient);
  server.clients=clients;server.subscriptions=subs;server.retained=retained;server.sessions=sessions;
  return server;
}
module.exports={createMqttBroker};
