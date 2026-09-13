'use strict';

class AdaptiveStoragePlanner {
  constructor(options={}){
    this.enabled=options.enabled!==false;
    this.small=Number(options.small||10_000);
    this.medium=Number(options.medium||250_000);
    this.large=Number(options.large||2_000_000);
    this.huge=Number(options.huge||8_000_000);
    this.writeBurstThreshold=Number(options.writeBurstThreshold||100);
    this.history=[];
    this.maxHistory=Math.max(100,Number(options.maxHistory||5000));
    this.selfTune=options.selfTune!==false;
    this.minSamples=Math.max(10,Number(options.minSamples||50));
    this.memoryPressureHigh=Number(options.memoryPressureHigh||0.80);
    this.latency={
      read:{},write:{},update:{},delete:{}
    };
    this.queryFields=new Map();
    this.tuningVersion=0;
    this.counters={read:0,write:0,update:0,delete:0};
  }
  observe(type,meta={}){
    if(this.counters[type]!==undefined)this.counters[type]++;
    this.history.push({type,time:Date.now(),...meta});
    if(this.history.length>this.maxHistory)this.history.shift();
  }
  _recent(type,windowMs=5000){
    const cutoff=Date.now()-windowMs;
    let n=0;
    for(let i=this.history.length-1;i>=0;i--){
      const x=this.history[i];
      if(x.time<cutoff)break;
      if(x.type===type)n++;
    }
    return n;
  }
  sizeClass(count){
    if(count<this.small)return 'small';
    if(count<this.medium)return 'medium';
    if(count<this.large)return 'large';
    if(count<this.huge)return 'very-large';
    return 'huge';
  }
  chooseRead(ctx={}){
    const count=Number(ctx.count||0),size=this.sizeClass(count);
    if(ctx.directId===true)return {strategy:'direct-slot',reason:'dense-id',size};
    if(ctx.hashIndexed===true)return {strategy:'hash-index',reason:'equality-index',size};
    if(ctx.rangeIndexed===true)return {strategy:'disk-range-index',reason:'range-index',size};
    if(size==='small')return {strategy:'memory-scan',reason:'small-collection',size};
    if(size==='medium')return {strategy:'bounded-scan',reason:'medium-collection',size};
    return {strategy:'paged-scan',reason:'large-collection-no-index',size};
  }
  chooseWrite(ctx={}){
    const count=Number(ctx.count||0),size=this.sizeClass(count);
    const burst=this._recent('write')+this._recent('update')+this._recent('delete');
    if(ctx.transactionSize>1)return {strategy:'transaction-group-commit',durability:'sync',reason:'batched-transaction',size,burst};
    if(size==='small'&&burst<this.writeBurstThreshold)return {strategy:'sync-write',durability:'sync',reason:'small-low-burst',size,burst};
    if(burst>=this.writeBurstThreshold || ['large','very-large','huge'].includes(size))
      return {strategy:'group-commit',durability:'group',reason:burst>=this.writeBurstThreshold?'write-burst':'large-collection',size,burst};
    return {strategy:'sync-write',durability:'sync',reason:'default-safe',size,burst};
  }
  chooseUpdate(ctx={}){
    const count=Number(ctx.count||0),size=this.sizeClass(count);
    if(ctx.directId===true)return {strategy:'direct-slot-version-append',reason:'dense-id',size};
    if(ctx.hashIndexed===true)return {strategy:'indexed-version-append',reason:'hash-index',size};
    return {strategy:size==='small'?'scan-update':'paged-candidate-scan',reason:'no-index',size};
  }
  chooseDelete(ctx={}){
    const count=Number(ctx.count||0),size=this.sizeClass(count);
    if(ctx.directId===true)return {strategy:'direct-tombstone',reason:'dense-id',size};
    if(ctx.hashIndexed===true)return {strategy:'indexed-tombstone',reason:'hash-index',size};
    return {strategy:size==='small'?'scan-delete':'paged-candidate-scan',reason:'no-index',size};
  }

  recordLatency(type,strategy,ms){
    if(!this.latency[type])this.latency[type]={};
    const x=this.latency[type][strategy]||(this.latency[type][strategy]={count:0,totalMs:0,avgMs:0,minMs:Infinity,maxMs:0});
    x.count++;x.totalMs+=ms;x.avgMs=x.totalMs/x.count;x.minMs=Math.min(x.minMs,ms);x.maxMs=Math.max(x.maxMs,ms);
  }
  observeQueryFields(where={}){
    for(const [field,cond] of Object.entries(where||{})){
      let kind='eq';
      if(cond&&typeof cond==='object'&&['$gt','$gte','$lt','$lte'].some(k=>Object.hasOwn(cond,k)))kind='range';
      const key=field+'|'+kind;
      this.queryFields.set(key,(this.queryFields.get(key)||0)+1);
    }
  }
  memoryPressure(){
    const m=process.memoryUsage();
    const heapRatio=m.heapTotal?m.heapUsed/m.heapTotal:0;
    return {heapUsed:m.heapUsed,heapTotal:m.heapTotal,rss:m.rss,heapRatio,high:heapRatio>=this.memoryPressureHigh};
  }
  recommendIndexes(existingHash=new Set(),existingRange=new Set()){
    const out=[];
    const entries=[...this.queryFields.entries()].sort((a,b)=>b[1]-a[1]);
    for(const [key,count] of entries){
      if(count<this.minSamples)continue;
      const [field,kind]=key.split('|');
      if(kind==='eq'&&!existingHash.has(field))out.push({type:'hash',field,count,reason:'frequent-equality-query'});
      if(kind==='range'&&!existingRange.has(field))out.push({type:'range',field,count,reason:'frequent-range-query'});
      if(out.length>=5)break;
    }
    return out;
  }
  tune(context={}){
    if(!this.selfTune)return {changed:false,reason:'disabled'};
    const mp=this.memoryPressure();
    let changed=false;
    const before={small:this.small,medium:this.medium,large:this.large,huge:this.huge,writeBurstThreshold:this.writeBurstThreshold};
    if(mp.high){
      this.small=Math.max(1000,Math.floor(this.small*0.8));
      this.medium=Math.max(this.small+1000,Math.floor(this.medium*0.85));
      this.large=Math.max(this.medium+1000,Math.floor(this.large*0.9));
      changed=true;
    }
    const writeCount=this.counters.write+this.counters.update+this.counters.delete;
    const readCount=this.counters.read;
    if(writeCount>readCount*2&&writeCount>this.minSamples){
      this.writeBurstThreshold=Math.max(20,Math.floor(this.writeBurstThreshold*0.8));
      changed=true;
    }else if(readCount>writeCount*4&&readCount>this.minSamples){
      this.writeBurstThreshold=Math.min(1000,Math.ceil(this.writeBurstThreshold*1.1));
      changed=true;
    }
    if(changed)this.tuningVersion++;
    return {changed,before,after:{small:this.small,medium:this.medium,large:this.large,huge:this.huge,writeBurstThreshold:this.writeBurstThreshold},memory:mp,tuningVersion:this.tuningVersion};
  }
  bestObserved(type){
    const rows=this.latency[type]||{};
    let best=null;
    for(const [strategy,x] of Object.entries(rows)){
      if(x.count<this.minSamples)continue;
      if(!best||x.avgMs<best.avgMs)best={strategy,avgMs:x.avgMs,count:x.count};
    }
    return best;
  }

  report(){return {
    enabled:this.enabled,selfTune:this.selfTune,tuningVersion:this.tuningVersion,
    thresholds:{small:this.small,medium:this.medium,large:this.large,huge:this.huge,writeBurstThreshold:this.writeBurstThreshold},
    counters:{...this.counters},
    bestObserved:{
      read:this.bestObserved('read'),write:this.bestObserved('write'),update:this.bestObserved('update'),delete:this.bestObserved('delete')
    },
    memory:this.memoryPressure()
  }}
}
module.exports={AdaptiveStoragePlanner};
