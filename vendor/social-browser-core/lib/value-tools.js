'use strict';

const AR_ONES=['','واحد','اثنان','ثلاثة','أربعة','خمسة','ستة','سبعة','ثمانية','تسعة'];
const AR_TEENS={10:'عشرة',11:'أحدعشر',12:'اثناعشر',13:'ثلاثةعشر',14:'أربعةعشر',15:'خمسةعشر',16:'ستةعشر',17:'سبعةعشر',18:'ثمانيةعشر',19:'تسعةعشر'};
const AR_TENS={20:'عشرون',30:'ثلاثون',40:'أربعون',50:'خمسون',60:'ستون',70:'سبعون',80:'ثمانون',90:'تسعون'};
const AR_HUNDREDS={100:'مائة',200:'مائتان',300:'ثلاثمائة',400:'أربعمائة',500:'خمسمائة',600:'ستمائة',700:'سبعمائة',800:'ثمانمائة',900:'تسعمائة'};

function numberToArabicWords(value){
  const n=Number(value);
  if(!Number.isFinite(n))return String(value??'');
  if(n===0)return 'صفر';
  if(n<0)return 'سالب'+numberToArabicWords(-n);
  if(n>999999999)return String(value);
  const parts=[];
  let x=Math.trunc(n);
  const millions=Math.floor(x/1_000_000); x%=1_000_000;
  const thousands=Math.floor(x/1000); x%=1000;
  if(millions)parts.push(numberToArabicWords(millions)+(millions===1?'مليون':'مليون'));
  if(thousands)parts.push(numberToArabicWords(thousands)+(thousands===1?'ألف':'ألف'));
  if(x){
    const h=Math.floor(x/100)*100;
    const r=x%100;
    if(h)parts.push(AR_HUNDREDS[h]);
    if(r){
      if(r<10)parts.push(AR_ONES[r]);
      else if(r<20)parts.push(AR_TEENS[r]);
      else{
        const one=r%10,ten=r-one;
        if(one)parts.push(AR_ONES[one]);
        parts.push(AR_TENS[ten]);
      }
    }
  }
  return parts.filter(Boolean).join('و');
}

function clone(value){
  if(typeof structuredClone==='function')return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
function stableStringify(value){
  const seen=new WeakSet();
  const walk=v=>{
    if(!v||typeof v!=='object')return v;
    if(seen.has(v))return '[Circular]';
    seen.add(v);
    if(Array.isArray(v))return v.map(walk);
    return Object.fromEntries(Object.keys(v).sort().map(k=>[k,walk(v[k])]));
  };
  return JSON.stringify(walk(value));
}
function deepMerge(target,...sources){
  target=target&&typeof target==='object'?clone(target):{};
  for(const src of sources){
    if(!src||typeof src!=='object')continue;
    for(const [k,v] of Object.entries(src)){
      if(v&&typeof v==='object'&&!Array.isArray(v))target[k]=deepMerge(target[k]||{},v);
      else target[k]=clone(v);
    }
  }
  return target;
}
function pick(obj,keys){return Object.fromEntries([].concat(keys||[]).filter(k=>Object.hasOwn(obj||{},k)).map(k=>[k,obj[k]]))}
function omit(obj,keys){const skip=new Set([].concat(keys||[]));return Object.fromEntries(Object.entries(obj||{}).filter(([k])=>!skip.has(k)))}

module.exports={numberToArabicWords,clone,stableStringify,deepMerge,pick,omit};
