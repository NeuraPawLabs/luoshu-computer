import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {assertSystemdUserAvailable,spawnSystemdSupervisor} from '../src/agent-engines/native-systemd-supervisor.js';
import {nativeModuleArguments,nativeTargetEnvironment,nativeControlEnvironment} from '../src/agent-engines/native-systemd-launch.js';

interface Identity{pid:number;start:string;state:string}
async function identity(pid:number):Promise<Identity|null>{try{const raw=await readFile(`/proc/${pid}/stat`,'utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');return{pid,start:parts[19]!,state:parts[0]!};}catch(error){if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null;throw error;}}
async function alive(saved:Identity){const value=await identity(saved.pid);return value?.start===saved.start&&!['Z','X'].includes(value.state);}

test('systemd user supervisor is available or reports an explicit unsupported capability',async()=>{try{await assertSystemdUserAvailable();}catch(error){expect((error as {code?:string}).code).toBe('SUPERVISOR_UNAVAILABLE');}});
test.each(['stop','native-exit'] as const)('transient service passes exact launch context and recovers setsid descendants on %s',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-systemd-supervisor-')),ready=join(root,'ready.json'),unit=`luoshu-codex-test-${randomUUID()}`;let child:any;
 try{
  const descendant=`process.send({pid:process.pid});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const target=`const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',1,2,'ipc']});d.once('message',m=>require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({target:process.pid,descendant:m.pid,cwd:process.cwd(),args:process.argv.slice(1),home:process.env.CODEX_HOME,secret:process.env.LUOSHU_SECRET??null,unknown:process.env.OTHER_SECRET??null})));process.stdin.once('data',()=>process.exit(7));process.stdin.resume();`;
  const literal=['$HOME','${CODEX_HOME}','a b','quote"','中文'];
  child=spawnSystemdSupervisor({executable:process.execPath,args:['-e',target,...literal],cwd:root,env:{PATH:process.env.PATH,CODEX_HOME:root,LUOSHU_SECRET:'must-not-forward',OTHER_SECRET:'also-private'},unitName:unit});
  let data='';child.stdout.on('data',(chunk:Buffer)=>{data+=chunk.toString();});child.stderr.on('data',(chunk:Buffer)=>{data+=chunk.toString();});
  await expect.poll(()=>readFile(ready,'utf8').then(value=>JSON.parse(value)).catch(()=>null),{timeout:8000}).not.toBeNull();
  const fixture=JSON.parse(await readFile(ready,'utf8')),saved=await Promise.all([fixture.target,fixture.descendant].map(identity));expect(saved.every(Boolean)).toBe(true);
  expect(fixture).toMatchObject({cwd:root,args:literal,home:root,secret:null,unknown:null});
  expect(child.confirmNativeExit).toBeTypeOf('function');
  const directChildren=(await readFile(`/proc/${child.pid}/task/${child.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  expect(directChildren.length).toBeGreaterThan(0);
  for(const pid of directChildren){const argv=await readFile(`/proc/${pid}/cmdline`,'utf8');expect(argv.includes(root)).toBe(false);expect(argv.includes('must-not-forward')).toBe(false);expect(argv.includes(target)).toBe(false);}
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));if(mode==='stop')child.kill('SIGTERM');else child.stdin.write('exit\n');await exited;
  await child.confirmNativeExit();
  await expect.poll(async()=>Promise.all(saved.map(alive)),{timeout:7000}).toEqual([false,false]);expect(data).not.toContain('must-not-forward');
 }finally{await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
test('supervisor command line does not embed a serialized launch spec',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-launch-argv-')),unit=`luoshu-codex-test-${randomUUID()}`;let child:any,exited:Promise<void>|undefined;
 try{
  child=spawnSystemdSupervisor({executable:process.execPath,args:['-e','process.stdin.resume()'],cwd:root,env:{CODEX_HOME:root,LUOSHU_TOKEN:'SYNTHETIC_TOKEN'},unitName:unit});
  exited=new Promise(resolve=>child.once('exit',resolve));
  const argv=child.spawnargs as string[];
  const disclosed=argv.some(value=>{try{return Buffer.from(value,'base64url').toString().includes('SYNTHETIC_TOKEN');}catch{return false;}});
  expect(disclosed).toBe(false);expect(argv.join(' ')).not.toContain(root);
 }finally{if(child?.connected)child.disconnect();await exited;await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
test('invalid unit names are rejected before spawning',()=>{expect(()=>spawnSystemdSupervisor({executable:'/bin/true',args:[],unitName:'bad name'})).toThrow(/unit/i);});
test('target environment does not permit service secrets or runtime injection',()=>{
 expect(nativeTargetEnvironment({HOME:'/fixture',CODEX_HOME:'/fixture/codex',PATH:'/usr/bin',LANG:'zh_CN.UTF-8',LC_CTYPE:'UTF-8',XDG_CONFIG_HOME:'/fixture/config',LUOSHU_SERVICES_KEY:'synthetic',LUOSHU_TOKEN:'synthetic',NODE_OPTIONS:'--require unsafe',LD_PRELOAD:'/unsafe',XDG_ARBITRARY_SECRET:'synthetic',DBUS_SESSION_BUS_ADDRESS:'private',TMPDIR:'bad\nvalue'})).toEqual({HOME:'/fixture',CODEX_HOME:'/fixture/codex',PATH:'/usr/bin',LANG:'zh_CN.UTF-8',LC_CTYPE:'UTF-8',XDG_CONFIG_HOME:'/fixture/config'});
});
test('missing systemd executable yields a bounded launch error without an unhandled stack',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-no-systemd-'));
 const child=spawn(process.execPath,[...nativeModuleArguments('native-systemd-supervisor'),'--run'],{env:{PATH:root},stdio:['pipe','pipe','pipe','ipc']});
 const stderr:Buffer[]=[];child.stderr.on('data',value=>stderr.push(value));child.stdout.resume();
 const done=new Promise<number|null>(resolve=>child.once('close',resolve));
 try{
  child.on('message',(message:any)=>{if(message.type==='native_launch_ready')child.send({type:'native_launch_commit',nonce:message.nonce});});
  child.send({type:'native_launch',spec:{executable:process.execPath,args:['-e','process.stdin.resume()'],cwd:root,env:{},unitName:`luoshu-codex-test-${randomUUID()}`,ownerToken:randomUUID()}});
  expect(await done).not.toBe(0);expect(Buffer.concat(stderr).toString()).toBe('Native supervisor failed\n');
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await done;await rm(root,{recursive:true,force:true});}
});
test('parent IPC disconnected before launch cannot start a later target',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-disconnected-')),marker=join(root,'must-not-start'),unit=`luoshu-codex-test-${randomUUID()}`;
 const child=spawn(process.execPath,[...nativeModuleArguments('native-systemd-supervisor'),'--run'],{env:nativeControlEnvironment(process.env),stdio:['pipe','pipe','pipe','ipc']});
 const done=new Promise<number|null>(resolve=>child.once('exit',resolve));child.stdout.resume();child.stderr.resume();
 try{
  child.send({type:'native_launch',spec:{executable:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],cwd:root,env:{},unitName:unit,ownerToken:randomUUID()}});child.disconnect();
  expect(await done).not.toBe(0);await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await done;await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
test('transient launch preserves RPC input and complete final output before native nonzero exit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-systemd-stream-')),unit=`luoshu-codex-test-${randomUUID()}`;
 const script=`process.stdin.once('data',b=>{process.stdout.write(b);process.stdout.write(Buffer.alloc(1024*1024,97),()=>process.exit(7));});`;
 const child=spawnSystemdSupervisor({executable:process.execPath,args:['-e',script],cwd:root,env:{},unitName:unit});
 const chunks:Buffer[]=[];child.stdout.on('data',b=>chunks.push(b));child.stderr.resume();const done=new Promise<number|null>(resolve=>child.once('close',resolve));
 try{
  child.stdout.pause();child.stdin.write('RPC_INPUT\n');await new Promise<void>(resolve=>setTimeout(resolve,500));child.stdout.resume();
  expect(await done).toBe(7);expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('RPC_INPUT\n'),Buffer.alloc(1024*1024,97)]));
 }finally{await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});if(child.exitCode===null)child.kill('SIGKILL');await done;await rm(root,{recursive:true,force:true});}
});
test('supervisor SIGKILL does not count as native exit and exact cgroup recovery preserves unrelated process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-supervisor-crash-')),unit=`luoshu-codex-test-${randomUUID()}`,ready=join(root,'ready');
 const outsider=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),outsideExit=new Promise(r=>outsider.once('exit',r));
 const code=`const {spawn}=require('node:child_process');const d=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});d.once('message',pid=>require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,pid])));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
 const child=spawnSystemdSupervisor({executable:process.execPath,args:['-e',code],cwd:root,env:{},unitName:unit});child.stdout.resume();child.stderr.resume();const exited=new Promise(r=>child.once('exit',r));
 try{
  await expect.poll(()=>readFile(ready,'utf8').catch(()=>null)).not.toBeNull();
  const saved=await Promise.all(JSON.parse(await readFile(ready,'utf8')).map(identity)),unrelated=(await identity(outsider.pid!))!;
  child.kill('SIGKILL');await exited;expect(await Promise.all(saved.map(alive))).toEqual([true,true]);
  await child.confirmNativeExit();expect(await Promise.all(saved.map(alive))).toEqual([false,false]);expect(await alive(unrelated)).toBe(true);
 }finally{await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;outsider.kill('SIGKILL');await outsideExit;await rm(root,{recursive:true,force:true});}
});
test('stop during delayed unit creation waits for the late exact unit instead of losing ownership',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-delayed-start-')),unit=`luoshu-codex-test-${randomUUID()}`,entered=join(root,'entered'),release=join(root,'release'),marker=join(root,'must-not-run');
 await writeFile(join(root,'systemd-run'),`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(entered)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);const c=require('node:child_process').spawn('/usr/bin/systemd-run',process.argv.slice(2),{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));}},10);\n`,{mode:0o700});
 const child=spawn(process.execPath,[...nativeModuleArguments('native-systemd-supervisor'),'--run'],{env:{...nativeControlEnvironment(process.env),PATH:root+':/usr/bin:/bin'},stdio:['pipe','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();let exited=false;const done=new Promise(r=>child.once('exit',code=>{exited=true;r(code);}));
 child.on('message',(m:any)=>{if(m.type==='native_launch_ready')child.send({type:'native_launch_commit',nonce:m.nonce});});
 try{
  child.send({type:'native_launch',spec:{executable:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],cwd:root,env:{},unitName:unit,ownerToken:randomUUID()}});
  await expect.poll(()=>readFile(entered,'utf8').catch(()=>null)).toBe('ready');child.kill('SIGTERM');await new Promise(r=>setTimeout(r,100));expect(exited).toBe(false);
  await writeFile(release,'go');await done;await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await writeFile(release,'go');await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});if(!exited)child.kill('SIGKILL');await done;await rm(root,{recursive:true,force:true});}
});
test.each(['query','stop'] as const)('supervisor keeps its fence while %s fails and closes only after recovery',async failure=>{
 const root=await mkdtemp(join(tmpdir(),'native-control-failure-')),unit=`luoshu-codex-test-${randomUUID()}`,broken=join(root,'broken'),ready=join(root,'ready');
 await writeFile(join(root,'systemctl'),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(fs.existsSync(${JSON.stringify(broken)})&&args.includes(${JSON.stringify(failure==='query'?'show':'stop')}))process.exit(1);const c=require('node:child_process').spawn('/usr/bin/systemctl',args,{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));\n`,{mode:0o700});
 const child=spawn(process.execPath,[...nativeModuleArguments('native-systemd-supervisor'),'--run'],{env:{...nativeControlEnvironment(process.env),PATH:root+':/usr/bin:/bin'},stdio:['pipe','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();let exited=false;const done=new Promise(r=>child.once('exit',code=>{exited=true;r(code);}));
 child.on('message',(m:any)=>{if(m.type==='native_launch_ready')child.send({type:'native_launch_commit',nonce:m.nonce});if(m.type==='native_systemd_cgroup')child.send({type:'native_runtime_commit',invocation:m.invocation});});
 try{
  child.send({type:'native_launch',spec:{executable:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],cwd:root,env:{},unitName:unit,ownerToken:randomUUID()}});
  await expect.poll(()=>readFile(ready,'utf8').catch(()=>null)).not.toBeNull();const saved=(await identity(Number(await readFile(ready,'utf8'))))!;
  await writeFile(broken,'unavailable');child.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));expect(exited).toBe(false);expect(await alive(saved)).toBe(true);
  await rm(broken);await done;expect(await alive(saved)).toBe(false);
 }finally{await rm(broken,{force:true});await promisify(execFile)('systemctl',['--user','stop',unit],{timeout:6000}).catch(()=>{});if(!exited)child.kill('SIGKILL');await done;await rm(root,{recursive:true,force:true});}
});
