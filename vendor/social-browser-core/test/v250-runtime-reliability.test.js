'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v250rel-'))}

test('MQTT QoS2 publishes exactly after PUBREL',async()=>{
 const site=aisite(),events=[],broker=site.createMqttBroker({onPublish:(t,b,s,m)=>events.push([t,b.toString(),m.qos])});
 await new Promise(res=>broker.listen(0,'127.0.0.1',res));
 const C=site.MqttClient,c=new C();await c.connect({host:'127.0.0.1',port:broker.address().port});
 const done=new Promise(res=>c.once('pubcomp',res));
 const id=c.publish('q2','hello',{qos:2});
 assert.equal(events.length,0);
 await done;assert.equal(id>0,true);assert.deepEqual(events,[['q2','hello',2]]);
 c.end();await new Promise(res=>broker.close(res));
});

test('FTP server supports STOR and RETR',async()=>{
 const dir=tmp(),site=aisite(),srv=site.createFtpServer({root:dir});
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const C=site.FtpClient,c=new C();await c.connect({host:'127.0.0.1',port:srv.address().port});await c.login();
 assert.equal((await c.stor('x.txt','hello')).code,226);
 assert.equal((await c.retr('x.txt')).toString(),'hello');
 await c.quit();await new Promise(res=>srv.close(res));
});

test('protocol supervisor tracks connections and graceful close',async()=>{
 const site=aisite(),srv=site.protocols.tcp(sock=>sock.on('data',d=>sock.write(d)));
 site.protocolSupervisor.register('echo',srv,{protocol:'tcp',maxConnections:10,idleTimeoutMs:5000});
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=net.connect(srv.address().port,'127.0.0.1');
 await new Promise(res=>c.once('connect',res));
 assert.equal(site.protocolSupervisor.status()[0].connections,1);
 c.end();await new Promise(res=>c.once('close',res));
 await site.protocolSupervisor.close('echo');
 assert.equal(site.protocolSupervisor.status().length,0);
});
