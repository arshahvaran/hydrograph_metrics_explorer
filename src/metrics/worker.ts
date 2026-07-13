// Web Worker: computes the full metric panel off the main thread (§18–19).
import { computeAll, type ComputeCtx } from './registry'

self.onmessage = (e: MessageEvent) => {
  const { id, obs, sim, ctx } = e.data as { id: number; obs: Float64Array; sim: Float64Array; ctx: ComputeCtx };
  try {
    const out = computeAll(obs, sim, ctx);
    (self as unknown as Worker).postMessage({ id, out });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
