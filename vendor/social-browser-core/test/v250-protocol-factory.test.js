'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('protocol factory validates capability sides',()=>{
 const site=aisite();
 assert.equal(site.protocolFactory.capabilities('http2').client,true);
 assert.throws(()=>site.protocolFactory.assert('ssh','server'));
});

test('protocol factory creates redis server',async()=>{
 const site=aisite(),srv=site.createProtocolServer('redis');
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=await site.connectProtocol(`redis://127.0.0.1:${srv.address().port}`);
 assert.equal(await c.set('a','1'),'OK');assert.equal(await c.get('a'),'1');
 await c.quit();await new Promise(res=>srv.close(res));
});

test('protocol factory creates websocket server and client',async()=>{
 const site=aisite(),srv=site.createProtocolServer('ws',{handler:p=>p.on('message',m=>p.send('x'+m))});
 await new Promise(res=>srv.listen(0,'127.0.0.1',res));
 const c=await site.connectProtocol(`ws://127.0.0.1:${srv.address().port}/`);
 const msg=new Promise(res=>c.once('message',res));c.send('1');assert.equal(await msg,'x1');c.close();
 await new Promise(res=>srv.close(res));
});
