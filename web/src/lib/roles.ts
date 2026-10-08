import type { Role } from '@shared';
import { ROLE_RANK } from '@shared';

export interface Permissions {
  role: Role;
  canView: boolean;
  canComment: boolean;
  canEdit: boolean;
  isOwner: boolean;
}

export function permissionsFor(role: Role | undefined | null): Permissions {
  const r: Role = role ?? 'viewer';
  const rank = ROLE_RANK[r] ?? 1;
  return {
    role: r,
    canView: rank >= ROLE_RANK.viewer,
    canComment: rank >= ROLE_RANK.commenter,
    canEdit: rank >= ROLE_RANK.editor,
    isOwner: rank >= ROLE_RANK.owner,
  };
}

/** Read-only permissions used by public shared pages. */
export const PUBLIC_PERMISSIONS: Permissions = {
  role: 'viewer',
  canView: true,
  canComment: false,
  canEdit: false,
  isOwner: false,
};

export const ROLES: Role[] = ['owner', 'editor', 'commenter', 'viewer'];
