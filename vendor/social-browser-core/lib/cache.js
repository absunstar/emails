'use strict';

function valueBytes(value){
  if(Buffer.isBuffer(value))return value.length;
  if(typeof value==='string')return Buffer.byteLength(value);
  if(value==null)return 8;
  if(typeof value==='number'||typeof value==='boolean')return 8;
  try{return Buffer.byteLength(JSON.stringify(value))}catch{return 256}
}
class MemoryCache {
  constructor(options={}) {
    this.map = new Map();
    this.max=Math.max(16,Number(options.max||options.maxEntries||10000));
    this.maxBytes=Math.max(1024*1024,Number(options.maxBytes||128*1024*1024));
    this.bytes=0;this.pressureFactor=1;
    this.hits=0;this.misses=0;this.evictions=0;
  }
  _limits(){return{max:Math.max(16,Math.floor(this.max*this.pressureFactor)),maxBytes:Math.max(1024*1024,Math.floor(this.maxBytes*this.pressureFactor))}}
  _touch(key,row){this.map.delete(key);this.map.set(key,row);return row}
  _delete(key){const row=this.map.get(key);if(!row)return false;this.map.delete(key);this.bytes-=row.bytes||0;return true}
  _evict(){
    const {max,maxBytes}=this._limits();
    while(this.map.size>max||this.bytes>maxBytes){const key=this.map.keys().next().value;if(key===undefined)break;if(this._delete(key))this.evictions++}
  }
  setPressureFactor(factor=1){this.pressureFactor=Math.max(.2,Math.min(1,Number(factor)||1));this._evict();return this.pressureFactor}
  set(key, value, ttlMs = 0) {
    const old=this.map.get(key);if(old)this._delete(key);
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    const row={ value, expiresAt, bytes:valueBytes(value) };
    if(row.bytes>this.maxBytes)return value;
    this.map.set(key,row);this.bytes+=row.bytes;this._evict();
    return value;
  }
  get(key) {
    const row = this.map.get(key);
    if (!row){this.misses++;return undefined}
    if (row.expiresAt && row.expiresAt <= Date.now()) {
      this._delete(key);this.misses++;return undefined;
    }
    this.hits++;this._touch(key,row);return row.value;
  }
  has(key) { return this.get(key) !== undefined; }
  delete(key) { return this._delete(key); }
  clear() { this.map.clear();this.bytes=0; }
  size() {
    for(const [key,row] of [...this.map])if(row.expiresAt&&row.expiresAt<=Date.now())this._delete(key);
    return this.map.size;
  }
  async remember(key, ttlMs, fn) {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }
  stats(){return{size:this.size(),max:this.max,bytes:this.bytes,maxBytes:this.maxBytes,pressureFactor:this.pressureFactor,hits:this.hits,misses:this.misses,evictions:this.evictions,hitRate:(this.hits+this.misses)?this.hits/(this.hits+this.misses):0}}
}
module.exports = { MemoryCache };
