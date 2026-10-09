import {spawn} from 'node:child_process';
import {nativeLaunchSchema,nativeTargetEnvironment,type NativeLaunch} from './native-systemd-launch.js';

// systemd invokes this module through env -i. The private stdin header is never
// a command-line argument or native RPC message. Only the exact spawned Agent
// receives the curated target environment, not the user-manager environment.
let header=Buffer.alloc(0);
const fail=()=>{process.stderr.write('Native target launch failed\n');process.exit(1);};
process.stdin.on('error',fail);process.stdout.on('error',()=>process.exit(1));process.stderr.on('error',()=>process.exit(1));
const incomplete=()=>fail();process.stdin.once('end',incomplete);
const read=(part:Buffer)=>{
 header=Buffer.concat([header,part]);const end=header.indexOf(10);if(end<0)return;
 process.stdin.pause();process.stdin.off('data',read);process.stdin.off('end',incomplete);
 let spec:NativeLaunch;
 try{spec=nativeLaunchSchema.parse(JSON.parse(header.subarray(0,end).toString('utf8')));}catch{fail();return;}
 const remaining=header.subarray(end+1);header=Buffer.alloc(0);
 // Inherit output descriptors directly: exiting the launcher must not drop
 // buffered native output or wait for descendants holding those descriptors.
 const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:nativeTargetEnvironment(spec.env),stdio:['pipe','inherit','inherit']});
 child.once('error',fail);child.stdin.on('error',()=>process.exit(1));
 // The main unit process must exit when the Agent does, even when detached
 // descendants hold pipes open; systemd then reaps the complete control group.
 child.once('exit',(code,signal)=>{process.stdin.unpipe(child.stdin);process.exit(signal?1:code??1);});
 if(remaining.length)child.stdin.write(remaining);
 process.stdin.pipe(child.stdin);process.stdin.resume();
};
process.stdin.on('data',read);
