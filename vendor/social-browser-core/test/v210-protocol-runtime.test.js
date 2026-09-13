'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('net');
const aisite=require('..');
const {ProtocolRuntime,encodeWsFrame,decodeWsFrames}=require('../lib/protocol-runtime');
const {FtpClient}=require('../lib/ftp-client');
const {SshProtocol}=require('../lib/ssh-protocol');

test('protocol runtime exposes native protocol surfaces',()=>{
 const p=new ProtocolRuntime();
 for(const k of ['http','https','http2','tcp','tls','udp','ws','wss','connectTcp','connectTls','dnsLookup','fetch'])assert.equal(typeof p[k],'function');
});

test('websocket frame codec round-trips text',()=>{
 const b=encodeWsFrame('hello');
 const x=decodeWsFrames(b);
 assert.equal(x.frames.length,1);assert.equal(x.frames[0].payload.toString(),'hello');
});

test('tcp server/client works',async()=>{
 const p=new ProtocolRuntime();
 const s=p.tcp(sock=>sock.end('ok'));
 await new Promise((res,rej)=>{s.once('error',rej);s.listen(0,'127.0.0.1',res)});
 const port=s.address().port;
 const text=await new Promise((res,rej)=>{let out='';const c=p.connectTcp({host:'127.0.0.1',port});c.on('data',d=>out+=d);c.on('end',()=>res(out));c.on('error',rej)});
 assert.equal(text,'ok');s.close();
});


test('ftp client speaks basic command protocol',async()=>{
 const srv=net.createServer(sock=>{
   sock.setEncoding('utf8');
   sock.write('220 ready\r\n');
   let buf='';
   sock.on('data',d=>{
     buf+=d;
     let i;
     while((i=buf.indexOf('\r\n'))>=0){
       const line=buf.slice(0,i);buf=buf.slice(i+2);
       if(line.startsWith('USER'))sock.write('331 pass\r\n');
       else if(line.startsWith('PASS'))sock.write('230 ok\r\n');
       else if(line==='PWD')sock.write('257 "/"\r\n');
       else if(line==='QUIT'){sock.write('221 bye\r\n');sock.end()}
     }
   });
 });
 await new Promise((res,rej)=>{srv.once('error',rej);srv.listen(0,'127.0.0.1',res)});
 const c=new FtpClient();
 const greeting=await c.connect({host:'127.0.0.1',port:srv.address().port});
 assert.equal(greeting.code,220);
 assert.equal((await c.login('u','p')).code,230);
 assert.equal((await c.pwd()).code,257);
 assert.equal((await c.quit()).code,221);
 await new Promise(res=>srv.close(res));
});

test('ssh capability surface is explicit about current support',()=>{
 const c=SshProtocol.capabilities();
 assert.equal(c.banner,true);assert.equal(c.keyExchange,false);assert.equal(c.productionReady,false);
});

test('site exposes protocols namespace',()=>{
 const site=aisite();
 assert.ok(site.protocols);assert.equal(typeof site.protocols.http,'function');
 assert.equal(typeof site.FtpClient,'function');assert.equal(typeof site.SshProtocol,'function');assert.equal(typeof site.SmtpClient,'function');
});
