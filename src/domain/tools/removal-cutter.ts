import { z } from "zod"
import { fail, ok } from "../primitives"
import type { Result } from "../primitives"
import { toolKindKey } from "./tool"
import type { Tool } from "./tool"

export const RemovalCutterSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("flat"),
    radius: z.number().positive(),
    cuttingLength: z.number().positive().optional(),
  }),
  z
    .object({
      kind: z.literal("v-bit"),
      radius: z.number().positive(),
      cuttingLength: z.number().positive().optional(),
      tipRadius: z.number().nonnegative(),
      /** Height above the tip per millimetre of radius beyond the flat tip. */
      slope: z.number().positive(),
    })
    .refine((cutter) => cutter.tipRadius < cutter.radius),
])
export type RemovalCutter = z.infer<typeof RemovalCutterSchema>

export function removalToolShape(kind: string) {
  const key = toolKindKey(kind)
  if (["flat end mill", "face mill"].includes(key)) return "flat"
  if (["chamfer mill", "engraving", "counter sink"].includes(key))
    return "v-bit"
  return null
}

/** Cutting geometry only; facing retains its separate flat-cutter requirement. */
export function removalCutter(tool: Tool | undefined): Result<RemovalCutter> {
  if (!tool) return fail("Assign a library cutter to this tool number.")
  const kind = toolKindKey(tool.kind)
  const shape = removalToolShape(kind)
  if (!shape)
    return fail("Removal supports flat end mills, face mills and V-bits.")
  const { geometry, diameter } = tool
  if (diameter === null || diameter <= 0)
    return fail("Enter the cutting diameter in the tool library.")
  if (geometry.fluteLength === null || geometry.fluteLength <= 0)
    return fail("Enter the cutting length in the tool library.")
  if ((geometry.cornerRadius ?? 0) !== 0)
    return fail("Rounded cutting edges are outside this removal model.")
  if (shape === "flat") {
    if (
      (geometry.taperAngle ?? 0) !== 0 ||
      (geometry.tipDiameter !== null && geometry.tipDiameter !== diameter) ||
      (geometry.maxDiameter !== null && geometry.maxDiameter !== diameter)
    )
      return fail("This cutter needs a straight, flat-ended profile.")
    return ok({
      kind: "flat",
      radius: diameter / 2,
      cuttingLength: geometry.fluteLength,
    })
  }
  // Same convention as the tool viewer: taper angle is measured from the axis;
  // point angle is the full included angle (90 degrees means a 45-degree taper).
  let halfAngle = geometry.taperAngle
  if (halfAngle === null || halfAngle <= 0 || halfAngle >= 90)
    halfAngle = geometry.pointAngle === null ? null : geometry.pointAngle / 2
  if (halfAngle === null || halfAngle <= 0 || halfAngle >= 90)
    return fail(
      "Enter a V-bit point angle between 0 and 180 degrees, or a taper angle between 0 and 90 degrees, in the tool library."
    )
  const tip = geometry.tipDiameter
  if (tip === null || tip < 0)
    return fail("Enter a V-bit tip diameter; use 0 for a sharp point.")
  const slope = 1 / Math.tan((halfAngle * Math.PI) / 180)
  // Engraving tools in Fusion use DC for the tip, not the wide end.
  const outerDiameter =
    geometry.maxDiameter ??
    (kind === "engraving" && diameter === tip
      ? geometry.shoulderDiameter
      : diameter)
  if (outerDiameter === null || outerDiameter <= tip)
    return fail("Enter a maximum cutting diameter larger than the V-bit tip.")
  return ok({
    kind: "v-bit",
    cuttingLength: geometry.fluteLength,
    radius: Math.min(outerDiameter / 2, tip / 2 + geometry.fluteLength / slope),
    tipRadius: tip / 2,
    slope,
  })
}
