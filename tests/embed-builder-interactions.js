'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const page=fs.readFileSync('apps/emails/site_files/html/embed-builder.html','utf8');
const source=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
assert(source);
const fields=new Map(),listeners=new Map();let previewAssignments=0,copyFallbacks=0,exportClicked=0,exportedBlob=null;
function elem(id){if(fields.has(id))return fields.get(id);const value={id,value:'',textContent:'',_src:'',set src(v){previewAssignments++;this._src=v},get src(){return this._src},setCustomValidity(t){this.invalid=t},children:[],replaceChildren(){this.children=[]},append(...nodes){this.children.push(...nodes)},click(){exportClicked++},remove(){},addEventListener(event,handler){listeners.set(id+':'+event,handler)},focus(){},select(){}};fields.set(id,value);return value;}
elem('language').value='en';elem('theme').value='dark';elem('width').value='100%';elem('partner').value='';
const requests=[];
const context={document:{getElementById:elem,body:{dataset:{codeCopied:'Copied!',invalidWebsite:'Invalid URL',statsError:'Stats failed',noSite:'Enter website',last30Days:'Last 30 days',noActivity:'No activity'},append(){}},createElement:elem,documentElement:{lang:'en'},execCommand(c){if(c==='copy'){copyFallbacks++;return true}return false}},location:{pathname:'/embed-builder'},URL:Object.assign(class TestUrl extends URL {static createObjectURL(blob){exportedBlob=blob;return 'blob:test'} static revokeObjectURL(){}},{}),Blob,setTimeout,encodeURIComponent,Number,navigator:{clipboard:{writeText(){return Promise.reject(Error('Denied'))}}},fetch(url){return new Promise(resolve=>requests.push({url,resolve}))},console};
vm.runInNewContext(source,context);
function fire(id,event){const fn=listeners.get(id+':'+event);assert(fn,'Handler '+id+event);return fn()}
async function settle(){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}
(async()=>{
 assert(elem('code').value.includes('<iframe'));
 assert.equal(previewAssignments,1);
 elem('width').value='360';fire('width','change');assert.equal(previewAssignments,1,'Width changes must not discard widget address by reloading iframe');
 assert(elem('code').value.includes('width="360"'));
 await fire('copy','click');assert.equal(copyFallbacks,1,'Clipboard fallback must work');assert.equal(elem('feedback').textContent,'Copied!');
 elem('partner').value='https://first.example.com';fire('partner','change');assert.equal(requests.length,1);
 elem('partner').value='https://second.example.com';fire('partner','change');assert.equal(requests.length,2);
 requests[1].resolve({ok:true,json:async()=>({done:true,metrics:{views:8,generated:5,copied:3,open:2,byDay:[{date:'2026-10-31',view:8,generated:5,copied:3,open:2}]}})});await settle();
 assert.equal(elem('metric-views').textContent,'8');
 assert.equal(elem('daily-rows').children.length,1,'Daily breakdown should render a row');
 assert.equal(elem('export-csv').disabled,false,'Export should be available for nonempty data');
 fire('export-csv','click');assert.equal(exportClicked,1);assert((await exportedBlob.text()).includes('2026-10-31,8,5,3,2'));
 requests[0].resolve({ok:true,json:async()=>({done:true,metrics:{views:1000,generated:1000,copied:1000,open:1000}})});await settle();
 assert.equal(elem('metric-views').textContent,'8','Older domain response must not override current partner metrics');
 elem('partner').value='';fire('partner','change');assert.equal(elem('metric-views').textContent,'—','Clearing domain must clear prior metrics');
 assert.equal(elem('metric-copied').textContent,'—');
 assert.equal(elem('daily-rows').children.length,0);assert.equal(elem('export-csv').disabled,true);
 console.log('Builder interactive QA: iframe preserved on width change; clipboard fallback; latest partner stats; clearing previous counts PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
