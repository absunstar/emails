'use strict';
const {EventEmitter}=require('events');

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function jittered(base,jitter){
  if(!jitter)return base;
  const spread=base*Math.max(0,Math.min(1,Number(jitter)));
  return Math.max(0,Math.round(base-spread+Math.random()*spread*2));
}

class CircuitBreaker extends EventEmitter{
  constructor(options={}){
    super();
    this.failureThreshold=Math.max(1,Number(options.failureThreshold||5));
    this.successThreshold=Math.max(1,Number(options.successThreshold||2));
    this.resetTimeoutMs=Math.max(10,Number(options.resetTimeoutMs||5000));
    this.halfOpenMaxCalls=Math.max(1,Number(options.halfOpenMaxCalls||1));
    this.state='closed';
    this.failures=0;this.successes=0;this.openedAt=0;this.halfOpenCalls=0;
  }
  canExecute(now=Date.now()){
    if(this.state==='closed')return true;
    if(this.state==='open'){
      if(now-this.openedAt>=this.resetTimeoutMs){
        this.state='half-open';this.successes=0;this.halfOpenCalls=0;this.emit('half-open');return true;
      }
      return false;
    }
    return this.halfOpenCalls<this.halfOpenMaxCalls;
  }
  begin(){
    if(!this.canExecute())throw Object.assign(new Error('Circuit breaker is open'),{code:'CIRCUIT_OPEN'});
    if(this.state==='half-open')this.halfOpenCalls++;
  }
  success(){
    if(this.state==='half-open'){
      this.successes++;
      if(this.successes>=this.successThreshold){this.state='closed';this.failures=0;this.successes=0;this.halfOpenCalls=0;this.emit('closed')}
    }else this.failures=0;
  }
  failure(){
    this.failures++;
    if(this.state==='half-open'||this.failures>=this.failureThreshold){
      this.state='open';this.openedAt=Date.now();this.halfOpenCalls=0;this.emit('open');
    }
  }
  snapshot(){return {state:this.state,failures:this.failures,successes:this.successes,openedAt:this.openedAt}}
}

class ResilienceRegistry{
  constructor(options={}){
    this.options=options;
    this.breakers=new Map();
  }
  breaker(name,options={}){
    if(!this.breakers.has(name))this.breakers.set(name,new CircuitBreaker({...this.options.circuitBreaker,...options}));
    return this.breakers.get(name);
  }
  async execute(name,fn,options={}){
    const breaker=options.circuitBreaker===false?null:this.breaker(name,options.circuitBreaker||{});
    const retries=Math.max(0,Number(options.retries??this.options.retries??2));
    const baseDelayMs=Math.max(0,Number(options.baseDelayMs??this.options.baseDelayMs??50));
    const maxDelayMs=Math.max(baseDelayMs,Number(options.maxDelayMs??this.options.maxDelayMs??1000));
    const factor=Math.max(1,Number(options.factor??this.options.factor??2));
    const jitter=Number(options.jitter??this.options.jitter??0.2);
    const isRetryable=typeof options.isRetryable==='function'?options.isRetryable:(e)=>!['ORM_QUERY_TOO_COMPLEX','ORM_QUERY_UNSAFE_KEY','SCHEMA_VALIDATION_FAILED'].includes(e?.code);
    let attempt=0;
    while(true){
      breaker?.begin();
      try{
        const value=await fn({attempt});
        breaker?.success();
        return value;
      }catch(e){
        breaker?.failure();
        if(attempt>=retries||!isRetryable(e))throw e;
        const delay=Math.min(maxDelayMs,baseDelayMs*(factor**attempt));
        await sleep(jittered(delay,jitter));
        attempt++;
      }
    }
  }
  snapshot(){return Object.fromEntries([...this.breakers].map(([k,v])=>[k,v.snapshot()]))}
}

module.exports={CircuitBreaker,ResilienceRegistry,sleep};
