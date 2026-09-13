'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('http');
const fs=require('fs'),os=require('os'),path=require('path');
const core=require('..');

async function start(setup,options={}){
  const site=core({compatibility:'isite',...options});
  setup(site);
  const server=site.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {site,server,port:server.address().port};
}
async function request(port,{method='GET',path='/',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method,path,headers},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({
        status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()
      }));
    });
    req.on('error',reject);
    if(body!=null)req.write(body);
    req.end();
  });
}
async function close(server){await new Promise(r=>server.close(r))}

test('iSite route matching is case-insensitive while params/query preserve raw forms',async()=>{
  const {server,port}=await start(site=>{
    site.onGET('/User/:UserId',(req,res)=>res.json({
      path:req.urlParser.pathname,
      rawPath:req.urlParserRaw.pathname,
      param:req.params.userid,
      paramRaw:req.paramsRaw.userid,
      paramNamed:req.params.UserId,
      query:req.query.code,
      queryRaw:req.queryRaw.code,
      bodyIsQuery:req.body===req.query,
      dataIsQuery:req.data===req.query,
      bodyRaw:req.bodyRaw,
      dataRaw:req.dataRaw
    }));
  });
  const r=await request(port,{path:'/USER/AbC?Code=XyZ'});
  assert.equal(r.status,200);
  const d=JSON.parse(r.body);
  assert.equal(d.path,'/user/abc');
  assert.equal(d.rawPath,'/USER/AbC');
  assert.equal(d.param,'abc');
  assert.equal(d.paramRaw,'AbC');
  assert.equal(d.paramNamed,'abc');
  assert.equal(d.query,'xyz');
  assert.equal(d.queryRaw,'XyZ');
  assert.equal(d.bodyIsQuery,true);
  assert.equal(d.dataIsQuery,true);
  assert.equal(d.bodyRaw.code,'XyZ');
  assert.equal(d.dataRaw.code,'XyZ');
  await close(server);
});

test('iSite JSON and urlencoded request aliases expose body/data and raw input',async()=>{
  const {server,port}=await start(site=>{
    site.post({name:'/json',public:true,overwrite:true},(req,res)=>res.json({
      body:req.body,data:req.data,bodyRaw:req.bodyRaw,dataRaw:req.dataRaw
    }));
    site.post({name:'/form',public:true},(req,res)=>res.json({
      body:req.body,data:req.data,bodyRaw:req.bodyRaw,dataRaw:req.dataRaw
    }));
  });
  const j=await request(port,{method:'POST',path:'/json',headers:{'content-type':'application/json'},body:'{"Name":"Amr","n":2}'});
  assert.equal(j.status,200);
  const jd=JSON.parse(j.body);
  assert.deepEqual(jd.body,{Name:'Amr',n:2});
  assert.deepEqual(jd.data,jd.body);
  assert.equal(jd.bodyRaw,'{"Name":"Amr","n":2}');
  assert.equal(jd.dataRaw,jd.bodyRaw);

  const f=await request(port,{method:'POST',path:'/form',headers:{'content-type':'application/x-www-form-urlencoded'},body:'Name=Amr&x=1'});
  const fd=JSON.parse(f.body);
  assert.deepEqual(fd.body,{Name:'Amr',x:'1'});
  assert.equal(fd.bodyRaw,'Name=Amr&x=1');
  assert.equal(fd.dataRaw,fd.bodyRaw);
  await close(server);
});

test('iSite multipart exposes formidable-compatible req.form.files aliases',async()=>{
  const {server,port}=await start(site=>{
    site.post({name:'/upload',public:true},(req,res)=>{
      const file=req.form.files.fileToUpload;
      res.json({
        field:req.form.fields.title,
        originalFilename:file.originalFilename,
        filepath:typeof file.filepath==='string',
        mimetype:file.mimetype,
        size:file.size,
        same:req.files.fileToUpload.filepath===file.filepath
      });
    });
  });
  const boundary='----sbcompat';
  const body=[
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nABC\r\n`,
    `--${boundary}--\r\n`
  ].join('');
  const r=await request(port,{method:'POST',path:'/upload',headers:{
    'content-type':`multipart/form-data; boundary=${boundary}`,
    'content-length':Buffer.byteLength(body)
  },body});
  assert.equal(r.status,200,r.body);
  const d=JSON.parse(r.body);
  assert.equal(d.field,'Hello');
  assert.equal(d.originalFilename,'a.txt');
  assert.equal(d.filepath,true);
  assert.equal(d.mimetype,'text/plain');
  assert.equal(d.size,3);
  assert.equal(d.same,true);
  await close(server);
});

test('getUserFinger returns the legacy object contract',async()=>{
  const {site,server,port}=await start(site=>{
    site.get({name:'/finger',public:true},(req,res)=>{
      req.session.user={id:7,email:'a@example.com',profile:{name:'Amr',name_ar:'عمرو',name_en:'Amr'}};
      res.json(req.getUserFinger());
    });
  });
  const r=await request(port,{path:'/finger'});
  const d=JSON.parse(r.body);
  assert.equal(d.id,7);
  assert.equal(d.email,'a@example.com');
  assert.equal(d.name,'Amr');
  assert.equal(d.name_ar,'عمرو');
  assert.equal(d.ip,'127.0.0.1');
  assert.ok(d.date);
  await close(server);
});

test('route descriptors support multiple names, headers, language, compres alias and content',async()=>{
  const {server,port}=await start(site=>{
    site.get({
      name:['/One','/Two'],
      public:true,
      language:{id:'Ar',dir:'rtl'},
      headers:{'X-Legacy':'Yes'},
      content:'<h1>  Hello \n World </h1>',
      parser:'html',
      compres:true
    });
  });
  for(const p of ['/ONE','/two']){
    const r=await request(port,{path:p});
    assert.equal(r.status,200);
    assert.equal(r.headers['x-legacy'],'Yes');
    assert.match(r.body,/Hello World/);
  }
  await close(server);
});

test('duplicate route keeps first handler unless overwrite=true',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/dup',public:true},(q,r)=>r.send('first'));
    site.get({name:'/dup',public:true},(q,r)=>r.send('second'));
    site.get({name:'/over',public:true},(q,r)=>r.send('old'));
    site.get({name:'/over',public:true,overwrite:true},(q,r)=>r.send('new'));
  });
  assert.equal((await request(port,{path:'/dup'})).body,'first');
  assert.equal((await request(port,{path:'/over'})).body,'new');
  await close(server);
});

test('response status/end/send/json/redirect/set semantics match iSite',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/status',public:true},(q,r)=>r.status(201).status(202).send('ok'));
    site.get({name:'/end-code',public:true},(q,r)=>r.end(204));
    site.get({name:'/send-object',public:true},(q,r)=>r.send({done:true}));
    site.get({name:'/redirect',public:true},(q,r)=>r.redirect('/home',301));
    site.get({name:'/set',public:true},(q,r)=>{r.set('Content-Type','text/plain');r.set('X-Test','ABC');r.end('x')});
  });
  const a=await request(port,{path:'/status'});assert.equal(a.status,201);assert.equal(a.body,'ok');assert.match(a.headers['content-type'],/text\/html/);
  const b=await request(port,{path:'/end-code'});assert.equal(b.status,204);
  const c=await request(port,{path:'/send-object'});assert.equal(c.status,200);assert.deepEqual(JSON.parse(c.body),{done:true});
  const d=await request(port,{path:'/redirect'});assert.equal(d.status,301);assert.equal(d.headers.location,'/home');
  const e=await request(port,{path:'/set'});assert.match(e.headers['content-type'],/charset=utf-8/i);assert.equal(e.headers['x-test'],'ABC');
  await close(server);
});

test('response cookie facade is shared across req/res and supports get/set/delete',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/cookie',public:true},(req,res)=>{
      const before=req.cookie('name');
      res.cookie('next','value');
      res.json({before,same:req.cookie===res.cookie});
    });
  });
  const r=await request(port,{path:'/cookie',headers:{cookie:'name=Amr'}});
  assert.equal(JSON.parse(r.body).before,'Amr');
  assert.equal(JSON.parse(r.body).same,true);
  assert.match(String(r.headers['set-cookie']),/next=value/);
  await close(server);
});

test('route require features/permissions and public bypass work',async()=>{
  const {site,server,port}=await start(site=>{
    site.security.isUserHasPermissions=(req,res,p)=>p==='allowed';
    site.get({name:'/public',public:true,require:{permissions:['missing']}},(q,r)=>r.send('public'));
    site.get({name:'/denied',require:{permissions:['missing']}},(q,r)=>r.send('no'));
    site.get({name:'/allowed',require:{permissions:['allowed']}},(q,r)=>r.send('yes'));
    site.get({name:'/feature',require:{features:['x.test']}},(q,r)=>r.send('feature'));
  });
  assert.equal((await request(port,{path:'/public'})).status,200);
  assert.equal((await request(port,{path:'/denied'})).status,401);
  assert.equal((await request(port,{path:'/allowed'})).body,'yes');
  assert.equal((await request(port,{path:'/feature'})).status,401);
  await close(server);
});

test('path array route merges files in order',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-route-array-'));
  const a=path.join(dir,'a.css'),b=path.join(dir,'b.css');
  fs.writeFileSync(a,'a{color:red}\n');fs.writeFileSync(b,'b{color:blue}\n');
  const {server,port}=await start(site=>{
    site.get({name:'/merged.css',path:[a,b],parser:'css',public:true});
  },{cwd:dir,dir});
  const r=await request(port,{path:'/merged.css'});
  assert.equal(r.status,200);
  assert.match(r.body,/a\{color:red\}/);assert.match(r.body,/b\{color:blue\}/);
  assert.match(r.headers['content-type'],/text\/css/);
  await close(server);
});


test('req.context and callRoute legacy routing work',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/Target',public:true},(req,res)=>res.json({
      ok:true,contextType:req.context?.type,requestId:!!req.context?.requestId
    }));
    site.get({name:'/Caller',public:true},(req,res)=>site.callRoute('/TARGET',req,res));
  });
  const r=await request(port,{path:'/caller'});
  assert.equal(r.status,200);
  const d=JSON.parse(r.body);
  assert.equal(d.ok,true);
  assert.equal(d.contextType,'http');
  assert.equal(d.requestId,true);
  await close(server);
});

test('HEAD and OPTIONS preserve iSite automatic 200 compatibility',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/normal',public:true},(q,r)=>r.send('GET'));
  });
  const h=await request(port,{method:'HEAD',path:'/does-not-exist'});
  assert.equal(h.status,200);
  const o=await request(port,{method:'OPTIONS',path:'/does-not-exist'});
  assert.equal(o.status,200);
  await close(server);
});

test('route limitPerIP enforces legacy per-IP window',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/limited',public:true,limitPerIP:1,limitWindowMs:60000},(q,r)=>r.send('ok'));
  });
  assert.equal((await request(port,{path:'/limited'})).status,200);
  const blocked=await request(port,{path:'/limited'});
  assert.equal(blocked.status,429);
  assert.ok(Number(blocked.headers['retry-after'])>=1);
  await close(server);
});


test('site.routing namespace exposes add/off/find/call/onREQUEST/list/handleServer/start',async()=>{
  const site=core({compatibility:'isite'});
  assert.equal(typeof site.routing.add,'function');
  assert.equal(typeof site.routing.off,'function');
  assert.equal(typeof site.routing.findRoute,'function');
  assert.equal(typeof site.routing.call,'function');
  assert.equal(typeof site.routing.onREQUEST,'function');
  assert.equal(typeof site.routing.handleServer,'function');
  assert.equal(typeof site.routing.start,'function');

  site.routing.add({name:'/Routing/:Id',method:'GET',public:true},(req,res)=>res.send(req.params.id));
  const route=site.routing.findRoute('/routing/abc','GET');
  assert.ok(route);
  assert.equal(route.name,'/routing/*');
  assert.ok(site.routing.list.some(r=>r.name==='/routing/*'&&r.nameRaw==='/Routing/:Id'));

  const req={method:'GET',params:{id:'abc'}};
  let body='';
  const res={writableEnded:false,send(x){body=x;this.writableEnded=true;return this}};
  await site.routing.call({name:'/routing/abc',method:'GET'},req,res);
  assert.equal(body,'abc');

  site.routing.off({name:'/routing/:id',method:'GET'});
  assert.equal(site.routing.findRoute('/routing/abc','GET'),null);
});

test('legacy validation hooks execute and can stop the request chain',async()=>{
  const order=[];
  const {site,server,port}=await start(site=>{
    site.validateServerRequest=(req,res,next)=>{order.push('server');next(req,res)};
    site.validateRequest=(req,res,next)=>{order.push('request');next(req,res)};
    site.validateRoute=(req,res,next)=>{order.push('route');next(req,res)};
    site.validateSession=(req,res,next)=>{order.push('session');next(req,res)};
    site.get({name:'/validated',public:true},(req,res)=>{order.push('handler');res.send('ok')});
    site.get({name:'/stopped',public:true},(req,res)=>res.send('should-not-run'));
  });
  const a=await request(port,{path:'/validated'});
  assert.equal(a.status,200);
  assert.equal(a.body,'ok');
  assert.deepEqual(order.slice(0,5),['server','request','route','session','handler']);

  site.validateRequest=(req,res,next)=>{
    if(req.urlParser?.pathname==='/stopped'){res.status(418).send('stopped');return}
    next(req,res);
  };
  const b=await request(port,{path:'/stopped'});
  assert.equal(b.status,418);
  assert.equal(b.body,'stopped');
  await close(server);
});

test('large compressible responses honor legacy Accept-Encoding compression',async()=>{
  const {server,port}=await start(site=>{
    site.get({name:'/compressed',public:true},(q,r)=>r.send('x'.repeat(5000)));
  });
  const r=await request(port,{path:'/compressed',headers:{'accept-encoding':'gzip'}});
  assert.equal(r.status,200);
  assert.equal(r.headers['content-encoding'],'gzip');
  assert.match(r.headers.vary,/Accept-Encoding/i);
  await close(server);
});


test('routing aliases match the official site/routing alias relationships',()=>{
  const site=core({compatibility:'isite'});
  assert.equal(site.get,site.onGET);
  assert.equal(site.post,site.onPOST);
  assert.equal(site.get,site.routing.onGET);
  assert.equal(site.post,site.routing.onPOST);
  assert.equal(site.run,site.start);
  assert.equal(site.run,site.listen);
  assert.equal(site.run,site.routing.start);
});

test('res.render supports compres/shared and masterPage route options',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-render-flags-'));
  const header=path.join(dir,'header.html'),body=path.join(dir,'body.html'),footer=path.join(dir,'footer.html');
  fs.writeFileSync(header,'<header>H</header>\n');
  fs.writeFileSync(body,'<main>  ##data.name## \n X </main>');
  fs.writeFileSync(footer,'\n<footer>F</footer>');
  const {site,server,port}=await start(site=>{
    site.addMasterPage({name:'layout',header,footer});
    let calls=0;
    site.get({name:'/page',public:true},(req,res)=>{
      calls++;
      return res.render(body,{name:'Amr'},{parser:'html',compres:true,shared:true,masterPage:'layout'});
    });
    site.__calls=()=>calls;
  },{cwd:dir,dir});
  const a=await request(port,{path:'/page'});
  assert.equal(a.status,200);
  assert.match(a.body,/<header>H<\/header> <main> Amr X <\/main> <footer>F<\/footer>/);
  const b=await request(port,{path:'/page'});
  assert.equal(b.status,200);
  assert.equal(b.body,a.body);
  assert.equal(site.sharedCache.size,1);
  await close(server);
});


test('txt/css/js/jsonFile helpers read and parse files like iSite',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-response-files-'));
  fs.writeFileSync(path.join(dir,'a.txt'),'Hello ##data.name##');
  fs.writeFileSync(path.join(dir,'a.css'),'a{color:var(---accent)}');
  fs.writeFileSync(path.join(dir,'part.js'),'const p="##data.name##";');
  fs.writeFileSync(path.join(dir,'a.js'),'/*##part.js*/');
  fs.writeFileSync(path.join(dir,'a.json'),'{"name":"##data.name##"}');
  const {site,server,port}=await start(site=>{
    site.vars={accent:'#123'};
    site.get({name:'/txt',public:true},(q,r)=>r.txt(path.join(dir,'a.txt'),{name:'Amr'}));
    site.get({name:'/css',public:true},(q,r)=>r.css(path.join(dir,'a.css')));
    site.get({name:'/js',public:true},(q,r)=>r.js(path.join(dir,'a.js'),{name:'Amr'}));
    site.get({name:'/json-file',public:true},(q,r)=>{q.data={name:'Amr'};return r.json(path.join(dir,'a.json'))});
  },{cwd:dir,dir});
  const txt=await request(port,{path:'/txt'});assert.equal(txt.body,'Hello Amr');assert.match(txt.headers['content-type'],/text\/plain/);
  const css=await request(port,{path:'/css'});assert.match(css.body,/#123/);assert.match(css.headers['content-type'],/text\/css/);
  const js=await request(port,{path:'/js'});assert.match(js.body,/Amr/);assert.match(js.headers['content-type'],/javascript/);
  // json(string) is the legacy "render JSON file" overload; pass render data through req.data.
  const jf=await request(port,{path:'/json-file'});assert.match(jf.headers['content-type'],/application\/json/);
  await close(server);
});

test('compatibility keeps hardened X-Forwarded-For behavior unless trustProxy is enabled',async()=>{
  const a=await start(site=>{
    site.get({name:'/ip',public:true},(req,res)=>res.json({ip:req.ip}));
  });
  let r=await request(a.port,{path:'/ip',headers:{'x-forwarded-for':'8.8.8.8'}});
  assert.equal(JSON.parse(r.body).ip,'127.0.0.1');
  await close(a.server);

  const b=await start(site=>{
    site.get({name:'/ip',public:true},(req,res)=>res.json({ip:req.ip}));
  },{securityShield:{trustProxy:true}});
  r=await request(b.port,{path:'/ip',headers:{'x-forwarded-for':'8.8.8.8, 1.1.1.1'}});
  assert.equal(JSON.parse(r.body).ip,'8.8.8.8');
  await close(b.server);
});
