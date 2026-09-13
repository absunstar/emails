'use strict';
const crypto=require('crypto');
const zlib=require('zlib');

class CompressionCache{
  constructor(options={}){
    this.maxEntries=Math.max(16,Number(options.maxEntries||2048));
    this.maxBytes=Math.max(1024*1024,Number(options.maxBytes||64*1024*1024));
    this.map=new Map();this.inflight=new Map();this.bytes=0;this.pressureFactor=1;
    this.hits=0;this.misses=0;this.sets=0;this.evictions=0;this.inflightHits=0;
  }
  _digest(buffer){return crypto.createHash('sha1').update(buffer).digest('base64url')}
  key(buffer,encoding){return String(encoding)+'\u0000'+this._digest(buffer)}
  get(buffer,encoding){
    const key=this.key(buffer,encoding),row=this.map.get(key);
    if(!row){this.misses++;return null}
    this.map.delete(key);this.map.set(key,row);this.hits++;row.lastAccess=Date.now();return row.buffer;
  }
  _setByKey(key,buffer){
    const old=this.map.get(key);if(old){this.map.delete(key);this.bytes-=old.bytes}
    const row={buffer,bytes:buffer.length,lastAccess:Date.now(),createdAt:Date.now()};
    if(row.bytes>this.maxBytes)return buffer;
    this.map.set(key,row);this.bytes+=row.bytes;this.sets++;
    const maxEntries=Math.max(16,Math.floor(this.maxEntries*this.pressureFactor));
    const maxBytes=Math.max(1024*1024,Math.floor(this.maxBytes*this.pressureFactor));
    this._evict();
    return buffer;
  }
  setPressureFactor(factor=1){this.pressureFactor=Math.max(0.2,Math.min(1,Number(factor)||1));this._evict?.();return this.pressureFactor}
  _evict(){
    const maxEntries=Math.max(16,Math.floor(this.maxEntries*this.pressureFactor));
    const maxBytes=Math.max(1024*1024,Math.floor(this.maxBytes*this.pressureFactor));
    while(this.map.size>maxEntries||this.bytes>maxBytes){const first=this.map.keys().next().value;if(first===undefined)break;const victim=this.map.get(first);this.map.delete(first);this.bytes-=victim?.bytes||0;this.evictions++}
  }
  async compress(buffer,encoding){
    if(!Buffer.isBuffer(buffer))buffer=Buffer.from(String(buffer));
    encoding=String(encoding||'gzip').toLowerCase();
    const key=this.key(buffer,encoding),hit=this.map.get(key);
    if(hit){this.hits++;this.map.delete(key);this.map.set(key,hit);return hit.buffer}
    this.misses++;
    if(this.inflight.has(key)){this.inflightHits++;return this.inflight.get(key)}
    const work=new Promise((resolve,reject)=>{
      const done=(err,out)=>err?reject(err):resolve(this._setByKey(key,out));
      if(encoding==='br'&&zlib.brotliCompress)return zlib.brotliCompress(buffer,done);
      if(encoding==='deflate')return zlib.deflate(buffer,done);
      return zlib.gzip(buffer,done);
    }).finally(()=>this.inflight.delete(key));
    this.inflight.set(key,work);return work;
  }
  clear(){this.map.clear();this.inflight.clear();this.bytes=0}
  stats(){return{entries:this.map.size,maxEntries:this.maxEntries,bytes:this.bytes,maxBytes:this.maxBytes,pressureFactor:this.pressureFactor,inflight:this.inflight.size,hits:this.hits,misses:this.misses,sets:this.sets,evictions:this.evictions,inflightHits:this.inflightHits,hitRate:(this.hits+this.misses)?this.hits/(this.hits+this.misses):0}}
}
module.exports={CompressionCache};
