'use strict';
function createWords(){
  const words={
    list:[],
    byName:Object.create(null),
    $collection:null,
    add(item){
      if(typeof item==='string')item={name:item,value:item};
      if(!item||!item.name)return null;
      words.byName[item.name]=item; words.list.push(item); return item;
    },
    addList(list){ return [].concat(list||[]).map(x=>words.add(x)).filter(Boolean); },
    addFile(){ return []; },
    get(name){ return words.byName[name]||null; },
    set(item){ return words.add(item); },
    word(name){ const x=words.get(name); return x?.value ?? x?.word ?? name; },
    save(){ return true; }
  };
  return words;
}
module.exports={createWords};
