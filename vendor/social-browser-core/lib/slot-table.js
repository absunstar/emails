'use strict';

class SlotTable {
  constructor(chunkSize=1_000_000){
    this.chunkSize=Math.max(1024,Number(chunkSize)||1_000_000);
    this.offsetChunks=[];
    this.lengthChunks=[];
    this.deletedChunks=[];
    this.length=0;
    this.deletedCount=0;
  }
  _ensure(slot){
    const ci=Math.floor(slot/this.chunkSize);
    while(this.offsetChunks.length<=ci){
      this.offsetChunks.push(new Float64Array(this.chunkSize));
      this.lengthChunks.push(new Uint32Array(this.chunkSize));
      this.deletedChunks.push(new Uint8Array(Math.ceil(this.chunkSize/8)));
    }
    return ci;
  }
  set(slot,offset,length){
    const ci=this._ensure(slot),i=slot-ci*this.chunkSize;
    this.offsetChunks[ci][i]=offset;
    this.lengthChunks[ci][i]=length;
    if(slot>=this.length)this.length=slot+1;
  }
  getOffset(slot){
    if(slot<0||slot>=this.length)return undefined;
    const ci=Math.floor(slot/this.chunkSize),i=slot-ci*this.chunkSize;
    return this.offsetChunks[ci]?.[i];
  }
  getLength(slot){
    if(slot<0||slot>=this.length)return 0;
    const ci=Math.floor(slot/this.chunkSize),i=slot-ci*this.chunkSize;
    return this.lengthChunks[ci]?.[i]||0;
  }
  isDeleted(slot){
    if(slot<0||slot>=this.length)return true;
    const ci=Math.floor(slot/this.chunkSize),i=slot-ci*this.chunkSize;
    const b=this.deletedChunks[ci];
    return !!(b[(i/8)|0]&(1<<(i&7)));
  }
  markDeleted(slot){
    if(slot<0||slot>=this.length||this.isDeleted(slot))return false;
    const ci=Math.floor(slot/this.chunkSize),i=slot-ci*this.chunkSize,b=this.deletedChunks[ci];
    b[(i/8)|0]|=(1<<(i&7));this.deletedCount++;return true;
  }
  unmarkDeleted(slot){
    if(slot<0||slot>=this.length||!this.isDeleted(slot))return false;
    const ci=Math.floor(slot/this.chunkSize),i=slot-ci*this.chunkSize,b=this.deletedChunks[ci];
    b[(i/8)|0]&=~(1<<(i&7));this.deletedCount--;return true;
  }
  memoryBytes(){
    return this.offsetChunks.reduce((n,a)=>n+a.byteLength,0)
      +this.lengthChunks.reduce((n,a)=>n+a.byteLength,0)
      +this.deletedChunks.reduce((n,a)=>n+a.byteLength,0);
  }
  serialize(){
    const header=Buffer.allocUnsafe(16);
    header.writeUInt32LE(this.length,0);
    header.writeUInt32LE(this.deletedCount,4);
    header.writeUInt32LE(this.chunkSize,8);
    header.writeUInt32LE(1,12);
    const parts=[header];
    let remaining=this.length;
    for(let ci=0;remaining>0;ci++){
      const n=Math.min(this.chunkSize,remaining);
      const o=Buffer.from(this.offsetChunks[ci].buffer,0,n*8);
      const l=Buffer.from(this.lengthChunks[ci].buffer,0,n*4);
      const d=Buffer.from(this.deletedChunks[ci].buffer,0,Math.ceil(n/8));
      parts.push(o,l,d);remaining-=n;
    }
    return Buffer.concat(parts);
  }
  static deserialize(buf){
    if(!buf||buf.length<16)return new SlotTable();
    const length=buf.readUInt32LE(0),deletedCount=buf.readUInt32LE(4),chunkSize=buf.readUInt32LE(8)||1_000_000;
    const t=new SlotTable(chunkSize);t.length=length;t.deletedCount=deletedCount;
    let off=16,remaining=length;
    while(remaining>0){
      const n=Math.min(chunkSize,remaining);
      const oc=new Float64Array(chunkSize),lc=new Uint32Array(chunkSize),dc=new Uint8Array(Math.ceil(chunkSize/8));
      Buffer.from(oc.buffer).set(buf.subarray(off,off+n*8));off+=n*8;
      Buffer.from(lc.buffer).set(buf.subarray(off,off+n*4));off+=n*4;
      const db=Math.ceil(n/8);Buffer.from(dc.buffer).set(buf.subarray(off,off+db));off+=db;
      t.offsetChunks.push(oc);t.lengthChunks.push(lc);t.deletedChunks.push(dc);remaining-=n;
    }
    return t;
  }
}
module.exports={SlotTable};
