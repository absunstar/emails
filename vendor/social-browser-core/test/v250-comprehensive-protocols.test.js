'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http2=require('http2'),dgram=require('dgram');
const aisite=require('..');
const {RedisRespClient}=require('../lib/redis-resp');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v250-'))}

test('HTTP2 client talks to native HTTP2 server',async()=>{
 const srv=http2.createServer();srv.on('stream',(s,h)=>{s.respond({':status':200,'content-type':'text/plain'});s.end('ok')});
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const site=aisite(),c=new site.Http2Client();await c.connect(`http://127.0.0.1:${srv.address().port}`);
 const r=await c.get('/');assert.equal(r.status,200);assert.equal(r.text(),'ok');c.close();await new Promise(res=>srv.close(res));
});

test('DNS runtime cache and A server work',async()=>{
 const site=aisite(),dnsrt=new site.DnsRuntime({cache:{defaultTtlMs:10000}});
 const srv=dnsrt.createServer({records:{'test.local':'127.0.0.9'}});
 await new Promise(res=>srv.bind(0,'127.0.0.1',res));
 const q=Buffer.from([0x12,0x34,0x01,0x00,0,1,0,0,0,0,0,0,4,116,101,115,116,5,108,111,99,97,108,0,0,1,0,1]);
 const resp=await new Promise((res,rej)=>{const c=dgram.createSocket('udp4');c.once('message',m=>{c.close();res(m)});c.once('error',rej);c.send(q,srv.address().port,'127.0.0.1')});
 assert.equal(resp.readUInt16BE(6),1);srv.close();
});

test('Redis TTL and persistence survive restart',async()=>{
 const dir=tmp(),file=path.join(dir,'redis.json'),site=aisite();
 let srv=site.createRedisRespServer({persistFile:file});await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 let c=new RedisRespClient();await c.connect({host:'127.0.0.1',port:srv.address().port});
 assert.equal(await c.command('SET','a','1','EX','10'),'OK');assert.ok((await c.ttl('a'))>=1);await c.command('SAVE');await c.quit();await new Promise(res=>srv.close(res));
 srv=site.createRedisRespServer({persistFile:file});await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 c=new RedisRespClient();await c.connect({host:'127.0.0.1',port:srv.address().port});assert.equal(await c.get('a'),'1');await c.quit();await new Promise(res=>srv.close(res));
});

test('FTP server accepts passive LIST',async()=>{
 const dir=tmp();fs.writeFileSync(path.join(dir,'a.txt'),'x');
 const site=aisite(),srv=site.createFtpServer({root:dir});await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const C=site.FtpClient,c=new C();await c.connect({host:'127.0.0.1',port:srv.address().port});await c.login();
 const list=await c.list();assert.ok(list.includes('a.txt'));await c.quit();await new Promise(res=>srv.close(res));
});

test('capabilities reflect comprehensive support',()=>{
 const caps=aisite().protocolCapabilities();
 assert.equal(caps.http2.client,true);assert.equal(caps.dns.server,true);assert.equal(caps.ftp.server,true);
 assert.ok(caps.redis.status.includes('ttl'));assert.ok(caps.mqtt.status.includes('qos2'));
});
