/**
 * The settings navigation is Host-rendered: its per-section icon mapping
 * (`navIcon(id)` in the general-settings bundle) knows only the built-in
 * sections and falls back to a gear for every plugin-contributed entry, and
 * the slot registration has no icon field. This shim watches for the nav cell
 * whose label reads "Discord" and swaps its gear for the monochrome Discord
 * mark, styled by the Host's own navIcon class. Idempotent: the replacement
 * carries a data marker, so re-running the sweep after our own mutation is a
 * no-op.
 */

import type { ReactNode } from 'react'

/** The mark path, shared by the React component and the DOM shim. */
const MARK_PATH = 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z'

/** The Discord mark, monochrome: it inherits the surrounding text color. */
export function DiscordMark({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d={MARK_PATH} />
    </svg>
  )
}

/** Real-DOM twin of {@link DiscordMark} for imperative Host-DOM shims. */
function markElement(size: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-discord-mark', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', MARK_PATH)
  svg.appendChild(path)
  return svg
}

/** Sweep every nav cell labeled Discord and swap its icon for the mark. */
function sweepNavIcons(): void {
  const cells = document.querySelectorAll<HTMLButtonElement>('button')
  cells.forEach((cell) => {
    const label = cell.querySelector<HTMLElement>('[class*="navLabel"]')
    if (label === null || label.textContent !== 'Discord') return
    const svg = cell.querySelector('svg')
    if (svg === null || svg.getAttribute('data-discord-mark') === 'true') return
    const replacement = markElement(16)
    const hostClass = svg.getAttribute('class')
    if (hostClass !== null) replacement.setAttribute('class', hostClass)
    svg.replaceWith(replacement)
  })
}

/**
 * Install the nav-icon shim and keep it applied while the settings dialog
 * mounts and re-renders.
 * @returns the disposer releasing the mutation observer.
 */
export function installDiscordNavIcon(): () => void {
  // Headless/test environments have no live DOM to decorate.
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  let scheduled = false
  const sweepScheduled = (): void => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => { scheduled = false; sweepNavIcons() })
  }
  const observer = new MutationObserver(sweepScheduled)
  observer.observe(document.body, { childList: true, subtree: true })
  sweepNavIcons()
  return () => { observer.disconnect() }
}
