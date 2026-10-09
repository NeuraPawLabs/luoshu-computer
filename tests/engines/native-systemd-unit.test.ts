import {expect,test} from 'vitest';
import {NativeSystemdUnit} from '../../src/engines/native-systemd-unit.js';

const unit='luoshu-codex-test-authority',token='11111111-1111-4111-8111-111111111111';
const cgroup='/user.slice/user-1000.slice/user@1000.service/app.slice/'+unit+'.service';
const invocation='a'.repeat(32);
const snapshot=(patch:Record<string,string>={})=>Object.entries({Id:unit+'.service',Description:'Luoshu native '+token,LoadState:'loaded',ActiveState:'active',SubState:'running',Job:'',InvocationID:invocation,ControlGroup:cgroup,...patch}).map(([k,v])=>k+'='+v).join('\n');
function fixture(){let output=snapshot(),events='populated 1\nfrozen 0\n',fail=false;const stops:string[]=[],paths:string[]=[];
 const owner=new NativeSystemdUnit({unitName:unit,ownerToken:token},{show:async()=>{if(fail)throw Error('manager unavailable');return output;},stop:async name=>{stops.push(name);},events:async path=>{paths.push(path);return events;}});
 return{owner,stops,paths,set:(s:string,e=events)=>{output=s;events=e;},fail:()=>fail=true};
}
test('only observed exact invocation plus terminal unit and empty recursive cgroup prove exit',async()=>{
 const f=fixture();expect(await f.owner.inspect()).toMatchObject({state:'active',runtime:{invocation,cgroup}});
 f.set(snapshot({ActiveState:'inactive',SubState:'dead'}));expect((await f.owner.inspect()).state).toBe('active');
 f.set(snapshot({ActiveState:'inactive',SubState:'dead'}),'populated 0\nfrozen 0\n');expect((await f.owner.inspect()).state).toBe('stopped');
 expect(f.paths.every(p=>p==='/sys/fs/cgroup'+cgroup+'/cgroup.events')).toBe(true);
});
test('a missing unit before launch observation cannot prove no late creation',async()=>{
 const f=fixture();f.set(snapshot({LoadState:'not-found',ActiveState:'inactive',SubState:'dead',Description:unit+'.service',InvocationID:'',ControlGroup:''}));
 expect((await f.owner.inspect()).state).toBe('missing');expect(f.paths).toEqual([]);
});
test('manager failure remains an error and never triggers an unverified stop',async()=>{
 const f=fixture();await f.owner.inspect();f.fail();await expect(f.owner.inspect()).rejects.toThrow('manager unavailable');await expect(f.owner.stop()).rejects.toThrow('manager unavailable');expect(f.stops).toEqual([]);
});
test.each([{Description:'foreign'},{Id:'foreign.service'},{InvocationID:'b'.repeat(32)},{ControlGroup:'/'},{ControlGroup:'/user.slice/../'+unit+'.service'},{ControlGroup:'/user.slice/foreign.service'}])('changed ownership is refused before stop: %j',async patch=>{
 const f=fixture();await f.owner.inspect();f.set(snapshot(patch));await expect(f.owner.stop()).rejects.toThrow(/identity|ownership|cgroup/);expect(f.stops).toEqual([]);
});
test('stopping targets only the observed unit and a queued job is not termination',async()=>{
 const f=fixture();await f.owner.stop();expect(f.stops).toEqual([unit+'.service']);
 f.set(snapshot({ActiveState:'inactive',SubState:'dead',Job:'55'}),'populated 0\nfrozen 0\n');expect((await f.owner.inspect()).state).toBe('active');
});
test('observed unit disappearance requires empty saved recursive cgroup, not merely absent systemd metadata',async()=>{
 const f=fixture();await f.owner.inspect();f.set(snapshot({LoadState:'not-found',ActiveState:'inactive',SubState:'dead',Description:unit+'.service',InvocationID:'',ControlGroup:''}));
 expect((await f.owner.inspect()).state).toBe('active');f.set(snapshot({LoadState:'not-found',ActiveState:'inactive',SubState:'dead',Description:unit+'.service',InvocationID:'',ControlGroup:''}),'populated 0\n');expect((await f.owner.inspect()).state).toBe('stopped');
});
test.each(['','frozen 0\n','populated 0\npopulated 1\n','populated unknown\n'])('malformed cgroup state cannot release an observed unit: %j',async events=>{
 const f=fixture();await f.owner.inspect();f.set(snapshot({ActiveState:'inactive',SubState:'dead'}),events);await expect(f.owner.inspect()).rejects.toThrow(/state is unknown/);
});
test('stop failure is not suppressed as successful shutdown',async()=>{
 const owner=new NativeSystemdUnit({unitName:unit,ownerToken:token},{show:async()=>snapshot(),stop:async()=>{throw Error('stop unavailable');},events:async()=>'populated 1\n'});
 await expect(owner.stop()).rejects.toThrow('stop unavailable');expect((await owner.inspect()).state).toBe('active');
});
test('missing kernel cgroup only releases a terminal observed invocation',async()=>{
 let output=snapshot();const owner=new NativeSystemdUnit({unitName:unit,ownerToken:token},{show:async()=>output,stop:async()=>{},events:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}});
 expect((await owner.inspect()).state).toBe('active');output=snapshot({ActiveState:'inactive',SubState:'dead',ControlGroup:''});expect((await owner.inspect()).state).toBe('stopped');
});
