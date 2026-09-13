'use strict';

class InvalidationCoordinator {
  constructor(options={}){
    this.handlers=new Map();
    this.sequence=0;
    this.metrics={invalidateEvents:0,clearEvents:0,handlerCalls:0,errors:0};
    this.errorHandler=typeof options.onError==='function'?options.onError:null;
  }
  subscribe(name,handler={}){
    name=String(name||`handler-${++this.sequence}`);
    const row={
      name,
      invalidate:typeof handler==='function'?handler:handler.invalidate,
      clear:typeof handler==='function'?handler:handler.clear,
      priority:Number(handler.priority||0),
      order:++this.sequence
    };
    this.handlers.set(name,row);
    return ()=>this.handlers.delete(name);
  }
  unsubscribe(name){return this.handlers.delete(String(name))}
  _ordered(){return [...this.handlers.values()].sort((a,b)=>b.priority-a.priority||a.order-b.order)}
  _call(type,payload){
    const rows=this._ordered();
    for(const row of rows){
      const fn=row[type];if(typeof fn!=='function')continue;
      try{fn(payload);this.metrics.handlerCalls++}
      catch(error){this.metrics.errors++;try{this.errorHandler?.(error,{type,payload,handler:row.name})}catch{}}
    }
  }
  invalidate(file){
    this.metrics.invalidateEvents++;
    this._call('invalidate',file);
  }
  clear(){
    this.metrics.clearEvents++;
    this._call('clear');
  }
  stats(){return{...this.metrics,handlers:this.handlers.size,names:[...this.handlers.keys()]}}
  close(){this.handlers.clear()}
}

function connectFileCache(fileCache,coordinator){
  if(!fileCache?.on||!coordinator)return()=>{};
  const onInvalidate=file=>coordinator.invalidate(file);
  const onClear=()=>coordinator.clear();
  fileCache.on('invalidate',onInvalidate);
  fileCache.on('clear',onClear);
  return()=>{
    fileCache.off?.('invalidate',onInvalidate);
    fileCache.off?.('clear',onClear);
  };
}

module.exports={InvalidationCoordinator,connectFileCache};
