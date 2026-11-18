// @ts-check
/**
 * The theme, applied before first paint. A classic script loaded in <head>,
 * not a module: modules are deferred, and a dark page that first paints
 * white flashes. (The CSP allows no inline script, so this cannot be one.)
 *
 * The preference is this BROWSER's (light, dark, or follow the system) and
 * lives in localStorage: client presentation, never runtime truth. It is
 * per origin, so a host on a new port starts from "system" (S22.2 decides a
 * stable home for client preferences).
 *
 * It also sets the hairline: DSH's 0.5px lines, as max(1, ⌊0.5·dpr⌋)/dpr, so a
 * 1× screen gets a real 1px line rather than an anti-aliased smear.
 */
;(() => {
  const KEY = 'minidsh.theme'
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')

  /** @returns {'light' | 'dark' | 'system'} */
  const read = () => {
    let value = null
    try {
      value = window.localStorage.getItem(KEY)
    } catch {
      value = null
    }
    return value === 'light' || value === 'dark' ? value : 'system'
  }

  const apply = () => {
    const preference = read()
    const dark = preference === 'dark' || (preference === 'system' && media.matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.themePreference = preference
  }

  const hairline = () => {
    const ratio = window.devicePixelRatio || 1
    root.style.setProperty('--hair', `${Math.max(1, Math.floor(0.5 * ratio)) / ratio}px`)
  }

  apply()
  hairline()
  media.addEventListener('change', apply)
  // Another tab of this host changed it.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) apply()
  })
  window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', hairline)

  /** The one handle the settings use; frozen, so nothing else can take it over. */
  Object.defineProperty(window, 'minidshTheme', {
    value: Object.freeze({
      get: read,
      /** @param {'light' | 'dark' | 'system'} preference */
      set(preference) {
        try {
          if (preference === 'system') window.localStorage.removeItem(KEY)
          else window.localStorage.setItem(KEY, preference)
        } catch {
          // A browser refusing storage keeps the session's choice only.
        }
        apply()
      },
    }),
  })
})()
