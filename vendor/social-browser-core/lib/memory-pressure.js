'use strict';
const os=require('os');
const v8=require('v8');

const MB=1024*1024;
function clamp(v,min,max){return Math.max(min,Math.min(max,Number(v)||0))}

class MemoryPressureController{
  constructor(site,options={}){
    this.site=site;
    this.enabled=options.enabled!==false;
    this.intervalMs=Math.max(1000,Number(options.intervalMs||15000));
    const constrained=Number(process.constrainedMemory?.()||0);
    const hostTotal=Math.min(os.totalmem(),constrained>0?constrained:Number.MAX_SAFE_INTEGER);
    this.memoryBudgetBytes=Math.max(128*MB,Number(options.memoryBudgetBytes||Math.min(1024*MB,Math.max(384*MB,Math.floor(hostTotal*0.10)))));
    this.thresholds={
      elevated:clamp(options.elevated??0.65,0.30,0.90),
      high:clamp(options.high??0.78,0.40,0.95),
      critical:clamp(options.critical??0.90,0.50,0.99),
      recover:clamp(options.recover??0.55,0.20,0.85)
    };
    if(this.thresholds.high<=this.thresholds.elevated)this.thresholds.high=this.thresholds.elevated+0.05;
    if(this.thresholds.critical<=this.thresholds.high)this.thresholds.critical=Math.min(.99,this.thresholds.high+0.08);
    this.factors={
      normal:1,
      elevated:clamp(options.elevatedFactor??0.85,0.2,1),
      high:clamp(options.highFactor??0.60,0.2,1),
      critical:clamp(options.criticalFactor??0.35,0.2,1)
    };
    this.memoryUsage=typeof options.memoryUsage==='function'?options.memoryUsage:()=>process.memoryUsage();
    this.heapStatistics=typeof options.heapStatistics==='function'?options.heapStatistics:()=>v8.getHeapStatistics();
    this.hysteresis=clamp(options.hysteresis??0.04,0,0.15);
    this.level='normal';this.factor=1;this.timer=null;
    this.metrics={samples:0,transitions:0,trims:0,restores:0,errors:0,lastSampleAt:0};
    this.last=null;
    if(this.enabled&&options.autoStart!==false)this.start();
  }
  cacheBytes(){
    const f=this.site.fileCache?.stats?.()||{},r=this.site.responseCache?.stats?.()||{},c=this.site.compressionCache?.stats?.()||{},m=this.site.cache?.stats?.()||{};
    return Number(f.bytes||0)+Number(f.compiledBytes||0)+Number(f.compressedBytes||0)+Number(r.bytes||0)+Number(c.bytes||0)+Number(m.bytes||0);
  }
  _nextLevel(ratio){
    if(this.level!=='normal'&&ratio<=this.thresholds.recover)return 'normal';
    if(ratio>=this.thresholds.critical)return 'critical';
    if(this.level==='critical'&&ratio>=this.thresholds.high-this.hysteresis)return 'high';
    if(ratio>=this.thresholds.high)return 'high';
    if(this.level==='high'&&ratio>=this.thresholds.elevated-this.hysteresis)return 'elevated';
    if(ratio>=this.thresholds.elevated)return 'elevated';
    if(this.level==='elevated'&&ratio>this.thresholds.recover)return 'elevated';
    return 'normal';
  }
  _apply(level){
    const factor=this.factors[level]??1;
    const changed=level!==this.level||factor!==this.factor;
    if(!changed)return false;
    const restoring=factor>this.factor;
    this.level=level;this.factor=factor;this.metrics.transitions++;
    try{this.site.fileCache?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.responseCache?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.compressionCache?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.cache?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.queryCache?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.queryPlan?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    try{this.site.sessionStore?.setPressureFactor?.(factor)}catch{this.metrics.errors++}
    if(restoring)this.metrics.restores++;else this.metrics.trims++;
    try{this.site.emit?.('memory-pressure',{level,factor,sample:this.last})}catch{}
    return true;
  }
  sample(){
    this.metrics.samples++;this.metrics.lastSampleAt=Date.now();
    let mem,heap;
    try{mem=this.memoryUsage();heap=this.heapStatistics()}catch(error){this.metrics.errors++;return this.last}
    const rss=Number(mem.rss||0),heapUsed=Number(mem.heapUsed||0),heapLimit=Math.max(1,Number(heap.heap_size_limit||0));
    const rssRatio=rss/this.memoryBudgetBytes,heapRatio=heapUsed/heapLimit;
    const ratio=Math.max(rssRatio,heapRatio);
    const cacheBytes=this.cacheBytes();
    this.last={
      at:this.metrics.lastSampleAt,rss,heapUsed,heapLimit,
      memoryBudgetBytes:this.memoryBudgetBytes,rssRatio,heapRatio,ratio,cacheBytes,
      level:this.level,factor:this.factor
    };
    const level=this._nextLevel(ratio);
    this._apply(level);
    this.last.level=this.level;this.last.factor=this.factor;
    return this.last;
  }
  start(){
    if(!this.enabled||this.timer)return this;
    this.timer=setInterval(()=>{try{this.sample()}catch{this.metrics.errors++}},this.intervalMs);
    this.timer.unref?.();return this;
  }
  stop(){if(this.timer){clearInterval(this.timer);this.timer=null}return this}
  stats(){return{enabled:this.enabled,intervalMs:this.intervalMs,memoryBudgetBytes:this.memoryBudgetBytes,thresholds:{...this.thresholds},hysteresis:this.hysteresis,factors:{...this.factors},level:this.level,factor:this.factor,...this.metrics,last:this.last}}
}
module.exports={MemoryPressureController};
