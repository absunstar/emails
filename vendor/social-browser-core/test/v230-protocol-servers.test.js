'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('net');
const http=require('http');
const aisite=require('..');
const {RedisRespClient}=require('../lib/redis-resp');

test('redis-compatible server GET/SET/DEL',async()=>{
 const site=aisite(),srv=site.createRedisRespServer();
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=new RedisRespClient();await c.connect({host:'127.0.0.1',port:srv.address().port});
 assert.equal(await c.set('a','1'),'OK');assert.equal(await c.get('a'),'1');assert.equal(await c.del('a'),1);assert.equal(await c.get('a'),null);
 await c.quit();await new Promise(res=>srv.close(res));
});

test('http CONNECT proxy tunnels bytes',async()=>{
 const target=net.createServer(s=>s.pipe(s));
 await new Promise(res=>target.listen(0,'127.0.0.1',res));
 const site=aisite(),proxy=site.createHttpProxyServer();
 await new Promise(res=>proxy.listen(0,'127.0.0.1',res));
 const sock=await site.httpConnect({host:'127.0.0.1',port:proxy.address().port},{host:'127.0.0.1',port:target.address().port});
 const reply=await new Promise((res,rej)=>{sock.once('data',d=>res(d.toString()));sock.once('error',rej);sock.write('hello')});
 assert.equal(reply,'hello');sock.end();
 await new Promise(res=>proxy.close(res));await new Promise(res=>target.close(res));
});

test('SMTP server receives message',async()=>{
 const site=aisite();let got=null;
 const srv=site.createSmtpServer({onMessage:m=>got=m});
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const C=site.SmtpClient,c=new C();await c.connect({host:'127.0.0.1',port:srv.address().port});await c.ehlo('x');
 assert.equal((await c.send({from:'a@x',to:'b@x',data:'Subject: T\r\n\r\nHi'})).code,250);
 await c.quit();assert.ok(got&&got.data.includes('Hi'));await new Promise(res=>srv.close(res));
});

test('protocol capability registry marks new servers',()=>{
 const caps=aisite().protocolCapabilities();
 for(const k of ['socks5','http_connect','redis','mqtt','smtp','pop3','imap'])assert.equal(caps[k].server,true);
});
