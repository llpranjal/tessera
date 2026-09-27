import { useSyncExternalStore } from 'react'

const EVENT = 'tessera:navigate'

export function navigate(path: string) {
  if (path === location.pathname) return
  history.pushState(null, '', path)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(fn: () => void) {
  window.addEventListener('popstate', fn)
  window.addEventListener(EVENT, fn)
  return () => {
    window.removeEventListener('popstate', fn)
    window.removeEventListener(EVENT, fn)
  }
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname)
}
