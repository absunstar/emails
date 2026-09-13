'use strict';
const net=require('net');
const dgram=require('dgram');

function createSocks5Server(options={}){
  return net.createServer(client=>{
    let stage='greeting',buf=Buffer.alloc(0),target=null;
    client.on('data',data=>{
      buf=Buffer.concat([buf,data]);
      try{
        if(stage==='greeting'){
          if(buf.length<2)return;const n=buf[1];if(buf.length<2+n)return;
          const methods=buf.subarray(2,2+n);buf=buf.subarray(2+n);
          const needAuth=!!options.authenticate;
          const method=needAuth?2:0;
          if(!methods.includes(method)){client.end(Buffer.from([5,255]));return}
          client.write(Buffer.from([5,method]));
          stage=needAuth?'auth':'request';
        }
        if(stage==='auth'){
          if(buf.length<2)return;const ulen=buf[1];if(buf.length<2+ulen+1)return;
          const plen=buf[2+ulen];if(buf.length<3+ulen+plen)return;
          const user=buf.subarray(2,2+ulen).toString();
          const pass=buf.subarray(3+ulen,3+ulen+plen).toString();
          buf=buf.subarray(3+ulen+plen);
          Promise.resolve(options.authenticate(user,pass)).then(ok=>{
            client.write(Buffer.from([1,ok?0:1]));if(!ok)client.end();else stage='request';
          }).catch(()=>client.end(Buffer.from([1,1])));
          return;
        }
        if(stage==='request'){
          if(buf.length<4)return;
          const ver=buf[0],cmd=buf[1],atyp=buf[3];if(ver!==5||![1,3].includes(cmd)){client.end(Buffer.from([5,7,0,1,0,0,0,0,0,0]));return}
          let off=4,host;
          if(atyp===1){if(buf.length<10)return;host=[buf[4],buf[5],buf[6],buf[7]].join('.');off=8}
          else if(atyp===3){if(buf.length<5)return;const l=buf[4];if(buf.length<7+l)return;host=buf.subarray(5,5+l).toString();off=5+l}
          else{client.end(Buffer.from([5,8,0,1,0,0,0,0,0,0]));return}
          const port=buf.readUInt16BE(off);buf=buf.subarray(off+2);
          if(cmd===3){
            const udp=dgram.createSocket('udp4');
            udp.bind(0,'127.0.0.1',()=>{
              const a=udp.address();
              client.write(Buffer.from([5,0,0,1,127,0,0,1,a.port>>8,a.port&255]));
            });
            client.on('close',()=>udp.close());
            stage='udp';return;
          }
          stage='proxy';
          target=net.connect(port,host,()=>{
            client.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));
            if(buf.length){target.write(buf);buf=Buffer.alloc(0)}
            client.pipe(target);target.pipe(client);
          });
          target.on('error',()=>client.end(Buffer.from([5,5,0,1,0,0,0,0,0,0])));
        }
      }catch{client.destroy()}
    });
  });
}
module.exports={createSocks5Server};
