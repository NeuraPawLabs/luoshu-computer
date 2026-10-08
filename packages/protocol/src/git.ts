import {z} from 'zod';
const dnsHost=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function normalizeGitHost(value:string):string {
 let host=value.trim().toLowerCase().replace(/\.$/,'');
 if(host.startsWith('[')&&host.endsWith(']'))host=host.slice(1,-1);
 if(host.includes(':')){if(!/^[a-f0-9:.]+$/.test(host))throw Error('Invalid Git host');try{host=new URL(`ssh://[${host}]`).hostname.slice(1,-1);}catch{throw Error('Invalid Git host');}}
 else if(!dnsHost.test(host))throw Error('Invalid Git host');
 if(!host||host.length>253)throw Error('Invalid Git host');return host;
}
export const gitHostSchema=z.string().min(1).max(253).refine(value=>{try{return normalizeGitHost(value)===value;}catch{return false;}},'Invalid Git host');
export function gitRemoteHost(remote:string):string {
 if(/[\x00-\x1f\x7f]/.test(remote)||remote.length>2048)throw Error('Invalid Git SSH URL');
 let host:string;
 if(remote.startsWith('ssh://')){
  const u=new URL(remote);if(u.password||u.search||u.hash||!u.pathname||u.pathname==='/')throw Error('Invalid Git SSH URL');host=u.hostname;
 }else{
  if(remote.includes('://'))throw Error('Use an SSH Git URL');
  const m=/^(?:[\w.+-]+@)?(\[[^\]]+\]|[\w.-]+):(.+)$/.exec(remote);if(!m)throw Error('Use an SSH Git URL');host=m[1]!;
 }
 return normalizeGitHost(host);
}
