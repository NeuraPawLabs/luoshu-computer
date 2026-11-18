import type { CodebasePrepareRequest } from '../protocol/index.js';
import { updateWorkerConfig, type WorkerConfig } from '../runtime/environment.js';
import { prepareCodebaseWorkspace, resolveCodebaseAssignments } from '../runtime/codebase-workspace.js';
import { DevelopmentRootPolicy } from './root-policy.js';
import {mutableConfig} from '../runtime/config-controller.js';

export function runtimeDevelopmentRoots(stateDir: string, config: WorkerConfig) {
  const current=mutableConfig(config);
  return new DevelopmentRootPolicy({
    roots: current.development_policy.mode==='home'?null:current.development_policy.mode==='custom'?[...current.development_policy.roots]:[],
    revision: config.development_roots_revision ?? config.worker_config_revision,
    persist: async (roots, revision) => {
      await updateWorkerConfig(stateDir, latest=>{
        const {development_roots:_previous,...rest}=latest;
        return {...rest,...(roots===null?{}:{development_roots:roots}),development_roots_revision:revision,worker_config_revision:revision};
      });
    },
  });
}

export function codebasePreparation(stateDir: string, policy: DevelopmentRootPolicy, gitSshCommand?: string) {
  return { prepare: async (request: CodebasePrepareRequest) => {
    const release = policy.acquire(`preparation:${request.request_id}`, 'preparation',
      request.codebases.flatMap(item => item.source.kind === 'local' ? [item.source.path] : []));
    try {
      const allowedRoots = policy.roots();
      const assignments = await resolveCodebaseAssignments({ codebases: request.codebases, allowedRoots, gitSshCommand });
      const workspace = await prepareCodebaseWorkspace({ stateDir, workspaceId: request.run_id, codebases: assignments, allowedRoots, gitSshCommand });
      return workspace.codebases.map(item => ({ codebase_id: item.id, base_commit: item.base_commit, branch: item.branch, checkout_path: item.checkout_path,
        ...(item.read_isolation ? { read_isolation: item.read_isolation } : {}) }));
    } finally { release(); }
  } };
}
