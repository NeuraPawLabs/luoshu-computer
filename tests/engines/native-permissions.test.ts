import {expect,test} from 'vitest';
import {nativePermissions,assertReturnedProfile} from '../../src/engines/native-permissions.js';

const scope={session:'session',cwd:'/state/session',runtime:'/opt/codex',read:['/state/references/lib'],write:['/state/targets/app']};
test('native profile grants exact host roots without broad home or filesystem grants',()=>{
 const policy=nativePermissions(scope);
 expect(policy.id).toMatch(/^luoshu_[a-f0-9]{64}$/);
 expect(policy.config).toEqual({filesystem:{':minimal':'read','/opt/codex':'read','/state/session':'write','/state/references/lib':'read','/state/targets/app':'write'},network:{enabled:false}});
 expect(nativePermissions({...scope,read:['/b','/a']})).toEqual(nativePermissions({...scope,read:['/a','/b']}));
 expect(nativePermissions({...scope,session:'other'}).id).not.toBe(policy.id);
});
test('danger-full-access grants root filesystem and network access',()=>{
 const policy=nativePermissions({...scope,mode:'danger-full-access'});
 expect(policy.config).toEqual({filesystem:{':root':'write'},network:{enabled:true}});
 expect(policy.runtimeWorkspaceRoots).toEqual([scope.cwd]);
});
test.each([
 {cwd:'/'},{cwd:'/state/../state/session'},{cwd:'relative'},{cwd:'/state\n/session'},
 {read:['/']},{write:['/']},{read:['/state/session/secret']},{read:['/state/session']},
 {write:['/state'],read:['/state/reference']},{write:['/opt']},{runtime:'/opt/codex\u0000'},
])('invalid or overlapping native permission roots fail closed: %j',change=>{
 expect(()=>nativePermissions({...scope,...change})).toThrow(/path|root|runtime|scope/i);
});
test('returned native profile identity and scope must match exactly',()=>{
 const policy=nativePermissions(scope),response={activePermissionProfile:{id:policy.id,extends:null},runtimeWorkspaceRoots:[scope.cwd]};
 expect(()=>assertReturnedProfile(response,policy)).not.toThrow();
 for(const r of [{...response,activePermissionProfile:null},{...response,activePermissionProfile:{id:policy.id,extends:':workspace'}},{...response,runtimeWorkspaceRoots:[scope.cwd,'/home/alice']},{...response,activePermissionProfile:{id:'different'}},{...response,runtimeWorkspaceRoots:[]}])expect(()=>assertReturnedProfile(r,policy)).toThrow(/profile|root/i);
});
test('Run roots change without changing the exact relative Codebase permission profile',()=>{
 const first=nativePermissions({...scope,resourceRoot:'/state/run-a',read:['/state/run-a/references/lib/docs'],write:['/state/run-a/targets/app/src']});
 const second=nativePermissions({...scope,resourceRoot:'/state/run-b',read:['/state/run-b/references/lib/docs'],write:['/state/run-b/targets/app/src']});
 expect(first.id).toBe(second.id);expect(first.runtimeWorkspaceRoots).toEqual(['/state/run-a']);expect(second.runtimeWorkspaceRoots).toEqual(['/state/run-b']);
 expect(first.config.filesystem[':workspace_roots']).toEqual({'references/lib/docs':'read','targets/app/src':'write'});
 expect(first.config.filesystem).not.toHaveProperty('/state/run-a');
 expect(()=>assertReturnedProfile({activePermissionProfile:{id:first.id,extends:null},runtimeWorkspaceRoots:['/state/run-b']},first)).toThrow(/roots/);
 expect(()=>nativePermissions({...scope,resourceRoot:'/state/run-a',read:['/state/outside'],write:[]})).toThrow(/root|scope/);
});
