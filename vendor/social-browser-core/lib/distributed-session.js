'use strict';

class DistributedSessionStore{
  constructor(cache,options={}){
    this.cache=cache;this.prefix=options.prefix||'__session:';this.ttlMs=Number(options.ttlMs||30*24*3600*1000);
  }
  async load(id){return this.cache.get(this.prefix+id)}
  async save(id,data,options={}){await this.cache.set(this.prefix+id,data,{ttlMs:options.ttlMs||this.ttlMs});return data}
  async destroy(id){return this.cache.delete(this.prefix+id)}
  async touch(id,ttlMs=this.ttlMs){
    const data=await this.load(id);if(data===undefined)return false;await this.save(id,data,{ttlMs});return true;
  }
  async exists(id){return this.cache.has(this.prefix+id)}
}

module.exports={DistributedSessionStore};
