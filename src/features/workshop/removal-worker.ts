import { VoxelRemoval } from "@/domain/tools/voxel-removal"
import type { RemovalEngine } from "@/domain/tools/removal-resolution"
import { MaterialRemoval } from "@/domain/tools/material-removal"
import type { RemovalCursor } from "@/domain/tools/material-removal"

type Request = {
  id: number
  cursor: RemovalCursor
  input?: unknown
  engine?: RemovalEngine
}
let model: MaterialRemoval | VoxelRemoval | null = null
self.addEventListener("message", (event: MessageEvent<Request>) => {
  const { id, input, cursor, engine } = event.data
  try {
    if (input) {
      model = null
      model =
        engine === "volume"
          ? new VoxelRemoval(input)
          : new MaterialRemoval(input)
    }
    if (!model) throw new Error("The sampled removal model is unavailable.")
    const grid = model.at(cursor)
    self.postMessage(
      { id, grid, error: null },
      { transfer: [grid.volumePositions?.buffer ?? grid.heights.buffer] }
    )
  } catch (error) {
    self.postMessage({
      id,
      grid: null,
      error:
        error instanceof Error
          ? error.message
          : "Material removal could not be calculated.",
    })
  }
})
