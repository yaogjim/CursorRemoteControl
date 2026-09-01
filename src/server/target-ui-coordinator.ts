import { EventEmitter } from 'events';

export type TargetUiErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'generation_changed'
  | 'aborted';

export class TargetUiError extends Error {
  readonly code: TargetUiErrorCode;
  readonly targetId: string;

  constructor(code: TargetUiErrorCode, targetId: string, message?: string) {
    super(message ?? `${code} (${targetId})`);
    this.name = 'TargetUiError';
    this.code = code;
    this.targetId = targetId;
  }
}

export interface TargetUiContext {
  targetId: string;
  generation: number;
  signal: AbortSignal;
}

export interface TargetUiEnqueueOptions {
  /** If set, the op is rejected unless it still matches the live generation. */
  generation?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  label?: string;
}

interface PendingTicket {
  generation: number;
  cancelled: boolean;
  reject: (err: TargetUiError) => void;
}

interface TargetLane {
  generation: number;
  tail: Promise<void>;
  running: AbortController | null;
  pending: Set<PendingTicket>;
  lastAbortCode: TargetUiErrorCode | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Serializes UI mutation / interactive probe work per stable targetId.
 * Different targets run in parallel. Generation changes, cancel, and
 * timeout invalidate queued work without requiring a live Cursor.
 *
 * Timeout/cancel reject the caller immediately, but the lane is not released
 * until the run callback settles so the next mutation cannot overlap.
 */
export class TargetUiCoordinator extends EventEmitter {
  private lanes = new Map<string, TargetLane>();

  getGeneration(targetId: string): number {
    return this.ensureLane(targetId).generation;
  }

  setGeneration(targetId: string, generation: number): void {
    const lane = this.ensureLane(targetId);
    if (lane.generation === generation) return;
    lane.generation = generation;
    this.invalidateLane(lane, targetId, 'generation_changed');
  }

  bumpGeneration(targetId: string): number {
    const lane = this.ensureLane(targetId);
    lane.generation += 1;
    this.invalidateLane(lane, targetId, 'generation_changed');
    return lane.generation;
  }

  cancel(targetId: string, reason: TargetUiErrorCode = 'cancelled'): void {
    const lane = this.lanes.get(targetId);
    if (!lane) return;
    lane.generation += 1;
    this.invalidateLane(lane, targetId, reason);
  }

  cancelAll(reason: TargetUiErrorCode = 'cancelled'): void {
    for (const [id, lane] of this.lanes) {
      lane.generation += 1;
      this.invalidateLane(lane, id, reason);
    }
  }

  enqueue<T>(
    targetId: string,
    run: (ctx: TargetUiContext) => Promise<T>,
    opts: TargetUiEnqueueOptions = {},
  ): Promise<T> {
    const lane = this.ensureLane(targetId);
    const generation = opts.generation ?? lane.generation;
    if (generation !== lane.generation) {
      return Promise.reject(new TargetUiError('generation_changed', targetId));
    }

    return new Promise<T>((resolve, reject) => {
      const ticket: PendingTicket = {
        generation,
        cancelled: false,
        reject,
      };
      lane.pending.add(ticket);

      const prev = lane.tail;
      let release: () => void = () => { /* set below */ };
      const gate = new Promise<void>((r) => { release = r; });
      lane.tail = prev.then(() => gate, () => gate);

      void prev.then(async () => {
        lane.pending.delete(ticket);
        try {
          if (ticket.cancelled) return;
          if (generation !== lane.generation) {
            reject(new TargetUiError('generation_changed', targetId));
            return;
          }
          const session = this.beginRun(lane, targetId, generation, run, opts);
          void session.outcome.then(
            (value) => { if (!ticket.cancelled) resolve(value); },
            (err) => { if (!ticket.cancelled) reject(err); },
          );
          await session.finished;
        } catch (err) {
          if (!ticket.cancelled) reject(err);
        } finally {
          release();
        }
      });
    });
  }

  private beginRun<T>(
    lane: TargetLane,
    targetId: string,
    generation: number,
    run: (ctx: TargetUiContext) => Promise<T>,
    opts: TargetUiEnqueueOptions,
  ): { outcome: Promise<T>; finished: Promise<void> } {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    lane.running = ac;

    const onExternalAbort = () => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const runPromise = Promise.resolve().then(() => run({ targetId, generation, signal: ac.signal }));

    let outcomeSettled = false;
    let resolveOutcome!: (value: T) => void;
    let rejectOutcome!: (err: unknown) => void;
    const outcome = new Promise<T>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });

    const settleOk = (value: T) => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      resolveOutcome(value);
    };
    const settleErr = (err: unknown) => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      if (!ac.signal.aborted) ac.abort();
      rejectOutcome(err);
    };

    const timer = setTimeout(() => {
      settleErr(new TargetUiError('timeout', targetId, `UI op timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      if (outcomeSettled) return;
      if (opts.signal?.aborted) {
        settleErr(new TargetUiError('aborted', targetId));
        return;
      }
      settleErr(new TargetUiError(
        lane.lastAbortCode ?? (generation !== lane.generation ? 'generation_changed' : 'cancelled'),
        targetId,
      ));
    };
    if (ac.signal.aborted) onAbort();
    else ac.signal.addEventListener('abort', onAbort, { once: true });

    void runPromise.then(settleOk, settleErr);

    const finished = runPromise.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      ac.signal.removeEventListener('abort', onAbort);
      if (lane.running === ac) lane.running = null;
    });

    return { outcome, finished };
  }

  private ensureLane(targetId: string): TargetLane {
    let lane = this.lanes.get(targetId);
    if (!lane) {
      lane = {
        generation: 1,
        tail: Promise.resolve(),
        running: null,
        pending: new Set(),
        lastAbortCode: null,
      };
      this.lanes.set(targetId, lane);
    }
    return lane;
  }

  private invalidateLane(lane: TargetLane, targetId: string, code: TargetUiErrorCode): void {
    lane.lastAbortCode = code;
    lane.running?.abort();
    for (const ticket of lane.pending) {
      ticket.cancelled = true;
      ticket.reject(new TargetUiError(code, targetId));
    }
    lane.pending.clear();
  }
}