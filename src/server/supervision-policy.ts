import type { SupervisionGrant, SupervisionWriteRequest } from './types.js';

function isActiveUnexpired(grant: SupervisionGrant, now: number): boolean {
  if (!grant || grant.status !== 'active') return false;
  if (!Number.isFinite(now) || !Number.isFinite(grant.expiresAt) || now >= grant.expiresAt) return false;
  return true;
}

/** Read is allowed while paused. Write is not. */
export function canReadUnderSupervision(
  grant: SupervisionGrant,
  composerId: string,
  now: number = Date.now(),
): boolean {
  if (!isActiveUnexpired(grant, now)) return false;
  if (typeof composerId !== 'string' || composerId.length === 0) return false;
  return Array.isArray(grant.readComposerIds) && grant.readComposerIds.includes(composerId);
}

export function canWriteUnderSupervision(
  grant: SupervisionGrant,
  request: SupervisionWriteRequest,
): boolean {
  const now = request.now ?? Date.now();
  if (!isActiveUnexpired(grant, now)) return false;
  if (!Array.isArray(grant.pauseReasons)) return false;
  const blockingPauses = grant.pauseReasons.filter((reason) => reason !== 'pending_issue');
  if (blockingPauses.length > 0) return false;
  if (grant.pauseReasons.includes('pending_issue') && !request.issueId) return false;
  if (typeof request.composerId !== 'string' || !Array.isArray(grant.writeComposerIds)) return false;
  if (!grant.writeComposerIds.includes(request.composerId)) return false;
  if (!Array.isArray(grant.allowedActionTypes) || !grant.allowedActionTypes.includes(request.actionType)) return false;
  if (grant.planVersion !== request.planVersion) return false;
  if (grant.authorizationVersion !== request.authorizationVersion) return false;
  if (grant.controlVersion !== request.controlVersion) return false;
  if (!Array.isArray(grant.allowedModes) || !grant.allowedModes.includes(request.mode)) return false;
  if (!Array.isArray(grant.allowedModels) || !grant.allowedModels.includes(request.model)) return false;
  if (!Number.isFinite(grant.operationLimit) || grant.operationLimit < 0) return false;
  if (!Number.isFinite(grant.operationsUsed) || grant.operationsUsed < 0) return false;
  if (grant.operationsUsed >= grant.operationLimit) return false;
  return true;
}