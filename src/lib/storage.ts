import { del, get, set } from 'idb-keyval'
import type { PersistedAppState } from '../types'

const APP_STATE_KEY = 'comedorbedarfomat-state-v1'

export function getInitialAppState(): PersistedAppState {
  return {
    activeView: 'catalog',
    currentWorkbook: null,
    previousWorkbook: null,
    inventoryDrafts: {},
    searchQuery: '',
    inventoryQuery: '',
    filters: {
      producer: '',
      category: '',
    },
  }
}

export function loadAppState(): PersistedAppState {
  if (typeof window === 'undefined') {
    return getInitialAppState()
  }

  try {
    const raw = window.localStorage.getItem(APP_STATE_KEY)
    if (!raw) {
      return getInitialAppState()
    }

    const parsed = JSON.parse(raw) as Partial<PersistedAppState>

    return {
      ...getInitialAppState(),
      ...parsed,
      filters: {
        ...getInitialAppState().filters,
        ...parsed.filters,
      },
      inventoryDrafts: parsed.inventoryDrafts ?? {},
      currentWorkbook: parsed.currentWorkbook ?? null,
      previousWorkbook: parsed.previousWorkbook ?? null,
    }
  } catch {
    return getInitialAppState()
  }
}

export function saveAppState(state: PersistedAppState) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(APP_STATE_KEY, JSON.stringify(state))
}

export function clearAppState() {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(APP_STATE_KEY)
}

export async function saveWorkbookBinary(
  workbookKey: string,
  buffer: ArrayBuffer,
) {
  await set(workbookKey, buffer)
}

export async function loadWorkbookBinary(workbookKey: string) {
  const stored = await get<ArrayBuffer | Uint8Array | null>(workbookKey)

  if (!stored) {
    return null
  }

  if (stored instanceof ArrayBuffer) {
    return stored
  }

  return new Uint8Array(stored).slice().buffer
}

export async function removeWorkbookBinary(workbookKey: string) {
  await del(workbookKey)
}
