'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');
const {StorageEngine}=require('../lib/storage-engine');
const {PagedStorageEngine}=require('../lib/paged-storage-engine');
const {ResponseCache}=require('../lib/response-cache');
const {atomicWriteDurable}=require('../lib/utils');

test('durable atomic write replaces target without leaving temporary files',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-atomic-'));
  const file=path.join(dir,'x.json');
  atomicWriteDurable(file,'{"a":1}');
  assert.equal(fs.readFileSync(file,'utf8'),'{"a":1}');
  atomicWriteDurable(file,'{"a":2}');
  assert.equal(fs.readFileSync(file,'utf8'),'{"a":2}');
  assert.deepEqual(fs.readdirSync(dir),['x.json']);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('snapshot checkpoint prevents duplicate replay when WAL survived after snapshot rename',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-wal-checkpoint-'));
  const file=path.join(dir,'items.json');
  const wal=path.join(dir,'items.wal');
  fs.writeFileSync(file,JSON.stringify({
    seq:1,checkpointSeq:1,walSeq:1,
    docs:[{id:1,_id:'a',name:'once'}]
  }));
  fs.writeFileSync(wal,[
    JSON.stringify({type:'begin',txid:'t1',txseq:1}),
    JSON.stringify({type:'op',txid:'t1',txseq:1,op:{type:'add',doc:{id:1,_id:'a',name:'once'}}}),
    JSON.stringify({type:'commit',txid:'t1',txseq:1})
  ].join('\n')+'\n');
  const db=new StorageEngine('items',{dir,crashSafe:true});
  assert.equal(db.docs.length,1);
  assert.equal(db.docs[0].name,'once');
  assert.equal(fs.readFileSync(wal,'utf8'),'');
  fs.rmSync(dir,{recursive:true,force:true});
});

test('committed WAL newer than checkpoint is applied exactly once and checkpointed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-wal-new-'));
  const file=path.join(dir,'items.json');
  const wal=path.join(dir,'items.wal');
  fs.writeFileSync(file,JSON.stringify({seq:0,checkpointSeq:0,walSeq:0,docs:[]}));
  const rows=[
    {type:'begin',txid:'t2',txseq:2},
    {type:'op',txid:'t2',txseq:2,op:{type:'add',doc:{id:1,_id:'a',name:'new'}}},
    {type:'commit',txid:'t2',txseq:2}
  ];
  fs.writeFileSync(wal,rows.map(JSON.stringify).join('\n')+'\n');
  let db=new StorageEngine('items',{dir,crashSafe:true});
  assert.equal(db.docs.length,1);
  assert.equal(db.checkpointSeq,2);
  // Re-create the stale WAL to simulate a crash after snapshot rename but before WAL cleanup.
  fs.writeFileSync(wal,rows.map(JSON.stringify).join('\n')+'\n');
  db=new StorageEngine('items',{dir,crashSafe:true});
  assert.equal(db.docs.length,1);
  assert.equal(db.docs[0].name,'new');
  fs.rmSync(dir,{recursive:true,force:true});
});

test('rollback in WAL mode never deletes a previously committed transaction',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-wal-rollback-'));
  const db=new StorageEngine('items',{dir,durability:'wal',walCompactEvery:1000,crashSafe:true});
  await db.add({name:'survive'});
  await assert.rejects(
    db.transaction(tx=>{tx.add({name:'rollback'});throw new Error('boom')}),
    /boom/
  );
  const wal=fs.readFileSync(path.join(dir,'items.wal'),'utf8');
  assert.match(wal,/"commit"/);
  assert.match(wal,/"rollback"/);
  const restarted=new StorageEngine('items',{dir,durability:'wal',walCompactEvery:1000,crashSafe:true});
  assert.equal(restarted.query({where:{name:'survive'}}).length,1);
  assert.equal(restarted.query({where:{name:'rollback'}}).length,0);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('full scan with no sort stops at limit instead of materializing every match',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-query-limit-'));
  const db=new StorageEngine('items',{dir,identity:false});
  db.docs=Array.from({length:50000},(_,i)=>({_id:String(i),group:i<25000?'a':'b',payload:'x'.repeat(64)}));
  const started=performance.now();
  const row=db.query({where:{group:'a'},limit:1});
  const elapsed=performance.now()-started;
  assert.equal(row.length,1);
  assert.equal(row[0]._id,'0');
  assert.ok(elapsed<100);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('unique index is used for duplicate checks without whole-document scans after index build',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-unique-fast-'));
  const db=new StorageEngine('items',{dir,identity:false,lazyIndexes:false});
  db.docs=Array.from({length:20000},(_,i)=>({_id:String(i),email:`u${i}@x.test`}));
  db.createIndex('email',{unique:true});
  const started=performance.now();
  await db.add({_id:'new',email:'new@x.test'});
  const elapsed=performance.now()-started;
  assert.ok(elapsed<100);
  await assert.rejects(db.add({_id:'dup',email:'u19999@x.test'}),/Unique index violation/);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('paged engine tracks append end in memory and survives reopen',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-paged-end-'));
  let db=new PagedStorageEngine('items',{dir,writeDurability:'sync',crashSafe:true});
  const before=db.dataEnd;
  for(let i=0;i<20;i++)await db.add({name:'x'+i});
  assert.ok(db.dataEnd>before);
  const end=db.dataEnd;
  db.close();
  db=new PagedStorageEngine('items',{dir,writeDurability:'sync',crashSafe:true});
  assert.equal(db.dataEnd,end);
  assert.equal(db.query({}).length,20);
  db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});

test('response cache clones stored objects so callers cannot mutate shared state',()=>{
  const cache=new ResponseCache();
  const original={user:{name:'A'},list:[1,2]};
  cache.set('x',original);
  original.user.name='MUTATED-ORIGINAL';
  const a=cache.get('x');
  assert.equal(a.user.name,'A');
  a.user.name='MUTATED-READ';
  a.list.push(3);
  const b=cache.get('x');
  assert.equal(b.user.name,'A');
  assert.deepEqual(b.list,[1,2]);
  assert.notEqual(a,b);
});

test('inflight response cache callers receive isolated object snapshots',async()=>{
  const cache=new ResponseCache();
  let calls=0;
  const producer=async()=>{calls++;await new Promise(r=>setTimeout(r,15));return{nested:{value:1}}};
  const [a,b,c]=await Promise.all([
    cache.getOrSet('same',producer),
    cache.getOrSet('same',producer),
    cache.getOrSet('same',producer)
  ]);
  assert.equal(calls,1);
  assert.notEqual(a,b);assert.notEqual(b,c);
  a.nested.value=99;
  assert.equal(b.nested.value,1);
  assert.equal(cache.get('same').nested.value,1);
});

test('scoped response cache separates users, sessions, routes, language and theme by default',()=>{
  const cache=new ResponseCache();
  const base={method:'GET',path:'/account',url:'/account',headers:{host:'example.test'}};
  const u1={...base,user:{id:'1'},session:{language:{id:'en'},theme:'dark'}};
  const u1b={...base,user:{id:'1'},session:{language:{id:'en'},theme:'dark'}};
  const u2={...base,user:{id:'2'},session:{language:{id:'en'},theme:'dark'}};
  const lang={...base,user:{id:'1'},session:{language:{id:'ar'},theme:'dark'}};
  const route={...base,path:'/other',url:'/other',user:{id:'1'},session:{language:{id:'en'},theme:'dark'}};
  assert.equal(cache.scopedKey(u1,'k'),cache.scopedKey(u1b,'k'));
  assert.notEqual(cache.scopedKey(u1,'k'),cache.scopedKey(u2,'k'));
  assert.notEqual(cache.scopedKey(u1,'k'),cache.scopedKey(lang,'k'));
  assert.notEqual(cache.scopedKey(u1,'k'),cache.scopedKey(route,'k'));

  const s1={...base,_sessionState:{id:'s1'},session:{language:{id:'en'}}};
  const s2={...base,_sessionState:{id:'s2'},session:{language:{id:'en'}}};
  assert.notEqual(cache.scopedKey(s1,'k'),cache.scopedKey(s2,'k'));
});

test('explicit public scope can intentionally share public data across authenticated users',()=>{
  const cache=new ResponseCache();
  const a={method:'GET',path:'/plans',headers:{host:'example.test'},user:{id:'1'}};
  const b={method:'GET',path:'/plans',headers:{host:'example.test'},user:{id:'2'}};
  assert.equal(
    cache.scopedKey(a,'plans',{scope:'public'}),
    cache.scopedKey(b,'plans',{scope:'public'})
  );
});

test('uncloneable cache values fail closed instead of sharing mutable references',()=>{
  const cache=new ResponseCache();
  const value={fn(){}};
  assert.throws(()=>cache.set('x',value),/cloneable\/serializable/);
});

test('site.cachedResponseFor uses automatic authenticated isolation',async()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  let calls=0;
  const r1={method:'GET',path:'/x',headers:{host:'a.test'},user:{id:'1'},session:{language:{id:'en'}}};
  const r2={method:'GET',path:'/x',headers:{host:'a.test'},user:{id:'2'},session:{language:{id:'en'}}};
  const a=await site.cachedResponseFor(r1,'data',async()=>({owner:++calls}));
  const b=await site.cachedResponseFor(r1,'data',async()=>({owner:++calls}));
  const c=await site.cachedResponseFor(r2,'data',async()=>({owner:++calls}));
  assert.equal(a.owner,1);assert.equal(b.owner,1);assert.equal(c.owner,2);
  assert.equal(calls,2);
});


test('legacy WAL without txseq is checkpointed so stale legacy WAL cannot replay twice',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-legacy-wal-'));
  const file=path.join(dir,'items.json'),wal=path.join(dir,'items.wal');
  fs.writeFileSync(file,JSON.stringify({seq:0,docs:[]}));
  const rows=[
    {type:'begin',txid:'legacy'},
    {type:'op',txid:'legacy',op:{type:'add',doc:{id:1,_id:'a',name:'legacy'}}},
    {type:'commit',txid:'legacy'}
  ];
  fs.writeFileSync(wal,rows.map(JSON.stringify).join('\n')+'\n');
  let db=new StorageEngine('items',{dir,crashSafe:true});
  assert.equal(db.docs.length,1);
  const snapshot=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.ok(snapshot.checkpointSeq>=1);
  fs.writeFileSync(wal,rows.map(JSON.stringify).join('\n')+'\n');
  db=new StorageEngine('items',{dir,crashSafe:true});
  assert.equal(db.docs.length,1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('paged insertMany WAL can rebuild missing slot metadata after a crash window',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-paged-batch-wal-'));
  let db=new PagedStorageEngine('items',{dir,writeDurability:'sync',crashSafe:true});
  // Manually create the crash state: data is durable + batch WAL, index/meta still old.
  const docs=[{id:1,_id:'a',name:'A'},{id:2,_id:'b',name:'B'}];
  const rows=[];let offset=db.dataEnd;
  for(const doc of docs){
    const buf=db._encode(doc);
    fs.writeSync(db.fd,buf,0,buf.length,offset);
    rows.push({slot:rows.length,offset,length:buf.length});
    offset+=buf.length;
  }
  db.dataEnd=offset;fs.fsyncSync(db.fd);
  db._appendWal({type:'batch-add',rows});db._syncWal();
  db.close();

  db=new PagedStorageEngine('items',{dir,writeDurability:'sync',crashSafe:true});
  assert.equal(db.query({}).length,2);
  assert.equal(db.query({where:{name:'A'}})[0].name,'A');
  assert.equal(fs.readFileSync(path.join(dir,'items.pwal'),'utf8'),'');
  db.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('Core provider defaults to crash-safe WAL in production but keeps development snapshot semantics',()=>{
  const prod=core({fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  const prodCol=prod.connectCollection('prod_'+Date.now());
  assert.equal(prodCol.engine.durability,'wal');
  assert.equal(prodCol.engine.crashSafe,true);

  const dev=core({mode:'development',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  const devCol=dev.connectCollection('dev_'+Date.now());
  assert.equal(devCol.engine.durability,'snapshot');
});


test('bounded sorted query returns the same page as a full reference sort',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-topk-sort-'));
  const db=new StorageEngine('items',{dir,identity:false});
  db.docs=Array.from({length:10000},(_,i)=>({_id:String(i),score:(i*7919)%10007,group:i%3,name:'n'+i}));
  const options={where:{group:1},sort:{score:-1,_id:1},skip:10,limit:25};
  const actual=db.query(options);
  const expected=db.docs
    .filter(d=>d.group===1)
    .sort((a,b)=>{
      if(a.score!==b.score)return b.score-a.score;
      return a._id<b._id?-1:a._id>b._id?1:0;
    })
    .slice(10,35)
    .map(x=>JSON.parse(JSON.stringify(x)));
  assert.deepEqual(actual,expected);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('empty count is O(1)-style and excludes tombstones',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-count-fast-'));
  const db=new StorageEngine('items',{dir,identity:false});
  db.docs=Array.from({length:100000},(_,i)=>({_id:String(i),__aisiteDeleted:i<1234?true:undefined}));
  db.tombstones=1234;
  const started=performance.now();
  assert.equal(db.count({}),98766);
  assert.ok(performance.now()-started<20);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('dependency invalidation during inflight production prevents stale cache resurrection',async()=>{
  const cache=new ResponseCache();
  let release;
  const gate=new Promise(r=>release=r);
  const pending=cache.getOrSet('x',async()=>{await gate;return{version:'old'}},{dependencies:['/data/x.json']});
  await new Promise(r=>setImmediate(r));
  cache.invalidateDependency('/data/x.json');
  release();
  assert.equal((await pending).version,'old'); // current caller may finish its own work
  assert.equal(cache.get('x'),null);          // but stale result must not repopulate cache
  assert.ok(cache.stats().staleInflightDrops>=1);
});

test('clear during inflight work cannot delete a newer producer or repopulate stale data',async()=>{
  const cache=new ResponseCache();
  let releaseOld;
  const oldGate=new Promise(r=>releaseOld=r);
  const old=cache.getOrSet('x',async()=>{await oldGate;return{version:'old'}});
  await new Promise(r=>setImmediate(r));
  cache.clear();
  const newer=cache.getOrSet('x',async()=>({version:'new'}));
  releaseOld();
  assert.equal((await old).version,'old');
  assert.equal((await newer).version,'new');
  assert.equal(cache.get('x').version,'new');
});


test('dependency invalidation detaches stale inflight work so a new request starts fresh immediately',async()=>{
  const cache=new ResponseCache();
  let releaseOld,oldCalls=0,newCalls=0;
  const oldGate=new Promise(r=>releaseOld=r);
  const old=cache.getOrSet('x',async()=>{oldCalls++;await oldGate;return{version:'old'}},{dependencies:['/d.json']});
  await new Promise(r=>setImmediate(r));
  cache.invalidateDependency('/d.json');

  const fresh=cache.getOrSet('x',async()=>{newCalls++;return{version:'fresh'}},{dependencies:['/d.json']});
  assert.equal((await fresh).version,'fresh');
  assert.equal(newCalls,1);

  releaseOld();
  assert.equal((await old).version,'old');
  assert.equal(oldCalls,1);
  assert.equal(cache.get('x').version,'fresh');
});
