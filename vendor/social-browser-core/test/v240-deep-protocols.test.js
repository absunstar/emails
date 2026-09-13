'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');
const {RedisRespClient}=require('../lib/redis-resp');
const {WebSocketClient}=require('../lib/websocket-client');

test('websocket client connects to aisite websocket server',async()=>{
 const site=aisite();const srv=site.protocols.ws(peer=>peer.on('message',m=>peer.send('echo:'+m)));
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=new WebSocketClient();await c.connect(`ws://127.0.0.1:${srv.address().port}/`);
 const msg=new Promise(res=>c.once('message',res));c.send('hi');assert.equal(await msg,'echo:hi');c.close();
 await new Promise(res=>srv.close(res));
});

test('redis MULTI/EXEC batches commands',async()=>{
 const site=aisite(),srv=site.createRedisRespServer();
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=new RedisRespClient();await c.connect({host:'127.0.0.1',port:srv.address().port});
 assert.equal(await c.multi(),'OK');
 assert.equal(await c.set('a','1'),'QUEUED');
 assert.equal(await c.set('b','2'),'QUEUED');
 const out=await c.exec();assert.deepEqual(out,['OK','OK']);
 assert.equal(await c.get('a'),'1');await c.quit();await new Promise(res=>srv.close(res));
});

test('mqtt broker retains messages and supports qos1 publish parsing',async()=>{
 const site=aisite(),broker=site.createMqttBroker();
 await new Promise(res=>broker.listen(0,'127.0.0.1',res));
 const C=site.MqttClient,pub=new C(),sub=new C();
 await pub.connect({host:'127.0.0.1',port:broker.address().port});
 pub.publish('a/b','hello',{qos:1,retain:true});
 await new Promise(r=>setTimeout(r,10));
 await sub.connect({host:'127.0.0.1',port:broker.address().port});
 const got=new Promise(res=>sub.once('message',(t,b)=>res([t,b.toString()])));
 sub.subscribe('a/b');
 assert.deepEqual(await got,['a/b','hello']);
 pub.end();sub.end();await new Promise(res=>broker.close(res));
});

test('capabilities reflect deep protocol support',()=>{
 const caps=aisite().protocolCapabilities();
 assert.equal(caps.ws.client,true);assert.equal(caps.wss.client,true);
 assert.ok(caps.redis.status.includes('pubsub'));
 assert.ok(caps.mqtt.status.includes('qos1'));
 assert.ok(caps.socks5.status.includes('udp-associate'));
});
