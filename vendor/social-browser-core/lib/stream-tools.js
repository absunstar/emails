'use strict';
async function ndjson(res, iterable){
  if(!res.headersSent)res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');
  for await(const row of iterable)res.write(JSON.stringify(row)+'\n');
  res.end(); return res;
}
async function jsonArray(res, iterable){
  if(!res.headersSent)res.setHeader('Content-Type','application/json; charset=utf-8');
  res.write('['); let first=true;
  for await(const row of iterable){ if(!first)res.write(','); first=false; res.write(JSON.stringify(row)); }
  res.end(']'); return res;
}
module.exports={ndjson,jsonLines:ndjson,jsonArray};
