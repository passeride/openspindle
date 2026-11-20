import { matchesCuttingMaterial } from "@/domain/tools/tool"
import { kitForPlate } from "@/domain/fixtures/catalog"
import { toast } from "sonner"
import {
  useSelectedPlate,
  useWorkspace,
  useWorkspaceStore,
} from "@/app/workspace/workspace-context"
import { PatternEditor } from "./pattern-editor"
import type { PatternSpec } from "@/domain/operations/pattern"
import type { PatternOutput } from "./pattern-core"

export function PatternPage({ operationId }: { operationId: string | null }) {
  const plate = useSelectedPlate()
  const operation = plate?.operations.find((item) => item.id === operationId)
  const pattern = operation?.source.kind === "pattern" ? operation : null
  const definition =
    operation?.source.kind === "pattern"
      ? operation.source.definition
      : undefined
  const workspace = useWorkspaceStore()
  const tools = useWorkspace((state) => state.tools)
  const libraryCutting = (local: number) => {
    const material = plate?.setup.stock?.material
    if (!plate || !material) return null
    const number =
      pattern?.tools.find((binding) => binding.local === local)?.plate ?? local
    const toolId = plate.tools.find((item) => item.number === number)?.toolId
    const tool = tools.find((item) => item.id === toolId)
    const matches = tool?.presets.filter((preset) =>
      matchesCuttingMaterial(preset, material)
    )
    if (matches?.length !== 1) return null
    const { feedRate, plungeFeed } = matches[0]
    const rpm = Math.round(matches[0].rpm ?? 0)
    const range = kitForPlate(plate).spindleRange
    if (
      !rpm ||
      !feedRate ||
      !plungeFeed ||
      (range && (rpm < range.min || rpm > range.max))
    )
      return null
    return { rpm, feed: feedRate, plunge: plungeFeed }
  }
  const cutting =
    definition &&
    pattern?.source.kind === "pattern" &&
    pattern.source.nc === null
      ? libraryCutting(definition.tool)
      : null
  const apply = (nextDefinition: PatternSpec, output: PatternOutput) => {
    if (!plate || !pattern) return
    const result = workspace.dispatch({
      type: "operation.source",
      plateId: plate.id,
      operationId: pattern.id,
      expectedRevision: pattern.revision,
      source: {
        kind: "pattern",
        tool: nextDefinition.tool,
        definition: nextDefinition,
        nc: output.generated.gcode,
      },
    })
    if (result.ok) toast.success("Toolpath added to the selected operation.")
    else toast.error(result.error)
  }
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <PatternEditor
          key={pattern?.id ?? "independent"}
          initial={
            definition && cutting ? { ...definition, ...cutting } : definition
          }
          libraryCutting={libraryCutting}
          onApply={pattern ? apply : undefined}
        />
      </div>
    </main>
  )
}
