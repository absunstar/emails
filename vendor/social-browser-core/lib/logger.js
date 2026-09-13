'use strict';

class Logger {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.level = options.level || 'info';
    this.sink = options.sink || console;
    this.levels = { debug:10, info:20, warn:30, error:40 };
    this.prefix = options.prefix || 'social-browser-core';
    this.json = options.json === true;
    this.base = {...(options.base||{})};
  }

  child(base={}) {
    return new Logger({
      enabled:this.enabled,level:this.level,sink:this.sink,prefix:this.prefix,json:this.json,
      base:{...this.base,...base}
    });
  }

  _write(level, args) {
    if (!this.enabled) return;
    if ((this.levels[level] || 20) < (this.levels[this.level] || 20)) return;
    const fn = this.sink[level] || this.sink.log || console.log;
    if(this.json){
      const row={
        time:new Date().toISOString(),
        level,
        service:this.prefix,
        ...this.base
      };
      if(args.length===1&&args[0]&&typeof args[0]==='object'&&!Array.isArray(args[0])){
        Object.assign(row,args[0]);
      }else{
        row.message=args.map(x=>x instanceof Error?x.message:typeof x==='string'?x:JSON.stringify(x)).join(' ');
      }
      fn.call(this.sink,JSON.stringify(row));
      return;
    }
    fn.call(this.sink, `[${this.prefix}:${level}]`, ...args);
  }

  debug(...a){ this._write('debug',a); }
  info(...a){ this._write('info',a); }
  warn(...a){ this._write('warn',a); }
  error(...a){ this._write('error',a); }
}

module.exports = { Logger };
