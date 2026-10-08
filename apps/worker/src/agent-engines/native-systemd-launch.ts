import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const value=z.string().refine(s=>!s.includes('\0'),'NUL is forbidden');
const path=value.refine(isAbsolute,'An absolute path is required');
export const nativeLaunchSchema=z.object({executable:path,args:z.array(value),cwd:path,env:z.record(z.string(),value),unitName:z.string().regex(/^luoshu-codex-[a-z0-9-]{1,90}$/u),ownerToken:z.string().uuid()}).strict();
export type NativeLaunch=z.infer<typeof nativeLaunchSchema>;

/** No app/service tokens, loader injection, inherited Node flags or manager
 * environment. These are runtime locations and locale, not credentials. */
export function nativeTargetEnvironment(env:NodeJS.ProcessEnv={}):Record<string,string>{
 const result:Record<string,string>={};
 for(const [key,value] of Object.entries(env)){
  if(!/^(?:HOME|PATH|CODEX_HOME|TMPDIR|LANG|LANGUAGE|LC_[A-Z0-9_]+|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/u.test(key))continue;
  if(value!==undefined&&!/[\u0000\r\n]/u.test(value))result[key]=value;
 }
 return result;
}
export function nativeControlEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
 const result:NodeJS.ProcessEnv={};
 for(const key of ['PATH','HOME','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'])if(env[key]!==undefined)result[key]=env[key];
 return result;
}
export function nativeModuleArguments(name:'native-systemd-supervisor'|'native-systemd-target'):string[]{
 const source=import.meta.url.endsWith('.ts');
 return[...(source?['--import',import.meta.resolve('tsx')]:[]),fileURLToPath(new URL(`./${name}.${source?'ts':'js'}`,import.meta.url))];
}
