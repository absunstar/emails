'use strict';

class Hooks {
  constructor(){ this.map=new Map(); }
  on(name,fn){
    if(!this.map.has(name))this.map.set(name,[]);
    this.map.get(name).push(fn);
    return ()=>this.off(name,fn);
  }
  once(name,fn){
    const off=this.on(name,(...args)=>{off();return fn(...args)});
    return off;
  }
  off(name,fn){
    const list=this.map.get(name);
    if(!list)return false;
    const i=list.indexOf(fn);
    if(i<0)return false;
    list.splice(i,1);
    if(!list.length)this.map.delete(name);
    return true;
  }
  async run(name,...args){
    const out=[];
    for(const fn of [...(this.map.get(name)||[])])out.push(await fn(...args));
    return out;
  }
  clear(name){
    if(name)this.map.delete(name); else this.map.clear();
  }
}
module.exports={Hooks};
