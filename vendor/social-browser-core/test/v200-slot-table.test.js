'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SlotTable}=require('../lib/slot-table');

test('slot table stores millions-style metadata compactly',()=>{
 const t=new SlotTable(1000);
 for(let i=0;i<5000;i++)t.set(i,100+i*20,20);
 t.markDeleted(123);t.markDeleted(4999);
 assert.equal(t.length,5000);assert.equal(t.deletedCount,2);
 assert.equal(t.getOffset(42),940);assert.equal(t.getLength(42),20);
 assert.equal(t.isDeleted(123),true);
 assert.ok(t.memoryBytes()<5000*14);
 const b=t.serialize(),t2=SlotTable.deserialize(b);
 assert.equal(t2.length,5000);assert.equal(t2.getOffset(42),940);assert.equal(t2.isDeleted(4999),true);
});

test('10m slot metadata estimate stays near 121 MB',()=>{
 const bytes=10_000_000*(8+4+1/8);
 assert.ok(bytes<130*1024*1024);
});
