import {z} from 'zod';

export const conversationTitleUpdateSchema=z.object({
 title:z.string().trim().min(1).max(120),
 expected_version:z.number().int().nonnegative(),
}).strict();
export type EngineTitleUpdate=z.infer<typeof conversationTitleUpdateSchema>;

export const engineTitleResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),updated:z.boolean(),title:z.string(),version:z.number().int().nonnegative()}).strict(),
 z.object({success:z.literal(false),error:z.string()}).strict(),
]);
export type EngineTitleResult=z.infer<typeof engineTitleResultSchema>;

export function nativeTitleTools(){
 return[{type:'function' as const,name:'luoshu_conversation_title',
  description:'Name this conversation after its substantive topic, never a greeting or "new chat". Metadata only: combine with already-needed work calls. Do not start a separate naming turn or Core model request.',
  inputSchema:z.toJSONSchema(conversationTitleUpdateSchema)}];
}

export function parseNativeTitleTool(name:string,argumentsValue:unknown):EngineTitleUpdate{
 if(name!=='luoshu_conversation_title')throw Error('Unsupported native title tool');
 return conversationTitleUpdateSchema.parse(argumentsValue);
}
