import {COMPUTER_VERSION} from '../src/computer/version.js';
import { createServer } from 'node:http';
import { verify } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, expect, test } from 'vitest';
import { WorkerClient, pairWorker, type WorkerClientOptions } from '../src/client.js';
import { createIdentity, saveWorkerConfig } from '../src/environment.js';
import type { Assignment, WorkerMessage, WorkerReport,MaintenanceRequest } from '@luoshu/protocol';
import {WorkerConfigController} from '../src/config-controller.js';
import {updateWorkerConfig} from '../src/environment.js';
const closers:(()=>void)[]=[];
afterEach(()=>{while(closers.length)closers.pop()?.();});
const waitFor=<T>(fn:()=>T|undefined)=>new Promise<T>((resolve,reject)=>{const until=Date.now()+3000;const poll=()=>{const value=fn();if(value!==undefined)return resolve(value);if(Date.now()>until)return reject(new Error('timeout'));setTimeout(poll,10);};poll();});
const report:WorkerReport={name:'desk',os:'linux',arch:'x64',tools:{opencode:'1.0.0','luoshu.live_progress':'1'},agents:[{id:'codex',detected:false},{id:'opencode',detected:true}],capacity:1,revision:1,protocol_version: 8, computer_version: '0.1.2'};
const assignment:Assignment={attempt_id:'execution_1',lease_epoch:1,agent:'opencode',instruction:'Summarize',input_files:[],codebases:[],timeout_seconds:30};
async function setup(options:Pick<WorkerClientOptions,'codebasePreparation'|'onAssistantEngineRequest'|'maintenance'>={}){
 const stateDir=await mkdtemp(join(tmpdir(),'luoshu-client-'));const identity=await createIdentity(stateDir);const server=createServer();const wss=new WebSocketServer({server,path:'/ws/worker'});const received:WorkerMessage[]=[];
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('listen');const url=`http://127.0.0.1:${address.port}`;
 await saveWorkerConfig(stateDir,{worker_id:'worker_1',url,name:'desk',capacity:1});
 let socket:WebSocket,generation=0;wss.on('connection',ws=>{socket=ws;const connection=++generation;ws.on('message',raw=>{const msg=JSON.parse(raw.toString()) as WorkerMessage;received.push(msg);if(msg.type==='auth')ws.send(JSON.stringify({type:'welcome',worker_id:'worker_1',generation:connection,heartbeat_ms:1000,lease_ms:120000}));if(msg.type==='event')ws.send(JSON.stringify({type:'ack',attempt_id:msg.attempt_id,sequence:msg.sequence,accepted:true}));});ws.send(JSON.stringify({type:'challenge',nonce:'nonce_1',protocol_version: 8}));});
 const controller=new WorkerConfigController(stateDir),client=new WorkerClient({stateDir,report,configController:controller,...options});closers.push(()=>{client.stop();wss.clients.forEach(ws=>ws.terminate());wss.close();server.close();});
 return {client,controller,stateDir,received,identity,send:(value:unknown)=>socket.send(JSON.stringify(value))};
}
const maintenance:MaintenanceRequest={type:'maintenance_request',request_id:'maintenance',attempt_id:'repair',lease_epoch:1,operation:'repair',repository:'/fixture',base_sha:'a'.repeat(40),branch:'luoshu/repair/incident/repair',agent:'opencode',instruction:'fix',allowed_paths:['src/**'],checks:[{name:'unit',executable:'npm',args:['test'],timeout_seconds:60}],timeout_seconds:60};

test('native execution blocks maintenance before invoking its executor',async()=>{
 let calls=0;const f=await setup({maintenance:{execute:async()=>{calls++;throw Error('must not execute');}}});f.client.assistantEngineActiveCount=()=>1;await f.client.connect();f.send(maintenance);
 expect(await waitFor(()=>f.received.find(m=>m.type==='maintenance_response'))).toMatchObject({error:'Worker capacity is full'});expect(calls).toBe(0);
});
test('maintenance reserves capacity across reconnect until its aborted execution actually settles',async()=>{
 let release!:()=>void,signal:AbortSignal|undefined;const pending=new Promise<void>(r=>release=r);
 const f=await setup({maintenance:{execute:async(_request,s)=>{signal=s;await pending;throw Error('stopped');}}});f.client.onOffer=()=>true;await f.client.connect();f.send(maintenance);
 await expect.poll(()=>Boolean(signal)).toBe(true);f.send({type:'offer',assignment});
 expect(await waitFor(()=>f.received.find(m=>m.type==='reject'))).toMatchObject({reason:'Worker capacity is full'});
 await f.client.reconnect();expect(signal!.aborted).toBe(true);expect(f.client.executionLoad('native')).toBe(1);
 release();await expect.poll(()=>f.client.executionLoad()).toBe(0);
});
test('execution load deduplicates offered and running attempts and observes applied capacity',async()=>{
 const f=await setup();f.client.onOffer=()=>true;await f.client.connect();f.send({type:'offer',assignment});await waitFor(()=>f.received.find(m=>m.type==='accept'));
 f.client.state.recordStart(assignment.attempt_id,assignment.lease_epoch,assignment);f.client.assistantEngineActiveCount=()=>1;
 expect(f.client.executionLoad('native')).toBe(1);expect(f.client.executionLoad()).toBe(2);
 expect(f.client.executionCapacity).toBe(1);
 await updateWorkerConfig(f.stateDir,c=>({...c,capacity:3}));await f.controller.state();expect(f.client.executionCapacity).toBe(3);
});
test('authenticates the v7 challenge with a current report and replays durable outbox',async()=>{
 const {client,received,identity}=await setup();client.state.appendEvent({type:'event',attempt_id:'old_execution',lease_epoch:1,sequence:1,event:{type:'unknown',reason:'restart'}});await client.connect();
 const auth=await waitFor(()=>received.find(m=>m.type==='auth'));if(auth.type!=='auth')throw new Error('auth');expect(verify(null,Buffer.from('luoshu:worker:v8:nonce_1:worker_1'),identity.publicKey,Buffer.from(auth.signature,'base64url'))).toBe(true);expect(auth.report).toMatchObject({...report,git_credentials:[]});
 await waitFor(()=>client.state.unackedEvents().length===0?true:undefined);expect(received.some(m=>m.type==='heartbeat')).toBe(true);
});
test('assistant engine request completion cannot send an old response on a new Worker connection',async()=>{
 let release!:(value:any)=>void;const f=await setup({onAssistantEngineRequest:()=>new Promise(r=>release=r)});await f.client.connect();
 f.send({type:'assistant_engine_request',request:{action:'reconcile',request_id:'old',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1}});
 await expect.poll(()=>Boolean(release)).toBe(true);await f.client.reconnect();
 release({action:'reconcile',request_id:'old',session_id:'session',submission_id:'submission',run_id:'run',authorization_revision:1,status:'idle'});
 await new Promise(r=>setTimeout(r,30));expect(f.received.filter(m=>m.type==='assistant_engine_response')).toEqual([]);
});
test('direct engine execution shares capacity with queued worker offers and disconnect is observable',async()=>{
 const f=await setup();let disconnects=0;f.client.onAssistantEngineDisconnected=()=>{disconnects++;};f.client.assistantEngineActiveCount=()=>1;f.client.onOffer=()=>true;await f.client.connect();
 expect(f.client.assistantEngineConnection).toMatchObject({authenticated:true,generation:1});
 f.send({type:'offer',assignment});expect(await waitFor(()=>f.received.find(m=>m.type==='reject'))).toMatchObject({reason:'Worker capacity is full'});
 await f.client.reconnect();expect(disconnects).toBe(1);expect(f.client.assistantEngineConnection.generation).toBe(2);
});
test('starts only the exact accepted assignment and never starts twice',async()=>{
 const {client,received,send}=await setup();let starts=0;client.onOffer=()=>true;client.onStart=()=>{starts++;};await client.connect();send({type:'offer',assignment});await waitFor(()=>received.find(m=>m.type==='accept'));expect(starts).toBe(0);
 send({type:'start',assignment:{...assignment,instruction:'Changed'},lease_ms:120000});await waitFor(()=>received.find(m=>m.type==='reject'));expect(starts).toBe(0);
 send({type:'start',assignment,lease_ms:120000});await waitFor(()=>starts||undefined);send({type:'start',assignment,lease_ms:120000});await new Promise(resolve=>setTimeout(resolve,30));expect(starts).toBe(1);
});
test('denies undetected agents and invalid legacy messages before invoking the executor',async()=>{
 const {client,received,send}=await setup();let offers=0,starts=0;client.onOffer=()=>{offers++;return true;};client.onStart=()=>{starts++;};await client.connect();
 send({type:'offer',assignment:{...assignment,agent:'codex'}});await waitFor(()=>received.find(m=>m.type==='reject'));send({type:'offer',assignment:{...assignment,execution:{mode:'workspace',agent:'opencode'}}});send({type:'start',assignment,lease_ms:1000});await new Promise(resolve=>setTimeout(resolve,30));expect(offers).toBe(0);expect(starts).toBe(0);
});
test('prepares Codebases through a strict Worker-local request without returning credentials',async()=>{const prepared={codebase_id:'11111111-1111-4111-8111-111111111111',base_commit:'a'.repeat(40),branch:'luoshu/feature/web',checkout_path:'/state/runs/run_1/targets/web'};const {client,received,send}=await setup({codebasePreparation:{prepare:async request=>{expect(request.codebases[0]).not.toHaveProperty('private_key');return[prepared];}}});await client.connect();send({type:'codebase_prepare_request',request_id:'prepare_1',run_id:'run_1',codebases:[{id:prepared.codebase_id,alias:'web',access_mode:'write',source:{kind:'git',repository_url:'https://git.test/web.git'},root_path:'.',default_branch:'main',branch:prepared.branch}]});expect(await waitFor(()=>received.find(message=>message.type==='codebase_prepare_response'))).toMatchObject({type:'codebase_prepare_response',run_id:'run_1',codebases:[prepared]});});
test('rejects plaintext non-loopback coordinator URLs',async()=>{const stateDir=await mkdtemp(join(tmpdir(),'luoshu-tls-'));const client=new WorkerClient({stateDir,config:{worker_id:'w',url:'http://example.com',name:'desk',capacity:1}});await expect(client.connect()).rejects.toThrow(/HTTPS/);client.stop();});

test('a cancelled pending offer cannot become accepted after its callback completes',async()=>{const {client,received,send}=await setup();let offered=false;let resolveOffer!:(value:boolean)=>void;client.onOffer=()=>{offered=true;return new Promise<boolean>(resolve=>{resolveOffer=resolve;});};client.onCancel=()=>undefined;await client.connect();send({type:'offer',assignment});await waitFor(()=>offered?true:undefined);send({type:'cancel',attempt_id:assignment.attempt_id,reason:'user cancelled'});await new Promise(resolve=>setTimeout(resolve,20));resolveOffer(true);await new Promise(resolve=>setTimeout(resolve,20));expect(received.filter(m=>m.type==='accept')).toEqual([]);});

test('rejects an old challenge without signing or accepting a welcome',async()=>{const dir=await mkdtemp(join(tmpdir(),'luoshu-old-challenge-'));await createIdentity(dir);const server=createServer();const wss=new WebSocketServer({server});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('listen');let sent=0;wss.on('connection',ws=>{ws.on('message',()=>{sent++;});ws.send(JSON.stringify({type:'challenge',nonce:'nonce_1',protocol_version:1}));ws.send(JSON.stringify({type:'welcome',worker_id:'worker_1',generation:1,heartbeat_ms:1000,lease_ms:120000}));});const client=new WorkerClient({stateDir:dir,config:{worker_id:'worker_1',url:`http://127.0.0.1:${address.port}`,name:'desk',capacity:1},report});closers.push(()=>{client.stop();wss.clients.forEach(ws=>ws.terminate());wss.close();server.close();});await expect(client.connect()).rejects.toThrow(/authentication|protocol/i);expect(sent).toBe(0);});

test('reserves capacity while an offer callback is pending',async()=>{const {client,received,send}=await setup();let calls=0;let resolveOffer!:(value:boolean)=>void;client.onOffer=()=>{calls++;return new Promise<boolean>(resolve=>{resolveOffer=resolve;});};await client.connect();send({type:'offer',assignment});await waitFor(()=>calls||undefined);send({type:'offer',assignment:{...assignment,attempt_id:'execution_2'}});expect(await waitFor(()=>received.find(m=>m.type==='reject'&&m.attempt_id==='execution_2'))).toMatchObject({reason:'Worker capacity is full'});resolveOffer(true);await waitFor(()=>received.find(m=>m.type==='accept'));expect(calls).toBe(1);});

test('reconnect refreshes detected executables from the current device',async()=>{const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'luoshu-report-refresh-'));await createIdentity(dir);const agent=join(dir,'agent');await writeFile(agent,'#!/usr/bin/env node\nconsole.log("agent 1.0.0")\n',{mode:0o700});const server=createServer();const wss=new WebSocketServer({server});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('listen');const config={worker_id:'worker_1',url:`http://127.0.0.1:${address.port}`,name:'desk',capacity:1,agent_paths:{codex:agent,opencode:agent}};await saveWorkerConfig(dir,config);const reports:WorkerReport[]=[];wss.on('connection',ws=>{ws.send(JSON.stringify({type:'challenge',nonce:'nonce',protocol_version: 8}));ws.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='auth'){reports.push(message.report);ws.send(JSON.stringify({type:'welcome',worker_id:'worker_1',generation:reports.length,heartbeat_ms:1000,lease_ms:120000}));}});});const client=new WorkerClient({stateDir:dir,reconnectMinMs:20,reconnectMaxMs:20});closers.push(()=>{client.stop();wss.clients.forEach(ws=>ws.terminate());wss.close();});await client.connect();expect(reports[0]?.agents.find(a=>a.id==='codex')?.detected).toBe(true);wss.clients.forEach(ws=>ws.close());await waitFor(()=>reports.length===2?true:undefined);expect(reports[1]?.agents.find(a=>a.id==='codex')?.detected).toBe(true);});

test('only an epoch-matched reconciliation releases an unknown execution capacity',async()=>{const {client,received,send}=await setup();client.state.recordStart('unknown_execution',1,{});client.state.recoverInterrupted();client.onOffer=()=>true;await client.connect();send({type:'reconciled',attempt_id:'unknown_execution',lease_epoch:2});await new Promise(resolve=>setTimeout(resolve,20));expect(client.state.status('unknown_execution')).toBe('unknown');send({type:'reconciled',attempt_id:'unknown_execution',lease_epoch:1});await waitFor(()=>client.state.status('unknown_execution')==='finished'?true:undefined);send({type:'offer',assignment});await waitFor(()=>received.find(m=>m.type==='accept'));expect(client.state.activeAttemptIds()).toEqual([]);});

test('a reconciled message cannot stop a running supervised execution',async()=>{const {client,send}=await setup();client.state.recordStart('live_execution',1,{});await client.connect();send({type:'reconciled',attempt_id:'live_execution',lease_epoch:1});await new Promise(resolve=>setTimeout(resolve,20));expect(client.state.status('live_execution')).toBe('running');});

test('pairing persists absolute Agent paths for the service environment',async()=>{const {loadWorkerConfig}=await import('../src/environment.js');const dir=await mkdtemp(join(tmpdir(),'luoshu-pair-'));let body:any;const paired=await pairWorker({stateDir:dir,url:'https://example.test',name:'desk',code:'pairing-code',capacity:1,codexPath:'/missing/codex',opencodePath:'/missing/opencode',fetchImpl:async(url,init)=>{expect(url).toBe('https://example.test/api/worker/join');body=JSON.parse(String(init?.body));return new Response(JSON.stringify({worker_id:'worker_1',status:'pending'}),{status:200});}});expect(paired).toEqual({workerId:'worker_1',status:'pending'});expect(body).toMatchObject({code:'pairing-code',public_key:expect.stringContaining('PUBLIC KEY'),report:{protocol_version: 8, computer_version: COMPUTER_VERSION}});expect(body.report.agents.every((agent:any)=>agent.enabled===undefined)).toBe(true);expect(await loadWorkerConfig(dir)).toMatchObject({agent_paths:{codex:'/missing/codex',opencode:'/missing/opencode'}});expect(await loadWorkerConfig(dir)).not.toHaveProperty('enabled_agents');});
