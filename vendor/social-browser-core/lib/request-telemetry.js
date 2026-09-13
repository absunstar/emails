'use strict';
const {AsyncLocalStorage}=require('async_hooks');

class RequestTelemetry {
  constructor(options={}) {
    this.enabled=options.enabled===true;
    this.max=Math.max(10,Number(options.max||1000));
    this.rows=[];
    this.current=new WeakMap();
    this.context=new AsyncLocalStorage();
  }

  configure(options={}) {
    if ('enabled' in options) this.enabled=!!options.enabled;
    if (options.max) this.max=Math.max(10,Number(options.max));
    return this;
  }

  begin(req) {
    if (!this.enabled) return null;
    const row={
      requestId:req.requestId,
      method:req.method,
      url:req.url,
      startedAt:Date.now(),
      startedPerf:performance.now(),
      phases:[],
      status:null,
      durationMs:null
    };
    this.current.set(req,row);
    this.context.enterWith({req,row});
    return row;
  }

  mark(reqOrName,nameOrData,data=null) {
    if(!this.enabled)return null;
    let row,name,payload;
    if(reqOrName && typeof reqOrName==='object'){
      row=this.current.get(reqOrName);
      name=nameOrData;payload=data;
    }else{
      row=this.context.getStore()?.row;
      name=reqOrName;payload=nameOrData??null;
    }
    if(!row)return null;
    const phase={name,timeMs:performance.now()-row.startedPerf};
    if(payload!==null)phase.data=payload;
    row.phases.push(phase);
    return phase;
  }

  end(req,res) {
    if (!this.enabled) return null;
    const row=this.current.get(req);
    if (!row) return null;
    this.current.delete(req);
    row.status=res.statusCode||200;
    row.durationMs=performance.now()-row.startedPerf;
    row.endedAt=Date.now();
    delete row.startedPerf;
    this.rows.push(row);
    if(this.rows.length>this.max)this.rows.splice(0,this.rows.length-this.max);
    return row;
  }

  recent(limit=50, filter={}) {
    let rows=this.rows;
    if(filter.url)rows=rows.filter(x=>x.url===filter.url);
    if(filter.method)rows=rows.filter(x=>x.method===filter.method);
    if(filter.status)rows=rows.filter(x=>x.status===filter.status);
    return rows.slice(-Math.max(0,Number(limit)||50));
  }

  clear(){this.rows.length=0;this.current=new WeakMap()}
}
module.exports={RequestTelemetry};
