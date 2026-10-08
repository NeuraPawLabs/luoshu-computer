import {expect,test,vi} from 'vitest';
import {CodexInteractions} from '../src/agent-engines/codex-interactions.js';
import {engineEventPayloadSchema} from '@luoshu/protocol';
const approval=(id:number|string=1)=>({id,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'cmd',command:'npm test',availableDecisions:['accept','decline','cancel']}});
test('native approval waits for a matching explicit allow-once response',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));let done=false;
 const pending=bridge.handle(approval()).then(result=>{done=true;return result;});await Promise.resolve();expect(done).toBe(false);
 expect(events[0]).toMatchObject({kind:'waiting_approval',summary:'npm test',decisions:['allow_once','deny','cancel']});
 bridge.respond(events[0].request_id,{kind:'approval',decision:'allow_once'});
 await expect(pending).resolves.toEqual({decision:'accept'});
 expect(()=>bridge.respond(events[0].request_id,{kind:'approval',decision:'allow_once'})).toThrow();
});
test('concurrent requests with string and numeric ids never answer one another',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 const one=bridge.handle(approval(42)),two=bridge.handle(approval('42'));
 expect(events[0].request_id).not.toBe(events[1].request_id);
 bridge.respond(events[1].request_id,{kind:'approval',decision:'deny'});await expect(two).resolves.toEqual({decision:'decline'});
 bridge.respond(events[0].request_id,{kind:'approval',decision:'cancel'});await expect(one).resolves.toEqual({decision:'cancel'});
});
test('foreign requests, unsupported methods and session-wide grants fail closed',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 await expect(bridge.handle({...approval(),params:{...approval().params,turnId:'foreign'}})).rejects.toThrow();
 await expect(bridge.handle({...approval(),method:'account/chatgptAuthTokens/refresh'})).rejects.toThrow();
 const pending=bridge.handle(approval());expect(()=>bridge.respond(events[0].request_id,{kind:'approval',decision:'acceptForSession'})).toThrow();
 bridge.respond(events[0].request_id,{kind:'approval',decision:'deny'});await pending;
});
test('revocation and native resolution invalidate pending approval replies',async()=>{
 const events:any[]=[];let authorized=true;const bridge=new CodexInteractions('thread','turn',e=>events.push(e),()=>authorized);
 const pending=bridge.handle(approval());authorized=false;
 expect(()=>bridge.respond(events[0].request_id,{kind:'approval',decision:'allow_once'})).toThrow(/authorized|revoked/);
 bridge.close();await expect(pending).rejects.toThrow();
 authorized=true;const second=new CodexInteractions('thread','turn',e=>events.push(e));const stale=second.handle(approval('input'));
 second.resolved('input');await expect(stale).rejects.toThrow(/resolved/);expect(()=>second.respond(events.at(-2).request_id,{kind:'approval',decision:'allow_once'})).toThrow();
});
test('user input questions and answers map exact native question ids without guessed defaults',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 const pending=bridge.handle({id:3,method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'q',isBlocking:true,questions:[{id:'choice',header:'Choice',question:'Which?',options:[{label:'A',description:'Option A'}]}]}});
 expect(events[0]).toMatchObject({kind:'waiting_input',questions:[{id:'choice',text:'Which?',options:['A']}]});
 expect(()=>bridge.respond(events[0].request_id,{kind:'input',answers:{foreign:['value']}})).toThrow();
 bridge.respond(events[0].request_id,{kind:'input',answers:{choice:['custom value']}});
 await expect(pending).resolves.toEqual({answers:{choice:{answers:['custom value']}}});
});
test.each([
 ['item/commandExecution/requestApproval',{additionalPermissions:{fileSystem:{read:['/outside']}}}],
 ['item/commandExecution/requestApproval',{additionalPermissions:{network:{enabled:true}}}],
 ['item/commandExecution/requestApproval',{networkApprovalContext:{host:'example.test',protocol:'https'}}],
 ['item/commandExecution/requestApproval',{environmentId:'remote'}],
 ['item/fileChange/requestApproval',{grantRoot:'/outside'}],
 ['item/commandExecution/requestApproval',{availableDecisions:'accept'}],
])('native approval cannot broaden frozen authority: %s %j',async(method,extra)=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 const pending=bridge.handle({...approval(),method:method as string,params:{...approval().params,...extra as object}}).catch(error=>error);
 try{await Promise.resolve();expect(events).toEqual([]);expect(await pending).toBeInstanceOf(Error);}
 finally{bridge.close();await pending;}
});

const userInput=(id:number|string,isBlocking:boolean)=>({id,method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'q',isBlocking,autoResolutionMs:1,questions:[{id:'exact-question',header:'选择',question:'继续？',isOther:true,options:[{label:'继续',description:'保留当前结果'}]}]}});
test.each([true,false])('native input preserves blocking=%s and has no invented timeout',async isBlocking=>{
 vi.useFakeTimers();const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 const pending=bridge.handle(userInput('original-id',isBlocking));void pending.catch(()=>{});
 try{
  expect(events[0]).toEqual({kind:'waiting_input',request_id:events[0].request_id,is_blocking:isBlocking,questions:[{id:'exact-question',text:'继续？',header:'选择',options:['继续'],option_descriptions:['保留当前结果'],is_other:true}],expires_at:null});
  expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(60000);expect(bridge.snapshot()).toHaveLength(1);
  bridge.respond(events[0].request_id,{kind:'input',answers:{'exact-question':['继续']}});
  await expect(pending).resolves.toEqual({answers:{'exact-question':{answers:['继续']}}});
  expect(events.filter(e=>e.kind==='interaction.resolved')).toEqual([]);expect(bridge.snapshot()).toEqual([]);
  bridge.resolved('original-id');expect(events.at(-1)).toEqual({kind:'interaction.resolved',request_id:events[0].request_id,resolution:'answered'});
  expect(bridge.outcomes()).toEqual([{request_id:events[0].request_id,resolution:'answered'}]);
 }finally{bridge.close();await pending.catch(()=>{});vi.useRealTimers();}
});

test('native input requires isBlocking rather than guessing a default',async()=>{
 const bridge=new CodexInteractions('thread','turn',()=>{}),params={...userInput(1,true).params} as Record<string,unknown>;delete params.isBlocking;
 const result=bridge.handle({...userInput(1,true),params});void result.catch(()=>{});
 try{await expect(result).rejects.toThrow();}finally{bridge.close();}
});

test('unanswered native cleanup emits dismissed and exact RPC id types remain distinct',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',e=>events.push(e));
 const one=bridge.handle(userInput(42,false)),two=bridge.handle(userInput('42',true));void one.catch(()=>{});void two.catch(()=>{});
 const oneId=events[0].request_id,twoId=events[1].request_id;
 bridge.resolved('42');await expect(two).rejects.toThrow(/resolved/);
 expect(events.at(-1)).toEqual({kind:'interaction.resolved',request_id:twoId,resolution:'dismissed'});
 expect(bridge.snapshot()).toMatchObject([{request_id:oneId}]);expect(bridge.outcomes()).toEqual([{request_id:twoId,resolution:'dismissed'}]);
 bridge.respond(oneId,{kind:'input',answers:{'exact-question':['yes']}});await one;bridge.resolved(42);
 expect(bridge.outcomes()).toEqual([{request_id:twoId,resolution:'dismissed'},{request_id:oneId,resolution:'answered'}]);
 bridge.resolved(42);expect(bridge.outcomes()).toHaveLength(2);
});

const messageQuestions={id:'message-questions',type:'agentMessage',phase:'commentary',text:'请选择。',questions:[{title:'目录',options:['src','tests']},{title:'备注',options:null}]};
test('native message questions create one stable nonblocking prompt and exact-turn steering confirms it',async()=>{
 const events:any[]=[],calls:any[]=[];let acknowledge!:(value:{turnId:string})=>void;
 const bridge=new CodexInteractions('thread','turn',e=>events.push(e),()=>true,params=>{calls.push(params);return new Promise(resolve=>acknowledge=resolve);});
 bridge.observeMessageQuestions(messageQuestions);bridge.observeMessageQuestions(structuredClone(messageQuestions));
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'waiting_input',is_blocking:false,expires_at:null,questions:[{id:'message-questions:0',text:'目录',options:['src','tests']},{id:'message-questions:1',text:'备注',options:[]}]});
 const id=events[0].request_id;
 expect(()=>bridge.respond(id,{kind:'input',answers:{foreign:['src']}})).toThrow(/IDs/);
 const responding=bridge.respond(id,{kind:'input',answers:{'message-questions:0':['tests'],'message-questions:1':['保留草稿']}});
 expect(calls).toMatchObject([{threadId:'thread',expectedTurnId:'turn',input:[{type:'text'}]}]);expect(calls[0].input[0].text).toContain('保留草稿');
 expect(bridge.snapshot()).toEqual([]);expect(bridge.outcomes()).toEqual([]);
 expect(()=>bridge.respond(id,{kind:'input',answers:{'message-questions:0':['src'],'message-questions:1':['conflict']}})).toThrow(/resolved|pending/);
 acknowledge({turnId:'turn'});await responding;
 expect(events.at(-1)).toEqual({kind:'interaction.resolved',request_id:id,resolution:'answered'});expect(bridge.outcomes()).toEqual([{request_id:id,resolution:'answered'}]);
 bridge.observeMessageQuestions(messageQuestions);expect(events.filter(e=>e.kind==='waiting_input')).toHaveLength(1);
});

test.each(['lost','different turn'])('ambiguous synthetic steering %s never emits answered or permits blind retry',async failure=>{
 const events:any[]=[],calls:any[]=[];
 const bridge=new CodexInteractions('thread','turn',e=>events.push(e),()=>true,async params=>{calls.push(params);if(failure==='lost')throw Object.assign(Error('lost native acknowledgement'),{code:'CODEX_RPC_UNKNOWN'});return{turnId:'foreign'};});
 bridge.observeMessageQuestions(messageQuestions);const id=events[0].request_id,response={kind:'input',answers:{'message-questions:0':['tests'],'message-questions:1':['draft']}};
 await expect(bridge.respond(id,response)).rejects.toThrow();expect(bridge.outcomes()).toEqual([]);expect(events.filter(e=>e.kind==='interaction.resolved')).toEqual([]);
 expect(()=>bridge.respond(id,response)).toThrow(/unknown|resolved|pending/);expect(calls).toHaveLength(1);bridge.close();
});

test('closed prompts cannot reappear and a late steering acknowledgement cannot claim acceptance',async()=>{
 const events:any[]=[];let acknowledge!:(value:{turnId:string})=>void;
 const bridge=new CodexInteractions('thread','turn',e=>events.push(e),()=>true,()=>new Promise(resolve=>acknowledge=resolve));
 bridge.observeMessageQuestions(messageQuestions);const id=events[0].request_id;
 const responding=bridge.respond(id,{kind:'input',answers:{'message-questions:0':['tests'],'message-questions:1':['draft']}});void Promise.resolve(responding).catch(()=>{});
 bridge.close();bridge.observeMessageQuestions({...messageQuestions,id:'later'});acknowledge({turnId:'turn'});
 await expect(responding).rejects.toThrow(/closed|authorized/);expect(bridge.snapshot()).toEqual([]);expect(bridge.outcomes()).toEqual([]);expect(events.filter(e=>e.kind==='waiting_input')).toHaveLength(1);
});

test('native request option labels remain exact controls while prompt prose and descriptions are redacted',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',event=>events.push(event));
 const pending=bridge.handle({id:'native-label',method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'choice',isBlocking:true,questions:[{id:'exact-choice',question:'Choose token=surface',header:'token=header',options:[{label:'token=surface',description:'Description token=surface'},{label:'secret=public-mode',description:'Another choice'}]}]}});void pending.catch(()=>{});
 try{
  const prompt=events[0];expect(prompt.questions[0]).toEqual({id:'exact-choice',text:'Choose token=[REDACTED]',header:'token=[REDACTED]',options:['token=surface','secret=public-mode'],option_descriptions:['Description token=[REDACTED]','Another choice']});
  bridge.respond(prompt.request_id,{kind:'input',answers:{'exact-choice':[prompt.questions[0].options[0]]}});
  await expect(pending).resolves.toEqual({answers:{'exact-choice':{answers:['token=surface']}}});
 }finally{bridge.close();await pending.catch(()=>{});}
});

test('synthetic message question options and selected steering labels stay verbatim',async()=>{
 const events:any[]=[],calls:any[]=[],bridge=new CodexInteractions('thread','turn',event=>events.push(event),()=>true,async params=>{calls.push(params);return{turnId:'turn'};});
 bridge.observeMessageQuestions({id:'message-label',type:'agentMessage',questions:[{title:'Choose token=surface',options:['token=surface','secret=public-mode']}]});
 try{
  const prompt=events[0];expect(prompt.questions[0]).toEqual({id:'message-label:0',text:'Choose token=[REDACTED]',options:['token=surface','secret=public-mode']});
  await bridge.respond(prompt.request_id,{kind:'input',answers:{'message-label:0':[prompt.questions[0].options[0]]}});
  expect(JSON.parse(calls[0].input[0].text)).toEqual({assistant_question_answers:[{id:'message-label:0',question:'Choose token=[REDACTED]',answers:['token=surface']}]});
 }finally{bridge.close();}
});

test('native secret questions remain unsupported despite preserving public option labels',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',event=>events.push(event));
 await expect(bridge.handle({id:1,method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'secret',isBlocking:true,questions:[{id:'secret-q',question:'Provide secret',isSecret:true,options:[{label:'token=surface'}]}]}})).rejects.toThrow(/Unsupported/);
 expect(events).toEqual([]);bridge.close();
});

test('synthetic questions from a valid 200-character item ID use bounded stable public IDs',async()=>{
 const events:any[]=[],calls:any[]=[],bridge=new CodexInteractions('thread','turn',event=>events.push(event),()=>true,async params=>{calls.push(params);return{turnId:'turn'};});
 const item={id:'i'.repeat(200),type:'agentMessage',questions:[{title:'First',options:['A']},{title:'Second',options:null}]};
 bridge.observeMessageQuestions(item);bridge.observeMessageQuestions(structuredClone(item));
 try{
  expect(events).toHaveLength(1);const prompt=events[0];expect(engineEventPayloadSchema.safeParse(prompt).success).toBe(true);
  expect(prompt.questions.every((question:any)=>question.id.length<=200)).toBe(true);expect(new Set(prompt.questions.map((question:any)=>question.id)).size).toBe(2);
  await bridge.respond(prompt.request_id,{kind:'input',answers:Object.fromEntries(prompt.questions.map((question:any)=>[question.id,['A']]))});
  expect(JSON.parse(calls[0].input[0].text).assistant_question_answers.map((question:any)=>question.id)).toEqual(prompt.questions.map((question:any)=>question.id));
 }finally{bridge.close();}
});

test('a native __proto__ question gets a safe public alias and replies with the exact original own property',async()=>{
 const events:any[]=[],bridge=new CodexInteractions('thread','turn',event=>events.push(event));
 const pending=bridge.handle({id:'native-proto',method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',itemId:'question',isBlocking:true,questions:[{id:'__proto__',question:'Choose a value',options:[{label:'selected'}]},{id:'normal-question',question:'Provide a comment',options:null}]}});void pending.catch(()=>{});
 try{
  const prompt=events[0],alias=prompt.questions[0].id;
  expect(alias).toMatch(/^question:[a-f0-9]{64}$/u);expect(alias.length).toBeLessThanOrEqual(200);
  expect(prompt.questions[1].id).toBe('normal-question');expect(bridge.snapshot()[0]).toEqual(prompt);
  expect(()=>bridge.respond(prompt.request_id,{kind:'input',answers:Object.fromEntries([['__proto__',['selected']],['normal-question',['comment']]])})).toThrow(/IDs/);
  bridge.respond(prompt.request_id,{kind:'input',answers:Object.fromEntries([[alias,['selected']],['normal-question',['comment']]])});
  const result=await pending as {answers:Record<string,{answers:string[]}>};
  expect(Object.hasOwn(result.answers,'__proto__')).toBe(true);expect(result.answers['__proto__']).toEqual({answers:['selected']});
  expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);expect(result.answers['normal-question']).toEqual({answers:['comment']});
  expect(Object.hasOwn(result.answers,alias)).toBe(false);
  expect(JSON.parse(JSON.stringify(result)).answers['__proto__']).toEqual({answers:['selected']});
 }finally{bridge.close();await pending.catch(()=>{});}
});
