'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {SecurityShield}=require('../lib/security-shield');

function fakeSocket(ip){
  const s=new EventEmitter();s.remoteAddress=ip;s.destroyed=false;s.destroy=()=>{s.destroyed=true;s.emit('close')};return s;
}

test('global concurrent connection limit is enforced',()=>{
 const shield=new SecurityShield({maxConnectionsTotal:2,maxConnectionsPerIp:10});
 const a=fakeSocket('1.1.1.1'),b=fakeSocket('2.2.2.2'),c=fakeSocket('3.3.3.3');
 assert.equal(shield.onConnection(a),true);
 assert.equal(shield.onConnection(b),true);
 assert.equal(shield.onConnection(c),false);
 assert.equal(c.destroyed,true);
 a.emit('close');b.emit('close');
});

test('strike and ban tracking remain bounded',()=>{
 const shield=new SecurityShield({maxTrackedIps:500,banThreshold:1000});
 for(let i=0;i<5000;i++)shield.strike('10.0.'+Math.floor(i/255)+'.'+(i%255),'test');
 shield.cleanupAbuseState();
 assert.ok(shield.strikes.size<=500);
});
