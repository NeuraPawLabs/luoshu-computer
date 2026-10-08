import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';

interface Options {cwd?:string;gitSshCommand?:string;signal?:AbortSignal;input?:Buffer;raw?:boolean;isolated?:boolean;indexFile?:string;commitTime?:number}
const MAX_OUTPUT=2*1024*1024;

/** Own one live Git process group. Abort is immediate and settles only after
 * process close/output drain, never after merely sending a signal. This does
 * not claim containment of helpers that deliberately create another session. */
export async function runGitCommand(args:string[],options:Options):Promise<string>{
 options.signal?.throwIfAborted();
 if(process.platform==='win32')throw Error('Supervised Git process groups are unavailable on this platform');
 return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv=options.isolated?Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))):{...process.env};
  if(options.isolated)Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_AUTHOR_NAME:'Luoshu',GIT_AUTHOR_EMAIL:'delivery@luoshu.invalid',GIT_COMMITTER_NAME:'Luoshu',GIT_COMMITTER_EMAIL:'delivery@luoshu.invalid'});
  if(options.indexFile)env.GIT_INDEX_FILE=options.indexFile;
  if(options.commitTime!==undefined){env.GIT_AUTHOR_DATE='@'+options.commitTime+' +0000';env.GIT_COMMITTER_DATE=env.GIT_AUTHOR_DATE;}
  if(options.gitSshCommand)Object.assign(env,{GIT_SSH_COMMAND:options.gitSshCommand,GIT_SSH_VARIANT:'ssh'});
  const gitArgs=options.isolated?['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.excludesFile=/dev/null',...args]:args;
  const source=import.meta.url.endsWith('.ts'),guardian=fileURLToPath(new URL(source?'./agent-engines/git-guardian.ts':'./agent-engines/git-guardian.js',import.meta.url));
  const child=(process.platform==='linux'
    ? spawn(process.execPath,[...(source?['--import',import.meta.resolve('tsx')]:[]),guardian,'git',...gitArgs],{cwd:options.cwd,detached:true,stdio:['pipe','pipe','pipe','ipc'],env})
    : spawn('git',gitArgs,{cwd:options.cwd,detached:true,stdio:['pipe','pipe','pipe'],env})) as ChildProcessWithoutNullStreams;
  const stdout:Buffer[]=[];let outBytes=0,errBytes=0,failure:Error|undefined,signalled=false;
  const stop=(error:Error)=>{
   failure??=error;
   // Only signal the group while the child handle still owns a live leader;
   // no deferred escalation can target a recycled PID after it has exited.
   if(!signalled&&child.pid&&child.exitCode===null&&child.signalCode===null){
    signalled=true;try{process.kill(-child.pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')failure=new Error('Git process termination could not be confirmed');}
   }
  };
  const abort=()=>stop(new Error('Git operation cancelled'));
  child.stdout.on('data',(bytes:Buffer)=>{outBytes+=bytes.length;if(outBytes>MAX_OUTPUT)stop(new Error('Git command output exceeds transport capacity'));else stdout.push(bytes);});
  child.stderr.on('data',(bytes:Buffer)=>{errBytes+=bytes.length;if(errBytes>MAX_OUTPUT)stop(new Error('Git command output exceeds transport capacity'));});
  child.once('error',error=>{failure??=error;});
  child.once('close',(code,signal)=>{
   options.signal?.removeEventListener('abort',abort);
   const stage=['clone','switch','checkout','rev-parse','ls-remote','status','diff'].includes(args[0]??'')?args[0]+' ':'';
   const output=Buffer.concat(stdout).toString('utf8');
   if(failure)reject(failure);else if(code!==0)reject(new Error(`Git ${stage}command failed (${signal??code??'unknown'})`));else resolve(options.raw?output:output.trim());
  });
  child.stdin.on('error',()=>{});child.stdin.end(options.input);
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 });
}
