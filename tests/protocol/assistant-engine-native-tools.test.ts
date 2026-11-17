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
