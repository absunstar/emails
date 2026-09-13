'use strict';
const net=require('net');
const tls=require('tls');
const {EventEmitter}=require('events');

function encStr(s){const b=Buffer.from(String(s));const h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b])}
function encRemaining(n){const a=[];do{let d=n%128;n=Math.floor(n/128);if(n>0)d|=128;a.push(d)}while(n>0);return Buffer.from(a)}
function packet(type,flags,payload){return Buffer.concat([Buffer.from([(type<<4)|flags]),encRemaining(payload.length),payload])}

class MqttClient extends EventEmitter{
  constructor(options={}){super();this.options=options;this.socket=null;this.packetId=0;this.buffer=Buffer.alloc(0)}
  connect(options={}){
    const o={host:'127.0.0.1',port:options.secure?8883:1883,clientId:'aisite-'+Math.random().toString(16).slice(2),keepAlive:60,...this.options,...options};
    return new Promise((resolve,reject)=>{
      this.socket=o.secure?tls.connect({host:o.host,port:o.port,servername:o.servername||o.host,rejectUnauthorized:o.rejectUnauthorized!==false})
                          :net.connect(o.port,o.host);
      this.socket.on('data',d=>this._onData(d));this.socket.once('error',reject);
      this.socket.once('connect',()=>{
        const vh=Buffer.concat([encStr('MQTT'),Buffer.from([4,2,o.keepAlive>>8,o.keepAlive&255])]);
        const pl=encStr(o.clientId);
        this.once('connack',x=>x.code===0?resolve(x):reject(new Error('MQTT CONNACK '+x.code)));
        this.socket.write(packet(1,0,Buffer.concat([vh,pl])));
      });
    });
  }
  _onData(d){
    this.buffer=Buffer.concat([this.buffer,d]);
    while(this.buffer.length>=2){
      let mul=1,rem=0,i=1,b;
      do{if(i>=this.buffer.length)return;b=this.buffer[i++];rem+=(b&127)*mul;mul*=128}while(b&128);
      if(this.buffer.length<i+rem)return;
      const head=this.buffer[0],type=head>>4,p=this.buffer.subarray(i,i+rem);this.buffer=this.buffer.subarray(i+rem);
      if(type===2)this.emit('connack',{sessionPresent:!!p[0],code:p[1]});
      else if(type===3){
        const n=p.readUInt16BE(0),topic=p.subarray(2,2+n).toString(),body=p.subarray(2+n);
        this.emit('message',topic,body);
      }else if(type===4){this.emit('puback',p.readUInt16BE(0))}
      else if(type===5){const id=p.readUInt16BE(0);this.emit('pubrec',id);this.socket.write(Buffer.from([0x62,0x02,id>>8,id&255]))}
      else if(type===7){this.emit('pubcomp',p.readUInt16BE(0))}
      else this.emit('packet',type,p);
    }
  }
  publish(topic,data,options={}){
    const body=Buffer.isBuffer(data)?data:Buffer.from(String(data));
    const qos=options.qos||0;let payload=encStr(topic),id=0;
    if(qos>0){id=++this.packetId;const h=Buffer.alloc(2);h.writeUInt16BE(id);payload=Buffer.concat([payload,h])}
    payload=Buffer.concat([payload,body]);
    this.socket.write(packet(3,(qos<<1)|(options.retain?1:0),payload));
    return id;
  }
  subscribe(topic,qos=0){
    const id=++this.packetId;const h=Buffer.alloc(2);h.writeUInt16BE(id);
    const pl=Buffer.concat([encStr(topic),Buffer.from([qos])]);
    this.socket.write(packet(8,2,Buffer.concat([h,pl])));return id;
  }
  ping(){this.socket.write(Buffer.from([0xC0,0]))}
  end(){try{this.socket.write(Buffer.from([0xE0,0]))}finally{this.socket.end()}}
}
module.exports={MqttClient};
