import {spawn} from 'node:child_process';
import {redact} from '../shared/security.js';
import {codexSandboxModeSchema, type CodexSandboxMode} from '../protocol/index.js';

interface SandboxInput {cwd:string; executable?:string; env?:Record<string,string>; signal?:AbortSignal; sandboxMode?:CodexSandboxMode}
interface ProbeResult {exitCode:number; output:string}

export function codexExecutionConfig(env?:Record<string,string>):string[] {
  return ['-c', 'approval_policy="never"', ...(env?.GIT_SSH_COMMAND
    ? ['-c', 'sandbox_workspace_write.network_access=true', ...Object.entries(env).flatMap(([key,value])=>['-c',`shell_environment_policy.set.${key}=${JSON.stringify(value)}`])]
    : [])];
}

// This invokes only the local sandbox helper, never a model. Bound both its
// lifetime and output, and kill the whole helper group when cancelled.
function probe(input:SandboxInput, argv:string[]):Promise<ProbeResult> {
  if (input.signal?.aborted) return Promise.resolve({exitCode:130,output:'Execution cancelled before sandbox check'});
  return new Promise(resolve=>{
    const child = spawn(input.executable ?? 'codex', argv, {
      cwd:input.cwd, env:{...process.env,...input.env}, detached:true, stdio:['ignore','pipe','pipe'],
    });
    let output = '', stopped:number|undefined;
    const stop = (code:number) => {
      if (stopped !== undefined) return;
      stopped = code;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* process already exited */ }
    };
    const abort = () => stop(130);
    const timeout = setTimeout(()=>stop(124),10_000);
    input.signal?.addEventListener('abort',abort,{once:true});
    if (input.signal?.aborted) abort();
    const collect = (chunk:string) => { output = (output + chunk).slice(0,16_000); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',collect); child.stderr.on('data',collect);
    child.once('error',error=>collect(error.message));
    child.once('close',code=>{
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort',abort);
      resolve({exitCode:stopped ?? code ?? 1,output:redact(output).trim().slice(0,8000)});
    });
  });
}

export async function checkCodexSandbox(input:SandboxInput):Promise<{exitCode:number; summary:string}|undefined> {
  const mode = codexSandboxModeSchema.parse(input.sandboxMode ?? 'workspace-write');
  if (mode === 'danger-full-access') return;
  const help = await probe(input,['sandbox','--help']);
  // Older Codex releases use `sandbox linux`; newer releases take the command
  // directly. Inspect help rather than guessing from a version number.
  const legacy = /^\s+linux\s+/m.test(help.output);
  const result = help.exitCode !== 0 ? help : await probe(input,[
    'sandbox', ...(legacy ? ['linux'] : []), '-c', 'sandbox_mode="workspace-write"',
    ...codexExecutionConfig(input.env), '--', '/bin/true',
  ]);
  if (result.exitCode === 0) return;
  if (result.exitCode === 130) return {exitCode:130,summary:'Execution cancelled during Codex sandbox check'};
  const detail = result.output || (result.exitCode === 124 ? 'Sandbox check timed out' : `Sandbox check exited ${result.exitCode}`);
  const guidance = /bwrap:|user namespace|userns/i.test(detail)
    ? '请在 Worker 设备上检查 bubblewrap 和 AppArmor 的用户命名空间授权；Ubuntu 24.04 需安装并加载 bwrap-userns-restrict 配置。'
    : '请在 Worker 设备上检查 Codex 安装与沙箱配置。';
  return {exitCode:result.exitCode,summary:redact(`Worker 上的 Codex 沙箱自检失败，尚未启动模型任务。\n${detail}\n${guidance}`).slice(0,16_000)};
}
