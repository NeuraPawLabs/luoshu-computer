import {createHash} from 'node:crypto';
import {deliveryEnvelopeSchema,type DeliveryEnvelope,type AgentEvidence} from './recovery.js';
import {assignmentSchema,type Assignment} from './execution.js';
import {MAX_WIRE_BYTES} from './task-files.js';

function canonical(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined)
  .map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const sha256=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function assertCompletionEvidence(previous:AgentEvidence,next:AgentEvidence):void{
 const fact=(e:AgentEvidence)=>({outcome:e.outcome,exit_code:e.exit_code,summary:e.summary,session_id:e.session_id,checks:e.checks});
 if(canonical(fact(previous))!==canonical(fact(next)))throw Error('Agent completion evidence conflict');
 if(previous.output_snapshot_sha256&&previous.output_snapshot_sha256!==next.output_snapshot_sha256)throw Error('Output evidence conflict');
 if(previous.codebases.length&&canonical(previous.codebases)!==canonical(next.codebases))throw Error('Codebase evidence conflict');
}
export function hashAssignment(value:Assignment):string{return sha256(canonical(assignmentSchema.parse(value)));}
export function hashDelivery(value:Omit<DeliveryEnvelope,'package_sha256'>):string{
 // Manifest hashes bind file bytes; verification below always recomputes them.
 const manifest=[...value.manifest].sort((a,b)=>a.file_key<b.file_key?-1:a.file_key>b.file_key?1:0);
 return sha256(canonical({execution_id:value.execution_id,delivery_id:value.delivery_id,
  assignment_sha256:value.assignment_sha256,checkpoint_version:value.checkpoint_version,
  purpose:value.purpose,agent:value.agent,evidence:value.evidence,manifest,verification_binding:value.verification_binding}));
}
export function verifyDelivery(value:unknown):DeliveryEnvelope{
 const packet=deliveryEnvelopeSchema.parse(value);
 if(Buffer.byteLength(JSON.stringify(packet))>MAX_WIRE_BYTES-4096)throw new Error('Delivery exceeds wire limit');
 for(const item of packet.manifest){
  const file=packet.files.find(f=>f.name===item.name)!;
  if(sha256(Buffer.from(file.content_base64,'base64'))!==item.sha256)throw new Error('Delivery file hash mismatch');
 }
 if(hashDelivery(packet)!==packet.package_sha256)throw new Error('Delivery package hash mismatch');
 return packet;
}
