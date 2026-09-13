'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const net=require('net');
const {SmtpClient}=require('../lib/smtp-client');

test('smtp client performs EHLO and basic message transaction',async()=>{
 const srv=net.createServer(sock=>{
   sock.setEncoding('utf8');sock.write('220 mock smtp\r\n');let buf='',dataMode=false;
   sock.on('data',d=>{
     buf+=d;
     if(dataMode&&buf.includes('\r\n.\r\n')){dataMode=false;buf='';sock.write('250 queued\r\n');return}
     let i;
     while(!dataMode&&(i=buf.indexOf('\r\n'))>=0){
       const line=buf.slice(0,i);buf=buf.slice(i+2);
       if(line.startsWith('EHLO'))sock.write('250 mock\r\n');
       else if(line.startsWith('MAIL FROM'))sock.write('250 ok\r\n');
       else if(line.startsWith('RCPT TO'))sock.write('250 ok\r\n');
       else if(line==='DATA'){dataMode=true;sock.write('354 end data\r\n')}
       else if(line==='QUIT'){sock.write('221 bye\r\n');sock.end()}
     }
   });
 });
 await new Promise((res,rej)=>{srv.once('error',rej);srv.listen(0,'127.0.0.1',res)});
 const c=new SmtpClient();
 assert.equal((await c.connect({host:'127.0.0.1',port:srv.address().port})).code,220);
 assert.equal((await c.ehlo('test')).code,250);
 assert.equal((await c.send({from:'a@test',to:'b@test',data:'Subject: Hi\r\n\r\nHello'})).code,250);
 assert.equal((await c.quit()).code,221);
 await new Promise(res=>srv.close(res));
});
