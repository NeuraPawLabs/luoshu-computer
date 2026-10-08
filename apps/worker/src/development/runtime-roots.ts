import type { CodebasePrepareRequest } from '@luoshu/protocol';
import { updateWorkerConfig, type WorkerConfig } from '../environment.js';
import { prepareCodebaseWorkspace, resolveCodebaseAssignments } from '../codebase-workspace.js';
import { DevelopmentRootPolicy } from './root-policy.js';

export function runtimeDevelopmentRoots(stateDir: string, config: WorkerConfig) {
  // Preserve the historical maintenance scope while separating all future edits.
  const maintenanceRoots = config.maintenance_roots ?? config.development_roots ?? [];
  return new DevelopmentRootPolicy({ roots: config.development_roots, revision: config.development_roots_revision,
    persist: async (roots, revision) => {
      await updateWorkerConfig(stateDir, latest=>{
        const { development_roots: _previous, ...rest } = latest;
        return { ...rest, ...(roots === null ? {} : { development_roots: roots }),
          development_roots_revision: revision, maintenance_roots: latest.maintenance_roots ?? maintenanceRoots };
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
