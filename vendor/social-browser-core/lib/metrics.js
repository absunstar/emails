'use strict';

class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = new Map();
    this.timings = new Map();
  }
  get(name) { return this.counters.get(name) || 0; }
  inc(name, by=1) {
    this.counters.set(name,(this.counters.get(name)||0)+by);
    return this.counters.get(name);
  }
  observe(name, ms) {
    const row=this.timings.get(name)||{count:0,totalMs:0,minMs:Infinity,maxMs:0};
    row.count++; row.totalMs+=ms; row.minMs=Math.min(row.minMs,ms); row.maxMs=Math.max(row.maxMs,ms);
    this.timings.set(name,row);
  }
  snapshot() {
    const timings={};
    for (const [k,v] of this.timings) timings[k]={...v,avgMs:v.count?v.totalMs/v.count:0,minMs:Number.isFinite(v.minMs)?v.minMs:0};
    return {
      uptimeMs:Date.now()-this.startedAt,
      counters:Object.fromEntries(this.counters),
      timings
    };
  }
}

module.exports = { Metrics };
