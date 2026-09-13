'use strict';
const net=require('net');
const crypto=require('crypto');

class SshProtocol{
  constructor(options={}){this.options=options}
  connect(options={}){
    const o={host:'127.0.0.1',port:22,...this.options,...options};
    return new Promise((resolve,reject)=>{
      const socket=net.connect(o.port,o.host);
      socket.once('error',reject);
      socket.once('data',data=>{
        const banner=data.toString('utf8');
        if(!banner.startsWith('SSH-')){socket.destroy();reject(new Error('Invalid SSH banner'));return}
        resolve({socket,banner,capabilities:{banner:true,keyExchange:false,auth:false,channels:false}});
      });
    });
  }
  static capabilities(){
    return {banner:true,keyExchange:false,auth:false,channels:false,productionReady:false};
  }
}
module.exports={SshProtocol};
