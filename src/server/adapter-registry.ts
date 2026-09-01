import type { CapabilityKind } from './types.js';
import type { AdapterRecord, ActiveBinding } from './adapter-store.js';
import { adapterFingerprint } from './adapter-store.js';

export interface AdapterMatch {
  adapter: AdapterRecord | null;
  binding: ActiveBinding | null;
  degraded: boolean;
  fingerprint: string;
}
export interface AdapterRegistrySource { builtin: AdapterRecord[]; local: AdapterRecord[]; bindings: ActiveBinding[]; }

function exactAdapterContext(adapter: AdapterRecord, cursorBuild: string, domSignature: string, endpointFingerprint: string): boolean {
  return adapter.cursorVersionRange === cursorBuild
    && adapter.domSignature === domSignature
    && adapter.endpointFingerprint === endpointFingerprint;
}

/** Exact-context registry. Local bindings never use semver prefixes or wildcards. */
export class AdapterRegistry {
  private source: AdapterRegistrySource;
  constructor(source: AdapterRegistrySource) { this.source = source; }
  update(source: AdapterRegistrySource): void { this.source = source; }

  find(kind: CapabilityKind, cursorBuild: string, domSignature: string, endpointFingerprint: string): AdapterMatch {
    const binding = this.source.bindings.find((item) => item.capabilityKind === kind
      && item.cursorVersionRange === cursorBuild
      && item.domSignature === domSignature
      && item.endpointFingerprint === endpointFingerprint);
    if (binding) {
      const adapter = this.source.local.find((item) => item.id === binding.adapterId
        && item.status === 'active'
        && item.capabilityKinds.includes(kind)
        && exactAdapterContext(item, cursorBuild, domSignature, endpointFingerprint));
      if (adapter) return { adapter, binding, degraded: false, fingerprint: adapterFingerprint(adapter) };
    }

    const builtin = this.source.builtin.find((item) => item.capabilityKinds.includes(kind)
      && exactAdapterContext(item, cursorBuild, domSignature, endpointFingerprint));
    return {
      adapter: builtin ?? null,
      binding: null,
      degraded: true,
      fingerprint: builtin ? adapterFingerprint(builtin) : '',
    };
  }

  fingerprint(kind: CapabilityKind, cursorBuild: string, domSignature: string, endpointFingerprint: string): string {
    return this.find(kind, cursorBuild, domSignature, endpointFingerprint).fingerprint;
  }
}