'use strict';
const crypto=require('crypto');
const {EventEmitter}=require('events');

const now=()=>Date.now();
const token=()=>crypto.randomBytes(16).toString('hex');

class MemoryCache extends EventEmitter{
  constructor(options={}){
    super();this.map=new Map();this.defaultTtlMs=Number(options.defaultTtlMs||0);this.max=Math.max(100,Number(options.max||100000));
  }
  _expired(row){return !!row?.expiresAt&&row.expiresAt<=now()}
  _getRow(key){
    const row=this.map.get(String(key));
    if(row&&this._expired(row)){this.map.delete(String(key));this.emit('expired',key);return null}
    return row||null;
  }
  async get(key){return this._getRow(key)?.value}
  async has(key){return !!this._getRow(key)}
  async set(key,value,options={}){
    key=String(key);
    const ttlMs=Number(options.ttlMs??this.defaultTtlMs);
    if(this.map.size>=this.max&&!this.map.has(key))this.map.delete(this.map.keys().next().value);
    this.map.set(key,{value,expiresAt:ttlMs>0?now()+ttlMs:0,createdAt:now()});
    this.emit('set',key,value);return value;
  }
  async delete(key){const ok=this.map.delete(String(key));if(ok)this.emit('delete',key);return ok}
  async clear(){this.map.clear();this.emit('clear');return true}
  async increment(key,amount=1,options={}){
    const value=Number(await this.get(key)||0)+Number(amount||0);await this.set(key,value,options);return value;
  }
  async getOrSet(key,factory,options={}){
    const existing=await this.get(key);if(existing!==undefined)return existing;
    const value=await factory();await this.set(key,value,options);return value;
  }
  async compareAndSet(key,expected,value,options={}){
    const current=await this.get(key);
    if(current!==expected)return false;
    await this.set(key,value,options);return true;
  }
  async keys(prefix=''){
    const out=[];for(const key of this.map.keys())if(String(key).startsWith(prefix)&&this._getRow(key))out.push(key);return out;
  }
  stats(){let expiring=0;for(const row of this.map.values())if(row.expiresAt)expiring++;return {provider:'memory',size:this.map.size,max:this.max,expiring}}
}

class LockManager extends EventEmitter{
  constructor(cache,options={}){
    super();this.cache=cache;this.prefix=options.prefix||'__lock:';this.defaultTtlMs=Number(options.defaultTtlMs||30000);
  }
  async acquire(name,options={}){
    const key=this.prefix+String(name),ttlMs=Number(options.ttlMs||this.defaultTtlMs),owner=options.owner||token();
    const deadline=now()+Number(options.waitMs||0),pollMs=Math.max(5,Number(options.pollMs||25));
    while(true){
      const existing=await this.cache.get(key);
      if(!existing){
        await this.cache.set(key,{owner,createdAt:now()}, {ttlMs});
        const verify=await this.cache.get(key);
        if(verify?.owner===owner){
          const lock={name:String(name),owner,ttlMs,released:false,
            release:()=>this.release(name,owner),
            extend:(nextTtl=ttlMs)=>this.extend(name,owner,nextTtl)
          };
          this.emit('acquired',lock);return lock;
        }
      }
      if(now()>=deadline)return null;
      await new Promise(r=>setTimeout(r,pollMs));
    }
  }
  async release(name,owner){
    const key=this.prefix+String(name),row=await this.cache.get(key);
    if(!row||row.owner!==owner)return false;
    await this.cache.delete(key);this.emit('released',{name,owner});return true;
  }
  async extend(name,owner,ttlMs){
    const key=this.prefix+String(name),row=await this.cache.get(key);
    if(!row||row.owner!==owner)return false;
    await this.cache.set(key,row,{ttlMs:Number(ttlMs||this.defaultTtlMs)});return true;
  }
  async using(name,fn,options={}){
    const lock=await this.acquire(name,options);
    if(!lock)throw Object.assign(new Error(`Lock unavailable: ${name}`),{code:'LOCK_UNAVAILABLE'});
    try{return await fn(lock)}finally{await lock.release()}
  }
}

class IdempotencyStore{
  constructor(cache,options={}){this.cache=cache;this.prefix=options.prefix||'__idem:';this.ttlMs=Number(options.ttlMs||24*3600*1000)}
  async get(key){return this.cache.get(this.prefix+key)}
  async remember(key,value,options={}){return this.cache.set(this.prefix+key,value,{ttlMs:options.ttlMs||this.ttlMs})}
  async run(key,fn,options={}){
    const existing=await this.get(key);
    if(existing!==undefined)return {replayed:true,value:existing};
    const value=await fn();await this.remember(key,value,options);return {replayed:false,value};
  }
}

class LeaderElection extends EventEmitter{
  constructor(locks,options={}){
    super();this.locks=locks;this.name=options.name||'core-leader';this.ttlMs=Number(options.ttlMs||5000);this.renewMs=Number(options.renewMs||Math.max(500,this.ttlMs/2));this.lock=null;this.timer=null;
  }
  async campaign(){
    if(this.lock)return true;
    this.lock=await this.locks.acquire(this.name,{ttlMs:this.ttlMs,waitMs:0});
    if(!this.lock)return false;
    this.emit('leader',this.lock.owner);
    this.timer=setInterval(async()=>{
      if(!this.lock)return;
      const ok=await this.lock.extend(this.ttlMs);
      if(!ok){this.lock=null;clearInterval(this.timer);this.timer=null;this.emit('lost')}
    },this.renewMs);this.timer.unref?.();return true;
  }
  async resign(){if(this.timer)clearInterval(this.timer);this.timer=null;if(this.lock)await this.lock.release();this.lock=null;this.emit('resigned');return true}
  isLeader(){return !!this.lock}
}

module.exports={MemoryCache,LockManager,IdempotencyStore,LeaderElection};
