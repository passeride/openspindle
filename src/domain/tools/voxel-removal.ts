import { coneHeight, RemovalInputSchema } from "./material-removal"
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
  private readonly surfaces: VoxelSurface

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
    this.surfaces = new VoxelSurface(this.solid, this.size, this.spacing)
  }

  at(cursor: RemovalCursor): RemovalGrid {
    if (
      cursor.move < this.cursor.move ||
      (cursor.move === this.cursor.move &&
        cursor.fraction < this.cursor.fraction)
    ) {
      this.solid.fill(1)
      this.surfaces.reset()
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
      volumePositions: this.surfaces.mesh(),
    }
  }

  private cut(move: number, from: number, to: number) {
    const { cutter, start, end } = this.input.segments[move]
    if (!cutter) return
    const delta = end.map((value, axis) => value - start[axis])
    const min = this.input.min
    const length = cutter.cuttingLength
    if (length === undefined)
      throw new Error("Volume preview needs a known cutting length.")
    const [nx, ny] = this.size
    const [dx, dy, dz] = this.spacing
    // At a voxel centre, clip the linear sweep to the interval where the
    // cutter's finite axial extent can touch it. The remaining radial test
    // is exact for a cylinder and convex for the truncated cone.
    const a = start.map((value, axis) => value + delta[axis] * from)
    const b = start.map((value, axis) => value + delta[axis] * to)
    // A shallow V-cut only reaches a small fraction of the cutter's full width.
    const depth = Math.max(0, this.input.max[2] - Math.min(a[2], b[2]))
    const radius =
      cutter.kind === "flat"
        ? cutter.radius
        : Math.min(
            cutter.radius,
            cutter.tipRadius + Math.min(length, depth) / cutter.slope
          )
    const ext = [radius, radius, 0]
    const upper = [radius, radius, length]
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
      const layerRadius =
        cutter.kind === "v-bit"
          ? Math.min(
              radius,
              cutter.tipRadius +
                Math.max(
                  0,
                  relativeZ - Math.min(first * delta[2], last * delta[2])
                ) /
                  cutter.slope
            )
          : radius
      const limit2 = layerRadius ** 2
      for (let y = low[1]; y <= high[1]; y++)
        for (let x = low[0]; x <= high[0]; x++) {
          const index = (z * ny + y) * nx + x
          if (!this.solid[index]) continue
          const px = min[0] + (x + 0.5) * dx - start[0]
          const py = min[1] + (y + 0.5) * dy - start[1]
          const projection = planar
            ? (px * delta[0] + py * delta[1]) / planar
            : first
          const nearest = Math.max(first, Math.min(last, projection))
          if (
            (px - nearest * delta[0]) ** 2 + (py - nearest * delta[1]) ** 2 >
            limit2
          )
            continue
          // For a horizontal pass the cross section is a fixed circle. For a
          // sloping cone, clip its radial reach and minimize the cone analytically.
          if (cutter.kind === "v-bit" && delta[2] && planar) {
            const cross2 = (px * delta[1] - py * delta[0]) ** 2 / planar
            const reach = Math.sqrt(Math.max(0, limit2 - cross2) / planar)
            const left = Math.max(first, projection - reach)
            const right = Math.min(last, projection + reach)
            if (
              left > right ||
              coneHeight(
                cutter,
                -relativeZ,
                delta[2],
                planar,
                projection,
                cross2,
                left,
                right
              ) > 1e-7
            )
              continue
          }
          this.solid[index] = 0
          this.surfaces.changed(x, y, z)
        }
    }
  }
}

const CHUNK = 32

/** Greedy face meshes cache unchanged blocks during timeline playback. */
class VoxelSurface {
  private readonly counts: number[]
  private readonly chunks = new Map<number, Float32Array>()
  private readonly dirty = new Set<number>()
  private combined: Float32Array | null = null
  private positionCount = 0
  private readonly solid: Uint8Array
  private readonly size: number[]
  private readonly spacing: number[]

  constructor(solid: Uint8Array, size: number[], spacing: number[]) {
    this.solid = solid
    this.size = size
    this.spacing = spacing
    this.counts = size.map((count) => Math.ceil(count / CHUNK))
    this.reset()
  }

  reset() {
    this.chunks.clear()
    this.positionCount = 0
    this.dirty.clear()
    for (let i = 0; i < this.counts[0] * this.counts[1] * this.counts[2]; i++)
      this.dirty.add(i)
    this.combined = null
  }

  changed(x: number, y: number, z: number) {
    const ix = Math.floor(x / CHUNK)
    const iy = Math.floor(y / CHUNK)
    const iz = Math.floor(z / CHUNK)
    const [nx, ny, nz] = this.counts
    const slab = nx * ny
    const index = (iz * ny + iy) * nx + ix
    this.dirty.add(index)
    // A boundary edit can expose a face of solid material in the neighbour.
    if (ix > 0 && x % CHUNK === 0) this.dirty.add(index - 1)
    if (ix + 1 < nx && x % CHUNK === CHUNK - 1) this.dirty.add(index + 1)
    if (iy > 0 && y % CHUNK === 0) this.dirty.add(index - nx)
    if (iy + 1 < ny && y % CHUNK === CHUNK - 1) this.dirty.add(index + nx)
    if (iz > 0 && z % CHUNK === 0) this.dirty.add(index - slab)
    if (iz + 1 < nz && z % CHUNK === CHUNK - 1) this.dirty.add(index + slab)
  }

  mesh() {
    if (this.dirty.size === 0 && this.combined) return this.combined.slice()
    for (const index of this.dirty) {
      const chunk = this.meshChunk(index)
      this.positionCount += chunk.length - (this.chunks.get(index)?.length ?? 0)
      this.chunks.set(index, chunk)
    }
    if (this.positionCount > MAX_QUADS * 18)
      throw new Error(
        "Volume preview exceeds its mesh budget. Lower Material removal resolution."
      )
    this.dirty.clear()
    this.combined = new Float32Array(this.positionCount)
    let offset = 0
    for (const chunk of this.chunks.values()) {
      this.combined.set(chunk, offset)
      offset += chunk.length
    }
    // The worker transfers the returned buffer, so keep the cached one intact.
    return this.combined.slice()
  }

  private meshChunk(index: number) {
    const [nx, ny] = this.counts
    const start = [
      index % nx,
      Math.floor(index / nx) % ny,
      Math.floor(index / (nx * ny)),
    ].map((coordinate) => coordinate * CHUNK)
    const end = start.map((coordinate, axis) =>
      Math.min(this.size[axis], coordinate + CHUNK)
    )
    const stride = [1, this.size[0], this.size[0] * this.size[1]]
    const positions: number[] = []
    const mask = new Uint8Array(CHUNK * CHUNK)
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3
      const v = (axis + 2) % 3
      const width = end[u] - start[u]
      const height = end[v] - start[v]
      for (const sign of [-1, 1]) {
        const neighbor = sign * stride[axis]
        for (let k = start[axis]; k < end[axis]; k++) {
          const boundary = k + sign < 0 || k + sign >= this.size[axis]
          for (let j = 0; j < height; j++) {
            const base =
              k * stride[axis] +
              (j + start[v]) * stride[v] +
              start[u] * stride[u]
            for (let i = 0; i < width; i++) {
              const at = base + i * stride[u]
              mask[j * width + i] = Number(
                this.solid[at] && (boundary || !this.solid[at + neighbor])
              )
            }
          }
          for (let j = 0; j < height; j++) {
            for (let i = 0; i < width; i++) {
              if (!mask[j * width + i]) continue
              let right = i + 1
              while (right < width && mask[j * width + right]) right++
              let bottom = j + 1
              rows: while (bottom < height) {
                for (let x = i; x < right; x++)
                  if (!mask[bottom * width + x]) break rows
                bottom++
              }
              for (let y = j; y < bottom; y++)
                mask.fill(0, y * width + i, y * width + right)
              const point = (x: number, y: number) => {
                const p = [0, 0, 0]
                p[axis] = (k + Number(sign > 0)) * this.spacing[axis]
                p[u] = (start[u] + x) * this.spacing[u]
                p[v] = (start[v] + y) * this.spacing[v]
                return p
              }
              const a = point(i, j)
              const b = point(right, j)
              const c = point(right, bottom)
              const d = point(i, bottom)
              if (sign > 0) positions.push(...a, ...b, ...c, ...a, ...c, ...d)
              else positions.push(...a, ...c, ...b, ...a, ...d, ...c)
              i = right - 1
            }
          }
        }
      }
    }
    return new Float32Array(positions)
  }
}
