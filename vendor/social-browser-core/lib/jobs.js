'use strict';
const {EventEmitter}=require('events');
const crypto=require('crypto');

const id=()=>crypto.randomBytes(10).toString('hex');

class JobQueue extends EventEmitter{
  constructor(site,options={}){
    super();this.site=site;this.options=options;this.defs=new Map();this.jobs=new Map();this.pending=[];this.running=new Map();this.dead=[];this.timer=null;this.started=false;
    this.concurrency=Math.max(1,Number(options.concurrency||4));
    this.stallMs=Math.max(1000,Number(options.stallMs||30000));
  }
  define(name,handler,options={}){
    if(typeof handler!=='function')throw new TypeError('Job handler must be a function');
    this.defs.set(String(name),{handler,options:{...options}});return this;
  }
  enqueue(name,payload={},options={}){
    if(!this.defs.has(String(name)))throw Object.assign(new Error(`Unknown job: ${name}`),{code:'JOB_NOT_DEFINED'});
    const key=options.idempotencyKey;
    if(key){
      for(const j of this.jobs.values())if(j.idempotencyKey===key&&!['failed','cancelled'].includes(j.state))return j;
    }
    const job={
      id:options.id||id(),name:String(name),payload,priority:Number(options.priority||0),
      state:'queued',attempts:0,maxAttempts:Math.max(1,Number(options.maxAttempts||this.defs.get(String(name)).options.maxAttempts||3)),
      runAt:Number(options.runAt||Date.now()+Number(options.delayMs||0)),createdAt:Date.now(),
      idempotencyKey:key||null,result:null,error:null,lockedAt:0
    };
    this.jobs.set(job.id,job);this.pending.push(job.id);this._sort();this.emit('queued',job);this._kick();return job;
  }
  schedule(name,payload,when,options={}){
    const runAt=when instanceof Date?when.getTime():typeof when==='number'?when:Date.parse(when);
    return this.enqueue(name,payload,{...options,runAt});
  }
  cancel(jobId){
    const j=this.jobs.get(jobId);if(!j||j.state==='running')return false;j.state='cancelled';this.pending=this.pending.filter(x=>x!==jobId);this.emit('cancelled',j);return true;
  }
  retry(jobId){
    const j=this.jobs.get(jobId);if(!j)return false;j.state='queued';j.error=null;j.runAt=Date.now();this.pending.push(j.id);this._sort();this._kick();return true;
  }
  get(jobId){return this.jobs.get(jobId)||null}
  list(filter={}){
    let rows=[...this.jobs.values()];
    if(filter.state)rows=rows.filter(x=>x.state===filter.state);
    if(filter.name)rows=rows.filter(x=>x.name===filter.name);
    return rows;
  }
  _sort(){this.pending.sort((a,b)=>{const A=this.jobs.get(a),B=this.jobs.get(b);return (B?.priority||0)-(A?.priority||0)||(A?.runAt||0)-(B?.runAt||0)})}
  start(){
    if(this.started)return this;this.started=true;
    this.timer=setInterval(()=>{this._recoverStalled();this._kick()},Math.min(1000,this.stallMs/2));this.timer.unref?.();this._kick();return this;
  }
  async stop(){
    this.started=false;if(this.timer)clearInterval(this.timer);this.timer=null;
    await Promise.allSettled([...this.running.values()].map(x=>x.promise));return true;
  }
  _kick(){
    if(!this.started)return;
    while(this.running.size<this.concurrency){
      const idx=this.pending.findIndex(jobId=>{
        const j=this.jobs.get(jobId);return j&&j.state==='queued'&&j.runAt<=Date.now();
      });
      if(idx<0)break;
      const [jobId]=this.pending.splice(idx,1);this._run(jobId);
    }
  }
  _run(jobId){
    const job=this.jobs.get(jobId),def=this.defs.get(job?.name);if(!job||!def)return;
    job.state='running';job.attempts++;job.lockedAt=Date.now();job.startedAt=Date.now();
    const promise=(async()=>{
      try{
        const result=await def.handler(job.payload,{job,queue:this,site:this.site});
        job.result=result;job.state='completed';job.completedAt=Date.now();this.emit('completed',job);
      }catch(e){
        job.error={name:e?.name,message:e?.message,code:e?.code||null};
        if(job.attempts<job.maxAttempts){
          const delay=Math.min(60000,Number(def.options.retryDelayMs||250)*(2**(job.attempts-1)));
          job.state='queued';job.runAt=Date.now()+delay;this.pending.push(job.id);this._sort();this.emit('retry',job,e);
        }else{
          job.state='failed';job.failedAt=Date.now();this.dead.push(job.id);this.emit('failed',job,e);
        }
      }finally{
        this.running.delete(job.id);this._kick();
      }
    })();
    this.running.set(job.id,{job,promise});
  }
  _recoverStalled(){
    const cutoff=Date.now()-this.stallMs;
    for(const [id,row] of this.running){
      if(row.job.lockedAt&&row.job.lockedAt<cutoff){
        row.job.state='queued';row.job.runAt=Date.now();this.running.delete(id);this.pending.push(id);this.emit('stalled',row.job);
      }
    }
    this._sort();
  }
  stats(){return {defined:this.defs.size,total:this.jobs.size,queued:this.list({state:'queued'}).length,running:this.running.size,completed:this.list({state:'completed'}).length,failed:this.list({state:'failed'}).length,dead:this.dead.length,concurrency:this.concurrency}}
}

module.exports={JobQueue};
