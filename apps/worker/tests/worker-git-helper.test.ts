import {expect,test} from 'vitest';
import {parseGitSshHost,parseGitSshTarget,gitHelperSocketPath} from '../src/git-helper.js';
test('resolves host and repository from actual Git SSH arguments',()=>{
 expect(parseGitSshHost(['git@github.com',"git-receive-pack 'org/repo.git'"])).toBe('github.com');
 expect(parseGitSshTarget(['-p','2222','-o','SendEnv=GIT_PROTOCOL','Git.Example.Com.',"git-receive-pack '/repo.git'"])).toMatchObject({host:'git.example.com',remote:'Git.Example.Com.:/repo.git'});
 expect(()=>parseGitSshHost(['git-upload-pack','repo.git'])).toThrow();
 expect(()=>parseGitSshHost(['-o','ProxyCommand=echo bad','host',"git-receive-pack 'a'"])).toThrow();
 expect(gitHelperSocketPath('/tmp/worker')).toBe('/tmp/worker/git-credential.sock');
});

test('recovers stale sockets after a Worker crash while refusing a live listener',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn}=await import('node:child_process');const {startGitCredentialServer}=await import('../src/git-helper.js');
 const dir=await mkdtemp(join(tmpdir(),'git-stale-')),path=gitHelperSocketPath(dir);const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(path)},()=>process.stdout.write('ready'))`]);
 await new Promise<void>(r=>child.stdout!.once('data',()=>r()));const stopped=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await stopped;
 let helper:Awaited<ReturnType<typeof startGitCredentialServer>>|undefined;
 try{helper=await startGitCredentialServer(dir,{requestGitCredential:async()=>({})});await expect(startGitCredentialServer(dir,{requestGitCredential:async()=>({})})).rejects.toThrow(/already/);}finally{await helper?.close();await rm(dir,{recursive:true,force:true});}
});

test('preserves actual Git SSH quoting for spaces and apostrophes, plus usernames and IPv6',()=>{
 expect(parseGitSshTarget(['git+ci@example.test',"git-receive-pack 'org/repo with spaces.git'"])).toMatchObject({host:'example.test',remote:'git+ci@example.test:org/repo with spaces.git'});
 expect(parseGitSshTarget(['git@example.test',"git-receive-pack 'org/owner'\\''s-repo.git'"])).toMatchObject({host:'example.test',remote:"git@example.test:org/owner's-repo.git"});
 expect(parseGitSshTarget(['-p','2222','git@2001:db8::1',"git-receive-pack '/repo.git'"])).toMatchObject({host:'2001:db8::1',remote:'git@[2001:db8::1]:/repo.git'});
 for(const command of ["git-receive-pack 'repo'; echo bad","git-receive-pack $(echo bad)","git-receive-pack 'repo' extra"])expect(()=>parseGitSshTarget(['host.test',command])).toThrow();
});

test('initial socket request preserves UTF-8 split between packets',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createConnection}=await import('node:net');const {startGitCredentialServer}=await import('../src/git-helper.js');
 const dir=await mkdtemp(join(tmpdir(),'git-utf8-'));let remote='';const server=await startGitCredentialServer(dir,{requestGitCredential:async value=>{remote=value;throw Error('fixture stop');}});const socket=createConnection(gitHelperSocketPath(dir));socket.on('error',()=>{});socket.resume();
 try{await new Promise<void>(r=>socket.once('connect',r));const bytes=Buffer.from(JSON.stringify({argv:['git@git.test',"git-receive-pack '资料.git'"]})+'\n'),cut=bytes.indexOf(Buffer.from('资'))+1;socket.write(bytes.subarray(0,cut));await new Promise(r=>setTimeout(r,25));socket.write(bytes.subarray(cut));await expect.poll(()=>remote).toBe('git@git.test:资料.git');}
 finally{socket.destroy();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('drains the final SSH output frame before closing the broker socket',async()=>{
 const {mkdtemp,mkdir,rm,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');const {readFileSync}=await import('node:fs');const {createConnection}=await import('node:net');const {receiveGitFrames}=await import('../src/git-wire.js');const {startGitCredentialServer}=await import('../src/git-helper.js');
 const dir=await mkdtemp(join(tmpdir(),'git-drain-')),bin=join(dir,'bin'),state=join(dir,'state'),oldPath=process.env.PATH;await mkdir(bin);await mkdir(state);
 const keyPath=join(dir,'fixture-key');execFileSync('ssh-keygen',['-t','ed25519','-N','','-f',keyPath],{stdio:'ignore'});const key=readFileSync(keyPath,'utf8');
 const payload='tail-'+ 'x'.repeat(1_300_000);
 await writeFile(join(bin,'ssh'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(payload)},()=>process.exit(0));\n`,{mode:0o700});
 process.env.PATH=`${bin}:${oldPath??''}`;
 const server=await startGitCredentialServer(state,{requestGitCredential:async()=>({host:'git.test',private_key:key})});const socket=createConnection(join(state,'git-credential.sock'));socket.on('error',()=>{});
 try{
  const frames:any[]=[];const done=new Promise<void>((resolve,reject)=>{socket.once('error',reject);receiveGitFrames(socket,frame=>{frames.push(frame);if(frame.type==='exit')resolve();});});
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.write(JSON.stringify({argv:['git@git.test',"git-receive-pack 'repo.git'"]})+'\n');
  await expect(done).resolves.toBeUndefined();
  const output=frames.filter(frame=>frame.type==='stdout').map(frame=>Buffer.from(frame.data,'base64').toString()).join('');expect(output).toBe(payload);expect(frames.at(-1)).toMatchObject({type:'exit',code:0});
 }finally{socket.destroy();await server.close();process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});
