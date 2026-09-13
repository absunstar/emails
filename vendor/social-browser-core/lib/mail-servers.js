'use strict';
const net=require('net');
const tls=require('tls');

function lineServer(onLine,{greeting}={}){
  return net.createServer(sock=>{
    sock.setEncoding('utf8');if(greeting)sock.write(greeting+'\r\n');let buf='';
    sock.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\r\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);onLine(sock,line)}});
  });
}

function createSmtpServer(options={}){
  const sessions=new WeakMap();
  const s=lineServer((sock,line)=>{
    let st=sessions.get(sock)||{from:null,to:[],data:false,lines:[]};sessions.set(sock,st);
    if(st.data){
      if(line==='.') {st.data=false;options.onMessage?.({from:st.from,to:st.to,data:st.lines.join('\r\n')},sock);sock.write('250 queued\r\n');st.lines=[]}
      else st.lines.push(line.startsWith('..')?line.slice(1):line);
      return;
    }
    const [cmd,...rest]=line.split(' '),arg=rest.join(' ');
    switch((cmd||'').toUpperCase()){
      case 'EHLO':case 'HELO':
        sock.write(options.tls?'250-aisite\r\n250 STARTTLS\r\n':'250 aisite\r\n');break;
      case 'STARTTLS':
        if(!options.tls){sock.write('454 TLS not available\r\n');break}
        sock.write('220 Ready to start TLS\r\n');
        options.onStartTls?.(sock);
        break;
      case 'MAIL':st.from=arg;sock.write('250 ok\r\n');break;
      case 'RCPT':st.to.push(arg);sock.write('250 ok\r\n');break;
      case 'DATA':st.data=true;sock.write('354 End data with <CRLF>.<CRLF>\r\n');break;
      case 'RSET':st.from=null;st.to=[];st.lines=[];sock.write('250 reset\r\n');break;
      case 'NOOP':sock.write('250 ok\r\n');break;
      case 'QUIT':sock.write('221 bye\r\n');sock.end();break;
      default:sock.write('502 command not implemented\r\n');
    }
  },{greeting:'220 aisite SMTP'});
  return s;
}
function createPop3Server(options={}){
  return lineServer(async(sock,line)=>{
    const [cmd,...rest]=line.split(' '),arg=rest.join(' ');
    const c=(cmd||'').toUpperCase();
    if(c==='USER'||c==='PASS')sock.write('+OK\r\n');
    else if(c==='STAT'){const x=await options.stat?.()||{count:0,size:0};sock.write(`+OK ${x.count} ${x.size}\r\n`)}
    else if(c==='NOOP')sock.write('+OK\r\n');
    else if(c==='QUIT'){sock.write('+OK bye\r\n');sock.end()}
    else sock.write('-ERR unsupported\r\n');
  },{greeting:'+OK aisite POP3'});
}
function createImapServer(options={}){
  return lineServer(async(sock,line)=>{
    const [tag,cmd,...rest]=line.split(' ');const c=(cmd||'').toUpperCase();
    if(c==='CAPABILITY')sock.write('* CAPABILITY IMAP4rev1\r\n'+`${tag} OK CAPABILITY completed\r\n`);
    else if(c==='LOGIN')sock.write(`${tag} OK LOGIN completed\r\n`);
    else if(c==='NOOP')sock.write(`${tag} OK NOOP completed\r\n`);
    else if(c==='LOGOUT'){sock.write('* BYE\r\n'+`${tag} OK LOGOUT completed\r\n`);sock.end()}
    else sock.write(`${tag} BAD unsupported\r\n`);
  },{greeting:'* OK aisite IMAP4rev1'});
}
module.exports={createSmtpServer,createPop3Server,createImapServer};
