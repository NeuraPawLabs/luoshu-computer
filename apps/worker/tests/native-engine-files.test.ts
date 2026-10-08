import {mkdtemp,mkdir,readFile,writeFile,symlink,link,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {NativeRunFiles} from '../src/agent-engines/native-files.js';
import {verifyNativeDelivery} from '@luoshu/protocol/assistant-engine-files-hash';

async function fixture(){const root=await mkdtemp(join(tmpdir(),'luoshu-native-files-')),db=new Database(':memory:');const files=new NativeRunFiles(db,()=>true);return{root,db,files,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};}
const file={name:'input.txt',mime_type:'text/plain',content_base64:Buffer.from('authorized input').toString('base64')};
const input=(cwd:string,run='run-a')=>({cwd,session_id:'session',run_id:run,submission_id:'submission-'+run,input_files:[file]});

test('native file intents give each Run separate outputs and replay only identical inputs',async()=>{
 const f=await fixture();try{
  const first=await f.files.prepare(input(f.root)),second=await f.files.prepare(input(f.root,'run-b'));
  expect(first.outputs).toBe(join(f.root,'runs','run-a','outputs'));expect(second.outputs).not.toBe(first.outputs);
  expect(await readFile(join(first.inputs,'input.txt'),'utf8')).toBe('authorized input');
  expect(await f.files.prepare(input(f.root))).toEqual(first);
  await expect(f.files.prepare({...input(f.root),input_files:[{...file,content_base64:Buffer.from('different').toString('base64')}]})).rejects.toThrow(/conflict/i);
 }finally{await f.close();}
});

test('native delivery hook adds derived documentation before the immutable output snapshot',async()=>{
 const f=await fixture();try{
  const files=new NativeRunFiles(f.db,()=>true,async()=>[],async()=>[],async(_identity,sha)=>({content:[{kind:'outputs',sha256:sha}],checks:[]}),async(_identity,outputs)=>{await mkdir(join(outputs,'documents','app'),{recursive:true});await writeFile(join(outputs,'documents','app','spec.md'),'derived spec');});
  await files.prepare(input(f.root));const delivery=await files.collect('session','run-a','submission-run-a');
  expect(delivery.files.map(file=>file.name)).toEqual(['documents.zip']);
  expect(Buffer.from(delivery.files[0].content_base64,'base64').subarray(0,2).toString()).toBe('PK');
 }finally{await f.close();}
});
test('output subdirectories become ZIPs and immutable collection never includes another Run',async()=>{
 const f=await fixture();try{
  const first=await f.files.prepare(input(f.root)),second=await f.files.prepare(input(f.root,'run-b'));
  await mkdir(join(first.outputs,'lottery'));await writeFile(join(first.outputs,'lottery','index.html'),'<h1>Draw</h1>');
  await writeFile(join(second.outputs,'different.txt'),'second run');
  const delivery=await f.files.collect('session','run-a','submission-run-a');
  expect(verifyNativeDelivery(delivery)).toEqual(delivery);
  expect(delivery.files.map(f=>f.name)).toEqual(['lottery.zip']);expect(Buffer.from(delivery.files[0].content_base64,'base64').subarray(0,2).toString()).toBe('PK');
  await writeFile(join(first.outputs,'lottery','index.html'),'changed after publication');
  expect(await f.files.collect('session','run-a','submission-run-a')).toEqual(delivery);
  await expect(f.files.collect('session','run-a','foreign')).rejects.toThrow(/identity|scope/i);
 }finally{await f.close();}
});
test('links cannot escape native input or output roots and an input cannot be overwritten on replay',async()=>{
 const f=await fixture();try{
  const external=join(f.root,'external');await mkdir(external);await symlink(external,join(f.root,'runs'));
  await expect(f.files.prepare(input(f.root))).rejects.toThrow(/link|directory/i);
 }finally{await f.close();}
 const g=await fixture();try{
  const paths=await g.files.prepare(input(g.root));
  await writeFile(join(paths.inputs,'input.txt'),'tampered');await expect(g.files.prepare(input(g.root))).rejects.toThrow(/conflict|changed/i);
  await writeFile(join(g.root,'secret'),'private');await link(join(g.root,'secret'),join(paths.outputs,'linked.txt'));
  await expect(g.files.collect('session','run-a','submission-run-a')).rejects.toThrow(/link/i);
 }finally{await g.close();}
});
test('output collection is forbidden before reliable native completion',async()=>{
 const f=await fixture();try{
  await f.files.prepare(input(f.root));const active=new NativeRunFiles(f.db,()=>false);
  await expect(active.collect('session','run-a','submission-run-a')).rejects.toThrow(/active|terminal/i);
  expect(f.db.prepare('SELECT delivery_json FROM assistant_native_run_files').get()).toEqual({delivery_json:null});
 }finally{await f.close();}
});
test('concurrent preparation and collection keep one stable intent and delivery after reopening the store',async()=>{
 const f=await fixture();try{
  const paths=await Promise.all([f.files.prepare(input(f.root)),f.files.prepare(input(f.root))]);expect(paths[0]).toEqual(paths[1]);
  await writeFile(join(paths[0].outputs,'answer.txt'),'one result');
  const results=await Promise.all([f.files.collect('session','run-a','submission-run-a'),f.files.collect('session','run-a','submission-run-a')]);
  expect(results[0]).toEqual(results[1]);
  const reopened=new NativeRunFiles(f.db,()=>true);expect(await reopened.collect('session','run-a','submission-run-a')).toEqual(results[0]);
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM assistant_native_run_files').get()).toEqual({count:1});
 }finally{await f.close();}
});
test('failed collection can be retried without recreating inputs or mutating the persisted intent',async()=>{
 const f=await fixture();try{
  const paths=await f.files.prepare(input(f.root));await symlink(join(f.root,'missing'),join(paths.outputs,'bad.txt'));
  await expect(f.files.collect('session','run-a','submission-run-a')).rejects.toThrow(/link/i);
  expect(f.db.prepare('SELECT state,delivery_json FROM assistant_native_run_files').get()).toEqual({state:'ready',delivery_json:null});
  await rm(join(paths.outputs,'bad.txt'));await writeFile(join(paths.outputs,'result.txt'),'safe output');
  const result=await f.files.collect('session','run-a','submission-run-a');expect(result.files.map(file=>file.name)).toEqual(['result.txt']);
  expect(await readFile(join(paths.inputs,'input.txt'),'utf8')).toBe('authorized input');
 }finally{await f.close();}
});
test('owned workspace cleanup refuses nested symlinks without changing their target',async()=>{
 const f=await fixture();try{
  const paths=await f.files.prepare(input(f.root)),outside=join(f.root,'outside');
  await f.files.collect('session','run-a','submission-run-a'); // Reach actual cleanup, not its pending-delivery guard.
  await writeFile(outside,'keep');await symlink(outside,join(paths.outputs,'escape'));
  await expect(f.files.cleanupSession('session')).rejects.toThrow(/link/i);expect(await readFile(outside,'utf8')).toBe('keep');expect(await readFile(join(paths.outputs,'escape'),'utf8')).toBe('keep');
 }finally{await f.close();}
});
test('cleanup validates every Run before deleting any settled predecessor',async()=>{
 const f=await fixture();try{
  const first=await f.files.prepare(input(f.root)),second=await f.files.prepare(input(f.root,'run-b'));
  await f.files.collect('session','run-a','submission-run-a');
  await expect(f.files.cleanupSession('session')).rejects.toThrow(/not settled/);
  expect(await readFile(join(first.inputs,'input.txt'),'utf8')).toBe('authorized input');
  expect(await readFile(join(second.inputs,'input.txt'),'utf8')).toBe('authorized input');
 }finally{await f.close();}
});
test('cleanup cannot delete a prepared Run while a replay is still writing inputs',async()=>{
 const f=await fixture();try{
  const paths=await f.files.prepare(input(f.root));await f.files.collect('session','run-a','submission-run-a');
  const replay=f.files.prepare(input(f.root));
  await expect(f.files.cleanupSession('session')).rejects.toThrow(/not settled/);await replay;
  expect(await readFile(join(paths.inputs,'input.txt'),'utf8')).toBe('authorized input');
 }finally{await f.close();}
});
test('immutable delivery freezes native command receipts alongside files without recollecting on retry',async()=>{
 const f=await fixture();let collected=0;
 const commands=[{thread_id:'thread',turn_id:'turn',item_id:'command',command:'npm test',cwd:f.root,status:'completed' as const,exit_code:0,duration_ms:5}];
 try{
  const files=new NativeRunFiles(f.db,()=>true,async()=>[],identity=>{collected++;expect(identity).toEqual({session_id:'session',run_id:'run-a',submission_id:'submission-run-a'});return commands;});
  const paths=await files.prepare(input(f.root));await writeFile(join(paths.outputs,'result.txt'),'result');
  const first=await files.collect('session','run-a','submission-run-a');expect(first.commands).toEqual(commands);
  commands[0].exit_code=1;expect(await new NativeRunFiles(f.db,()=>true).collect('session','run-a','submission-run-a')).toEqual(first);expect(collected).toBe(1);
 }finally{await f.close();}
});

test('file data purge requires a transaction and preserves a foreign session delivery',async()=>{
 const f=await fixture();try{
  await f.files.prepare(input(f.root));await f.files.collect('session','run-a','submission-run-a');
  await f.files.prepare({...input(f.root,'foreign'),session_id:'foreign'});await f.files.collect('foreign','foreign','submission-foreign');
  const foreign=f.db.prepare("SELECT * FROM assistant_native_run_files WHERE session_id='foreign'").get();
  expect(()=>f.files.purgeSessionData('session')).toThrow(/transaction/);
  await f.files.cleanupSession('session');f.db.transaction(()=>f.files.purgeSessionData('session'))();
  expect(f.db.prepare('SELECT * FROM assistant_native_run_files').all()).toEqual([foreign]);
  expect(f.files.cached('session','run-a','submission-run-a')).toBeNull();
 }finally{await f.close();}
});
test('file data purge rejects uncollected and in-flight preparation before discarding records',async()=>{
 const f=await fixture();try{
  await f.files.prepare(input(f.root));const purge=()=>f.db.transaction(()=>f.files.purgeSessionData('session'))();
  expect(purge).toThrow(/not settled/);await f.files.collect('session','run-a','submission-run-a');
  const replay=f.files.prepare(input(f.root));expect(purge).toThrow(/not settled/);await replay;
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM assistant_native_run_files').get()).toEqual({n:1});
 }finally{await f.close();}
});
