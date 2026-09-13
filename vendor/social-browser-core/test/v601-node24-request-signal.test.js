'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const {enhanceRequest}=require('../lib/request');

function fakeRequestWithGetterOnlySignal(){
  const nativeController=new AbortController();
  const proto=Object.create(EventEmitter.prototype);
  Object.defineProperty(proto,'signal',{
    configurable:true,
    enumerable:false,
    get(){ return nativeController.signal; }
  });
  const req=Object.create(proto);
  EventEmitter.call(req);
  req.socket={encrypted:false,remoteAddress:'127.0.0.1'};
  req.headers={host:'localhost'};
  req.url='/hello?x=1';
  req.complete=false;
  return {req,nativeController};
}

test('enhanceRequest supports Node 24 getter-only IncomingMessage.signal',()=>{
  const {req,nativeController}=fakeRequestWithGetterOnlySignal();
  const nativeSignal=req.signal;
  assert.doesNotThrow(()=>enhanceRequest(req));
  assert.equal(req.signal,nativeSignal);
  assert.ok(req.abortController instanceof AbortController);
  assert.equal(req.abortSignal,req.abortController.signal);
  assert.equal(req.abortSignal.aborted,false);
  nativeController.abort(new Error('native abort'));
  assert.equal(req.abortSignal.aborted,true);
});

test('enhanceRequest provides req.signal fallback when runtime has no native signal',()=>{
  const req=new EventEmitter();
  req.socket={encrypted:false,remoteAddress:'127.0.0.1'};
  req.headers={host:'localhost'};
  req.url='/';
  req.complete=false;
  enhanceRequest(req);
  assert.equal(req.signal,req.abortSignal);
  req.emit('aborted');
  assert.equal(req.signal.aborted,true);
});
