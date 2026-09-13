'use strict';

class Scheduler {
  constructor(){
    this.jobs=new Map();
  }
  every(name,ms,fn){
    this.cancel(name);
    const id=setInterval(fn,Math.max(1,Number(ms)||1));
    id.unref?.();
    this.jobs.set(name,{type:'interval',id,ms,fn});
    return name;
  }
  later(name,ms,fn){
    this.cancel(name);
    const id=setTimeout(()=>{
      this.jobs.delete(name);
      fn();
    },Math.max(0,Number(ms)||0));
    id.unref?.();
    this.jobs.set(name,{type:'timeout',id,ms,fn});
    return name;
  }
  cancel(name){
    const job=this.jobs.get(name);
    if(!job)return false;
    if(job.type==='interval')clearInterval(job.id); else clearTimeout(job.id);
    this.jobs.delete(name);
    return true;
  }
  clear(){
    for(const name of [...this.jobs.keys()])this.cancel(name);
  }
  list(){ return [...this.jobs.keys()]; }
  has(name){ return this.jobs.has(name); }
}
module.exports={Scheduler};
