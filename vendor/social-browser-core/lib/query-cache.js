'use strict';
const crypto=require('crypto');
class QueryCache {
  constructor(options={}){this.map=new Map();this.generations=new Map();this.hits=0;this.misses=0;this.evictions=0;this.max=Math.max(16,Number(options.max||options.maxEntries||5000));this.pressureFactor=1}
  generation(scope='default'){return this.generations.get(scope)||0}
  invalidate(scope='default'){const n=this.generation(scope)+1;this.generations.set(scope,n);return n}
  invalidateAll(){this.map.clear();this.generations.clear();return true}
  key(scope,query,options={}){return crypto.createHash('sha1').update(JSON.stringify([scope,this.generation(scope),query,options])).digest('hex')}
  _evict(){const max=Math.max(16,Math.floor(this.max*this.pressureFactor));while(this.map.size>max){this.map.delete(this.map.keys().next().value);this.evictions++}}
  setPressureFactor(factor=1){this.pressureFactor=Math.max(.2,Math.min(1,Number(factor)||1));this._evict();return this.pressureFactor}
  async cached(scope,query,loader,options={}){
    const key=this.key(scope,query,options);
    if(this.map.has(key)){this.hits++;const value=this.map.get(key);this.map.delete(key);this.map.set(key,value);return value}
    this.misses++;const value=await loader();this.map.set(key,value);this._evict();return value;
  }
  stats(){return{size:this.map.size,max:this.max,pressureFactor:this.pressureFactor,hits:this.hits,misses:this.misses,evictions:this.evictions,generations:Object.fromEntries(this.generations)}}
}
class QueryPlan {
  constructor(options={}){this.map=new Map();this.hits=0;this.misses=0;this.evictions=0;this.max=Math.max(16,Number(options.max||options.maxEntries||5000));this.pressureFactor=1}
  key(query,options={}){return JSON.stringify([query,options])}
  _evict(){const max=Math.max(16,Math.floor(this.max*this.pressureFactor));while(this.map.size>max){this.map.delete(this.map.keys().next().value);this.evictions++}}
  setPressureFactor(factor=1){this.pressureFactor=Math.max(.2,Math.min(1,Number(factor)||1));this._evict();return this.pressureFactor}
  compile(query,options={}){
    const key=this.key(query,options);
    if(this.map.has(key)){this.hits++;const plan=this.map.get(key);this.map.delete(key);this.map.set(key,plan);return plan}
    this.misses++;const plan={key,query,options,compiledAt:Date.now()};this.map.set(key,plan);this._evict();return plan;
  }
  instantiate(plan){return{...plan,instantiatedAt:Date.now()}}
  clear(){this.map.clear()}
  stats(){return{size:this.map.size,max:this.max,pressureFactor:this.pressureFactor,hits:this.hits,misses:this.misses,evictions:this.evictions}}
}
module.exports={QueryCache,QueryPlan};
