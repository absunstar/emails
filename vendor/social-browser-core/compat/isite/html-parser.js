'use strict';
const fs=require('fs');
const path=require('path');

const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAW=new Set(['script','style','textarea']);

function escAttr(v){return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}
function getPath(obj,key){
  if(key==null||key==='')return obj;
  if(key==='*')return obj;
  let cur=obj;
  for(const p of String(key).split('.')){
    if(cur==null)return undefined;
    cur=cur[p];
  }
  return cur;
}
function jsonish(v){
  if(v==null)return '';
  if(typeof v==='object'){try{return JSON.stringify(v)}catch{return ''}}
  return String(v);
}
function readOpenTag(src,start){
  let q=null;
  for(let i=start;i<src.length;i++){
    const c=src[i];
    if(q){if(c===q&&src[i-1]!=='\\')q=null}
    else if(c==='"'||c==="'")q=c;
    else if(c==='>')return i;
  }
  return src.length-1;
}
function parseAttrs(raw){
  const attrs=[];
  let i=0;
  while(i<raw.length){
    while(/\s/.test(raw[i]||''))i++;
    if(i>=raw.length)break;
    let j=i;
    while(j<raw.length&&!/[\s=>]/.test(raw[j]))j++;
    const name=raw.slice(i,j);
    if(!name){i++;continue}
    i=j;while(/\s/.test(raw[i]||''))i++;
    let value=null,quote='"';
    if(raw[i]==='='){
      i++;while(/\s/.test(raw[i]||''))i++;
      if(raw[i]==='"'||raw[i]==="'"){
        quote=raw[i++];j=i;
        while(j<raw.length&&raw[j]!==quote)j++;
        value=raw.slice(i,j);i=j+1;
      }else{
        j=i;while(j<raw.length&&!/\s/.test(raw[j]))j++;
        value=raw.slice(i,j);i=j;
      }
    }
    attrs.push({name,value,quote});
  }
  return attrs;
}
function parseHTML(src){
  const root={type:'root',children:[],parent:null};
  const stack=[root];
  let i=0;
  const push=n=>{n.parent=stack[stack.length-1];n.parent.children.push(n)};
  while(i<src.length){
    const lt=src.indexOf('<',i);
    if(lt<0){push({type:'text',value:src.slice(i)});break}
    if(lt>i)push({type:'text',value:src.slice(i,lt)});
    if(src.startsWith('<!--',lt)){
      const end=src.indexOf('-->',lt+4);
      const e=end<0?src.length:end+3;
      push({type:'raw',value:src.slice(lt,e)});i=e;continue;
    }
    if(/^<!doctype\b/i.test(src.slice(lt,lt+12))||src.startsWith('<!',lt)||src.startsWith('<?',lt)){
      const end=readOpenTag(src,lt+1)+1;
      push({type:'raw',value:src.slice(lt,end)});i=end;continue;
    }
    if(src.startsWith('</',lt)){
      const end=readOpenTag(src,lt+2)+1;
      const m=/^<\/\s*([^\s>]+)/.exec(src.slice(lt,end));
      const tag=(m?.[1]||'').toLowerCase();
      for(let k=stack.length-1;k>0;k--){
        if(stack[k].tag===tag){stack.length=k;break}
      }
      i=end;continue;
    }
    const end=readOpenTag(src,lt+1)+1;
    const open=src.slice(lt,end);
    const m=/^<\s*([^\s/>]+)/.exec(open);
    if(!m){push({type:'text',value:'<'});i=lt+1;continue}
    const tag=m[1].toLowerCase();
    const self=/\/\s*>$/.test(open)||VOID.has(tag);
    let attrRaw=open.slice(m[0].length,open.length-(self&&/\/\s*>$/.test(open)?2:1));
    const node={type:'element',tag,tagOriginal:m[1],attrs:parseAttrs(attrRaw),children:[],parent:null,selfClosing:self};
    push(node);i=end;
    if(RAW.has(tag)&&!self){
      const closeRe=new RegExp(`</\\s*${tag}\\s*>`,'ig');closeRe.lastIndex=i;
      const cm=closeRe.exec(src);
      const bodyEnd=cm?cm.index:src.length;
      node.children.push({type:'text',value:src.slice(i,bodyEnd),parent:node});
      i=cm?closeRe.lastIndex:src.length;
      continue;
    }
    if(!self)stack.push(node);
  }
  return root;
}
function attr(node,name){
  const a=node.attrs?.find(x=>x.name.toLowerCase()===String(name).toLowerCase());
  return a?.value??(a?'':null);
}
function hasAttr(node,name){return node.attrs?.some(x=>x.name.toLowerCase()===String(name).toLowerCase())}
function removeAttr(node,name){if(node.attrs)node.attrs=node.attrs.filter(x=>x.name.toLowerCase()!==String(name).toLowerCase())}
function setAttr(node,name,value){
  let a=node.attrs?.find(x=>x.name.toLowerCase()===String(name).toLowerCase());
  if(a)a.value=String(value);else node.attrs.push({name,value:String(value),quote:'"'});
}
function clone(node,parent=null){
  const n={...node,parent};
  if(node.attrs)n.attrs=node.attrs.map(a=>({...a}));
  if(node.children)n.children=node.children.map(c=>clone(c,n));
  return n;
}
function serialize(node){
  if(node.type==='root')return node.children.map(serialize).join('');
  if(node.type==='text'||node.type==='raw')return node.value||'';
  if(node.type!=='element')return '';
  const attrs=(node.attrs||[]).map(a=>a.value===null?` ${a.name}`:` ${a.name}="${escAttr(a.value)}"`).join('');
  const open=`<${node.tagOriginal||node.tag}${attrs}${node.selfClosing&&!VOID.has(node.tag)?' /':''}>`;
  if(node.selfClosing||VOID.has(node.tag))return open;
  return open+node.children.map(serialize).join('')+`</${node.tagOriginal||node.tag}>`;
}
function walk(node,fn){
  if(!node?.children)return;
  for(const child of [...node.children]){
    if(child.type==='element')fn(child);
    walk(child,fn);
  }
}
function truthy(v){return !!v}
function featureCheck(expr,hasFeature){
  const test=raw=>{
    raw=String(raw||'').trim();let not=false;
    if(raw.startsWith('!')){not=true;raw=raw.slice(1).trim()}
    const yes=!!hasFeature(raw);return not?!yes:yes;
  };
  expr=String(expr||'').trim();
  if(expr.includes('||'))return expr.split('||').some(test);
  if(expr.includes('&&'))return expr.split('&&').every(test);
  return test(expr);
}
function permissionsCheck(expr,fn,req,res,ctx={},kind='permission'){
  const cache=ctx.authCache||(ctx.authCache=new Map());
  const key=kind+'\u0000'+String(expr||'');
  if(cache.has(key))return cache.get(key);
  let value=false;
  try{value=!!fn?.(req,res,expr)}catch{value=false}
  cache.set(key,value);
  return value;
}
function defaultHide(v){
  // Exact crypto/obfuscation is intentionally delegated when iSite exposes hide().
  return Buffer.from(String(v??''),'utf8').toString('base64');
}

function createLegacyHtmlParser(site,opts={}){
  const maxImportDepth=Math.max(1,Number(opts.maxImportDepth||64));
  const maxTemplatePasses=Math.max(1,Number(opts.maxTemplatePasses||16));
  const fileCache=site.fileCache||null;
  const readText=file=>fileCache?.getTextSync?fileCache.getTextSync(file,'utf8'):fs.readFileSync(file,'utf8');
  const isFile=file=>fileCache?.isFileSync?fileCache.isFileSync(file):(()=>{try{return fs.statSync(file).isFile()}catch{return false}})();
  const resolveExisting=candidates=>fileCache?.resolveExistingFile?fileCache.resolveExistingFile(candidates):candidates.find(isFile)||null;
  const contentResolutionCache=new Map();
  const tokenPlanCache=new Map();
  const maxTokenPlans=Math.max(256,Number(opts.maxTokenPlans||20000));
  const BUILTIN_TOKEN_KINDS=new Set(['var','user','site','req','session','json','setting','params','query','data','word']);

  function tokenPlan(source){
    if(tokenPlanCache.has(source)){
      const plan=tokenPlanCache.get(source);tokenPlanCache.delete(source);tokenPlanCache.set(source,plan);return plan;
    }
    const re=/##([A-Za-z0-9_$-]+)\.([\s\S]*?)##/g;
    const parts=[];let last=0,m;
    while((m=re.exec(source))){
      if(m.index>last)parts.push(source.slice(last,m.index));
      parts.push({token:true,raw:m[0],kind:m[1],key:m[2]});
      last=re.lastIndex;
    }
    if(last<source.length)parts.push(source.slice(last));
    const plan={parts,hasTokens:parts.some(x=>x&&typeof x==='object'&&x.token)};
    tokenPlanCache.set(source,plan);
    while(tokenPlanCache.size>maxTokenPlans)tokenPlanCache.delete(tokenPlanCache.keys().next().value);
    return plan;
  }
  const ANY_X_RE=/\bx-[A-Za-z0-9-]+\s*=/i;
  const FILTER_DIRECTIVES=new Set(['x-setting','x-data','x-permission','x-role','x-permissions','x-roles','x-lang','x-feature','x-features']);
  let renderPlansCompiled=0,renderPlanNodes=0;
  function compileRenderPlan(root){
    const visit=node=>{
      renderPlanNodes++;
      if(node.type==='text'){
        node.__renderPlan={tokenText:typeof node.value==='string'&&node.value.includes('##')};
        return;
      }
      if(node.type==='element'){
        const filters=[],tokenAttrs=[],listLevels=[],showLevels=[];
        let importDirective=null;
        for(const a of node.attrs||[]){
          const name=String(a.name||'').toLowerCase(),value=a.value??'';
          if(FILTER_DIRECTIVES.has(name))filters.push({name,value});
          if(typeof a.value==='string'&&a.value.includes('##'))tokenAttrs.push(a.name);
          if(name==='x-replace')importDirective={key:'x-replace',mode:'replace',value};
          else if(!importDirective&&name==='x-append')importDirective={key:'x-append',mode:'append',value};
          else if(!importDirective&&name==='x-import')importDirective={key:'x-import',mode:'import',value};
          let m=/^x-list(\d+)$/.exec(name);if(m)listLevels.push(Number(m[1]));
          m=/^x-show-item(\d+)$/.exec(name);if(m)showLevels.push(Number(m[1]));
        }
        node.__renderPlan={
          filters,tokenAttrs,importDirective,listLevels,showLevels,
          cssText:node.tag==='style',jsText:node.tag==='script'
        };
      }
      for(const child of node.children||[])visit(child);
    };
    visit(root);renderPlansCompiled++;return root;
  }
  function plannedImport(node){
    const p=node?.__renderPlan?.importDirective;
    if(p&&hasAttr(node,p.key))return p;
    if(hasAttr(node,'x-replace'))return {key:'x-replace',mode:'replace',value:attr(node,'x-replace')};
    if(hasAttr(node,'x-append'))return {key:'x-append',mode:'append',value:attr(node,'x-append')};
    if(hasAttr(node,'x-import'))return {key:'x-import',mode:'import',value:attr(node,'x-import')};
    return null;
  }
  function plannedHasList(node,level){
    const levels=node?.__renderPlan?.listLevels;
    if(levels&&!levels.includes(level))return false;
    return hasAttr(node,`x-list${level}`);
  }
  function plannedHasShow(node,level){
    const levels=node?.__renderPlan?.showLevels;
    if(levels&&!levels.includes(level))return false;
    return hasAttr(node,`x-show-item${level}`);
  }

  function language(req){
    return req?.session?.language?.id||req?.session?.lang||site.options?.lang||site.setting?.lang||'En';
  }
  function word(req,name,ctx={}){
    const cache=ctx.wordCache||(ctx.wordCache=new Map());
    const lang=language(req);
    const cacheKey=lang+'\u0000'+String(name);
    if(cache.has(cacheKey))return cache.get(cacheKey);

    // Match current iSite hot-path semantics: req.word() is the canonical request-
    // aware resolver and is invoked at most once per unique key per request.
    // Falling back to site.word() is only for Native/compat contexts that did not
    // install req.word.
    let out=name;
    if(typeof req?.word==='function'){
      try{out=req.word(name)}catch{out=name}
    }else if(typeof site.word==='function'){
      try{out=site.word(name,lang)}catch{out=name}
    }
    if(out===undefined||out===null)out=name;
    cache.set(cacheKey,out);
    return out;
  }
  function hide(v){return typeof site.hide==='function'?site.hide(v):defaultHide(v)}
  function tokenValue(kind,key,ctx){
    const req=ctx.req||{},data={...(req.data||{}),...(ctx.data||{})};
    let hidden=false;
    if(String(key).startsWith('#')){hidden=true;key=String(key).slice(1)}
    let v;
    if(kind==='word')v=word(req,key,ctx);
    else if(kind==='var')v=key==='*'?(site.vars||site.var||{}):getPath(site.vars||site.var||{},key);
    else if(kind==='setting')v=key==='*'?(site.setting||{}):getPath(site.setting||{},key);
    else if(kind==='session'){
      if(key==='lang')v=language(req);
      else if(key==='theme')v=req.session?.theme;
      else v=key==='*'?req.session:getPath(req.session||{},key);
    } else if(kind==='user')v=key==='*'?(req.session?.user||req.user||{}):getPath(req.session?.user||req.user||{},key);
    else if(kind==='site')v=key==='*'?site:getPath(site,key);
    else if(kind==='req')v=key==='*'?req:getPath(req,key);
    else if(kind==='params')v=key==='*'?(req.paramsRaw||req.params||{}):getPath(req.paramsRaw||req.params||{},key);
    else if(kind==='query')v=key==='*'?(req.queryRaw||req.query||{}):getPath(req.queryRaw||req.query||{},key);
    else if(kind==='data')v=key==='*'?data:getPath(data,key);
    else if(kind==='json'){
      const f=resolveContent(ctx.file,key+'.json',ctx);
      if(f)try{v=readText(f)}catch{v=''}
    } else {
      const merged={...(req.data||{}),...(ctx.data||{}),...(ctx.extra||{})};
      v=getPath(merged?.[kind],key);
    }
    if(hidden)return hide(v);
    return jsonish(v);
  }
  function supportedTokenKind(kind,ctx){
    if(BUILTIN_TOKEN_KINDS.has(kind))return true;
    let roots=ctx._tokenRootKinds;
    if(!roots){
      roots=new Set([
        ...Object.keys(ctx.req?.data||{}),
        ...Object.keys(ctx.data||{}),
        ...Object.keys(ctx.extra||{})
      ]);
      ctx._tokenRootKinds=roots;
    }
    return roots.has(kind);
  }
  function expandTokensSlow(txt,ctx,passes=maxTemplatePasses){
    let out=txt;
    const pattern=/##([A-Za-z0-9_$-]+)\.([\s\S]*?)##/g;
    for(let pass=0;pass<passes&&out.includes('##');pass++){
      let changed=false;
      out=out.replace(pattern,(m,kind,key)=>{
        if(!supportedTokenKind(kind,ctx))return m;
        changed=true;return tokenValue(kind,key,ctx);
      });
      if(!changed)break;
    }
    return out;
  }
  function expandTokens(txt,ctx){
    if(typeof txt!=='string'||!txt.includes('##'))return txt;
    const plan=tokenPlan(txt);
    if(!plan.hasTokens)return txt;
    let changed=false,out='';
    for(const part of plan.parts){
      if(typeof part==='string'){out+=part;continue}
      if(!supportedTokenKind(part.kind,ctx)){out+=part.raw;continue}
      changed=true;out+=tokenValue(part.kind,part.key,ctx);
    }
    // Token values may intentionally emit another token. Preserve the existing
    // bounded multi-pass semantics without re-tokenizing the original source.
    if(changed&&out.includes('##'))out=expandTokensSlow(out,ctx,Math.max(0,maxTemplatePasses-1));
    return out;
  }
  function resolveContent(currentFile,name,ctx={}){
    name=String(name||'');
    const hidden=name.startsWith('#');if(hidden)name=name.slice(1);
    const resolutionKey=String(currentFile||'')+'\u0000'+name+'\u0000'+String(ctx.parserDir||'');
    if(fileCache?.mode==='production'&&contentResolutionCache.has(resolutionKey))
      return contentResolutionCache.get(resolutionKey);
    const ext=path.extname(name).replace('.','');
    const parts=name.split('/').filter(Boolean);
    const parserDir=ctx.parserDir||path.dirname(currentFile||site.dir||site.cwd);
    let base=parserDir.includes('site_files')?path.dirname(parserDir):parserDir;
    const candidates=[];
    const push=p=>{if(p&&!candidates.includes(p))candidates.push(p)};
    // Native Core projects commonly expose site.dir as the actual site_files
    // directory (rather than its parent). Prefer those canonical roots first so
    // legacy x-import="app.js" / x-import="zero-ui.css" directives keep
    // resolving after an iSite -> Native Core migration. Also detect the nearest
    // app-local site_files root from the file currently being rendered.
    const siteFilesDir=site.dir&&path.basename(path.resolve(site.dir))==='site_files'
      ? path.resolve(site.dir)
      : path.join(path.resolve(site.dir||site.cwd||process.cwd()),'site_files');
    const currentFilePath=path.resolve(currentFile||parserDir);
    const siteFilesToken=path.sep+'site_files'+path.sep;
    const siteFilesAt=currentFilePath.lastIndexOf(siteFilesToken);
    const currentSiteFilesDir=siteFilesAt>=0
      ? currentFilePath.slice(0,siteFilesAt)+path.sep+'site_files'
      : null;
    if(parts.length===1){
      push(currentSiteFilesDir&&path.join(currentSiteFilesDir,ext,name));
      push(path.join(siteFilesDir,ext,name));
      push(path.join(site.cwd||process.cwd(),'site_files',ext,name));
      push(path.join(base,'site_files',ext,name));
      push(path.join(path.dirname(parserDir),'site_files',ext,name));
      push(path.join(parserDir,name));
    }else if(parts.length===2){
      // Nested imports (for example x-import="navbar/index.html" or
      // x-import="emails/view.html") must resolve against the same canonical
      // roots as single-file imports.  The legacy resolver skipped these roots,
      // which made project-level shared UI disappear when an app-local template
      // was rendered under Native Core.
      push(currentSiteFilesDir&&path.join(currentSiteFilesDir,ext,...parts));
      push(path.join(siteFilesDir,ext,...parts));
      push(path.join(site.cwd||process.cwd(),'site_files',ext,...parts));
      push(path.join(base,'site_files',ext,...parts));
      push(path.join(path.dirname(parserDir),'site_files',ext,...parts));
      push(path.join(path.dirname(parserDir),'apps',parts[0],'site_files',ext,parts[1]));
    }else if(parts.length>=3){
      push(currentSiteFilesDir&&path.join(currentSiteFilesDir,ext,...parts));
      push(path.join(siteFilesDir,ext,...parts));
      push(path.join(site.cwd||process.cwd(),'site_files',ext,...parts));
      push(path.join(base,'site_files',ext,...parts));
      push(path.join(path.dirname(parserDir),'site_files',ext,...parts));
      push(path.join(path.dirname(parserDir),'apps',parts[0],'site_files',ext,...parts.slice(1)));
    }
    // Direct relative resolution is required by many current Smart Code themes.
    push(path.resolve(path.dirname(currentFile||parserDir),name));
    push(path.resolve(site.dir||site.cwd,name));
    push(path.resolve(site.cwd,name));
    for(const ap of site.apps||[]){
      if(parts.length>1&&(ap?.name===parts[0]||ap?.name2===parts[0])){
        push(path.join(ap.path,'site_files',ext,...parts.slice(1)));
      }
    }
    const resolved=resolveExisting(candidates);
    if(fileCache?.mode==='production'){
      contentResolutionCache.set(resolutionKey,resolved);
      if(contentResolutionCache.size>10000)contentResolutionCache.delete(contentResolutionCache.keys().next().value);
    }
    return resolved;
  }
  function readContent(currentFile,name,ctx,depth){
    const hidden=String(name||'').startsWith('#');
    const clean=hidden?String(name).slice(1):String(name||'');
    const file=resolveContent(currentFile,clean,ctx);
    if(!file)return '';
    if(ctx.file&&fileCache?.trackDependency)fileCache.trackDependency(ctx.file,file);
    let txt='';try{txt=readText(file)}catch{return ''}
    if(clean.endsWith('.content.html'))return hidden?hide(txt):txt;
    if(clean.endsWith('.html'))txt=renderFile(file,ctx.req,ctx.data,{...ctx,parserDir:path.dirname(file)},depth+1);
    else if(clean.endsWith('.js'))txt=renderJS(txt,{...ctx,file});
    else if(clean.endsWith('.css'))txt=renderCSS(txt,{...ctx,file});
    else txt=expandTokens(txt,{...ctx,file});
    return hidden?hide(txt):txt;
  }
  function replaceNode(node,replacementNodes){
    const p=node.parent;if(!p)return;
    const i=p.children.indexOf(node);if(i<0)return;
    const list=replacementNodes.map(n=>clone(n,p));
    p.children.splice(i,1,...list);
  }
  function filterDirective(root,name,predicate){
    walk(root,node=>{
      if(!hasAttr(node,name))return;
      const keep=predicate(attr(node,name),node);
      if(keep)removeAttr(node,name);
      else replaceNode(node,[]);
    });
  }
  function applyFilters(root,ctx){
    const req=ctx.req||{},sec=site.security||{};
    const featureCache=ctx.featureCache||(ctx.featureCache=new Map());
    const hasFeature=f=>{
      f=String(f||'');
      if(featureCache.has(f))return featureCache.get(f);
      let value=false;
      if(typeof req.hasFeature==='function'){try{value=!!req.hasFeature(f)}catch{}}
      else if(typeof site.hasFeature==='function'){try{value=!!site.hasFeature(f)}catch{}}
      else{
        const list=req.features||[];value=Array.isArray(list)?list.includes(f):!!list?.[f];
      }
      featureCache.set(f,value);return value;
    };
    const tests={
      'x-setting':v=>truthy(getPath(site.setting||{},v)),
      'x-data':v=>truthy(getPath(req.data||ctx.data||{},v)),
      'x-permission':v=>permissionsCheck(v,sec.isUserHasPermission,req,ctx.res,ctx,'permission'),
      'x-role':v=>permissionsCheck(v,sec.isUserHasRole,req,ctx.res,ctx,'role'),
      'x-permissions':v=>permissionsCheck(v,sec.isUserHasPermissions,req,ctx.res,ctx,'permissions'),
      'x-roles':v=>permissionsCheck(v,sec.isUserHasRoles,req,ctx.res,ctx,'roles'),
      'x-lang':v=>String(v)===String(language(req)),
      'x-feature':v=>featureCheck(v,hasFeature),
      'x-features':v=>featureCheck(v,hasFeature)
    };
    const visit=node=>{
      if(node?.type==='element'){
        const directives=node.__renderPlan?.filters || (node.attrs||[]).filter(a=>FILTER_DIRECTIVES.has(String(a.name).toLowerCase())).map(a=>({name:String(a.name).toLowerCase(),value:a.value??''}));
        for(const d of directives){
          if(!hasAttr(node,d.name))continue;
          if(!tests[d.name](d.value,node)){replaceNode(node,[]);return}
          removeAttr(node,d.name);
        }
      }
      for(const c of [...(node?.children||[])])visit(c);
    };
    visit(root);
  }

  function compiledTreeForFile(file,ctx={}){
    const content=readText(file);
    if(fileCache?.getCompiledSync){
      const variant=ctx.cacheVariant||ctx.route?.masterPage||ctx.route?.parser||'';
      const key=`isite-html:${path.resolve(file)}:${variant}`;
      const base=fileCache.getCompiledSync(key,()=>compileRenderPlan(parseHTML(content)),{files:[file],source:content});
      return clone(base);
    }
    return compileRenderPlan(parseHTML(content));
  }

  function processTree(root,ctx={}){
    applyFilters(root,ctx);
    applyImports(root,ctx,ctx.depth||0);
    applyLists(root,ctx);
    processFinalTree(root,ctx);
    return root;
  }

  function renderImportedHtmlTree(currentFile,name,ctx={},depth=0){
    const hidden=String(name||'').startsWith('#');
    if(hidden)return null;
    const clean=String(name||'');
    if(clean.endsWith('.content.html'))return null;
    const file=resolveContent(currentFile,clean,ctx);
    if(!file||!clean.endsWith('.html'))return null;
    if(ctx.file&&fileCache?.trackDependency)fileCache.trackDependency(ctx.file,file);
    const tree=compiledTreeForFile(file,{...ctx,file,parserDir:path.dirname(file)});
    return processTree(tree,{
      ...ctx,
      file,
      parserDir:path.dirname(file),
      depth:depth+1,
      wordCache:ctx.wordCache||new Map(),
      authCache:ctx.authCache||new Map(),
      featureCache:ctx.featureCache||new Map()
    });
  }

  function applyImports(root,ctx,depth){
    // Preserve iSite's runtime ordering, but avoid serialize -> parse round-trips for
    // ordinary HTML imports by attaching the already-rendered imported AST directly.
    for(let pass=0;pass<maxImportDepth;pass++){
      const nodes=[];walk(root,n=>{if(plannedImport(n))nodes.push(n)});
      if(!nodes.length)break;
      let changed=false;
      for(const node of nodes.reverse()){
        if(!node.parent)continue;
        changed=true;
        const directive=plannedImport(node);if(!directive)continue;
        if(directive.mode==='replace'){
          const name=attr(node,directive.key);
          const importedTree=renderImportedHtmlTree(ctx.file,name,ctx,depth+pass);
          if(importedTree){
            replaceNode(node,importedTree.children);
          }else{
            const content=readContent(ctx.file,name,ctx,depth+pass);
            const parsed=compileRenderPlan(parseHTML(content));
            replaceNode(node,parsed.children);
          }
          continue;
        }
        const mode=directive.mode;
        const key=directive.key;
        const name=attr(node,key);
        removeAttr(node,key);
        if(node.tag==='script'||node.tag==='style'){
          const content=readContent(ctx.file,name,ctx,depth+pass);
          const existing=node.children.map(serialize).join('');
          node.children=[{type:'text',value:mode==='append'?existing+content:content+existing,parent:node}];
        }else{
          const importedTree=renderImportedHtmlTree(ctx.file,name,ctx,depth+pass);
          let imported;
          if(importedTree){
            imported=importedTree.children.map(n=>clone(n,node));
          }else{
            const content=readContent(ctx.file,name,ctx,depth+pass);
            const parsed=compileRenderPlan(parseHTML(content));
            imported=parsed.children.map(n=>clone(n,node));
          }
          node.children=mode==='append'?[...node.children,...imported]:[...imported,...node.children];
        }
      }
      if(!changed)break;
    }
  }

  function itemTokenReplace(str,index,item){
    const re=new RegExp(`##item${index}\\.([\\s\\S]*?)##`,'g');
    return String(str).replace(re,(m,key)=>jsonish(getPath(item,key)));
  }
  function replaceTokensInTree(node,index,item){
    if(node.type==='text')node.value=itemTokenReplace(node.value,index,item);
    if(node.attrs)for(const a of node.attrs)if(a.value!=null)a.value=itemTokenReplace(a.value,index,item);
    for(const c of node.children||[])replaceTokensInTree(c,index,item);
  }
  function processShow(node,index,item){
    if(node.type!=='element')return;
    const key=`x-show-item${index}`;
    if(plannedHasShow(node,index)){
      if(!truthy(getPath(item,attr(node,key)))){replaceNode(node,[]);return}
      removeAttr(node,key);
    }
    for(const c of [...(node.children||[])])processShow(c,index,item);
  }
  function applyLists(root,ctx){
    // Support the official x-list1/x-list2 and generalized x-listN used by newer Smart Code templates.
    for(let level=1;level<=16;level++){
      const key=`x-list${level}`;
      let found=true,guard=0;
      while(found&&guard++<10000){
        found=null;walk(root,n=>{if(!found&&plannedHasList(n,level))found=n});
        if(!found)break;
        const rootData={...(ctx.req?.data||{}),...(ctx.data||{})};
        const source=level===1?rootData:(found.__listParentItem||rootData);
        const expr=attr(found,key);
        const list=expr==='*'?source:getPath(source,expr);
        removeAttr(found,key);
        const replacements=[];
        if(Array.isArray(list)){
          list.forEach((item,i)=>{
            const n=clone(found);
            setAttr(n,`x-item${level}`,i);
            n.__listParentItem=item;
            replaceTokensInTree(n,level,item);
            processShow(n,level,item);
            // Nested list gets parent item as its source.
            walk(n,c=>{if(plannedHasList(c,level+1))c.__listParentItem=item});
            replacements.push(n);
          });
        }
        replaceNode(found,replacements);
      }
    }
    // Remove unresolved show directives when no parent item was available.
    walk(root,n=>{
      const levels=n.__renderPlan?.showLevels;
      if(levels?.some(level=>plannedHasShow(n,level))){replaceNode(n,[]);return}
      if(!levels)for(const a of [...(n.attrs||[])]){
        const m=/^x-show-item(\d+)$/.exec(a.name);
        if(m){replaceNode(n,[]);return}
      }
    });
  }
  function processFinalTree(root,ctx){
    const parserFlags=String(ctx.route?.parser||ctx.parser||'html').toLowerCase();
    const doCss=parserFlags.includes('css'),doJs=parserFlags.includes('js');
    const visit=node=>{
      const plan=node.__renderPlan;
      if(node.type==='text'){
        if(!plan||plan.tokenText)node.value=expandTokens(node.value,ctx);
        return;
      }
      if(node.attrs){
        if(plan){
          for(const name of plan.tokenAttrs||[]){
            const a=node.attrs.find(x=>x.name===name);
            if(a?.value!=null)a.value=expandTokens(a.value,ctx);
          }
        }else{
          for(const a of node.attrs)if(a.value!=null&&String(a.value).includes('##'))a.value=expandTokens(a.value,ctx);
        }
      }
      if(node.tag==='style'&&doCss){
        for(const c of node.children||[])if(c.type==='text')c.value=renderCSS(c.value,ctx);
        return;
      }
      if(node.tag==='script'&&doJs){
        for(const c of node.children||[])if(c.type==='text')c.value=renderJS(c.value,ctx);
        return;
      }
      for(const c of node.children||[])visit(c);
    };
    visit(root);
  }

  function renderFastString(content,ctx={}){
    let out=String(content??'');
    const parserFlags=String(ctx.route?.parser||ctx.parser||'html').toLowerCase();
    if(parserFlags.includes('css')){
      out=out.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi,(m,a='',body)=>`<style${a}>${renderCSS(body,ctx)}</style>`);
    }
    if(parserFlags.includes('js')){
      out=out.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi,(m,a='',body)=>`<script${a}>${renderJS(body,ctx)}</script>`);
    }
    return expandTokens(out,ctx);
  }

  function renderParsed(root,ctx={}){
    return serialize(processTree(root,ctx));
  }
  function renderHTML(content,ctx={}){
    if(typeof content!=='string')return content;
    if((ctx.depth||0)>maxImportDepth)return '';
    // Most real website fragments do not use structural x-* directives. Avoid
    // constructing/cloning a DOM tree for those hot-path templates.
    if(!ANY_X_RE.test(content))return renderFastString(content,ctx);
    let root;
    if(ctx.file&&ctx.cacheCompiled!==false&&fileCache?.getCompiledSync){
      const variant=ctx.cacheVariant||ctx.route?.masterPage||ctx.route?.parser||'';
      const key=`isite-html:${path.resolve(ctx.file)}:${variant}`;
      const base=fileCache.getCompiledSync(key,()=>compileRenderPlan(parseHTML(content)),{files:[ctx.file],source:content});
      root=clone(base);
    }else root=compileRenderPlan(parseHTML(content));
    return renderParsed(root,ctx);
  }
  function renderFile(file,req,data={},ctx={},depth=0){
    if(depth>maxImportDepth)return '';
    const content=readText(file);
    return renderHTML(content,{...ctx,req:req||ctx.req||{},res:ctx.res,data:data||{},file,depth,parserDir:ctx.parserDir||path.dirname(file),extra:ctx.extra||{},wordCache:ctx.wordCache||new Map()});
  }
  function renderJS(content,ctx={}){
    let out=String(content??'');
    // iSite: /*##file.js*/ means inline content import.
    out=out.replace(/\/\*##([\s\S]*?)\*\//g,(_,name)=>readContent(ctx.file,name,ctx,ctx.depth||0));
    return expandTokens(out,ctx);
  }
  function renderCSS(content,ctx={}){
    let out=expandTokens(String(content??''),ctx);
    out=out.replace(/var\(---(.*?)\)/g,(_,v)=>tokenValue('var',v,ctx));
    out=out.replace(/word\(---(.*?)\)/g,(_,v)=>tokenValue('word',v,ctx));
    return out;
  }
  function renderTXT(content,ctx={}){return expandTokens(String(content??''),ctx)}

  return {
    html:renderHTML,
    renderHtml:renderHTML,
    renderFile,
    txt:renderTXT,
    js:renderJS,
    css:renderCSS,
    handleMatches:expandTokens,
    resolveContent,
    readContent,
    parseHTML,
    serialize,
    stats:()=>({tokenPlans:tokenPlanCache.size,contentResolutions:contentResolutionCache.size,renderPlansCompiled,renderPlanNodes})
  };
}
module.exports={createLegacyHtmlParser,parseHTML,serialize,getPath,featureCheck};
