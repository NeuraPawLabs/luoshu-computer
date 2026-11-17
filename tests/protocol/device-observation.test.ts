import { expect, test } from 'vitest';
import vectors from './fixtures/device-observation.json' with { type: 'json' };
import { deviceObservationSchema, developmentPolicySchema, deviceServiceReportSchema, PROTOCOL_VERSION } from '../../src/protocol/index.js';

test('v9 observation rejects control fields and obsolete support flags', () => {
  const observation = vectors[0];
  expect(PROTOCOL_VERSION).toBe(9);
  expect(deviceObservationSchema.safeParse(observation).success).toBe(true);
  for (const extra of [{development:true},{approved_agents:['codex']},{name:'rewrite'}, {tools:{'luoshu.worker_config':'1'}}]) {
    expect(deviceObservationSchema.safeParse({...observation,...extra}).success).toBe(false);
  }
  expect(deviceObservationSchema.safeParse({...observation,protocol_version:8}).success).toBe(false);
  expect(developmentPolicySchema.safeParse({mode:'custom',roots:[]}).success).toBe(false);
});

test('the shared vectors have identical strict parsing semantics', () => {
  expect(vectors.map(value => deviceObservationSchema.safeParse(value).success)).toEqual([true,true,false,false,false]);
});

test('observations reject duplicate ids/features and enforce availability reasons', () => {
  const base = vectors[1] as any;
  expect(deviceObservationSchema.safeParse({...base,agents:[{id:'codex',version:null,detected:true},{id:'codex',version:'1',detected:true}]}).success).toBe(false);
  expect(deviceObservationSchema.safeParse({...base,services:[{...base.services[0],features:['list','list']}]}).success).toBe(false);
  expect(deviceObservationSchema.safeParse({...base,services:[{...base.services[0],status:'ready',reason:'bad'}]}).success).toBe(false);
  expect(deviceObservationSchema.safeParse({...base,services:[{...base.services[0],status:'unavailable',reason:null}]}).success).toBe(false);
});

test('unknown services carry only bounded diagnostics', () => {
  const value = {...vectors[0], services:[{id:'x',type:'future_service',version:'1',agent_id:null,status:'unavailable',reason:'unsupported',features:[],diagnostic:{message:'Install future service',resolver_hint:'UNSUPPORTED_SERVICE'}}]};
  expect(deviceObservationSchema.safeParse(value).success).toBe(true);
  expect(deviceObservationSchema.safeParse({...value,services:[{...value.services[0],diagnostic:{message:'x',extra:'no'}}]}).success).toBe(false);
});
