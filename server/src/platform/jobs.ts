// TEMP stub: the platform module replaces this file at merge.
import type { Job, JobStatus } from '../../../shared/src/index.js';

const ni = (): never => {
  throw new Error('not implemented');
};

export function createJob(_userId: string, _kind: 'nocodb-migration' | 'import'): Job {
  return ni();
}
export function updateJob(
  _id: string,
  _patch: { status?: JobStatus; progress?: number; message?: string; appendLog?: string; result?: unknown },
): Job {
  return ni();
}
export function getJob(_id: string): Job {
  return ni();
}
