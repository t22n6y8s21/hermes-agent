import type { ComponentProps, CSSProperties } from 'react'
import { memo, useCallback, useRef, useState } from 'react'

import { useResizeObserver } from '@/hooks/use-resize-observer'
import { cn } from '@/lib/utils'

interface FadeTextProps extends Omit<ComponentProps<'span'>, 'children'> {
  children: React.ReactNode
  /**
   * Width of the fade region on the trailing edge. Accepts any CSS length.
   * Defaults to 3rem so long strings clearly trail off — short enough to
   * preserve readable content, long enough to feel like a deliberate fade
   * rather than a clipped ellipsis.
   */
  fadeWidth?: string
}

/**
 * Single-line text that fades out instead of truncating with an ellipsis.
 *
 * Uses an inline mask-image so the fade resolves against whatever the parent
 * background is — no need to know the surface color, no after-pseudo overlap.
 * The mask is only applied when the text is actually overflowing, so short
 * strings render as plain text without an unnecessary gradient on their tail.
 *
 * `memo` with a custom comparator skips re-renders entirely when the parent
 * passed the same scalar `children` (e.g. a tool title string that didn't
 * change between streaming frames). This matters during assistant streaming,
 * where parents re-render on every token; without the memo+comparator,
 * tool-fallback's title FadeTexts re-rendered for every token even though
 * the title text was unchanged, and the `useResizeObserver` callback paid
 * the `scrollWidth`/`clientWidth` cost (forced layout) on each one.
 *
 * The internal `useResizeObserver` fires the measure callback once on mount
 * and whenever the host span's size changes; that covers initial render and
 * any container resize. The previous explicit `useEffect([children, ...])`
 * is redundant in that picture — RO already handles the only case where
 * overflow state can legitimately change (host size changes) — and was the
 * cause of the per-token forced-layout flushes.
 */
function FadeTextImpl({ children, className, fadeWidth = '3rem', style, ...rest }: FadeTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  const measureOverflow = useCallback(() => {
    const el = ref.current

    if (!el) {
      return
    }

    const overflow = el.scrollWidth - el.clientWidth > 1

    setOverflowing(prev => (prev === overflow ? prev : overflow))
  }, [])

  useResizeObserver(measureOverflow, ref)

  const maskStyle: CSSProperties = overflowing
    ? {
        maskImage: `linear-gradient(to right, black calc(100% - ${fadeWidth}), transparent)`,
        WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${fadeWidth}), transparent)`,
        ...style
      }
    : (style ?? {})

  return (
    <span
      {...rest}
      className={cn('block min-w-0 max-w-full overflow-hidden whitespace-nowrap', className)}
      ref={ref}
      style={maskStyle}
    >
      {children}
    </span>
  )
}

function arePropsEqual(prev: FadeTextProps, next: FadeTextProps): boolean {
  // Cheap scalar-children short-circuit — the hot path during streaming is
  // re-rendering FadeText with the same string children every token tick.
  // For non-string children we skip the optimization and fall through to
  // React's default referential check (returning false re-renders, but
  // crucially the inner `useResizeObserver` is still the only thing that
  // can trigger a forced-layout pass).
  if (prev.children !== next.children) {
    if (typeof prev.children !== 'string' || typeof next.children !== 'string') {
      return false
    }
    if (prev.children !== next.children) return false
  }

  return (
    prev.className === next.className &&
    prev.fadeWidth === next.fadeWidth &&
    prev.style === next.style
  )
}

export const FadeText = memo(FadeTextImpl, arePropsEqual)

