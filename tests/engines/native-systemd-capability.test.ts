import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,test,vi} from 'vitest';
import {assertSystemdUserAvailable} from '../../src/engines/native-systemd-supervisor.js';

afterEach(()=>vi.unstubAllEnvs());
async function withManagerVersion(version:string,check:()=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'systemd-capability-'));
 try{
  await writeFile(join(root,'systemctl'),`#!/bin/sh\nprintf '%s\\n' '${version}'\n`,{mode:0o700});
  vi.stubEnv('PATH',root+':'+process.env.PATH);await check();
 }finally{await rm(root,{recursive:true,force:true});}
}
test.each(['249.11-0ubuntu3.16','253','invalid'])('does not advertise native execution with unsupported manager %s',async version=>{
 await withManagerVersion(version,async()=>{await expect(assertSystemdUserAvailable()).rejects.toMatchObject({code:'SUPERVISOR_UNAVAILABLE'});});
});
test.each(['254','255.4-1ubuntu8.17'])('allows the systemd %s launch interface required by native execution',async version=>{
 await withManagerVersion(version,async()=>{await expect(assertSystemdUserAvailable()).resolves.toBeUndefined();});
});
