import {z} from 'zod';
const nativeId=z.string().min(1).max(200);
/** Observed execution provenance, not a declaration of check purpose or
 * proof that delivered content passed an independent verification. */
export const nativeCommandReceiptSchema=z.object({
 thread_id:nativeId,turn_id:nativeId,item_id:nativeId,
 command:z.string().nullable(),cwd:z.string().nullable(),
 status:z.enum(['completed','failed','declined']),exit_code:z.number().int().nullable(),duration_ms:z.number().int().nonnegative().nullable(),
}).strict();
export const nativeCommandReceiptsSchema=z.array(nativeCommandReceiptSchema).refine(items=>new Set(items.map(i=>JSON.stringify([i.thread_id,i.turn_id,i.item_id]))).size===items.length,'Duplicate native command receipt');
export type NativeCommandReceipt=z.infer<typeof nativeCommandReceiptSchema>;
