'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');
const {MemoryPressureController}=require('../lib/memory-pressure');

test('production memory pressure controller is enabled by default and development is opt-in',()=>{
  const prod=core({fileCache:{prewarm:false},session:{enabled:false}});
  assert.equal(prod.memoryPressure.enabled,true);
  prod.memoryPressure.stop();

  const dev=core({mode:'development',fileCache:{prewarm:false},session:{enabled:false}});
  assert.equal(dev.memoryPressure.enabled,false);
  dev.memoryPressure.stop();
});

test('memory pressure transitions shrink and restore all bounded caches deterministically',()=>{
  const MB=1024*1024;
  let rss=100*MB;
  const site=core({
    fileCache:{prewarm:false,maxBytes:8*1024*1024,maxCompiledBytes:4*1024*1024,maxCompressedBytes:4*1024*1024},
    responseCache:{maxBytes:4*1024*1024},
    compressionCache:{maxBytes:4*1024*1024},
    session:{maxMemorySessions:1000},
    memoryPressure:{enabled:false}
  });
  const ctl=new MemoryPressureController(site,{
    enabled:false,
    memoryBudgetBytes:200*MB,
    memoryUsage:()=>({rss,heapUsed:10*MB}),
    heapStatistics:()=>({heap_size_limit:1000*MB})
  });
  assert.equal(ctl.sample().level,'normal');
  rss=140*MB; assert.equal(ctl.sample().level,'elevated'); assert.equal(site.fileCache.pressureFactor,.85);
  rss=164*MB; assert.equal(ctl.sample().level,'high'); assert.equal(site.responseCache.pressureFactor,.60);
  rss=186*MB; assert.equal(ctl.sample().level,'critical'); assert.equal(site.compressionCache.pressureFactor,.35);
  rss=100*MB; assert.equal(ctl.sample().level,'normal'); assert.equal(site.sessionStore.pressureFactor,1);
  ctl.stop();site.memoryPressure.stop();
});

test('memory pressure physically evicts oldest cache entries without changing configured limits',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-pressure-'));
  const site=core({
    cwd:dir,dir,
    fileCache:{prewarm:false,maxEntries:100,maxBytes:1024*1024,maxCompiledEntries:100,maxCompiledBytes:1024*1024,maxCompressedBytes:1024*1024},
    responseCache:{max:100,maxBytes:1024*1024},
    compressionCache:{maxEntries:100,maxBytes:1024*1024},
    session:{dir:path.join(dir,'sessions'),maxMemorySessions:100,persistence:'sync'},
    memoryPressure:{enabled:false}
  });
  for(let i=0;i<80;i++)site.responseCache.set('r'+i,'x'.repeat(100));
  for(let i=0;i<800;i++)site.sessionStore.save('s'+i,{user_id:i,user:{id:i}});
  site.responseCache.setPressureFactor(.35);
  site.sessionStore.setPressureFactor(.35);
  assert.ok(site.responseCache.map.size<=35);
  assert.ok(site.sessionStore.memory.size<=350);
  assert.equal(site.responseCache.max,100);
  assert.equal(site.sessionStore.maxMemorySessions,100);
  site.memoryPressure.stop();site.sessionStore.close();
  fs.rmSync(dir,{recursive:true,force:true});
});

test('compiled iSite render plans preserve filters/import/list/token semantics',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-plan-'));
  fs.writeFileSync(path.join(dir,'part.html'),'<b>##word.hello##</b>');
  const site=core({cwd:dir,dir,compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  site.word=name=>name==='hello'?'HELLO':name;
  site.setting.show=true;
  const req={
    session:{language:{id:'En'},user:{id:1}},
    data:{rows:[{name:'A'},{name:'B'}]},
    features:['f'],
    word:name=>site.word(name),
    hasFeature:name=>name==='f'
  };
  site.security.isUserHasPermission=()=>true;
  const html=[
    '<section x-setting="show" x-permission="read" x-feature="f">',
    '<div x-import="part.html"></div>',
    '<ul x-list1="rows"><li>##item1.name##</li></ul>',
    '</section>'
  ].join('');
  const out=site.parser.html(html,{req,file:path.join(dir,'main.html'),parserDir:dir});
  assert.match(out,/HELLO/);
  assert.match(out,/>A</);
  assert.match(out,/>B</);
  assert.doesNotMatch(out,/x-setting|x-permission|x-feature|x-list1|x-import/);
  assert.ok(site.parser.stats().renderPlansCompiled>=1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('compiled render plans avoid rescanning non-token attributes and repeat security checks',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  let permissionCalls=0,wordCalls=0;
  site.security.isUserHasPermission=()=>{permissionCalls++;return true};
  const req={session:{language:{id:'En'}},data:{},features:[],word:n=>{wordCalls++;return n==='x'?'X':n}};
  const row='<div class="a" id="b" title="plain" data-a="1" x-permission="read">##word.x##</div>';
  const html=row.repeat(500);
  const a=site.parser.html(html,{req,file:'/tmp/render-plan.html'});
  const b=site.parser.html(html,{req,file:'/tmp/render-plan.html'});
  assert.equal(permissionCalls,2); // one per independent render/request
  assert.equal(wordCalls,2);
  assert.equal(a,b);
  const stats=site.parser.stats();
  assert.ok(stats.renderPlansCompiled>=1);
  assert.ok(stats.renderPlanNodes>=500);
});


test('Native runtime/query caches are bounded and pressure-aware',async()=>{
  const site=core({
    memoryCache:{max:40,maxBytes:1024*1024},
    queryCache:{max:40},
    queryPlan:{max:40},
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
  for(let i=0;i<100;i++)site.cache.set('k'+i,{i});
  assert.ok(site.cache.size()<=40);
  for(let i=0;i<100;i++)await site.queryCache.cached('s',{i},async()=>i);
  assert.ok(site.queryCache.map.size<=40);
  for(let i=0;i<100;i++)site.queryPlan.compile({i});
  assert.ok(site.queryPlan.map.size<=40);

  site.cache.setPressureFactor(.5);
  site.queryCache.setPressureFactor(.5);
  site.queryPlan.setPressureFactor(.5);
  assert.ok(site.cache.size()<=20);
  assert.ok(site.queryCache.map.size<=20);
  assert.ok(site.queryPlan.map.size<=20);
});

test('QueryPlan reuses identical compiled plans instead of growing duplicate work',()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  const a=site.queryPlan.compile({where:{id:1}},{limit:1});
  const b=site.queryPlan.compile({where:{id:1}},{limit:1});
  assert.equal(a,b);
  assert.equal(site.queryPlan.stats().hits,1);
  assert.equal(site.queryPlan.stats().misses,1);
});
