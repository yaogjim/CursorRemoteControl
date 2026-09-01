export interface CircuitKey { cursorBuild: string; domSignature: string; capabilityKind: string; adapterId: string; }
interface Sample { at: number; ok: boolean; }
export interface CircuitState { open: boolean; failures: number; samples: number; openedAt: number | null; }

function keyOf(k: CircuitKey): string { return `${k.cursorBuild}|${k.domSignature}|${k.capabilityKind}|${k.adapterId}`; }
export class CapabilityCircuitBreaker {
  private samples = new Map<string, Sample[]>();
  private opened = new Map<string, number>();
  constructor(private readonly opts: { minSamples?: number; windowMs?: number; failureRatio?: number } = {}) {}
  record(key: CircuitKey, ok: boolean, now = Date.now()): CircuitState { const id=keyOf(key), window=this.opts.windowMs ?? 60_000; const list=(this.samples.get(id) ?? []).filter((s)=>now-s.at<=window); list.push({at:now,ok}); this.samples.set(id,list); const failures=list.filter((s)=>!s.ok).length; const open=list.length >= (this.opts.minSamples ?? 3) && failures/list.length >= (this.opts.failureRatio ?? .66); if(ok) this.opened.delete(id); else if(open) this.opened.set(id,now); return this.state(key,now); }
  isOpen(key: CircuitKey, now=Date.now()): boolean { const state=this.state(key,now); return state.open; }
  reset(key: CircuitKey): void { this.samples.delete(keyOf(key)); this.opened.delete(keyOf(key)); }
  state(key: CircuitKey, now=Date.now()): CircuitState { const id=keyOf(key), list=(this.samples.get(id)??[]).filter((s)=>now-s.at<=(this.opts.windowMs??60_000)); this.samples.set(id,list); return {open:this.opened.has(id),failures:list.filter((s)=>!s.ok).length,samples:list.length,openedAt:this.opened.get(id)??null}; }
}