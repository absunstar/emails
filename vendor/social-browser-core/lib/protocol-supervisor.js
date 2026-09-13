'use strict';
const {EventEmitter}=require('events');
const {ProtocolMetrics}=require('./protocol-metrics');

class ProtocolSupervisor extends EventEmitter{
  constructor(options={}){
    super();
    this.options=options;
    this.metrics=options.metrics||new ProtocolMetrics();
    this.entries=new Map();
  }
  register(name,server,options={}){
    if(this.entries.has(name))throw new Error(`Protocol server already registered: ${name}`);
    const entry={name,server,protocol:options.protocol||name,maxConnections:Number(options.maxConnections||0),idleTimeoutMs:Number(options.idleTimeoutMs||0),connections:new Set(),startedAt:Date.now()};
    this.entries.set(name,entry);
    server.on?.('connection',socket=>{
      entry.connections.add(socket);this.metrics.inc(entry.protocol,'connections');this.metrics.setActive(entry.protocol,entry.connections.size);
      if(entry.maxConnections>0&&entry.connections.size>entry.maxConnections){this.metrics.inc(entry.protocol,'rejected');socket.destroy();return}
      if(entry.idleTimeoutMs>0)socket.setTimeout?.(entry.idleTimeoutMs,()=>{this.metrics.inc(entry.protocol,'idleTimeouts');socket.destroy()});
      socket.on?.('error',()=>this.metrics.inc(entry.protocol,'socketErrors'));
      socket.on?.('close',()=>{entry.connections.delete(socket);this.metrics.setActive(entry.protocol,entry.connections.size)});
    });
    server.on?.('error',e=>{this.metrics.inc(entry.protocol,'serverErrors');this.emit('error',e,entry)});
    return server;
  }
  unregister(name){const e=this.entries.get(name);if(!e)return false;this.entries.delete(name);return true}
  status(){
    return [...this.entries.values()].map(e=>({name:e.name,protocol:e.protocol,listening:!!e.server.listening,address:e.server.address?.()||null,connections:e.connections.size,maxConnections:e.maxConnections,idleTimeoutMs:e.idleTimeoutMs,uptimeMs:Date.now()-e.startedAt}));
  }
  health(){
    const servers=this.status();return {ok:servers.every(x=>x.listening),servers,metrics:this.metrics.snapshot()}
  }
  async close(name,{forceAfterMs=2000}={}){
    const e=this.entries.get(name);if(!e)return false;
    await new Promise(resolve=>{
      let done=false;const finish=()=>{if(done)return;done=true;resolve()};
      try{e.server.close(finish)}catch{finish()}
      const t=setTimeout(()=>{for(const s of e.connections)try{s.destroy()}catch{};finish()},forceAfterMs);t.unref?.();
    });
    this.entries.delete(name);return true;
  }
  async closeAll(options={}){
    for(const name of [...this.entries.keys()])await this.close(name,options);
  }
}
module.exports={ProtocolSupervisor};
