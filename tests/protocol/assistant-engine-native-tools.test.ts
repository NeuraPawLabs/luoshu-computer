import {expect,test} from 'vitest';
import {nativeTaskTools,parseNativeTaskTool} from '../../src/protocol/assistant-engine-native-tools.js';
test('Codex task tools use function specs and accept metadata only',()=>{
 expect(nativeTaskTools().map(t=>t.name)).toEqual(['luoshu_task_create','luoshu_task_attach','luoshu_task_revise','luoshu_task_report']);
 for(const tool of nativeTaskTools()){expect(tool.type).toBe('function');expect(tool.inputSchema).toMatchObject({type:'object',additionalProperties:false});}
 expect(parseNativeTaskTool('luoshu_task_create',{title:'Research',goal:'Check official disclosures'})).toEqual({action:'create',title:'Research',goal:'Check official disclosures'});
 expect(()=>parseNativeTaskTool('shell',{command:'id'})).toThrow();
 expect(()=>parseNativeTaskTool('luoshu_task_create',{title:'Research',goal:'Check',actor_id:'other'})).toThrow();
 expect(()=>parseNativeTaskTool('luoshu_task_create',{title:'Research',goal:'Check',action:'report'})).toThrow();
});

test('native task creation advertises and preserves the classified work and its acceptance evidence',()=>{
 const input={title:'审查权限',goal:'检查越权边界',task_kind:'review',acceptance_criteria:[{statement:'越权测试通过',verification_kind:'check'}]};
 expect(nativeTaskTools().find(tool=>tool.name==='luoshu_task_create')?.inputSchema).toMatchObject({properties:{task_kind:{enum:expect.arrayContaining(['review'])},acceptance_criteria:{type:'array',maxItems:64}}});
 expect(parseNativeTaskTool('luoshu_task_create',input)).toEqual({action:'create',...input});
 for(const patch of [{task_kind:'unknown'},{acceptance_criteria:[{statement:' ',verification_kind:'check'}]},{acceptance_criteria:[{statement:'完成',verification_kind:'trusted'}]}]){
  expect(()=>parseNativeTaskTool('luoshu_task_create',{...input,...patch})).toThrow();
 }
});
