import { readFile, rm, unlink } from 'node:fs/promises';
import type { WorkerReport } from '../protocol/index.js';
import type { ComputerPaths } from './paths.js';
import { COMPUTER_VERSION } from './version.js';
import { execFile } from 'node:child_process';

export interface ComputerStatus { version: string; service: string; server?: string; worker_id?: string; agents: WorkerReport['agents']; assistant_engines?: WorkerReport['assistant_engines'] }
export interface DoctorCheck { id: 'config' | 'permissions' | 'service' | 'core' | 'agents'; status: 'ok' | 'warn' | 'error'; message: string }
type Config = { worker_id: string; url: string; name: string; capacity: number };

export async function computerStatus(options: { paths: ComputerPaths; readConfig?: () => Promise<Config>; report?: WorkerReport }): Promise<ComputerStatus> {
  const read = options.readConfig ?? (async () => JSON.parse(await readFile(`${options.paths.state}/config.json`, 'utf8')) as Config);
  const config = await read();
  return { version: options.report?.computer_version ?? COMPUTER_VERSION, service: 'luoshu-computer.service', server: config.url, worker_id: config.worker_id, agents: options.report?.agents ?? [], assistant_engines: options.report?.assistant_engines ?? [] };
}

export async function computerDoctor(options: { paths: ComputerPaths; serviceState?: 'running' | 'missing'; fetchImpl?: typeof fetch; probe?: () => Promise<string | undefined>; report?: WorkerReport }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let serviceState = options.serviceState;
  if (!serviceState) serviceState = await new Promise<'running' | 'missing'>(resolve => execFile('systemctl', ['--user', 'is-active', 'luoshu-computer.service'], error => resolve(error ? 'missing' : 'running')));
  checks.push({ id: 'service', status: serviceState === 'missing' ? 'error' : 'ok', message: serviceState === 'missing' ? 'systemd 用户服务未运行' : 'systemd 用户服务正在运行' });
  let server: string | undefined;
  try { server = (JSON.parse(await readFile(`${options.paths.state}/config.json`, 'utf8')) as Config).url; } catch { /* config check below reports the missing file */ }
  try { const response = await (options.fetchImpl ?? fetch)(`${server ?? 'http://127.0.0.1:8080'}/readyz`); checks.push({ id: 'core', status: response.ok ? 'ok' : 'error', message: response.ok ? 'Core 可访问' : `Core 返回 ${response.status}` }); } catch { checks.push({ id: 'core', status: 'error', message: 'Core 无法访问' }); }
  const detected = options.report ? options.report.agents.some(agent => agent.detected) : await (options.probe ?? (async () => undefined))();
  checks.push({ id: 'agents', status: detected ? 'ok' : 'warn', message: detected ? '至少检测到一个 Agent' : '尚未检测到 Agent' });
  checks.push({ id: 'config', status: server ? 'ok' : 'error', message: server ? '配置可读取' : '设备尚未注册' });
  checks.push({ id: 'permissions', status: 'ok', message: '状态目录权限待服务启动时核对' });
  return checks;
}

export async function uninstallComputer(options: { paths: ComputerPaths; purge?: boolean; run: (command: string, args: string[]) => Promise<void> | void; remove?: (path: string) => Promise<void> }): Promise<void> {
  await options.run('systemctl', ['--user', 'disable', '--now', 'luoshu-computer.service']);
  const remove = options.remove ?? (async path => { await unlink(path).catch(() => undefined); });
  await remove(options.paths.service);
  await remove(options.paths.executable);
  if (options.purge) await (options.remove ?? (async path => { await rm(path, { recursive: true, force: true }); }))(options.paths.state);
}
