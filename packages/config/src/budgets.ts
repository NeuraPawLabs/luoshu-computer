/** null disables a functional budget; it is never a zero-duration timeout. */
export interface ExecutionBudgets {
 task_timeout_ms:number|null;
 model_timeout_ms:number|null;
 chat_timeout_ms:number|null;
 remote_timeout_ms:number|null;
 worker_timeout_seconds:number|null;
 max_decisions:number|null;
 max_calls:number|null;
 max_child_decisions:number|null;
 context_bytes:number|null;
}
export const DEFAULT_EXECUTION_BUDGETS:Readonly<ExecutionBudgets>=Object.freeze({
 task_timeout_ms:null,model_timeout_ms:null,chat_timeout_ms:null,
 remote_timeout_ms:null,worker_timeout_seconds:null,max_decisions:null,max_calls:null,max_child_decisions:null,context_bytes:null,
});
export function resolveExecutionBudgets(overrides:Partial<ExecutionBudgets>={}):Readonly<ExecutionBudgets>{
 for(const [key,value] of Object.entries(overrides)){
  if(!Object.hasOwn(DEFAULT_EXECUTION_BUDGETS,key)||value!==null&&(!Number.isSafeInteger(value)||value<=0))throw new Error(`Invalid execution budget: ${key}`);
  if(key==='worker_timeout_seconds'&&value!==null&&value>7200)throw new Error('Invalid execution budget: worker_timeout_seconds (maximum finite value is 7200)');
 }
 return Object.freeze({...DEFAULT_EXECUTION_BUDGETS,...overrides});
}
export const budgetReached=(value:number,limit:number|null):boolean=>limit!==null&&value>=limit;
export const budgetDeadline=(now:number,duration:number|null):number|null=>duration===null?null:now+duration;

/** Chunk large delays instead of overflowing Node's 32-bit setTimeout interval. */
export function scheduleDeadline(deadline:number|null,expire:()=>void,now:()=>number=Date.now):()=>void{
 let timer:ReturnType<typeof setTimeout>|undefined;
 let disposed=false;
 const schedule=()=>{if(disposed||deadline===null)return;const remaining=deadline-now();if(remaining<=0){expire();return;}timer=setTimeout(schedule,Math.min(remaining,2_147_483_647));timer.unref?.();};
 schedule();
 return()=>{disposed=true;if(timer!==undefined)clearTimeout(timer);};
}
export function budgetSignal(parent:AbortSignal,timeoutMs:number|null):{signal:AbortSignal;dispose:()=>void}{
 if(timeoutMs===null)return{signal:parent,dispose:()=>{}};
 const timerController=new AbortController();
 const clear=scheduleDeadline(budgetDeadline(Date.now(),timeoutMs),()=>timerController.abort(new DOMException('Execution budget expired','TimeoutError')));
 const dispose=()=>{clear();parent.removeEventListener('abort',dispose);};
 parent.addEventListener('abort',dispose,{once:true});if(parent.aborted)dispose();
 return{signal:AbortSignal.any([parent,timerController.signal]),dispose};
}
