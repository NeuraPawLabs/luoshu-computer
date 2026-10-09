import {chmod, lstat, mkdir, readdir, realpath,readFile,writeFile} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';
import {runGitCommand} from './git-command.js';
import {codebaseAssignmentSchema, codebaseExecutionResultSchema, type CodebaseAssignment, type CodebaseExecutionResult, type CodebasePrepareSpec} from '../protocol/index.js';
import {homedir} from 'node:os';
import {withOutputRoot,removeOwnedWorkspace} from './files.js';

const workspaceId = /^[A-Za-z0-9_-]{1,100}$/;

export interface PreparedCodebase {
  id: string;
  alias: string;
  access_mode: 'write' | 'read';
  repository_path: string;
  checkout_path: string;
  base_commit: string;
  branch: string | null;
  read_isolation: 'enforced' | null;
}
export interface CodebaseWorkspace {
  path: string;
  targets: string;
  references: string;
  codebases: PreparedCodebase[];
}

function contained(root: string, target: string): boolean {
  const value = relative(resolve(root), resolve(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
}

async function git(args: string[], cwd?: string, gitSshCommand?: string,signal?:AbortSignal): Promise<string> {
  return runGitCommand(args,{cwd,gitSshCommand,signal});
}

async function localSource(path: string, allowedRoots: string[]): Promise<string> {
  const actual = await realpath(path);
  const info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local Codebase must be a real directory');
  const roots = await Promise.all(allowedRoots.map(root => realpath(root)));
  if (!roots.some(root => contained(root, actual))) throw new Error('Local Codebase is outside an allowed root');
  return actual;
}

export async function resolveCodebaseAssignments(options:{codebases:CodebasePrepareSpec[];allowedRoots?:string[];gitSshCommand?:string;signal?:AbortSignal}):Promise<CodebaseAssignment[]> {
  const results:CodebaseAssignment[]=[];
  for(const codebase of options.codebases){
    options.signal?.throwIfAborted();
    let baseCommit:string;
    if(codebase.source.kind==='local'){
      const source=await localSource(codebase.source.path,options.allowedRoots??[homedir()]);
      baseCommit=await git(['rev-parse',codebase.default_branch],source,options.gitSshCommand,options.signal);
    }else{
      const output=await git(['ls-remote','--heads',codebase.source.repository_url,`refs/heads/${codebase.default_branch}`],undefined,options.gitSshCommand,options.signal);
      baseCommit=output.split(/\s+/)[0]??'';
    }
    if(!/^[a-f0-9]{40,64}$/.test(baseCommit))throw new Error(`Unable to resolve Codebase ${codebase.alias} default branch`);
    results.push(codebaseAssignmentSchema.parse({...codebase,base_commit:baseCommit}));
  }
  return results;
}

async function readOnlyTree(path: string,signal?:AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const entries = await readdir(path, {withFileTypes: true});
  for (const entry of entries) {
    signal?.throwIfAborted();
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Read Codebase contains a symbolic link');
    if (entry.isDirectory()) { await readOnlyTree(child,signal); await chmod(child, 0o555); }
    else if (entry.isFile()) await chmod(child, 0o444);
    else throw new Error('Read Codebase contains an unsupported file');
  }
  await chmod(path, 0o555);
}

export async function removeCodebaseWorkspace(path: string,current:()=>void=()=>{}): Promise<void> {
  await removeOwnedWorkspace(path,current);
}
export async function existingCodebaseWorkspace(stateDir:string,id:string,assignments:CodebaseAssignment[]):Promise<CodebaseWorkspace>{
 if(!workspaceId.test(id))throw Error('Invalid Codebase workspace ID');
 const path=resolve(stateDir,'runs',id),targets=resolve(path,'targets'),references=resolve(path,'references');
 const identity=await withOutputRoot(path,async root=>{
  const {open}=await import('node:fs/promises'),{constants}=await import('node:fs');
  const handle=await open(`/proc/self/fd/${root.fd}/workspace.json`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size>1024*1024)throw Error('Invalid Codebase identity');return JSON.parse(await handle.readFile('utf8')) as {assignments:CodebaseAssignment[];workspace:CodebaseWorkspace};}finally{await handle.close();}
 });
 if(JSON.stringify(identity.assignments)!==JSON.stringify(assignments)||identity.workspace.path!==path||identity.workspace.targets!==targets||identity.workspace.references!==references||identity.workspace.codebases.length!==assignments.length)throw Error('Codebase workspace identity mismatch');
 for(const assignment of assignments){
  const item=identity.workspace.codebases.find(c=>c.id===assignment.id),repository=resolve(assignment.access_mode==='write'?targets:references,assignment.alias);
  if(!item||item.repository_path!==repository||item.checkout_path!==resolve(repository,assignment.root_path)||item.alias!==assignment.alias||item.access_mode!==assignment.access_mode||item.base_commit!==assignment.base_commit||item.branch!==assignment.branch||item.read_isolation!==(assignment.access_mode==='read'?'enforced':null))throw Error('Codebase workspace identity mismatch');
  if(await realpath(repository)!==repository||await realpath(item.checkout_path)!==item.checkout_path)throw Error('Codebase workspace path contains symbolic links');
 }
 return identity.workspace;
}

export async function prepareCodebaseWorkspace(options: {
  stateDir: string;
  workspaceId: string;
  codebases: CodebaseAssignment[];
  allowedRoots?: string[];
  gitSshCommand?: string;
  signal?:AbortSignal;
  /** The caller has already reserved and pinned the exact Run root in its
   * creator registry. Without this proof, an existing partial root is foreign. */
  ownedRoot?:boolean;
}): Promise<CodebaseWorkspace> {
  options.signal?.throwIfAborted();
  if (!workspaceId.test(options.workspaceId)) throw new Error('Invalid Codebase workspace ID');
  const codebases = options.codebases.map(value => codebaseAssignmentSchema.parse(value));
  if (new Set(codebases.map(item => item.id)).size !== codebases.length || new Set(codebases.map(item => item.alias)).size !== codebases.length) throw new Error('Duplicate Codebase workspace entry');
  const state = await realpath(resolve(options.stateDir));
  const parent = resolve(state, 'runs');
  await mkdir(parent, {recursive: true, mode: 0o700});
  const parentReal = await realpath(parent);
  if (!contained(state, parentReal)) throw new Error('Codebase workspace root escapes Worker state');
  const path = resolve(parentReal, options.workspaceId);
  if (!contained(parentReal, path)) throw new Error('Codebase workspace path escapes Worker state');
  const identityPath=resolve(path,'workspace.json');
  try{
    const identity=JSON.parse(await readFile(identityPath,'utf8')) as {assignments:CodebaseAssignment[];workspace:CodebaseWorkspace};
    if(JSON.stringify(identity.assignments)!==JSON.stringify(codebases))throw new Error('Codebase workspace identity mismatch');
    if(await realpath(path)!==path)throw new Error('Codebase workspace identity contains symbolic link');
    for(const item of identity.workspace.codebases){
      if(!contained(path,item.repository_path)||!contained(item.repository_path,item.checkout_path)||await realpath(item.checkout_path)!==item.checkout_path)throw new Error('Codebase workspace identity path mismatch');
    }
    options.signal?.throwIfAborted();return identity.workspace;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    try{await lstat(path);if(!options.ownedRoot)throw new Error('Existing Codebase workspace has no complete matching identity');}
    catch(existsError){if((existsError as NodeJS.ErrnoException).code!=='ENOENT')throw existsError;}
  }
  const targets = resolve(path, 'targets');
  const references = resolve(path, 'references');
  await mkdir(targets, {recursive: true, mode: 0o700});
  await mkdir(references, {recursive: true, mode: 0o700});
  const prepared: PreparedCodebase[] = [];
  try {
    for (const codebase of codebases) {
      options.signal?.throwIfAborted();
      const destination = resolve(codebase.access_mode === 'write' ? targets : references, codebase.alias);
      const source = codebase.source.kind === 'local'
        ? await localSource(codebase.source.path, options.allowedRoots ?? [homedir()])
        : codebase.source.repository_url;
      await git(['clone', '--no-checkout', ...(codebase.source.kind === 'local' ? ['--no-local'] : []), '--', source, destination], undefined, options.gitSshCommand,options.signal);
      if (codebase.access_mode === 'write') await git(['switch', '-C', codebase.branch!, codebase.base_commit], destination, options.gitSshCommand,options.signal);
      else await git(['checkout', '--detach', codebase.base_commit], destination, options.gitSshCommand,options.signal);
      const head = await git(['rev-parse', 'HEAD'], destination, options.gitSshCommand,options.signal);
      if (head !== codebase.base_commit) throw new Error('Codebase checkout did not resolve the pinned commit');
      const checkout = await realpath(resolve(destination, codebase.root_path));
      if (!contained(destination, checkout)) throw new Error('Codebase root path escapes its repository');
      if (codebase.access_mode === 'read') await readOnlyTree(destination,options.signal);
      prepared.push({id: codebase.id, alias: codebase.alias, access_mode: codebase.access_mode, repository_path: destination, checkout_path: checkout, base_commit: codebase.base_commit, branch: codebase.branch, read_isolation: codebase.access_mode === 'read' ? 'enforced' : null});
    }
    const workspace={path, targets, references, codebases: prepared};
    options.signal?.throwIfAborted();
    await writeFile(identityPath,JSON.stringify({assignments:codebases,workspace}),{flag:'wx',mode:0o600});
    return workspace;
  } catch (error) {
    // Keep partial preparation; never erase potential task work to retry.
    throw error;
  }
}

function paths(output: string): string[] {
  return output.split('\n').map(value => value.trim()).filter(Boolean);
}

export async function collectCodebaseResults(workspace: CodebaseWorkspace, assignments: CodebaseAssignment[]): Promise<CodebaseExecutionResult[]> {
  const byId = new Map(workspace.codebases.map(value => [value.id, value]));
  const results: CodebaseExecutionResult[] = [];
  for (const assignment of assignments) {
    const prepared = byId.get(assignment.id);
    if (!prepared) throw new Error('Prepared Codebase is missing');
    const actualHead = await git(['rev-parse', 'HEAD'], prepared.repository_path);
    const dirty = paths(await git(['status', '--porcelain=v1'], prepared.repository_path));
    if (assignment.access_mode === 'read') {
      if (actualHead !== assignment.base_commit || dirty.length) throw new Error('Read Codebase changed during execution');
      results.push(codebaseExecutionResultSchema.parse({codebase_id: assignment.id, access_mode: 'read', head_commit: null, branch: null, result: 'unchanged', changed_paths: [], read_isolation: 'enforced'}));
      continue;
    }
    const committed = paths(await git(['diff', '--name-only', `${assignment.base_commit}..${actualHead}`], prepared.repository_path));
    const dirtyPaths = dirty.map(line => line.slice(3).trim()).filter(Boolean);
    const allPaths = [...new Set([...committed, ...dirtyPaths])].sort();
    const rootPrefix = assignment.root_path === '.' ? '' : `${assignment.root_path.replace(/\/+$/, '')}/`;
    const outside = rootPrefix ? allPaths.some(path => !path.startsWith(rootPrefix)) : false;
    const changedPaths = rootPrefix ? allPaths.filter(path => path.startsWith(rootPrefix)).map(path => path.slice(rootPrefix.length)) : allPaths;
    const result = dirty.length || outside ? 'failed' : actualHead === assignment.base_commit ? 'unchanged' : 'changed';
    results.push(codebaseExecutionResultSchema.parse({codebase_id: assignment.id, access_mode: 'write', head_commit: actualHead, branch: assignment.branch, result, changed_paths: changedPaths}));
  }
  return results;
}
