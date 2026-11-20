import { z } from "zod"

export const RemovalResolutionSchema = z.union([
  z.literal(128),
  z.literal(256),
  z.literal(512),
  z.literal(1024),
])
export type RemovalResolution = z.infer<typeof RemovalResolutionSchema>
export const DEFAULT_REMOVAL_RESOLUTION: RemovalResolution = 512

export const RemovalEngineSchema = z.enum(["height-field", "volume"])
export type RemovalEngine = z.infer<typeof RemovalEngineSchema>
