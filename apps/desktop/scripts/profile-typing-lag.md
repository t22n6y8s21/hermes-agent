# Profiling renderer typing lag

Workflow for empirically measuring (and fixing) typing/submit lag in the
desktop chat composer.

## Quick boot for profiling

Vite 8 + plugin-react 6 has a known issue where the React Fast Refresh
preamble script isn't injected into `index.html`, so opening Electron at
`http://127.0.0.1:5174` throws `$RefreshReg$ is not defined` on every TSX
module and the React tree never mounts. Workaround: run vite with HMR off.

```bash
# Terminal A — start dev server without HMR
cd apps/desktop
node scripts/dev-no-hmr.mjs

# Terminal B — start Electron with CDP exposed
cd apps/desktop
XCURSOR_SIZE=24 HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5174 \
  ../../node_modules/.bin/electron --remote-debugging-port=9222 .
```

Terminal C is yours to run the harnesses.

## Harnesses

All zero-dep — Node 24 built-in `WebSocket` + `fetch`.

### Typing latency — `measure-latency.mjs`

Per-keystroke `keypress → next paint` latency, p50/p90/p99/max.
Synthesizes keystrokes via `Input.dispatchKeyEvent` so the run is
reproducible.

```bash
node apps/desktop/scripts/measure-latency.mjs --chars=120 --cps=20
```

Anything > 16ms is a dropped frame. On a freshly-loaded session
(`scripts/click-session.mjs 'Phaser particle'`) we currently see:

| | unpatched | patched |
|---|---|---|
| p50 paint | 1.9 ms | 2.0 ms |
| p90 paint | 3.3 ms | 13.7 ms |
| p99 paint | 16.7 ms | 15.2 ms |
| max paint | 20.5 ms | 30.4 ms |
| >16ms drops | 2/120 | 1/120 |

Roughly even on a quick session — patches don't fix typing latency
under benign synthetic conditions because the existing baseline is
already snappy on synthetic input. The real wins are in the leak counters
(see below). If the user reports typing jank, capture a profile + heap
diff during their actual usage and compare against the synthetic baseline
to identify what condition (long thread, popover open, paste, etc.)
makes the path slow.

### Leak counters — `leak-typing.mjs`

Types N chars, clears, force-GCs, captures `Performance.getMetrics` deltas.
Reveals leaked event listeners, heap drift, document node growth, and
forced-layout counts.

```bash
node apps/desktop/scripts/leak-typing.mjs --rounds=6 --chars=200 --cps=50
```

Before patches (real run on this branch's previous tip):
```
heapUsedMB    Δ/round=+0.06     /char=+0.0003
jsListeners   Δ/round=+34.75    /char=+0.1737   ← LEAK
layoutCount   Δ/round=+453.00   /char=+2.27
```

After patches:
```
heapUsedMB    Δ/round=+0.00     /char=+0.0000
jsListeners   Δ/round=+0.00     /char=+0.0000   ← fixed
layoutCount   Δ/round=+476.00   /char=+2.38
```

The listener leak is gone. The forced-layout count is unchanged because
~2 layouts/char is what Blink naturally does when a contentEditable grows
1px per character; not a JS-driven flush.

### CPU profile + heap snapshot — `profile-typing.mjs`

Records a CPU profile while typing, plus before/after heap snapshots so
you can do a comparison diff in Chrome DevTools Memory tab.

```bash
node apps/desktop/scripts/profile-typing.mjs \
  --chars=400 --cps=30 --out=/tmp/hermes-typing
# → /tmp/hermes-typing.cpuprofile  (open in Chrome DevTools Performance)
# → /tmp/hermes-typing.before.heapsnapshot
# → /tmp/hermes-typing.after.heapsnapshot
```

Loading the cpuprofile: Chrome DevTools → Performance tab → drag the file
in, or VS Code → open the `.cpuprofile` directly.

For heap diff: Chrome DevTools → Memory → Load snapshot → load "before",
then Comparison view → load "after". Sort by `# Delta`. Stay alert for
detached DOM, FiberNodes (unmounted), and listener growth.

## Helpers

- `probe-renderer.mjs` — dump page state (URL, composer mounted?, body text)
- `click-session.mjs <title>` — click a sidebar session by partial title match
- `reload-renderer.mjs` — force Page.reload via CDP (no HMR available)
- `dump-state.mjs` — richer state dump (thread message count, sticky session, etc.)
- `probe-console.mjs` — dump recent console errors / exceptions

## Findings

See commit messages for the actual edits. Summary:

1. **`src/app/chat/composer/index.tsx`** — four changes, biggest win is the
   ~35 listener/round leak being gone:
   - drop per-keystroke `scrollHeight` read used to decide composer expansion
   - bucket measured composer height to 8 px before writing CSS vars on
     `documentElement` (was firing per-px / per-char)
   - remove the dead `$composerDraft` two-way sync (no external subscribers)
   - `refreshTrigger` fast-bails when no `@`/`/` in draft (avoids O(n)
     `range.toString()` walk)

2. **`src/components/ui/fade-text.tsx`** — biggest win during streaming:
   - drop the `useEffect([children])` that re-measured `scrollWidth` on
     every parent re-render; `useResizeObserver` already handles the only
     case where overflow state can legitimately change
   - wrap the component in `memo` with a custom comparator that
     short-circuits re-renders when scalar `children` (a string) is
     unchanged

   Measured impact via `scripts/profile-under-stream.mjs` (typing 100 chars
   into the composer while the assistant is streaming a 6-paragraph reply):

   - FadeText self time: **35.8 ms → 18.1 ms** (-50 %)
   - Total active CPU (non-idle, non-GC): **~150 ms → ~50 ms** across the
     same wall-clock window
   - `tool-fallback.tsx` re-renders + `selectMessageRunning` selector both
     dropped out of the top-5 self-time list

## Submit / TTFT stall

`scripts/measure-submit.mjs` measures Enter → composer-cleared →
user-message-rendered → first-paint. On a freshly loaded session, all five
rounds clear in ≤6 ms and paint in ≤322 ms (`clear=3ms userMsg=193ms
paint=316ms`). There's no UI-side stall on the submit path. Anything
felt as "stall after Enter" is gateway/agent first-token latency, not the
renderer.

## Typing during streaming (the real complaint)

`scripts/latency-under-stream.mjs` types into the composer while the
assistant is actively streaming. Before/after my patches:

| | before | after |
|---|---|---|
| keystroke→paint p50 | 9.0 ms | 9-10 ms |
| keystroke→paint p90 | 14.9 ms | 14-15 ms |
| keystroke→paint p99 | 29.1 ms | 25-30 ms |
| dropped frames | 5/80 | 2-3/60 |

Synthetic latency at 15 cps is similar; the CPU profile shows the per-token
work dropping by ~⅔, which means there's a lot more headroom for fast-burst
typing and complex token contents (long code blocks, math, etc.) — exactly
the case where the user-felt jank shows up.
