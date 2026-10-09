import {expect,test} from 'vitest';
import {CodexTurnProjection} from '../../src/engines/codex-events.js';
const source={threadId:'thread',turnId:'turn'};
test('commentary stays progress while final item authoritatively replaces streamed text',()=>{
 const p=new CodexTurnProjection('thread','turn');
 expect(p.consume('item/started',{...source,item:{id:'plan',type:'agentMessage',phase:'commentary',text:''}})).toEqual([]);
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'plan',delta:'Checking sources'})).toEqual([{kind:'progress.delta',item_id:'plan',text:'Checking sources'}]);
 p.consume('item/started',{...source,item:{id:'final',type:'agentMessage',phase:'final_answer',text:''}});
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'final',delta:'Draft'})).toEqual([{kind:'reply.delta',item_id:'final',text:'Draft'}]);
 expect(p.consume('item/completed',{...source,item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Authoritative answer'}})).toEqual([{kind:'reply.final',item_id:'final',text:'Authoritative answer',citations:[],artifact_ids:[]}]);
});
test('failed command followed by successful recovery does not fail the turn',()=>{
 const p=new CodexTurnProjection('thread','turn');
 expect(p.consume('item/started',{...source,item:{id:'cmd',type:'commandExecution',command:'python -V',status:'inProgress'}})).toEqual([{kind:'tool.started',item_id:'cmd',name:'commandExecution',command:'python -V'}]);
 expect(p.consume('item/commandExecution/outputDelta',{...source,itemId:'cmd',delta:'not found'})).toEqual([{kind:'tool.output',item_id:'cmd',text:'not found'}]);
 expect(p.consume('item/completed',{...source,item:{id:'cmd',type:'commandExecution',status:'failed',exitCode:127,aggregatedOutput:'not found'}})).toEqual([{kind:'tool.finished',item_id:'cmd',status:'failed',exit_code:127}]);
 expect(p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'answer',phase:'final_answer',text:'Recovered with python3'}]}})).toMatchObject([{kind:'reply.final',text:'Recovered with python3'},{kind:'turn.status',state:'completed'}]);
});
test('wrong thread, turn, unknown item, and late events cannot mutate a projection',()=>{
 const p=new CodexTurnProjection('thread','turn');
 for(const src of [{threadId:'foreign',turnId:'turn'},{threadId:'thread',turnId:'foreign'}])expect(p.consume('item/completed',{...src,item:{type:'agentMessage',id:'x',phase:'final_answer',text:'leak'}})).toEqual([]);
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'unknown',delta:'incomplete'})).toEqual([]);
 p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'interrupted',items:[]}});
 expect(p.consume('item/completed',{...source,item:{type:'agentMessage',id:'x',phase:'final_answer',text:'late'}})).toEqual([]);
 expect(p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}})).toEqual([]);
});
test('raw reasoning content is never projected, only public summaries',()=>{
 const p=new CodexTurnProjection('thread','turn');
 expect(p.consume('item/reasoning/textDelta',{...source,itemId:'reason',delta:'PRIVATE REASONING'})).toEqual([]);
 expect(p.consume('item/reasoning/summaryTextDelta',{...source,itemId:'reason',summaryIndex:0,delta:'more public'})).toEqual([{kind:'reasoning.summary',item_id:'reason',mode:'append',text:'more public'}]);
 expect(p.consume('item/completed',{...source,item:{type:'reasoning',id:'reason',content:['PRIVATE REASONING'],summary:['Public summary']}})).toEqual([{kind:'reasoning.summary',item_id:'reason',mode:'replace',text:'Public summary'}]);
});
test('unphased text waits for turn completion; final reply has no output truncation',()=>{
 const p=new CodexTurnProjection('thread','turn'),text='完整'.repeat(100_000);
 expect(p.consume('item/completed',{...source,item:{type:'agentMessage',id:'candidate',phase:null,text}})).toEqual([]);
 const events=p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'candidate',phase:null,text}]}});
 expect(events).toHaveLength(2);expect(events[0]).toMatchObject({kind:'reply.final'});expect((events[0] as {text:string}).text.length).toBe(text.length);
});
test('repeated identical native items do not duplicate visible final output',()=>{
 const p=new CodexTurnProjection('thread','turn'),item={id:'answer',type:'agentMessage',phase:'final_answer',text:'Answer'};
 expect(p.consume('item/completed',{...source,item})).toHaveLength(1);expect(p.consume('item/completed',{...source,item})).toEqual([]);
 expect(p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{...item,text:'Corrected'}]}})).toMatchObject([{kind:'reply.final',text:'Corrected'},{kind:'turn.status',state:'completed'}]);
});

test('Chinese commentary deltas are identified and completion replaces them only once',()=>{
 const p=new CodexTurnProjection('thread','turn'),item={id:'plan',type:'agentMessage',phase:'commentary',text:'正在检查来源。'};
 p.consume('item/started',{...source,item:{...item,text:''}});
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'plan',delta:'正在'})).toEqual([{kind:'progress.delta',item_id:'plan',text:'正在'}]);
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'plan',delta:'检查来源'})).toEqual([{kind:'progress.delta',item_id:'plan',text:'检查来源'}]);
 expect(p.consume('item/completed',{...source,item})).toEqual([{kind:'progress.final',item_id:'plan',text:item.text}]);
 expect(p.consume('item/completed',{...source,item})).toEqual([]);
 expect(p.consume('item/agentMessage/delta',{...source,itemId:'plan',delta:'late'})).toEqual([]);
 expect(p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[item]}})).toEqual([{kind:'turn.status',state:'completed',reason:null}]);
});

test('full public summary replaces deltas and repeated terminal snapshots do not duplicate it',()=>{
 const p=new CodexTurnProjection('thread','turn'),item={id:'reason',type:'reasoning',summary:['完整公开摘要'],content:['PRIVATE']};
 p.consume('item/started',{...source,item});
 expect(JSON.stringify([...((p as any).items?.values()??[])])).not.toContain('PRIVATE');
 expect(p.consume('item/reasoning/summaryTextDelta',{...source,itemId:'reason',delta:'草稿'})).toEqual([{kind:'reasoning.summary',item_id:'reason',mode:'append',text:'草稿'}]);
 expect(p.consume('item/completed',{...source,item})).toEqual([{kind:'reasoning.summary',item_id:'reason',mode:'replace',text:'完整公开摘要'}]);
 expect(p.consume('item/completed',{...source,item})).toEqual([]);
 expect(p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[item]}})).toEqual([{kind:'turn.status',state:'completed',reason:null}]);
});

test('explicit native final answers take precedence over trailing unphased messages',()=>{
 const p=new CodexTurnProjection('thread','turn');
 const events=p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'Answer'},{id:'unphased',type:'agentMessage',phase:null,text:'Draft'}]}});
 expect(events).toEqual([{kind:'reply.final',item_id:'final',text:'Answer',citations:[],artifact_ids:[]},{kind:'turn.status',state:'completed',reason:null}]);
});

test('terminal snapshot order determines the last unphased answer after repeated live candidates',()=>{
 const p=new CodexTurnProjection('thread','turn'),first={id:'first',type:'agentMessage',phase:null,text:'First'},last={id:'last',type:'agentMessage',phase:null,text:'Last'};
 for(const item of [first,last])expect(p.consume('item/completed',{...source,item})).toEqual([]);
 const events=p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[last,first]}});
 expect(events).toEqual([{kind:'reply.final',item_id:'first',text:'First',citations:[],artifact_ids:[]},{kind:'turn.status',state:'completed',reason:null}]);
 expect(p.finalReply()).toMatchObject({item_id:'first',text:'First'});
});

test.each(['final_answer',null])('a duplicate earlier live %s item cannot replace the latest answer at terminal completion',phase=>{
 const p=new CodexTurnProjection('thread','turn'),first={id:'first',type:'agentMessage',phase,text:'First'},last={id:'last',type:'agentMessage',phase,text:'Last'};
 for(const item of [first,last,first])p.consume('item/completed',{...source,item});
 p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[]}});
 expect(p.finalReply()).toMatchObject({item_id:'last',text:'Last'});
});

test('a malformed nullable-phase item cannot hide the last valid native answer',()=>{
 const p=new CodexTurnProjection('thread','turn');
 const events=p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{id:'valid',type:'agentMessage',phase:null,text:'Valid nullable answer'},{id:'malformed',type:'agentMessage',phase:null,text:null}]}});
 expect(events).toEqual([{kind:'reply.final',item_id:'valid',text:'Valid nullable answer',citations:[],artifact_ids:[]},{kind:'turn.status',state:'completed',reason:null}]);
});

test('a native message with missing phase is not a nullable-phase final candidate',()=>{
 const p=new CodexTurnProjection('thread','turn');
 const events=p.consume('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed',items:[{id:'valid',type:'agentMessage',phase:null,text:'Valid nullable answer'},{id:'missing-phase',type:'agentMessage',text:'Malformed trailing answer'}]}});
 expect(events).toEqual([{kind:'reply.final',item_id:'valid',text:'Valid nullable answer',citations:[],artifact_ids:[]},{kind:'turn.status',state:'completed',reason:null}]);
});
