'use strict';
const crypto=require('crypto');

function etagForStat(stat){
  return `W/"${Number(stat.size).toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}
function etagForValue(value){
  return `"${crypto.createHash('sha1').update(Buffer.isBuffer(value)?value:String(value)).digest('hex')}"`;
}
function isFresh(headers,etag,lastModified){
  const inm=headers?.['if-none-match'];
  if(inm && etag && inm.split(/\s*,\s*/).includes(etag)) return true;
  const ims=headers?.['if-modified-since'];
  if(ims && lastModified){
    const a=Date.parse(ims),b=Date.parse(lastModified);
    if(Number.isFinite(a)&&Number.isFinite(b)&&a>=b)return true;
  }
  return false;
}
module.exports={etagForStat,etagForValue,isFresh};
