import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';

if(process.platform!=='linux'||!process.send)throw Error('Git guardian requires Linux and parent IPC');
const stat=await import('node:fs/promises').then(fs=>fs.readFile('/proc/self/stat','utf8'));
const group=Number(stat.slice(stat.lastIndexOf(')')+2).trim().split(' ')[2]);
if(group!==process.pid||process.pid<=1)throw Error('Git guardian requires a private process group');
const executable=process.argv[2];if(!executable)throw Error('Git guardian target is missing');
let child:ChildProcessWithoutNullStreams|undefined,stopping=false,escalation:ReturnType<typeof setTimeout>|undefined;
const stop=()=>{
 if(stopping)return;stopping=true;
 try{if(child?.pid)process.kill(child.pid,'SIGTERM');}catch{}
 escalation=setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},1500);
};
process.once('disconnect',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.stdout.on('error',stop);process.stderr.on('error',stop);
if(!stopping){
 child=spawn(executable,process.argv.slice(3),{detached:false,stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
 child.stdin.on('error',stop);child.stdout.on('error',stop);child.stderr.on('error',stop);
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
 child.once('error',()=>{stop();process.exitCode=1;});
 child.once('exit',(code,signal)=>{if(stopping)return;if(escalation)clearTimeout(escalation);process.exit(signal?1:code??1);});
}
