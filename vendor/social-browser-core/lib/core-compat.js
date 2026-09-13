'use strict';
class AsyncPool{
  constructor(options={}){this.concurrency=Math.max(1,Number(options.concurrency||4));this.active=0;this.queue=[]}
  run(fn){return new Promise((resolve,reject)=>{this.queue.push({fn,resolve,reject});this._drain()})}
  _drain(){while(this.active<this.concurrency&&this.queue.length){const j=this.queue.shift();this.active++;Promise.resolve().then(j.fn).then(j.resolve,j.reject).finally(()=>{this.active--;this._drain()})}}
}
class BackpressureQueue extends AsyncPool{
  constructor(options={}){super(options);this.maxQueue=Math.max(this.concurrency,Number(options.maxQueue||1000))}
  run(fn){if(this.queue.length>=this.maxQueue)return Promise.reject(new Error('Backpressure queue full'));return super.run(fn)}
}
class AdaptiveCache{
  constructor(options={}){this.max=Number(options.max||1000);this.map=new Map();this.hits=0;this.misses=0}
  get(k){if(this.map.has(k)){this.hits++;const v=this.map.get(k);this.map.delete(k);this.map.set(k,v);return v}this.misses++}
  set(k,v){if(this.map.has(k))this.map.delete(k);this.map.set(k,v);while(this.map.size>this.max)this.map.delete(this.map.keys().next().value);return v}
  delete(k){return this.map.delete(k)} clear(){this.map.clear()}
  stats(){return{size:this.map.size,hits:this.hits,misses:this.misses}}
}
module.exports={AsyncPool,BackpressureQueue,AdaptiveCache};
