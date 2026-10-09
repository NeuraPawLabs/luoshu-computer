import { chmod, link, lstat, mkdtemp as createTemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { collectOutputFiles, collectOutputSnapshot, prepareWorkspace, MAX_ARCHIVE_ENTRIES } from '../../src/runtime/files.js';
import { promisify } from 'node:util';

const command = promisify(execFile);
test('source snapshot changes with content and preserves a stable unchanged digest',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-source-snapshot-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'snapshot',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));await writeFile(join(w.outputs,'project','app.js'),'v1');
 const first=await collectOutputSnapshot(w.outputs);
 expect(first.source_sha256).toMatch(/^[a-f0-9]{64}$/);
 expect((await collectOutputSnapshot(w.outputs)).source_sha256).toBe(first.source_sha256);
 await writeFile(join(w.outputs,'project','app.js'),'v2');
 expect((await collectOutputSnapshot(w.outputs)).source_sha256).not.toBe(first.source_sha256);
 const controller=new AbortController();controller.abort();
 await expect(collectOutputSnapshot(w.outputs,controller.signal)).rejects.toThrow();
});
const roots:string[]=[];
async function mkdtemp(prefix:string){const root=await createTemp(prefix);roots.push(root);return root;}
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

test('prepares private task inputs and collects bounded regular output files', async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-files-'));
 const workspace=await prepareWorkspace({stateDir:root,attemptId:'attempt_1',inputFiles:[{name:'note.txt',mime_type:'text/plain',content_base64:'aGVsbG8='}]});
 expect((await lstat(workspace.path)).mode&0o077).toBe(0); await writeFile(join(workspace.outputs,'answer.txt'),'done');
 expect(await collectOutputFiles(workspace.outputs)).toEqual([{name:'answer.txt',mime_type:'text/plain',content_base64:'ZG9uZQ=='}]);
});

test('rejects output symlinks, traversal names, duplicates, and oversized files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-files-bad-'));const out=join(root,'outputs');await mkdir(out);
 await writeFile(join(root,'secret'),'secret');await symlink(join(root,'secret'),join(out,'leak.txt'));
 await expect(collectOutputFiles(out)).rejects.toThrow(/symbolic link/i);
 await expect(prepareWorkspace({stateDir:root,attemptId:'../escape',inputFiles:[]})).rejects.toThrow(/execution/i);
});

test('does not reuse an attempt directory or reject a benign double-dot filename',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-files-fresh-'));await prepareWorkspace({stateDir:root,attemptId:'attempt_1',inputFiles:[{name:'a..b.txt',mime_type:'text/plain',content_base64:'eA=='}]});await expect(prepareWorkspace({stateDir:root,attemptId:'attempt_1',inputFiles:[]})).rejects.toThrow(/exists|fresh/i);
});

test('rejects an outputs path whose ancestor resolves through a symlink',async()=>{const root=await mkdtemp(join(tmpdir(),'luoshu-output-parent-')),actual=join(root,'actual');await mkdir(actual);await mkdir(join(actual,'outputs'));await symlink(actual,join(root,'linked'));await expect(collectOutputFiles(join(root,'linked','outputs'))).rejects.toThrow(/symbolic link|resolved path/i);});

test('supports Unicode files up to 10 MiB',async()=>{const root=await mkdtemp(join(tmpdir(),'luoshu-unicode-'));const workspace=await prepareWorkspace({stateDir:root,attemptId:'execution_1',inputFiles:[{name:'资料.txt',mime_type:'text/plain',content_base64:'aGVsbG8='}]});expect(await readFile(join(workspace.inputs,'资料.txt'),'utf8')).toBe('hello');await writeFile(join(workspace.outputs,'结果.bin'),Buffer.alloc(10*1024*1024));expect((await collectOutputFiles(workspace.outputs))[0]?.name).toBe('结果.bin');});

test('packages nested output directories as one zip while preserving relative paths', async () => {
 const root = await mkdtemp(join(tmpdir(), 'luoshu-nested-output-'));
 const workspace = await prepareWorkspace({stateDir:root,attemptId:'execution_1',inputFiles:[]});
 await mkdir(join(workspace.outputs, 'classroom-lottery', 'src'), {recursive:true});
 await writeFile(join(workspace.outputs, 'classroom-lottery', 'package.json'), '{"name":"lottery"}');
 await writeFile(join(workspace.outputs, 'classroom-lottery', 'src', 'main.ts'), 'export const main = true;');
 const files = await collectOutputFiles(workspace.outputs);
 expect(files).toHaveLength(1);
 expect(files[0]).toMatchObject({name:'classroom-lottery.zip', mime_type:'application/zip'});
 const archive = join(root, 'result.zip');
 await writeFile(archive, Buffer.from(files[0]!.content_base64, 'base64'));
 const listing = await command('unzip', ['-Z1', archive]);
 expect(listing.stdout.trim().split('\n').sort()).toEqual(['classroom-lottery/package.json', 'classroom-lottery/src/main.ts']);
 await command('unzip', ['-t', archive]);
 const extracted=join(root,'extracted');
 await command('unzip',['-q',archive,'-d',extracted]);
 expect(await readFile(join(extracted,'classroom-lottery','src','main.ts'),'utf8')).toBe('export const main = true;');
});

test('archives Unicode paths, dotfiles, empty directories and executable permissions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-content-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'run',inputFiles:[]});
 await mkdir(join(w.outputs,'project','空目录'),{recursive:true});
 await writeFile(join(w.outputs,'project','中文.txt'),Buffer.from([0,255,1,0,128]));
 await writeFile(join(w.outputs,'project','.gitignore'),'node_modules');
 await writeFile(join(w.outputs,'project','run.sh'),'#!/bin/sh\nexit 0\n');
 await chmod(join(w.outputs,'project','run.sh'),0o755);
 const [file]=await collectOutputFiles(w.outputs),archive=join(root,'archive.zip');
 await writeFile(archive,Buffer.from(file.content_base64,'base64'));
 await command('unzip',['-t',archive]);
 const extracted=join(root,'extracted');await command('unzip',['-q',archive,'-d',extracted]);
 expect(await readFile(join(extracted,'project','中文.txt'))).toEqual(Buffer.from([0,255,1,0,128]));
 expect(await readFile(join(extracted,'project','.gitignore'),'utf8')).toBe('node_modules');
 expect((await lstat(join(extracted,'project','空目录'))).isDirectory()).toBe(true);
 expect((await lstat(join(extracted,'project','run.sh'))).mode&0o111).toBe(0o111);
});

test('rejects links, duplicate paths and archive-name collisions explicitly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-invalid-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'collision',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));await writeFile(join(w.outputs,'project.zip'),'existing');
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/Duplicate output deliverable/i);
 const h=await prepareWorkspace({stateDir:root,attemptId:'hardlinks',inputFiles:[]});
 await mkdir(join(h.outputs,'project'));await writeFile(join(root,'secret'),'private');
 await link(join(root,'secret'),join(h.outputs,'project','hard.txt'));
 await expect(collectOutputFiles(h.outputs)).rejects.toThrow(/regular|hard link/i);
 const d=await prepareWorkspace({stateDir:root,attemptId:'duplicates',inputFiles:[]});
 await mkdir(join(d.outputs,'project'));await writeFile(join(d.outputs,'project','A.txt'),'a');await writeFile(join(d.outputs,'project','a.txt'),'b');
 await expect(collectOutputFiles(d.outputs)).rejects.toThrow(/Duplicate output path/i);
});

test('rejects nested output symlinks while collecting a directory archive', async () => {
 const root = await mkdtemp(join(tmpdir(), 'luoshu-nested-output-link-'));
 const workspace = await prepareWorkspace({stateDir:root,attemptId:'execution_1',inputFiles:[]});
 await mkdir(join(workspace.outputs, 'classroom-lottery'), {recursive:true});
 await writeFile(join(workspace.outputs, 'secret.txt'), 'secret');
 await symlink(join(workspace.outputs, 'secret.txt'), join(workspace.outputs, 'classroom-lottery', 'leak.txt'));
 await expect(collectOutputFiles(workspace.outputs)).rejects.toThrow(/symbolic link|regular/i);
});

test('directory total bytes and ZIP name length have explicit errors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-limits-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'large',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));
 await writeFile(join(w.outputs,'project','one.bin'),Buffer.alloc(6*1024*1024));
 await writeFile(join(w.outputs,'project','two.bin'),Buffer.alloc(6*1024*1024));
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/exceeds 10 MiB/);
 const n=await prepareWorkspace({stateDir:root,attemptId:'name',inputFiles:[]});
 await mkdir(join(n.outputs,'n'.repeat(237)));
 await expect(collectOutputFiles(n.outputs)).rejects.toThrow(/ZIP filename/);
});

test.each(['bad\\name','bad\nname','trailing.'])('rejects unsafe nested ZIP name %s',async name=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-path-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'path',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));await writeFile(join(w.outputs,'project',name),'unsafe');
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/archive path/);
});

test('rejects Windows drive-like archive paths even on Linux',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-drive-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'drive',inputFiles:[]});
 await mkdir(join(w.outputs,'C:'));await writeFile(join(w.outputs,'C:','answer.txt'),'unsafe');
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/archive path/);
});

test('bounds total nested entries across sibling directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-count-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'count',inputFiles:[]});
 const project=join(w.outputs,'project');await mkdir(project);
 // Each subtree is within the bound, but their aggregate is not.
 for(const name of ['a','b']){
  const directory=join(project,name);await mkdir(directory);
  for(let batch=0;batch<MAX_ARCHIVE_ENTRIES/2;batch+=100)
   await Promise.all(Array.from({length:100},(_,i)=>writeFile(join(directory,String(batch+i)),'x')));
 }
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/Too many entries/);
},15000);

test('multiple files and empty folders share one deliverable without changing source files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-many-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'many',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));await mkdir(join(w.outputs,'empty'));
 for(let i=0;i<8;i++)await writeFile(join(w.outputs,'project',String(i)),String(i));
 await writeFile(join(w.outputs,'readme.txt'),'instructions');
 const files=await collectOutputFiles(w.outputs);
 expect(files.map(f=>f.name).sort()).toEqual(['empty.zip','project.zip','readme.txt']);
 expect(await readFile(join(w.outputs,'project','0'),'utf8')).toBe('0');
 const archive=join(root,'empty.zip');await writeFile(archive,Buffer.from(files.find(f=>f.name==='empty.zip')!.content_base64,'base64'));
 expect((await command('unzip',['-Z1',archive])).stdout.trim()).toBe('empty/');
});

test('ZIP overhead cannot exceed the existing per-artifact wire limit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'luoshu-zip-wire-limit-'));
 const w=await prepareWorkspace({stateDir:root,attemptId:'wire',inputFiles:[]});
 await mkdir(join(w.outputs,'project'));
 await writeFile(join(w.outputs,'project','random.bin'),randomBytes(10*1024*1024));
 await expect(collectOutputFiles(w.outputs)).rejects.toThrow(/ZIP exceeds 10 MiB/);
});
