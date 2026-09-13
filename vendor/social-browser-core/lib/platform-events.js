'use strict';
const {EventEmitter}=require('events');

class PlatformEventBus extends EventEmitter{
  constructor(options={}){
    super();this.maxHistory=Math.max(0,Number(options.maxHistory||1000));this.history=[];this.adapter=options.adapter||null;
  }
  async publish(topic,payload,meta={}){
    const event={topic:String(topic),payload,meta:{...meta},timestamp:Date.now()};
    if(this.maxHistory){this.history.push(event);if(this.history.length>this.maxHistory)this.history.splice(0,this.history.length-this.maxHistory)}
    this.emit(event.topic,event);this.emit('*',event);
    if(this.adapter?.publish)await this.adapter.publish(event.topic,payload,event.meta);
    return event;
  }
  subscribe(topic,fn){this.on(String(topic),fn);return ()=>this.off(String(topic),fn)}
  recent(limit=100,topic=null){
    let rows=this.history;if(topic)rows=rows.filter(x=>x.topic===topic);return rows.slice(-Math.max(0,Number(limit)||100));
  }
  clearHistory(){this.history.length=0}
  stats(){return {listeners:this.eventNames().reduce((n,k)=>n+this.listenerCount(k),0),history:this.history.length,adapter:!!this.adapter}}
}

module.exports={PlatformEventBus};
