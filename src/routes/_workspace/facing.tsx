import { facingKeepOuts } from "@/domain/operations/facing"
import { kitForPlate } from "@/domain/fixtures/catalog"
import { useMemo, useState } from "react"
import type { FacingParams } from "@/domain/operations/facing"
import { PreparePage } from "@/features/prepare/prepare-page"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { selectedPlate, useWorkspace } from "@/app/workspace/workspace-context"
import { PrepareViewer } from "@/features/prepare/prepare-viewer"
import { FacingEditor } from "@/features/workshop/facing-dialog"

const id = z.string().min(1).max(200).optional().catch(undefined)

export const Route = createFileRoute("/_workspace/facing")({
  validateSearch: z.object({ plate: id, operation: id }),
  component: FacingRoute,
})

function FacingRoute() {
  const { plate: plateId, operation: operationId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const plate = useWorkspace((state) =>
    plateId
      ? state.plates.find((item) => item.id === plateId)
      : selectedPlate(state)
  )
  const operation = plate?.operations.find(
    (item) => item.id === operationId && item.source.kind === "facing"
  )
  const [draft, setDraft] = useState<{ key: string; params: FacingParams }>()
  const key = JSON.stringify([plate?.id, operationId])
  const onPreview = useMemo(
    () => (params: FacingParams) => setDraft({ key, params }),
    [key]
  )
  const preview = useMemo(() => {
    if (!plate || draft?.key !== key) return undefined
    const p = draft.params
    if (
      ![p.x, p.y, p.top, p.width, p.depth, p.removal].every(Number.isFinite) ||
      p.width <= 0 ||
      p.depth <= 0 ||
      p.removal <= 0
    )
      return undefined
    const [ox, oy, oz] = plate.setup.workOrigin
    const x = ox + p.x
    const y = oy + p.y
    const top = oz + p.top + 0.015
    const bottom = top - p.removal
    const w = p.width
    const d = p.depth
    const rect = (level: number) => [
      x,
      y,
      level,
      x + w,
      y,
      level,
      x + w,
      y,
      level,
      x + w,
      y + d,
      level,
      x + w,
      y + d,
      level,
      x,
      y + d,
      level,
      x,
      y + d,
      level,
      x,
      y,
      level,
    ]
    const grid = rect(top)
    for (let i = 1; i < 5; i++) {
      grid.push(x + (w * i) / 5, y, top, x + (w * i) / 5, y + d, top)
      grid.push(x, y + (d * i) / 5, top, x + w, y + (d * i) / 5, top)
    }
    const depth = rect(bottom)
    for (const [cx, cy] of [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ])
      depth.push(cx, cy, top, cx, cy, bottom)
    const protectedAreas = facingKeepOuts(
      plate.setup,
      kitForPlate(plate),
      p
    ).flatMap((area) => {
      const pad = p.diameter / 2 + area.margin
      const left = Math.max(x, ox + area.min[0] - pad)
      const right = Math.min(x + w, ox + area.max[0] + pad)
      const front = Math.max(y, oy + area.min[1] - pad)
      const back = Math.min(y + d, oy + area.max[1] + pad)
      if (left >= right || front >= back) return []
      return [
        left,
        front,
        top,
        right,
        front,
        top,
        right,
        front,
        top,
        right,
        back,
        top,
        right,
        back,
        top,
        left,
        back,
        top,
        left,
        back,
        top,
        left,
        front,
        top,
        left,
        front,
        top,
        right,
        back,
        top,
        right,
        front,
        top,
        left,
        back,
        top,
      ]
    })
    return {
      plateId: plate.id,
      width: 2,
      strokes: [
        {
          color: "#ff5267",
          through: true,
          positions: new Float32Array(protectedAreas),
        },
        { color: "#ffc62c", positions: new Float32Array(grid) },
        { color: "#fb8230", through: true, positions: new Float32Array(depth) },
      ],
    }
  }, [plate, draft, key])
  return (
    <PreparePage
      sidebar={
        <>
          <h1 className="shrink-0 border-b px-4 py-3 font-medium">
            {operation?.name ?? "Facing"}
          </h1>
          {preview && draft && (
            <p className="shrink-0 px-4 pt-2 text-xs text-muted-foreground">
              {draft.params.width.toFixed(2)} × {draft.params.depth.toFixed(2)}{" "}
              mm · Top {draft.params.top.toFixed(3)} → final Z{" "}
              {(draft.params.top - draft.params.removal).toFixed(3)} mm
            </p>
          )}
          <FacingEditor
            key={key}
            plateId={plateId ?? plate?.id}
            operationId={operationId}
            onPreview={onPreview}
            onSaved={(savedPlate, savedOperation) =>
              void navigate({
                search: { plate: savedPlate, operation: savedOperation },
                replace: true,
              })
            }
          />
        </>
      }
      viewer={<PrepareViewer preview={preview} />}
    />
  )
}
