'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const core=require('..');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'sb-html-parser-'))}
function request(overrides={}){
  return {
    session:{
      language:{id:'En'},
      theme:'dark',
      user:{id:7,name:'Amr',roles:['admin'],permissions:['users.view','reports.view']},
      ...overrides.session
    },
    data:{...overrides.data},
    query:{q:'hello',...overrides.query},
    params:{id:'42',...overrides.params},
    headers:{},
    features:['ads','mcp'],
    hasFeature(name){return this.features.includes(name)},
    word(name){return {'Hello':'Hello Word','Imported':'Imported Word'}[name]||name},
    ...overrides
  };
}

test('legacy parser expands official placeholder families',()=>{
  const site=core({compatibility:'isite'});
  site.setting.company={name:'Social Browser'};
  site.vars={build:'390'};
  const req=request();
  const parser=site.createParser(req,null,{parserDir:process.cwd()});
  const out=parser.txt([
    '##word.Hello##',
    '##session.lang##',
    '##session.theme##',
    '##user.name##',
    '##query.q##',
    '##params.id##',
    '##setting.company.name##',
    '##var.build##',
    '##data.name##',
    '##req.session.user.id##'
  ].join('|').replace('##data.name##','##data.name##'));
  // createParser data comes from req.data
  req.data.name='DataName';
  const out2=parser.txt('##data.name##');
  assert.equal(out,'Hello Word|En|dark|Amr|hello|42|Social Browser|390||7');
  assert.equal(out2,'DataName');
});

test('legacy parser applies setting/data/lang/feature/permission/role directives',()=>{
  const site=core({compatibility:'isite'});
  site.setting.enabled=true;
  const req=request({data:{show:true}});
  const parser=site.createParser(req,null);
  const html=`
    <a id="setting" x-setting="enabled">A</a>
    <a id="setting-off" x-setting="missing">B</a>
    <a id="data" x-data="show">C</a>
    <a id="lang" x-lang="En">D</a>
    <a id="lang-off" x-lang="Ar">E</a>
    <a id="feature" x-feature="ads">F</a>
    <a id="feature-not" x-feature="!disabled">G</a>
    <a id="features-or" x-features="missing || mcp">H</a>
    <a id="features-and" x-features="ads && mcp">I</a>
    <a id="permission" x-permission="users.view">J</a>
    <a id="permission-off" x-permission="users.delete">K</a>
    <a id="permissions" x-permissions="users.view,reports.view">L</a>
    <a id="role" x-role="admin">M</a>
    <a id="role-off" x-role="manager">N</a>
  `;
  const out=parser.html(html);
  for(const id of ['setting','data','lang','feature','feature-not','features-or','features-and','permission','permissions','role'])assert.match(out,new RegExp(`id="${id}"`),id);
  for(const id of ['setting-off','lang-off','permission-off','role-off'])assert.doesNotMatch(out,new RegExp(`id="${id}"`),id);
  assert.doesNotMatch(out,/\bx-(setting|data|lang|feature|features|permission|permissions|role)=/);
});

test('x-import prepends, x-append appends, and x-replace replaces',()=>{
  const dir=tmp();
  fs.writeFileSync(path.join(dir,'imp.html'),'<b>##word.Imported##</b>');
  const main=path.join(dir,'main.html');
  fs.writeFileSync(main,`
    <div id="import" x-import="imp.html"><i>tail</i></div>
    <div id="append" x-append="imp.html"><i>head</i></div>
    <div id="replace" x-replace="imp.html"><i>gone</i></div>
  `);
  const site=core({cwd:dir,dir,compatibility:'isite'});
  const out=site.parser.renderFile(main,request(),{},{parserDir:dir});
  assert.match(out,/id="import"><b>Imported Word<\/b><i>tail<\/i>/);
  assert.match(out,/id="append"><i>head<\/i><b>Imported Word<\/b>/);
  assert.doesNotMatch(out,/id="replace"/);
  assert.match(out,/<b>Imported Word<\/b>/);
  assert.doesNotMatch(out,/x-(import|append|replace)=/);
});

test('x-listN, item placeholders and x-show-itemN support nested lists',()=>{
  const site=core({compatibility:'isite'});
  const req=request({data:{
    groups:[
      {name:'A',visible:true,items:[{name:'A1',show:true},{name:'A2',show:false}]},
      {name:'B',visible:false,items:[{name:'B1',show:true}]}
    ]
  }});
  const parser=site.createParser(req,null);
  const html=`
    <section x-list1="groups" x-show-item1="visible">
      <h1>##item1.name##</h1>
      <span x-list2="items" x-show-item2="show">##item2.name##</span>
    </section>`;
  const out=parser.html(html);
  assert.match(out,/>A<\/h1>/);
  assert.match(out,/>A1<\/span>/);
  assert.doesNotMatch(out,/A2/);
  assert.doesNotMatch(out,/>B<\/h1>/);
  assert.doesNotMatch(out,/x-list|x-show-item/);
});

test('x-list4 and arbitrary item roots used by newer Smart Code are supported',()=>{
  const site=core({compatibility:'isite'});
  const req=request({data:{$list0:[{title:'One'},{title:'Two'}]}});
  const out=site.createParser(req,null).html('<div x-list4="$list0">##item4.title##</div>');
  assert.match(out,/>One<\/div>/);
  assert.match(out,/>Two<\/div>/);
});

test('custom top-level render data placeholders are resolved',()=>{
  const site=core({compatibility:'isite'});
  const parser=site.createParser(request(),null);
  const out=site.parser.html('<p>##lawsuit.name##</p>',{
    req:request(),
    data:{lawsuit:{name:'Case 1'}}
  });
  assert.match(out,/Case 1/);
});

test('JS includes and CSS var/word helpers match iSite parser forms',()=>{
  const dir=tmp();
  fs.writeFileSync(path.join(dir,'part.js'),'const imported="##word.Imported##";');
  const site=core({cwd:dir,dir,compatibility:'isite'});
  site.vars={accent:'#123456'};
  const req=request();
  const ctx={req,file:path.join(dir,'main.js'),parserDir:dir,data:{}};
  const js=site.parser.js('/*##part.js*/\nconst user="##user.name##";',ctx);
  assert.match(js,/Imported Word/);
  assert.match(js,/Amr/);
  const css=site.parser.css('a{color:var(---accent)} .x:before{content:"word(---Hello)"}',ctx);
  assert.match(css,/#123456/);
  assert.match(css,/Hello Word/);
});

test('template expansion is bounded for recursive tokens',()=>{
  const site=core({compatibility:'isite',parser:{maxTemplatePasses:4}});
  const req=request({word:()=> '##word.Loop##'});
  const out=site.createParser(req,null).txt('##word.Loop##');
  assert.match(out,/##word\.Loop##/);
});


test('HTML parser applies embedded CSS/JS parsing only when route parser enables them',()=>{
  const site=core({compatibility:'isite'});
  site.vars={accent:'#abc'};
  const req=request();
  const html='<style>a{color:var(---accent)}</style><script>const u="##user.name##";</script>';
  const plain=site.parser.html(html,{req,route:{parser:'html'}});
  assert.match(plain,/var\(---accent\)/);
  const parsed=site.parser.html(html,{req,route:{parser:'html css js'}});
  assert.match(parsed,/#abc/);
  assert.match(parsed,/Amr/);
});
