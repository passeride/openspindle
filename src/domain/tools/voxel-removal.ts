import { RemovalInputSchema } from "./material-removal"
import type { RemovalCursor, RemovalGrid } from "./material-removal"

const MAX_CELLS = 2_000_000
const MAX_VISITS = 24_000_000
const MAX_QUADS = 180_000

/** Uniform volumetric baseline for comparing future surface reconstruction. */
export class VoxelRemoval {
  private readonly input
  private readonly size: number[]
  private readonly spacing: number[]
  private readonly solid: Uint8Array
  private cursor: RemovalCursor = { move: 0, fraction: 0 }
  private visits = 0

  constructor(input: unknown) {
    this.input = RemovalInputSchema.parse(input)
    if (this.input.reference)
      throw new Error(
        "Model deviation is available with the height-field engine."
      )
    const extent = this.input.max.map((max, axis) => max - this.input.min[axis])
    if (extent.some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error("Material removal needs positive stock dimensions.")
    const pitch = Math.max(...extent) / this.input.resolution
    this.size = extent.map((value) => Math.max(1, Math.ceil(value / pitch)))
    this.spacing = extent.map((value, axis) => value / this.size[axis])
    const cells = this.size.reduce((total, count) => total * count, 1)
    if (cells > MAX_CELLS)
      throw new Error(
        "Volume preview exceeds its cell budget. Lower Material removal resolution in Settings."
      )
    this.solid = new Uint8Array(cells).fill(1)
  }

  at(cursor: RemovalCursor): RemovalGrid {
    if (
      cursor.move < this.cursor.move ||
      (cursor.move === this.cursor.move &&
        cursor.fraction < this.cursor.fraction)
    ) {
      this.solid.fill(1)
      this.visits = 0
      this.cursor = { move: 0, fraction: 0 }
    }
    for (
      let move = this.cursor.move;
      move <= cursor.move && move < this.input.segments.length;
      move++
    ) {
      const from = move === this.cursor.move ? this.cursor.fraction : 0
      const to = move === cursor.move ? cursor.fraction : 1
      if (to > from) this.cut(move, from, to)
    }
    this.cursor = cursor
    return {
      columns: this.size[0],
      rows: this.size[1],
      layers: this.size[2],
      resolution: Math.max(...this.spacing),
      heights: new Float32Array(),
      volumePositions: this.mesh(),
    }
  }

  private cut(move: number, from: number, to: number) {
    const { cutter, start, end } = this.input.segments[move]
    if (!cutter) return
    const delta = end.map((value, axis) => value - start[axis])
    const min = this.input.min
    const radius = cutter.radius
    const length = cutter.cuttingLength
    if (length === undefined)
      throw new Error("Volume preview needs a known cutting length.")
    const [nx, ny] = this.size
    const [dx, dy, dz] = this.spacing
    // At a voxel centre, clip the linear sweep to the interval where the
    // cutter's finite axial extent can touch it. The remaining radial test
    // is exact for a cylinder and convex for the truncated cone.
    const ext = [radius, radius, 0]
    const upper = [radius, radius, length]
    const a = start.map((value, axis) => value + delta[axis] * from)
    const b = start.map((value, axis) => value + delta[axis] * to)
    const low = a.map((value, axis) =>
      Math.max(
        0,
        Math.ceil(
          (Math.min(value, b[axis]) - ext[axis] - min[axis]) /
            this.spacing[axis] -
            0.5
        )
      )
    )
    const high = a.map((value, axis) =>
      Math.min(
        this.size[axis] - 1,
        Math.floor(
          (Math.max(value, b[axis]) + upper[axis] - min[axis]) /
            this.spacing[axis] -
            0.5
        )
      )
    )
    this.visits += low.reduce(
      (count, value, axis) => count * Math.max(0, high[axis] - value + 1),
      1
    )
    if (this.visits > MAX_VISITS)
      throw new Error(
        "Volume preview exceeds its sweep budget. Lower Material removal resolution or preview fewer operations."
      )
    const planar = delta[0] ** 2 + delta[1] ** 2
    for (let z = low[2]; z <= high[2]; z++) {
      const relativeZ = min[2] + (z + 0.5) * dz - start[2]
      let first = from
      let last = to
      if (delta[2]) {
        const tip = relativeZ / delta[2]
        const shoulder = (relativeZ - length) / delta[2]
        first = Math.max(first, Math.min(tip, shoulder))
        last = Math.min(last, Math.max(tip, shoulder))
      } else if (relativeZ < 0 || relativeZ > length) continue
      if (first > last) continue
      for (let y = low[1]; y <= high[1]; y++)
        for (let x = low[0]; x <= high[0]; x++) {
          const index = (z * ny + y) * nx + x
          if (!this.solid[index]) continue
          const px = min[0] + (x + 0.5) * dx - start[0]
          const py = min[1] + (y + 0.5) * dy - start[1]
          const projection = planar
            ? (px * delta[0] + py * delta[1]) / planar
            : first
          const distance = (t: number) =>
            Math.hypot(px - t * delta[0], py - t * delta[1])
          const nearest = Math.max(first, Math.min(last, projection))
          if (distance(nearest) > radius) continue
          if (cutter.kind === "v-bit") {
            // Intersect the time interval with the outer cylinder first.
            let left = first
            let right = last
            if (planar) {
              const reach = Math.sqrt(
                Math.max(0, radius ** 2 - distance(projection) ** 2) / planar
              )
              left = Math.max(left, projection - reach)
              right = Math.min(right, projection + reach)
            }
            const excess = (t: number) =>
              cutter.slope * Math.max(0, distance(t) - cutter.tipRadius) -
              relativeZ +
              t * delta[2]
            // Convex 1D minimization for the conical face, including the flat tip.
            for (let pass = 0; pass < 28 && right - left > 1e-9; pass++) {
              const third = (right - left) / 3
              if (excess(left + third) <= excess(right - third)) right -= third
              else left += third
            }
            if (excess((left + right) / 2) > 1e-7) continue
          }
          this.solid[index] = 0
        }
    }
  }

  private mesh() {
    const positions: number[] = []
    // Emit strips of exposed faces. Local coordinates keep the worker output
    // independent of where the viewer places the plate.
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3
      const v = (axis + 2) % 3
      const stride = [1, this.size[0], this.size[0] * this.size[1]]
      for (const sign of [-1, 1]) {
        for (let k = 0; k < this.size[axis]; k++)
          for (let j = 0; j < this.size[v]; j++) {
            const base = k * stride[axis] + j * stride[v]
            const boundary = k + sign < 0 || k + sign >= this.size[axis]
            const exposed = (i: number) => {
              const at = base + i * stride[u]
              return (
                this.solid[at] &&
                (boundary || !this.solid[at + sign * stride[axis]])
              )
            }
            for (let i = 0; i < this.size[u];) {
              const first = i++
              if (!exposed(first)) continue
              while (i < this.size[u] && exposed(i)) i++
              if (positions.length >= MAX_QUADS * 18)
                throw new Error(
                  "Volume preview exceeds its mesh budget. Lower Material removal resolution."
                )
              const point = (x: number, y: number) => {
                const p = [0, 0, 0]
                p[axis] = (k + Number(sign > 0)) * this.spacing[axis]
                p[u] = x * this.spacing[u]
                p[v] = y * this.spacing[v]
                return p
              }
              const a = point(first, j)
              const b = point(i, j)
              const c = point(i, j + 1)
              const d = point(first, j + 1)
              if (sign > 0) positions.push(...a, ...b, ...c, ...a, ...c, ...d)
              else positions.push(...a, ...c, ...b, ...a, ...d, ...c)
            }
          }
      }
    }
    return new Float32Array(positions)
  }
}
