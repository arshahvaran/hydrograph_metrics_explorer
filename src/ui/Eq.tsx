import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** Render a KaTeX equation inline (used by the metric reference table). */
export function Eq({ tex }: { tex: string }) {
  const html = useMemo(
    () => katex.renderToString(tex, { throwOnError: false, displayMode: false, output: 'html' }),
    [tex],
  )
  return <span className="eq" dangerouslySetInnerHTML={{ __html: html }} />
}
