import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,readlink,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,test,vi} from 'vitest';
import {PROTOCOL_VERSION} from '../../src/protocol/index.js';
import {saveWorkerConfig} from '../../src/runtime/environment.js';
import {runComputerCli} from '../../src/cli/index.js';
import type {ComputerPaths} from '../../src/cli/paths.js';

const location=vi.hoisted(()=>({paths:undefined as ComputerPaths|undefined}));
vi.mock('../../src/cli/paths.js',()=>({resolveComputerPaths:()=>{
 if(!location.paths)throw Error('Test paths must be supplied');return location.paths;
}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();location.paths=undefined;});

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cli-release-'));
 const paths={root,state:join(root,'state'),versions:join(root,'versions'),current:join(root,'current'),executable:join(root,'bin','luoshu-computer'),service:join(root,'service')};location.paths=paths;
 await mkdir(join(root,'source'));await writeFile(join(root,'source','version.txt'),'verified');
 const archiveFile=join(root,'release.tar.gz');await promisify(execFile)('tar',['-czf',archiveFile,'-C',join(root,'source'),'.']);const archive=await readFile(archiveFile);
 await mkdir(join(paths.versions,'0.1.0'),{recursive:true});await symlink(join(paths.versions,'0.1.0'),paths.current);
 const keys=generateKeyPairSync('ed25519'),manifest=Buffer.from(JSON.stringify({version:'0.2.0',protocol_version:PROTOCOL_VERSION,releases:{'linux-x64':{path:'/computer/releases/0.2.0/linux-x64.tar.gz',sha256:createHash('sha256').update(archive).digest('hex'),size:archive.length}}}));
 await saveWorkerConfig(paths.state,{worker_id:'worker_1',url:'https://core.test',name:'desk',capacity:1,release_url:'https://downloads.test/computer',release_public_key:keys.publicKey.export({type:'spki',format:'pem'}).toString()});
 const bodies=new Map([['https://downloads.test/computer/manifest.json',manifest],['https://downloads.test/computer/manifest.sig',sign(null,manifest,keys.privateKey)],['https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz',archive]]),requests:string[]=[];
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);requests.push(url);expect(init?.redirect).toBe('error');const bytes=bodies.get(url);return bytes?new Response(bytes):new Response('missing',{status:404});});
 const output=vi.spyOn(console,'log').mockImplementation(()=>{});
 return{root,paths,bodies,requests,output};
}

test('CLI update installs a verified independent release and keeps the prior rollback target',async()=>{
 const f=await fixture();try{
  expect(await runComputerCli(['update'])).toBe(0);
  expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,'0.2.0'));
  expect(await readFile(join(f.paths.current,'version.txt'),'utf8')).toBe('verified');
  expect(await readFile(join(f.paths.root,'rollback-version'),'utf8')).toBe(join(f.paths.versions,'0.1.0'));
  expect(f.output).toHaveBeenCalledWith(JSON.stringify({status:'updated',from:'0.1.0',to:'0.2.0'}));
  expect(f.requests).toEqual(['https://downloads.test/computer/manifest.json','https://downloads.test/computer/manifest.sig','https://downloads.test/computer/releases/0.2.0/linux-x64.tar.gz']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('CLI invalid release signature cannot download or switch the installed version',async()=>{
 const f=await fixture();try{
  f.bodies.set('https://downloads.test/computer/manifest.sig',Buffer.alloc(64));
  await expect(runComputerCli(['update'])).rejects.toThrow(/signature/i);
  expect(await readlink(f.paths.current)).toBe(join(f.paths.versions,'0.1.0'));
  expect(f.requests).toEqual(['https://downloads.test/computer/manifest.json','https://downloads.test/computer/manifest.sig']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
