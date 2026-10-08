import { createHash, randomBytes } from 'node:crypto';
export const token=()=>randomBytes(32).toString('base64url');
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function redact(value:string):string{return value.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{10,}|github_pat_[\w_]{10,})\b/g,'[REDACTED]').replace(/(Bearer\s+)[\w.\-]+/gi,'$1[REDACTED]').replace(/((?:token|password|secret|api_key)\s*[=:]\s*)[^\s,;]+/gi,'$1[REDACTED]');}
