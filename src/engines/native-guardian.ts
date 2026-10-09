import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFileSync} from 'node:fs';

// Only the live group leader signals its own group. Native PID reuse and an
// already-exited native parent cannot redirect shutdown at an unrelated group.
// Descendants creating a new session/group are NOT contained by this helper.
if(process.platform!=='linux')throw Error('Native guardian requires Linux');
const stat=readFileSync('/proc/self/stat','utf8');
const group=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);
if(group!==process.pid||process.pid<=1||!process.send)throw Error('Native guardian requires a private process group and parent IPC');
const executable=process.argv[2];if(!executable)throw Error('Native guardian target is missing');
let child:ChildProcessWithoutNullStreams|undefined;
let stopping=false;
function reap(){
 if(stopping)return;stopping=true;
 // Ref'ed until escalation even when the native parent and all pipes close.
 // Persistent signal listeners keep repeated stop requests from killing the
 // guardian before it can terminate its SIGTERM-resistant group members.
 setTimeout(()=>process.kill(-process.pid,'SIGKILL'),1500);
 process.kill(-process.pid,'SIGTERM');
 process.stdin.unpipe();process.stdin.destroy();child?.stdin.destroy();
}
process.on('SIGTERM',reap);process.on('SIGINT',reap);
process.once('disconnect',reap);
process.stdin.on('end',reap);process.stdin.on('error',reap);
process.stdout.on('error',reap);process.stderr.on('error',reap);
if(!process.connected)reap();
if(!stopping){
 child=spawn(executable,process.argv.slice(3),{detached:false,stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',reap);child.stdout.on('error',reap);child.stderr.on('error',reap);
 child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);process.stdin.pipe(child.stdin);
 child.once('error',reap);
 // exit, not close: a surviving descendant may still hold the stdout pipe.
 child.once('exit',reap);
}
