'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('net');
const aisite=require('..');
const {encodeResp,parseResp}=require('../lib/redis-resp');

test('RESP encoder/parser roundtrip',()=>{
 const b=encodeResp(['SET','a','1']);
 assert.ok(b.toString().startsWith('*3\r\n'));
 const x=parseResp(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\na\r\n'));
 assert.deepEqual(x.value,['GET','a']);
});

test('POP3 client basic auth/stat',async()=>{
 const srv=net.createServer(sock=>{
   sock.setEncoding('utf8');sock.write('+OK pop3\r\n');let b='';
   sock.on('data',d=>{b+=d;let i;while((i=b.indexOf('\r\n'))>=0){const l=b.slice(0,i);b=b.slice(i+2);
     if(l.startsWith('USER'))sock.write('+OK\r\n');else if(l.startsWith('PASS'))sock.write('+OK\r\n');
     else if(l==='STAT')sock.write('+OK 2 20\r\n');else if(l==='QUIT'){sock.write('+OK bye\r\n');sock.end()}
   }});
 });
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=new (require('../lib/pop3-client').Pop3Client)();
 assert.ok((await c.connect({host:'127.0.0.1',port:srv.address().port})).ok);
 assert.ok((await c.user('u')).ok);assert.ok((await c.pass('p')).ok);assert.ok((await c.stat()).ok);
 await c.quit();await new Promise(res=>srv.close(res));
});

test('IMAP client greeting/login',async()=>{
 const srv=net.createServer(sock=>{
   sock.setEncoding('utf8');sock.write('* OK imap ready\r\n');let b='';
   sock.on('data',d=>{b+=d;let i;while((i=b.indexOf('\r\n'))>=0){const l=b.slice(0,i);b=b.slice(i+2);const tag=l.split(' ')[0];
     if(l.includes('LOGIN'))sock.write(`${tag} OK logged in\r\n`);
     else if(l.includes('LOGOUT')){sock.write('* BYE\r\n'+`${tag} OK logout\r\n`);sock.end()}
   }});
 });
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=new (require('../lib/imap-client').ImapClient)();
 const g=await c.connect({host:'127.0.0.1',port:srv.address().port});assert.ok(g.startsWith('* OK'));
 assert.ok((await c.login('u','p')).ok);await c.logout();await new Promise(res=>srv.close(res));
});

test('site exposes new protocol clients',()=>{
 const site=aisite();
 for(const k of ['Pop3Client','ImapClient','RedisRespClient','MqttClient','socks5Connect','socks4Connect','httpConnect'])assert.equal(typeof site[k],'function');
 const caps=site.protocolCapabilities();
 for(const k of ['pop3','imap','mqtt','redis','socks4','socks5','http_connect'])assert.ok(caps[k]);
});
