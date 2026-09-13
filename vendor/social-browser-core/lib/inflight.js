'use strict';
class Inflight {
  constructor(){this.map=new Map()}
  run(key,fn){
    if(this.map.has(key))return this.map.get(key);
    const p=Promise.resolve().then(fn).finally(()=>this.map.delete(key));
    this.map.set(key,p);
    return p;
  }
  has(key){return this.map.has(key)}
  size(){return this.map.size}
  clear(){this.map.clear()}
}
module.exports={Inflight};
