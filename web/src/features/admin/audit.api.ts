/** Audit log: paged listing with filters, chain verification and the JSONL export URL. */
import { api } from '@/shared/api/client';
import type { AuditPage, AuditVerify } from '@/shared/api/types';

// Optional filters and paging cursor for the audit list.
export interface AuditFilter {
  envId?: string;
  actorId?: string;
  action?: string;
  before?: string | number;
  limit?: number;
}

// One page of audit entries.
export const listAudit = (f: AuditFilter) => api.get<AuditPage>('/api/audit', { query: { ...f } });

// Check the audit hash chain.
export const verifyAudit = () => api.get<AuditVerify>('/api/audit/verify');

// Direct download link for the full log.
export const AUDIT_EXPORT_URL = '/api/audit/export.jsonl';
