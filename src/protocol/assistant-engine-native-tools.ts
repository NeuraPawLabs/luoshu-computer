import {z} from 'zod';
import {engineTaskOperationSchema} from './assistant-engine-tasks.js';
const descriptions={create:'Create explicitly tracked work and bind this Run. Do not create tasks merely for messages, research or tool use.',attach:'Bind this Run to an existing authorized task at its current revision.',revise:'Amend an existing task at the expected revision and bind this unbound Run.',report:'Report progress or delivery for the task bound to this Run. Delivered does not mean user acceptance.'};
export function nativeTaskTools(){return engineTaskOperationSchema.options.map(schema=>{
 const {action,...fields}=schema.shape;
 return{type:'function' as const,name:'luoshu_task_'+action.value,description:descriptions[action.value],inputSchema:z.toJSONSchema(z.object(fields).strict())};
});}
export function parseNativeTaskTool(name:string,argumentsValue:unknown){
 const schema=engineTaskOperationSchema.options.find(schema=>'luoshu_task_'+schema.shape.action.value===name);
 if(!schema)throw Error('Unsupported native task tool');
 const {action,...fields}=schema.shape;
 return engineTaskOperationSchema.parse({...z.object(fields).strict().parse(argumentsValue),action:action.value});
}
