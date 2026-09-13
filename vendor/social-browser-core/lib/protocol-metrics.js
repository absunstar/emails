'use strict';
class ProtocolMetrics{
  constructor(){this.counters=new Map();this.timings=new Map();this.active=new Map()}
  inc(protocol,name,n=1){const k=`${protocol}.${name}`;this.counters.set(k,(this.counters.get(k)||0)+n)}
  setActive(protocol,n){this.active.set(protocol,n)}
  observe(protocol,name,ms){
    const k=`${protocol}.${name}`,x=this.timings.get(k)||{count:0,totalMs:0,minMs:Infinity,maxMs:0};
    x.count++;x.totalMs+=ms;x.minMs=Math.min(x.minMs,ms);x.maxMs=Math.max(x.maxMs,ms);x.avgMs=x.totalMs/x.count;this.timings.set(k,x)
  }
  snapshot(){return {
    counters:Object.fromEntries(this.counters),
    active:Object.fromEntries(this.active),
    timings:Object.fromEntries([...this.timings].map(([k,v])=>[k,{...v}]))
  }}
}
module.exports={ProtocolMetrics};
