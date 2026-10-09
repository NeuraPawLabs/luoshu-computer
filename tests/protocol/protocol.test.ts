import { expect, test } from 'vitest';
import { reportSchema, taskFilesSchema, workerEventSchema, workerMessageSchema, serverMessageSchema } from '../../src/protocol/index.js';
const report={name:'worker',os:'linux',arch:'x64',tools:{},agents:[],capacity:1,revision:1,protocol_version: 8,computer_version:'0.1.0'};
test('requires v8 reports without local authority fields',()=>{
 expect(reportSchema.safeParse(report).success).toBe(true);
 for(const changed of [{protocol_version:5},{protocol_version:undefined},{agents:undefined},{scopes:['personal']},{default_agent:'codex'},{runtimes:['codex']}])expect(reportSchema.safeParse({...report,...changed}).success).toBe(false);
});
test('authentication requires a current report and events require positive sequence',()=>{
 expect(workerMessageSchema.safeParse({type:'auth',worker_id:'a',signature:'sig'}).success).toBe(false);
 expect(workerMessageSchema.safeParse({type:'auth',worker_id:'a',signature:'sig',report}).success).toBe(true);
 expect(workerEventSchema.safeParse({type:'event',attempt_id:'a',lease_epoch:1,sequence:-1,event:{type:'started'}}).success).toBe(false);
});
test('live progress is bounded and independent from durable event sequencing',()=>{
 expect(workerMessageSchema.safeParse({type:'live_progress',attempt_id:'a',lease_epoch:1,text:'working'}).success).toBe(true);
 expect(workerMessageSchema.safeParse({type:'live_progress',attempt_id:'a',lease_epoch:1,text:'x'.repeat(8000)}).success).toBe(true);
 expect(workerMessageSchema.safeParse({type:'live_progress',attempt_id:'a',lease_epoch:1,text:'x'.repeat(8001)}).success).toBe(false);
 expect(workerMessageSchema.safeParse({type:'live_progress',attempt_id:'a',lease_epoch:1,sequence:1,text:'working'}).success).toBe(false);
});
test('file transport supports Unicode, canonical base64 and 10 MiB while rejecting unsafe names',()=>{
 const file={name:'说明.txt',mime_type:'text/plain',content_base64:Buffer.alloc(10*1024*1024).toString('base64')};
 expect(taskFilesSchema.safeParse([file]).success).toBe(true);
 for(const name of ['../a','a/b','a\\b','.','..','.hidden','trailing.','trailing ','bad\u0000'])expect(taskFilesSchema.safeParse([{...file,name,content_base64:''}]).success).toBe(false);
 expect(taskFilesSchema.safeParse([{...file,content_base64:'AB=='}]).success).toBe(false);
 expect(taskFilesSchema.safeParse([{...file,content_base64:Buffer.alloc(10*1024*1024+1).toString('base64')}]).success).toBe(false);
 expect(taskFilesSchema.safeParse([{...file,name:'A.txt',content_base64:''},{...file,name:'a.TXT',content_base64:''}]).success).toBe(false);
});

test('assignments pin write and read Codebases without carrying credentials',async()=>{const {assignmentSchema,serverMessageSchema,resultSchema}=await import('../../src/protocol/index.js');const assignment={attempt_id:'execution_1',lease_epoch:1,agent:'codex',instruction:'Modify web and consult api',input_files:[],run_id:'run_1',codebases:[{id:'11111111-1111-4111-8111-111111111111',alias:'web',access_mode:'write',source:{kind:'git',repository_url:'https://git.test/web.git'},root_path:'.',default_branch:'main',base_commit:'a'.repeat(40),branch:'luoshu/feature/web'},{id:'22222222-2222-4222-8222-222222222222',alias:'api',access_mode:'read',source:{kind:'local',path:'/srv/api'},root_path:'.',default_branch:'main',base_commit:'b'.repeat(40),branch:null}],timeout_seconds:30};expect(assignmentSchema.safeParse(assignment).success).toBe(true);for(const change of [{agent:undefined},{task:{}},{project:{}},{execution:{mode:'workspace'}},{instruction:''},{private_key:'secret'},{codebases:[{...assignment.codebases[1],branch:'feature'}]}])expect(assignmentSchema.safeParse({...assignment,...change}).success).toBe(false);expect(serverMessageSchema.safeParse({type:'challenge',nonce:'n',protocol_version: 8}).success).toBe(true);expect(serverMessageSchema.safeParse({type:'challenge',nonce:'n',protocol_version:5}).success).toBe(false);expect(resultSchema.safeParse({status:'succeeded',summary:'done',checks:[],agent:'codex',codebases:[{codebase_id:assignment.codebases[0].id,access_mode:'write',head_commit:'c'.repeat(40),branch:'luoshu/feature/web',result:'changed',changed_paths:['src/app.ts']},{codebase_id:assignment.codebases[1].id,access_mode:'read',head_commit:null,branch:null,result:'unchanged',changed_paths:[],read_isolation:'enforced'}]}).success).toBe(true);expect(resultSchema.safeParse({status:'succeeded',summary:'done',checks:[],agent:'codex',codebases:[{codebase_id:assignment.codebases[1].id,access_mode:'read',head_commit:'c'.repeat(40),branch:null,result:'changed',changed_paths:[]}]}).success).toBe(false);});


test('Git host matching accepts IPv6, encoded paths, and scp paths without corrupting host identity',async()=>{
 const {gitRemoteHost,normalizeGitHost}=await import('../../src/protocol/index.js');
 expect(gitRemoteHost("git+ci@example.test:org/repo with spaces.git")).toBe('example.test');
 expect(gitRemoteHost("ssh://git+ci@[2001:0db8::1]:2222/org/owner%27s%20repo.git")).toBe('2001:db8::1');
 expect(gitRemoteHost("git@[::1]:repo.git")).toBe('::1');
 expect(normalizeGitHost('[2001:0db8::1]')).toBe('2001:db8::1');
 expect(()=>normalizeGitHost('git@127.0.0.1:/repo.git')).toThrow();
 for(const value of ['https://git.test/repo','ssh://user:password@git.test/repo','ssh://git.test/repo?token=x','git@host.test:repo\nnext'])expect(()=>gitRemoteHost(value)).toThrow();
});
