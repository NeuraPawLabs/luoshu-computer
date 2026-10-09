import {randomUUID} from 'node:crypto';
import {codexSandboxModeSchema, type CodexSandboxMode, type CodexSettingsState} from '../protocol/index.js';
import {loadWorkerConfig,updateWorkerConfig,type WorkerConfig} from './environment.js';

const stateOf=(config:WorkerConfig):CodexSettingsState=>({
 mode:config.codex_sandbox??'workspace-write', revision:config.codex_settings_revision??'',
});

export class CodexPermissions {
 constructor(private readonly stateDir:string){}
 async state():Promise<CodexSettingsState>{return stateOf(await loadWorkerConfig(this.stateDir));}
 async mode():Promise<CodexSandboxMode>{return (await this.state()).mode;}
 async update(value:CodexSandboxMode,expectedRevision:string):Promise<CodexSettingsState>{
  const mode=codexSandboxModeSchema.parse(value);
  const config=await updateWorkerConfig(this.stateDir,current=>{
   if(stateOf(current).revision!==expectedRevision)throw Error('Codex 权限配置已改变，请重新读取后保存');
   return {...current,codex_sandbox:mode,codex_settings_revision:randomUUID()};
  });
  return stateOf(config);
 }
}
