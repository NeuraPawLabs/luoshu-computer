import { expect, test } from 'vitest';
import vectors from './fixtures/device-observation.json' with { type: 'json' };
import { deviceObservationSchema, developmentPolicySchema, deviceConfigurationResponseSchema, PROTOCOL_VERSION } from '../../src/protocol/index.js';

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
  expect(deviceObservationSchema.safeParse({...value,services:[{...value.services[0],status:'ready',reason:null}]}).success).toBe(false);
  expect(deviceObservationSchema.safeParse({...value,services:[{...value.services[0],reason:''}]}).success).toBe(false);
  expect(deviceObservationSchema.safeParse({...value,services:[{...value.services[0],diagnostic:{message:'x',extra:'no'}}]}).success).toBe(false);
});

test('configuration responses bind outer status and revision to the actual state', () => {
  const config = {name:'fixture',capacity:2,agent_paths:{codex:'/opt/codex'},development_policy:{mode:'home',roots:[] as []},maintenance_roots:[],codex_sandbox:'workspace-write' as const};
  const base = {type:'device_configuration_response' as const,request_id:'r1',device_id:'d1',connection_generation:1,requested_revision:'desired-1'};
  const applied = {desired_revision:'desired-1',applied_revision:'desired-1',desired:config,applied:config,status:'applied' as const,error:null};
  expect(deviceConfigurationResponseSchema.safeParse({...base,status:'applied',state:applied}).success).toBe(true);
  for (const change of [
    {status:'failed',state:applied},
    {status:'applied',requested_revision:'other',state:applied},
    {status:'applied',state:{...applied,applied:null,applied_revision:null}},
    {status:'applied',state:{...applied,applied_revision:'other'}},
    {status:'applied',state:{...applied,applied_revision:''}},
    {status:'applied',state:{...applied,applied:{...config,capacity:3}}},
  ]) expect(deviceConfigurationResponseSchema.safeParse({...base,...change}).success).toBe(false);
  for (const status of ['pending','blocked','failed'] as const) {
    const state = {desired_revision:'desired-1',applied_revision:null,desired:config,applied:null,status,error:status === 'pending' ? null : 'unable'};
    expect(deviceConfigurationResponseSchema.safeParse({...base,status,state}).success).toBe(true);
  }
});

