'use strict';
const net=require('net');

function readExact(socket,n){
  return new Promise((resolve,reject)=>{
    let chunks=[],len=0;
    function onData(d){chunks.push(d);len+=d.length;if(len>=n){socket.off('data',onData);const b=Buffer.concat(chunks);if(b.length>n)socket.unshift(b.subarray(n));resolve(b.subarray(0,n))}}
    socket.on('data',onData);socket.once('error',reject);
  });
}

async function socks5Connect(proxy,target,auth=null){
  const socket=net.connect(proxy.port||1080,proxy.host||'127.0.0.1');
  await new Promise((res,rej)=>{socket.once('connect',res);socket.once('error',rej)});
  socket.write(auth?Buffer.from([5,2,0,2]):Buffer.from([5,1,0]));
  let r=await readExact(socket,2);if(r[0]!==5)throw new Error('Invalid SOCKS5 response');
  if(r[1]===2){
    const u=Buffer.from(auth.username||''),p=Buffer.from(auth.password||'');
    socket.write(Buffer.concat([Buffer.from([1,u.length]),u,Buffer.from([p.length]),p]));
    r=await readExact(socket,2);if(r[1]!==0)throw new Error('SOCKS5 authentication failed');
  }else if(r[1]!==0)throw new Error('SOCKS5 method rejected');
  const host=Buffer.from(target.host),port=target.port;
  socket.write(Buffer.concat([Buffer.from([5,1,0,3,host.length]),host,Buffer.from([port>>8,port&255])]));
  r=await readExact(socket,4);if(r[1]!==0)throw new Error('SOCKS5 connect failed: '+r[1]);
  let skip=0;if(r[3]===1)skip=4;else if(r[3]===4)skip=16;else if(r[3]===3){const l=(await readExact(socket,1))[0];skip=l}
  if(skip)await readExact(socket,skip);await readExact(socket,2);
  return socket;
}

async function socks4Connect(proxy,target,user=''){
  const socket=net.connect(proxy.port||1080,proxy.host||'127.0.0.1');
  await new Promise((res,rej)=>{socket.once('connect',res);socket.once('error',rej)});
  const ip=target.ip||'0.0.0.1',parts=ip.split('.').map(Number),u=Buffer.from(user);
  const host=Buffer.from(target.host||'');
  socket.write(Buffer.concat([Buffer.from([4,1,target.port>>8,target.port&255,...parts]),u,Buffer.from([0]),host,Buffer.from([0])]));
  const r=await readExact(socket,8);if(r[1]!==90)throw new Error('SOCKS4 connect failed: '+r[1]);
  return socket;
}

async function httpConnect(proxy,target,headers={}){
  const socket=net.connect(proxy.port||8080,proxy.host||'127.0.0.1');
  await new Promise((res,rej)=>{socket.once('connect',res);socket.once('error',rej)});
  const lines=[`CONNECT ${target.host}:${target.port} HTTP/1.1`,`Host: ${target.host}:${target.port}`,...Object.entries(headers).map(([k,v])=>`${k}: ${v}`),'',''];
  socket.write(lines.join('\r\n'));
  let data=Buffer.alloc(0);
  while(!data.includes('\r\n\r\n'))data=Buffer.concat([data,await new Promise((res,rej)=>{socket.once('data',res);socket.once('error',rej)})]);
  const head=data.toString('utf8',0,data.indexOf('\r\n\r\n'));
  if(!/^HTTP\/1\.[01] 200 /.test(head))throw new Error('HTTP CONNECT failed: '+head.split('\r\n')[0]);
  const rest=data.subarray(data.indexOf('\r\n\r\n')+4);if(rest.length)socket.unshift(rest);
  return socket;
}
module.exports={socks5Connect,socks4Connect,httpConnect};
