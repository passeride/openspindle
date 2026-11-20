import { createAtom, useSelector } from "@tanstack/react-store"
import {
  DEFAULT_REMOVAL_RESOLUTION,
  RemovalEngineSchema,
  RemovalResolutionSchema,
} from "@/domain/tools/removal-resolution"
import type {
  RemovalEngine,
  RemovalResolution,
} from "@/domain/tools/removal-resolution"

const KEY = "openspindle:removal:resolution"
function readResolution(): RemovalResolution {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) {
      const parsed = RemovalResolutionSchema.safeParse(JSON.parse(saved))
      if (parsed.success) return parsed.data
    }
  } catch {
    // Invalid or unavailable storage uses the default for this session.
  }
  return DEFAULT_REMOVAL_RESOLUTION
}

const preference = createAtom({
  resolution: readResolution(),
  saveError: null as string | null,
})

export function useRemovalResolution() {
  const state = useSelector(preference)
  const update = (resolution: RemovalResolution) => {
    let saveError: string | null = null
    try {
      localStorage.setItem(KEY, JSON.stringify(resolution))
    } catch {
      saveError =
        "The resolution applies for this session but could not be saved."
    }
    preference.set({ resolution, saveError })
  }
  return { ...state, update }
}

const ENGINE_KEY = "openspindle:removal:engine"
function readEngine(): RemovalEngine {
  try {
    return RemovalEngineSchema.parse(localStorage.getItem(ENGINE_KEY))
  } catch {
    return "height-field"
  }
}
const enginePreference = createAtom({
  engine: readEngine(),
  saveError: null as string | null,
})
export function useRemovalEngine() {
  const state = useSelector(enginePreference)
  const update = (engine: RemovalEngine) => {
    let saveError: string | null = null
    try {
      localStorage.setItem(ENGINE_KEY, engine)
    } catch {
      saveError = "The engine applies for this session but could not be saved."
    }
    enginePreference.set({ engine, saveError })
  }
  return { ...state, update }
}
