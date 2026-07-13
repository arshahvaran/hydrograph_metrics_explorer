import { useEffect, useRef } from 'react'

let plotlyPromise: Promise<any> | null = null;
const loadPlotly = () => (plotlyPromise ??= import('plotly.js-dist-min').then(m => m.default ?? m));

export const BASE_LAYOUT = {
  margin: { t: 36, r: 14, l: 56, b: 44 },
  font: { size: 12, family: 'Segoe UI, system-ui, sans-serif' },
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  legend: { orientation: 'h', y: 1.12 },
  hovermode: 'x unified',
} as const;

export function PlotHost({ traces, layout, height = 380 }: { traces: any[]; layout: any; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(P => {
      if (cancelled || !ref.current) return;
      P.react(ref.current, traces, { ...BASE_LAYOUT, ...layout }, {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        toImageButtonOptions: { format: 'png', filename: 'hme_plot', scale: 2 },
      });
    });
    return () => { cancelled = true; };
  }, [traces, layout]);
  useEffect(() => () => {
    if (ref.current) loadPlotly().then(P => P.purge(ref.current!));
  }, []);
  return <div ref={ref} style={{ width: '100%', height }} className="plothost" />;
}
