/** Verified Responses effort values. `auto` is a summary setting, not an effort. */
export const reasoningEffortValues=['none','minimal','low','medium','high','xhigh','max'] as const;
export type ReasoningEffort=typeof reasoningEffortValues[number];

/** Official model pages verified 2026-10-01; no prefix guessing for gateway aliases. */
const officialReasoningEfforts:Record<string,readonly ReasoningEffort[]>={
 'gpt-6-astra':['low','medium','high','xhigh','max'],
 'gpt-6-luna':['none','low','medium','high','xhigh','max'],
 'gpt-6-sol':['none','low','medium','high','xhigh','max'],
 'gpt-6.1-sol':['low','medium','high','xhigh','max'],
 'gpt-5.4':['none','low','medium','high','xhigh'],
 'gpt-5.4-2026-03-05':['none','low','medium','high','xhigh'],
 'gpt-5.2':['none','low','medium','high','xhigh'],
 'gpt-5.2-2025-12-11':['none','low','medium','high','xhigh'],
 'gpt-5':['minimal','low','medium','high'],
 'gpt-5-2025-08-07':['minimal','low','medium','high'],
};
export function configuredReasoningEfforts(provider:string,model:string,override?:readonly ReasoningEffort[]|null):ReasoningEffort[]{
 if(provider!=='openai')return [];
 if(override!=null)return reasoningEffortValues.filter(value=>override.includes(value));
 return Object.hasOwn(officialReasoningEfforts,model)?[...officialReasoningEfforts[model]]:[];
}
export function defaultReasoningEffort(supported:readonly ReasoningEffort[]):ReasoningEffort|null{
 return supported.includes('medium')?'medium':supported[0]??null;
}
