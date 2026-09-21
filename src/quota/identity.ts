/**
 * Quota identity resolution (docs/PROVIDER-LIMITS-PLAN.zh-CN.md §3/§9,
 * docs/GLM-PLAN-SCOPES.zh-CN.md §3).
 *
 * Responsibilities, in the order a check executes them:
 * 1. `matchProfiles`: exact provider-ID matching (never prefix guessing), with the
 *    optional `modelIds` narrowing. Multiple enabled matches are reported, never
 *    resolved by list order.
 * 2. Scope reconciliation between an explicit profile and the host's resolved
 *    headers: header names are compared case-insensitively; duplicate names with
 *    different values are a conflict, as are profile/host disagreements. A team
 *    scope that is still incomplete after reconciliation yields `needs-scope`
 *    before any network access; a conflict yields `scope-conflict`.
 * 3. Credential fingerprinting: a short non-reversible tag so a credential change
 *    invalidates cache entries without the raw key ever being retained, displayed
 *    or logged.
 *
 * No I/O happens here; the host auth result is injected by the caller.
 */
import type { QuotaProfile } from "../config.ts";
import type { QuotaIdentity, QuotaHostAuth } from "./types.ts";

export interface QuotaModelRef {
  provider: string;
  id: string;
}

export interface ProfileMatch {
  /** Enabled profiles whose providerId/modelIds match the current model. */
  matches: readonly QuotaProfile[];
}

export function matchProfiles(profiles: readonly QuotaProfile[], model: QuotaModelRef | null): ProfileMatch {
  if (!model || !model.provider) return { matches: [] };
  const matches = profiles.filter((profile) => profile.enabled !== false && profile.providerId === model.provider &&
    (!profile.modelIds || profile.modelIds.includes(model.id)));
  return { matches };
}

/** Extract the https origin (scheme://host[:port]) from a base URL, lowercased.
 *  Quota queries only ever compare https origins; plain http yields `null`. */
export function originOfBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 2_048) return null;
  const match = /^https:\/\/([^/?#]+)/i.exec(baseUrl.trim());
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(host)) return null;
  return `https://${host}`;
}

/** FNV-1a 32-bit over the credential material. Output is hex; it is only ever used
 *  as an in-memory cache-key component and never rendered or logged. */
export function credentialTag(apiKey: string | null | undefined, organizationId: string | null, projectId: string | null): string {
  let hash = 0x811c9dc5;
  const input = `${apiKey ?? ""}\n${organizationId ?? ""}\n${projectId ?? ""}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface ScopeReconciliation {
  organizationId: string | null;
  projectId: string | null;
  conflict: boolean;
}

/** Case-insensitive header lookup. A name appearing several times with different
 *  values (possible with differently-cased keys) is a conflict, per contract. */
function collectHeaderValues(headers: Record<string, string | null> | null | undefined, name: string): { values: string[]; conflict: boolean } {
  const values: string[] = [];
  if (!headers) return { values, conflict: false };
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value !== "string" || value === "") continue;
    if (!values.includes(value)) values.push(value);
  }
  return { values, conflict: values.length > 1 };
}

const pick = (profileValue: string | undefined, hostValues: string[]): string | null | "conflict" => {
  const hostValue = hostValues.length === 1 ? hostValues[0] : null;
  if (hostValues.length > 1) return "conflict";
  if (profileValue && hostValue && profileValue !== hostValue) return "conflict";
  return profileValue || hostValue || null;
};

/**
 * Reconcile the profile's explicit scope with the host's resolved headers. For
 * `personal-legacy` the host headers are not part of the verified request shape, so
 * they are ignored entirely; any profile-configured scope still identifies the
 * cache entry. For `team`, a complete organization+project pair is required before
 * any request may be sent; the personal environment key is never a fallback.
 */
export function reconcileScope(profile: QuotaProfile, auth: QuotaHostAuth | null, queryMode: string): ScopeReconciliation {
  const useHeaders = queryMode === "team";
  if (!useHeaders) {
    return {
      organizationId: typeof profile.organizationId === "string" ? profile.organizationId : null,
      projectId: typeof profile.projectId === "string" ? profile.projectId : null,
      conflict: false,
    };
  }
  const organization = collectHeaderValues(auth?.headers, "bigmodel-organization");
  const project = collectHeaderValues(auth?.headers, "bigmodel-project");
  const organizationId = pick(profile.organizationId, organization.values);
  const projectId = pick(profile.projectId, project.values);
  const conflict = organization.conflict || project.conflict || organizationId === "conflict" || projectId === "conflict";
  return {
    organizationId: organizationId === "conflict" ? null : organizationId,
    projectId: projectId === "conflict" ? null : projectId,
    conflict,
  };
}

/** Build the full cache identity for one matched profile. */
export function buildIdentity(profile: QuotaProfile, origin: string, scope: ScopeReconciliation, auth: QuotaHostAuth | null): QuotaIdentity {
  const organizationId = scope.organizationId;
  const projectId = scope.projectId;
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    adapter: profile.adapter,
    plan: profile.plan ?? "",
    queryMode: profile.queryMode ?? "",
    origin,
    organizationId,
    projectId,
    credentialTag: credentialTag(auth?.apiKey ?? null, organizationId, projectId),
  };
}
