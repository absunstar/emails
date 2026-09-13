'use strict';
const crypto=require('crypto');
const {AsyncLocalStorage}=require('async_hooks');

class Tracer{
  constructor(options={}){
    this.enabled=options.enabled!==false;
    this.max=Math.max(10,Number(options.max||2000));
    this.rows=[];
    this.storage=new AsyncLocalStorage();
  }
  id(bytes=8){return crypto.randomBytes(bytes).toString('hex')}
  start(name,attributes={},parent=null){
    if(!this.enabled){
      const noop={setAttribute:()=>noop,error:()=>noop,end:()=>null,run:fn=>fn()};
      return noop;
    }
    const parentSpan=parent||this.storage.getStore()?.span||null;
    const row={
      traceId:parentSpan?.traceId||this.id(16),
      spanId:this.id(8),
      parentSpanId:parentSpan?.spanId||null,
      name:String(name),
      startedAt:Date.now(),
      startedHr:process.hrtime.bigint(),
      attributes:{...attributes},
      status:'ok'
    };
    const span={
      ...row,
      setAttribute:(k,v)=>{row.attributes[k]=v;return span},
      error:(e)=>{row.status='error';row.error={name:e?.name,message:e?.message,code:e?.code||null};return span},
      end:()=>{
        if(row.endedAt)return row;
        row.endedAt=Date.now();
        row.durationMs=Number(process.hrtime.bigint()-row.startedHr)/1e6;
        delete row.startedHr;
        this.rows.push(row);
        if(this.rows.length>this.max)this.rows.splice(0,this.rows.length-this.max);
        return row;
      },
      run:fn=>this.storage.run({span:row},fn)
    };
    return span;
  }
  recent(limit=100,filter={}){
    let rows=this.rows;
    if(filter.name)rows=rows.filter(x=>x.name===filter.name);
    if(filter.traceId)rows=rows.filter(x=>x.traceId===filter.traceId);
    if(filter.status)rows=rows.filter(x=>x.status===filter.status);
    return rows.slice(-Math.max(0,Number(limit)||100));
  }
  clear(){this.rows.length=0}
}

function prometheus(metrics,extra={}){
  const snap=metrics.snapshot();
  const lines=[];
  const safe=x=>String(x).replace(/[^a-zA-Z0-9_:]/g,'_');
  for(const [name,value] of Object.entries(snap.counters||{}))
    lines.push(`${safe(name)} ${Number(value)||0}`);
  for(const [name,row] of Object.entries(snap.timings||{})){
    const n=safe(name);
    lines.push(`${n}_count ${row.count||0}`);
    lines.push(`${n}_sum_ms ${row.totalMs||0}`);
    lines.push(`${n}_avg_ms ${row.avgMs||0}`);
    lines.push(`${n}_max_ms ${row.maxMs||0}`);
  }
  lines.push(`process_uptime_ms ${snap.uptimeMs||0}`);
  lines.push(`process_rss_bytes ${process.memoryUsage().rss}`);
  lines.push(`process_heap_used_bytes ${process.memoryUsage().heapUsed}`);
  for(const [k,v] of Object.entries(extra))if(typeof v==='number'||typeof v==='boolean')lines.push(`${safe(k)} ${Number(v)}`);
  return lines.join('\n')+'\n';
}

module.exports={Tracer,prometheus};
