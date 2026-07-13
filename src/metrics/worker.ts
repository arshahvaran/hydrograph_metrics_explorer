// Web Worker: full metric panel and bootstrap CIs off the main thread.
import { computeAll, type ComputeCtx } from './registry'
import { bootstrapCIs, type BootstrapOptions } from './bootstrap'

interface Msg { id: number; task?: 'panel' | 'bootstrap'; obs: Float64Array; sim: Float64Array; ctx: ComputeCtx; boot?: BootstrapOptions }

self.onmessage = (e: MessageEvent) => {
  const { id, task = 'panel', obs, sim, ctx, boot } = e.data as Msg;
  const post = (m: object) => (self as unknown as Worker).postMessage({ id, ...m });
  try {
    if (task === 'bootstrap') {
      const res = bootstrapCIs(obs, sim, { nanPolicy: ctx.nanPolicy, transform: ctx.transform }, {
        ...boot,
        onProgress: (done, total) => post({ progress: done / total }),
      });
      post({ out: res });
    } else {
      const out = computeAll(obs, sim, ctx);
      post({ out });
    }
  } catch (err) {
    post({ error: String((err as Error)?.message ?? err) });
  }
};
