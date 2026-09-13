'use strict';
const cluster=require('cluster');
const os=require('os');
const {EventEmitter}=require('events');

class ClusterRuntime extends EventEmitter{
  constructor(site,options={}){
    super();this.site=site;this.options=options;this.workers=new Map();this.started=false;this.restarting=false;
  }
  get isPrimary(){return cluster.isPrimary}
  get isWorker(){return cluster.isWorker}
  count(){return this.workers.size}
  start(options={}){
    const enabled=options.enabled??this.options.enabled??false;
    if(!enabled)return {enabled:false,primary:cluster.isPrimary,workers:0};
    if(!cluster.isPrimary)return {enabled:true,primary:false,workerId:cluster.worker?.id||null};
    if(this.started)return this.status();
    this.started=true;
    const count=Math.max(1,Number(options.workers||this.options.workers||Math.min(os.cpus().length,4)));
    for(let i=0;i<count;i++)this._fork();
    cluster.on('exit',(worker,code,signal)=>{
      this.workers.delete(worker.id);this.emit('workerExit',{id:worker.id,code,signal});
      if(this.started&&!this.restarting&&(options.respawn??this.options.respawn??true))this._fork();
    });
    return this.status();
  }
  _fork(){
    const worker=cluster.fork({...process.env,SB_CORE_CLUSTER_WORKER:'1'});
    this.workers.set(worker.id,{worker,startedAt:Date.now(),state:'starting'});
    worker.on('online',()=>{const row=this.workers.get(worker.id);if(row)row.state='online';this.emit('workerOnline',worker.id)});
    worker.on('message',msg=>{
      const row=this.workers.get(worker.id);if(!row)return;
      if(msg?.type==='sb-core:ready'){row.state='ready';row.lastHeartbeat=Date.now();this.emit('workerReady',worker.id,msg)}
      else if(msg?.type==='sb-core:heartbeat'){row.lastHeartbeat=Date.now();row.metrics=msg.metrics||null;this.emit('workerHeartbeat',worker.id,msg)}
    });return worker;
  }
  async rollingRestart(options={}){
    if(!cluster.isPrimary)return false;this.restarting=true;
    const timeoutMs=Math.max(500,Number(options.timeoutMs||10000));
    try{
      for(const row of [...this.workers.values()]){
        const replacement=this._fork();
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Replacement worker timeout')),timeoutMs);
          const done=id=>{if(id===replacement.id){clearTimeout(timer);this.off('workerReady',done);resolve()}};
          this.on('workerReady',done);
        }).catch(()=>{});
        try{row.worker.send({type:'sb-core:drain'})}catch{}
        await new Promise(r=>setTimeout(r,Number(options.drainMs||250)));
        try{row.worker.disconnect()}catch{}
      }
      return true;
    }finally{this.restarting=false}
  }
  async stop(){
    this.started=false;
    if(cluster.isPrimary){
      await Promise.all([...this.workers.values()].map(row=>new Promise(resolve=>{
        const timer=setTimeout(()=>{try{row.worker.kill()}catch{};resolve()},2000);
        row.worker.once('exit',()=>{clearTimeout(timer);resolve()});
        try{row.worker.disconnect()}catch{resolve()}
      })));
      this.workers.clear();
    }
    return true;
  }
  status(){
    return {
      enabled:this.started||!!(this.options.enabled),
      primary:cluster.isPrimary,
      workerId:cluster.worker?.id||null,
      workers:[...this.workers].map(([id,row])=>({id,state:row.state,startedAt:row.startedAt,lastHeartbeat:row.lastHeartbeat||null,metrics:row.metrics||null}))
    };
  }
}

module.exports={ClusterRuntime};
