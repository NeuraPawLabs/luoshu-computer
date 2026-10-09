import {createConnection,createServer,type Socket} from 'node:net';
import {chmod,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {receiveGitFrames as lines,sendGitFrame as send} from './git-wire.js';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {normalizeGitHost,gitRemoteHost} from '../protocol/index.js';
import {LocalGitCredentialStore} from './git-credentials.js';

export function gitHelperSocketPath(stateDir:string):string{return resolve(stateDir,'git-credential.sock');}
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export function gitSshCommand(stateDir:string):string {
 const source=import.meta.url.endsWith('.ts'),file=fileURLToPath(new URL(source?'./git-ssh-main.ts':'./git-ssh-main.js',import.meta.url));
 return [process.execPath,...(source?['--import',import.meta.resolve('tsx')]:[]),file,'--socket',gitHelperSocketPath(stateDir)].map(quote).join(' ');
}
export function parseGitSshTarget(args:string[]):{host:string;remote:string;args:string[]} {
 let i=0;const flags:string[]=[];
 while(args[i]?.startsWith('-')){
  const option=args[i++];
  if(option==='-p'){const port=args[i++];if(!port||!/^\d{1,5}$/.test(port)||+port<1||+port>65535)throw Error('Invalid SSH port');flags.push('-p',port);}
  else if(option==='-o'&&args[i]==='SendEnv=GIT_PROTOCOL'){flags.push('-o',args[i++]!);}
  else if(option==='-4'||option==='-6')flags.push(option);
  else throw Error('Unsupported Git SSH option');
 }
 const destination=args[i++],command=args[i++];
 if(!destination||!command||i!==args.length)throw Error('Invalid Git SSH host or command');
 const at=destination.lastIndexOf('@'),user=at<0?'':destination.slice(0,at),rawHost=destination.slice(at+1);
 if(at>=0&&!/^[\w.+-]+$/.test(user))throw Error('Invalid Git SSH username');
 const host=normalizeGitHost(rawHost);
 const match=/^(git-receive-pack|git-upload-pack) (.+)$/.exec(command);if(!match)throw Error('Expected Git receive-pack or upload-pack');
 const word=match[2]!;let offset=0,path='';
 // Decode only Git's single-quoted shell word, never evaluate shell syntax.
 while(offset<word.length){
  if(word[offset]!=="'")throw Error('Invalid Git repository quoting');
  const end=word.indexOf("'",offset+1);if(end<0)throw Error('Invalid Git repository quoting');path+=word.slice(offset+1,end);offset=end+1;
  if(offset<word.length){if(word.slice(offset,offset+2)!=="\\'")throw Error('Invalid Git repository quoting');path+="'";offset+=2;}
 }
 if(!path||/[\x00-\x1f\x7f]/.test(path))throw Error('Invalid Git repository path');
 const address=host.includes(':')?`[${host}]`:rawHost;
 const remote=`${at<0?'':user+'@'}${address}:${path}`;gitRemoteHost(remote);

 return{host,remote,args:[...flags,destination,command]};
}
export function parseGitSshHost(args:string[]):string{return parseGitSshTarget(args).host;}
export interface GitCredentialRequester {requestGitCredential(remote:string,options?:{signal?:AbortSignal}):Promise<Record<string,unknown>>}
// The local API streams SSH I/O. It never exposes a credential-read operation.
export async function startGitCredentialServer(stateDir:string,requester?:GitCredentialRequester){
 const localCredentials=new LocalGitCredentialStore(stateDir);
 const path=gitHelperSocketPath(stateDir);
 try{if(!(await stat(path)).isSocket())throw Error('Git helper path is not a socket');
 const live=await new Promise<boolean>((res,rej)=>{const probe=createConnection(path);probe.setTimeout(1000);probe.once('connect',()=>{probe.destroy();res(true);});probe.once('timeout',()=>{probe.destroy();res(true);});probe.once('error',error=>{if(['ECONNREFUSED','ENOENT'].includes((error as NodeJS.ErrnoException).code??''))res(false);else rej(error);});});
 if(live)throw Error('Git helper socket already in use');await rm(path,{force:true});
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const sockets=new Set<Socket>(),jobs=new Set<Promise<void>>(),sessions=new Set<ChildProcess>();let closed=false;
 const stopSession=(session:ChildProcess)=>{if(session.exitCode!==null||session.signalCode!==null)return;if(session.connected)session.disconnect();const timer=setTimeout(()=>{if(session.exitCode===null&&session.signalCode===null)session.kill('SIGKILL');},1500);session.once('exit',()=>clearTimeout(timer));};
 const waitForOutput=(stream:NodeJS.ReadableStream)=>new Promise<void>(resolve=>{let timer:ReturnType<typeof setTimeout>;const finish=()=>{clearTimeout(timer);stream.off('end',finish);stream.off('close',finish);stream.off('error',finish);resolve();};stream.once('end',finish);stream.once('close',finish);stream.once('error',finish);timer=setTimeout(finish,1500);});
 const server=createServer(socket=>{
  if(closed){socket.destroy();return;}
  sockets.add(socket);const abort=new AbortController();let session:ChildProcess|undefined,initial='';const decoder=new StringDecoder('utf8');
  socket.on('error',()=>{});socket.once('close',()=>{sockets.delete(socket);abort.abort();if(session)stopSession(session);});
  const first=(chunk:Buffer)=>{
   initial+=decoder.write(chunk);if(initial.length>65536){socket.destroy();return;}
   const end=initial.indexOf('\n');if(end<0)return;
   socket.removeListener('data',first);socket.pause();
   const job=(async()=>{
    try{
     const frame=JSON.parse(initial.slice(0,end));
     if(!Array.isArray(frame.argv)||frame.argv.length>12||frame.argv.some((v:unknown)=>typeof v!=='string'))throw Error('Invalid Git SSH request');
     const target=parseGitSshTarget(frame.argv);const credential=requester?await requester.requestGitCredential(target.remote,{signal:abort.signal}):await localCredentials.credential(target.host);if(!credential)throw Error(`No Git credential configured for ${target.host}`);
     if(abort.signal.aborted)return;
     if(credential.host!==target.host||typeof credential.private_key!=='string')throw Error('Invalid Git credential response');
     const source=import.meta.url.endsWith('.ts');const file=fileURLToPath(new URL(source?'./git-ssh-session.ts':'./git-ssh-session.js',import.meta.url));
     session=fork(file,[],{execArgv:source?['--import',import.meta.resolve('tsx')]:[],detached:true,stdio:['pipe','pipe','ignore','ipc']});
     sessions.add(session);session.once('exit',()=>sessions.delete(session!));
     const exit=new Promise<void>((res,rej)=>{session!.once('error',rej);session!.once('exit',()=>res());});
     const output=waitForOutput(session.stdout!);
     session.stdin!.on('error',()=>{});session.stdout!.on('error',()=>socket.destroy());
     socket.pipe(session.stdin!);session.stdout!.pipe(socket,{end:false});
     session.send({stateDir,args:target.args,privateKey:credential.private_key},error=>{if(error)socket.destroy();});delete credential.private_key;
     if(initial.length>end+1)session.stdin!.write(initial.slice(end+1));socket.resume();
     await exit;await output;socket.end();
    }catch(error){send(socket,{type:'error',message:error instanceof Error?error.message.slice(0,500):'Git SSH connection failed'});socket.end();}
   })();jobs.add(job);void job.finally(()=>jobs.delete(job));
  };socket.on('data',first);
 });

 await new Promise<void>((res,rej)=>{server.once('error',rej);server.listen(path,res);});await chmod(path,0o600);
 let closing:Promise<void>|undefined;return {close(){return closing??=(async()=>{closed=true;const stopped=new Promise<void>(r=>server.close(()=>r()));for(const s of sockets)s.destroy();for(const session of sessions)stopSession(session);await Promise.allSettled([...jobs]);await stopped;await rm(path,{force:true});})();}};
}
export async function runGitSshHelper(argv:string[],socketPath:string):Promise<number>{
 if(argv.includes('-G'))return 0;
 parseGitSshTarget(argv);
 return await new Promise<number>((resolvePromise,reject)=>{
  const socket=createConnection(socketPath);let settled=false,ready=false;
  const finish=(code:number)=>{if(settled)return;settled=true;clearTimeout(timer);process.stdin.off('end',endInput);process.stdin.off('data',input);process.stdin.pause();process.off('SIGTERM',cancel);process.off('SIGINT',cancel);socket.destroy();resolvePromise(code);};
  const input=(bytes:Buffer)=>{if(!send(socket,{type:'stdin',data:bytes.toString('base64')})){process.stdin.pause();socket.once('drain',()=>{if(!settled)process.stdin.resume();});}};const cancel=()=>finish(130);
  const endInput=()=>send(socket,{type:'end'});const timer=setTimeout(()=>finish(1),20000);process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
  socket.on('error',()=>finish(1));socket.on('close',()=>finish(1));
  socket.on('connect',()=>send(socket,{argv}));
  lines(socket,frame=>{
   if(frame.type==='ready'&&!ready){ready=true;clearTimeout(timer);process.stdin.on('data',input);process.stdin.once('end',endInput);process.stdin.resume();if(process.stdin.readableEnded)send(socket,{type:'end'});}
   else if((frame.type==='stdout'||frame.type==='stderr')&&typeof frame.data==='string'){const stream=frame.type==='stdout'?process.stdout:process.stderr;if(!stream.write(Buffer.from(frame.data,'base64'))){socket.pause();stream.once('drain',()=>socket.resume());}}
   else if(frame.type==='exit')finish(Number.isInteger(frame.code)?frame.code:1);
   else if(frame.type==='error'){process.stderr.write(String(frame.message)+'\n');finish(1);}
  });
 });
}
