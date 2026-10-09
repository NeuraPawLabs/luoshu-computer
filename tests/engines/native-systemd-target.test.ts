import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {nativeModuleArguments,type NativeLaunch} from '../../src/engines/native-systemd-launch.js';

function target(){
 const child=spawn(process.execPath,nativeModuleArguments('native-systemd-target'),{env:{PATH:process.env.PATH,MANAGER_SECRET:'synthetic-manager-only',LUOSHU_TOKEN:'synthetic-service-only'},stdio:['pipe','pipe','pipe']});
 const out:Buffer[]=[],err:Buffer[]=[];child.stdout.on('data',value=>out.push(value));child.stderr.on('data',value=>err.push(value));
 const done=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
 return{child,done,stdout:()=>Buffer.concat(out),stderr:()=>Buffer.concat(err).toString()};
}
test.each([false,true])('target preserves split header/RPC boundary and clears manager environment (split=%s)',async split=>{
 const root=await mkdtemp(join(tmpdir(),'native-target-')),f=target();
 try{
  const script=`const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input:Buffer.concat(chunks).toString('base64'),cwd:process.cwd(),args:process.argv.slice(1),env:process.env})));`;
  const spec:NativeLaunch={executable:process.execPath,args:['-e',script,'$HOME','中文'],cwd:root,env:{CODEX_HOME:root,LUOSHU_TOKEN:'must-drop'},unitName:'luoshu-codex-fixture',ownerToken:'11111111-1111-4111-8111-111111111111'};
  const header=Buffer.from(JSON.stringify(spec)+'\n'),rpc=Buffer.from('{"jsonrpc":"2.0","method":"中文"}\n\0\xff');
  if(split){f.child.stdin.write(header.subarray(0,8));await new Promise<void>(r=>setImmediate(r));f.child.stdin.end(Buffer.concat([header.subarray(8),rpc]));}
  else f.child.stdin.end(Buffer.concat([header,rpc]));
  expect(await f.done).toBe(0);const result=JSON.parse(f.stdout().toString());
  expect(result).toMatchObject({input:rpc.toString('base64'),cwd:root,args:['$HOME','中文']});
  expect(result.env.CODEX_HOME).toBe(root);for(const key of ['MANAGER_SECRET','LUOSHU_TOKEN'])expect(result.env[key]).toBeUndefined();
  expect(f.stderr()).toBe('');
 }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');await f.done;await rm(root,{recursive:true,force:true});}
});
test('target preserves fully flushed native stdout and exit status',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-target-output-')),f=target();
 try{
  const script=`process.stdout.write(Buffer.alloc(1024*1024,97),()=>process.exit(7));`;
  const spec:NativeLaunch={executable:process.execPath,args:['-e',script],cwd:root,env:{},unitName:'luoshu-codex-fixture',ownerToken:'11111111-1111-4111-8111-111111111111'};
  // A slow output consumer must not lose bytes when the Agent exits.
  f.child.stdout.pause();f.child.stdin.end(JSON.stringify(spec)+'\n');
  await new Promise<void>(r=>setTimeout(r,300));f.child.stdout.resume();
  expect(await f.done).toBe(7);expect(f.stdout()).toEqual(Buffer.alloc(1024*1024,97));
 }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');await f.done;await rm(root,{recursive:true,force:true});}
});
test.each(['invalid','incomplete','missing'] as const)('target rejects %s launch without exposing spec or executing input',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'native-target-error-')),marker=join(root,'marker'),f=target();
 try{
  const spec={executable:mode==='missing'?join(root,'PRIVATE_MISSING'):process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],cwd:root,env:{CODEX_HOME:root},unitName:'luoshu-codex-fixture',ownerToken:'11111111-1111-4111-8111-111111111111',...(mode==='invalid'?{PRIVATE_FIELD:'secret'}:{})};
  f.child.stdin.end(JSON.stringify(spec)+(mode==='incomplete'?'':'\n'));
  expect(await f.done).not.toBe(0);expect(f.stdout().length).toBe(0);expect(f.stderr()).toBe('Native target launch failed\n');await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
 }finally{if(f.child.exitCode===null)f.child.kill('SIGKILL');await f.done;await rm(root,{recursive:true,force:true});}
});
