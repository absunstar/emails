'use strict';

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(ms)||0))); }

async function retry(fn, options={}) {
  const retries=Math.max(0,Number(options.retries??3));
  const baseDelay=Math.max(0,Number(options.delayMs??50));
  let lastError;
  for(let attempt=0;attempt<=retries;attempt++){
    try{return await fn(attempt)}
    catch(e){
      lastError=e;
      if(attempt>=retries)break;
      const delay=typeof options.backoff==='function'?options.backoff(attempt,e):baseDelay*Math.max(1,attempt+1);
      if(delay)await sleep(delay);
    }
  }
  throw lastError;
}

function timeout(promise, ms, message='Operation timed out') {
  ms=Math.max(0,Number(ms)||0);
  if(!ms)return Promise.resolve(promise);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error(message),{code:'ETIMEDOUT'})),ms);
    Promise.resolve(promise).then(
      v=>{clearTimeout(timer);resolve(v)},
      e=>{clearTimeout(timer);reject(e)}
    );
  });
}

function once(fn){
  let called=false,value;
  return function(...args){
    if(called)return value;
    called=true;
    value=fn.apply(this,args);
    return value;
  };
}

module.exports={sleep,retry,timeout,once};
