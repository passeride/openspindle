import { workOriginOnMachine } from "@/domain/plate/work-origin"
import { useReadAnchorsFix } from "@/features/prepare/quick-fix"
import { plateMachining } from "@/domain/compile/toolpath-bounds"
import { ToolLibraryDialog } from "@/features/tool-library"
import { useWorkspaceLibrary } from "@/features/tool-library/workspace-tool-library"
import { SpeedsFeeds } from "./speeds-feeds"
import { bedOffsetOf } from "@/domain/anchors/stored-anchors"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { OptionSelect } from "@/components/option-select"
import {
  selectedPlate,
  useWorkspace,
  useWorkspaceStore,
} from "@/app/workspace/workspace-context"
import { createOperation } from "@/domain/operations/operation"
import {
  FacingParamsSchema,
  facingToolIssue,
  facingKeepOuts,
  facingPocketPaths,
  facingEntryFrameIssue,
} from "@/domain/operations/facing"
import type { FacingParams } from "@/domain/operations/facing"
import type { PlateSetup } from "@/domain/plate/plate"
import { createPreset, matchesCuttingMaterial } from "@/domain/tools/tool"
import type { Tool } from "@/domain/tools/tool"
import { kitForPlate } from "@/domain/fixtures/catalog"
import { useProbingDraft } from "@/features/probing/probing-form"
import {
  MeasurementField,
  probingField,
} from "@/features/probing/probing-fields"
import { AppDialog } from "@/features/shell/app-dialog"
import { openDialog } from "@/features/shell/dialogs"
import { usePrepareSelection } from "@/features/prepare/plate-tree/use-prepare-selection"

const FIELDS: {
  key: {
    [K in keyof FacingParams]-?: NonNullable<FacingParams[K]> extends number
      ? K
      : never
  }[keyof FacingParams]
  label: string
  unit: string
  description?: string
}[] = [
  { key: "x", label: "Front-left X", unit: "mm" },
  { key: "y", label: "Front-left Y", unit: "mm" },
  { key: "width", label: "Width · X", unit: "mm" },
  { key: "depth", label: "Depth · Y", unit: "mm" },
  {
    key: "top",
    label: "Starting top Z",
    unit: "mm",
    description:
      "Work coordinates. Match the measured surface and the actual work Z.",
  },
  { key: "removal", label: "Total removal", unit: "mm" },
  { key: "clearance", label: "Clearance above top", unit: "mm" },
  { key: "rpm", label: "Spindle", unit: "rpm" },
  { key: "feed", label: "Cutting feed", unit: "mm/min" },
  {
    key: "plunge",
    label: "Entry feed",
    unit: "mm/min",
    description: "Vertical feed while entering the verified clear space.",
  },
  { key: "stepdown", label: "Depth per pass", unit: "mm" },
  { key: "stepover", label: "Stepover", unit: "mm" },
]

const ENTRY_FIELDS: typeof FIELDS = [
  { key: "entryX", label: "Pocket centre X", unit: "mm" },
  { key: "entryY", label: "Pocket centre Y", unit: "mm" },
  { key: "entryDiameter", label: "Measured clear opening", unit: "mm" },
  { key: "entryDepth", label: "Measured clear depth from top", unit: "mm" },
]

function materialPreset(
  tool: Tool | undefined,
  material: string | undefined,
  range?: { min: number; max: number } | null
) {
  if (!tool || !material) return undefined
  const matches = tool.presets.filter((preset) => {
    const rpm = Math.round(preset.rpm ?? 0)
    return (
      matchesCuttingMaterial(preset, material) &&
      rpm > 0 &&
      (preset.feedRate ?? 0) > 0 &&
      (preset.plungeFeed ?? 0) > 0 &&
      (!range || (rpm >= range.min && rpm <= range.max))
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}

function applyCuttingPreset(
  params: FacingParams,
  preset: Tool["presets"][number]
): FacingParams {
  return {
    ...params,
    rpm: preset.rpm === null ? params.rpm : Math.round(preset.rpm),
    feed: preset.feedRate ?? params.feed,
    plunge: preset.plungeFeed ?? params.plunge,
    stepdown:
      preset.useStepdown === true
        ? Math.min(params.removal, preset.stepdown ?? params.stepdown)
        : params.stepdown,
    stepover:
      preset.useStepover === true
        ? Math.min(params.diameter / 2, preset.stepover ?? params.stepover)
        : params.stepover,
  }
}

const STEPS = [
  {
    title: "Tool",
    help: "Choose the tool installed for planing. Facing uses flat-ended cutters with a known diameter and cutting length.",
  },
  {
    title: "Area",
    help: "Choose what to flatten. Use the shared 3D view to check the location before setting the cut depth.",
  },
  {
    title: "Cut",
    help: "Set how much to remove and how fast the cutter moves. Use a preset for the stock material or enter values for your tool.",
  },
  {
    title: "Entry",
    help: "Tell Facing where the tool can lower. Outside stock needs open space beyond the edge. A cleared pocket requires measurements from the installed setup.",
  },
  {
    title: "Review",
    help: "Confirm the tool, area and final surface before saving this operation to the plate.",
  },
] as const

type FacingStep = (typeof STEPS)[number]["title"]
const AREA_FIELDS = new Set(["x", "y", "width", "depth", "top"])
const BASIC_CUT_FIELDS = new Set(["removal", "rpm", "feed", "plunge"])
const PASS_FIELDS = new Set(["stepover", "stepdown"])

function FacingLegend() {
  return (
    <ul aria-label="3D preview legend" className="grid gap-1 text-xs">
      <li>
        <span
          aria-hidden="true"
          className="mr-2 inline-block size-2 rounded-sm bg-[#ffc62c]"
        />
        Requested area at starting surface
      </li>
      <li>
        <span
          aria-hidden="true"
          className="mr-2 inline-block size-2 rounded-sm bg-[#fb8230]"
        />
        Final surface after removal
      </li>
      <li>
        <span
          aria-hidden="true"
          className="mr-2 inline-block size-2 rounded-sm bg-[#ff5267]"
        />
        Protected areas within the cut
      </li>
    </ul>
  )
}

function FacingFields({
  step,
  value,
  setup,
  onChange,
}: {
  step: FacingStep
  value: FacingParams
  setup: PlateSetup | undefined
  onChange: (p: FacingParams) => void
}) {
  // Keep raw drafts, including invalid geometry, when presets replace cutting fields.
  const schema: z.ZodType<FacingParams, FacingParams> = FacingParamsSchema
  const form = useForm({
    defaultValues: value,
    validators: { onChange: schema },
    listeners: {
      onChange: ({ formApi }) => {
        onChange(formApi.state.values)
      },
    },
  })
  const id = useId()
  const measurement = ({
    key,
    label,
    unit,
    description,
  }: (typeof FIELDS)[number]) =>
    probingField(
      form,
      key
    )((field) => (
      <MeasurementField
        key={key}
        id={`${id}-${key}`}
        label={label}
        description={description}
        unit={unit}
        value={field.value ?? null}
        errors={field.errors}
        disabled={false}
        onBlur={field.onBlur}
        onValueChange={(v) => {
          if (key.startsWith("entry") || key === "top")
            form.setFieldValue("entryConfirmed", false)
          field.onChange(v ?? NaN)
        }}
      />
    ))
  if (step === "Area")
    return (
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Set area manually
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {FIELDS.filter(({ key }) => AREA_FIELDS.has(key)).map(measurement)}
        </div>
      </details>
    )
  if (step === "Cut")
    return (
      <FieldGroup>
        <div className="grid grid-cols-2 gap-2">
          {FIELDS.filter(({ key }) => BASIC_CUT_FIELDS.has(key)).map(
            measurement
          )}
        </div>
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer text-sm font-medium">
            Pass depth and spacing
          </summary>
          <FieldDescription>
            The depth controls how much is removed per pass. Stepover is the
            distance between adjacent cutting rows.
          </FieldDescription>
          {FIELDS.filter(({ key }) => PASS_FIELDS.has(key)).map(measurement)}
        </details>
      </FieldGroup>
    )
  if (step !== "Entry") return null
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Entry method</FieldLabel>
        <form.Field name="entryMode">
          {(field) => (
            <ToggleGroup
              variant="outline"
              aria-label="Facing entry method"
              value={[field.state.value ?? "outside"]}
              onValueChange={(values) => {
                const mode = values[0]
                if (mode !== "outside" && mode !== "pocket") return
                if (mode === "outside") {
                  form.setFieldValue("borderFirst", false)
                  form.setFieldValue("entryX", undefined)
                  form.setFieldValue("entryY", undefined)
                  form.setFieldValue("entryDiameter", undefined)
                  form.setFieldValue("entryDepth", undefined)
                  form.setFieldValue("entryFrame", undefined)
                }
                form.setFieldValue("entryConfirmed", false)
                field.handleChange(mode)
              }}
            >
              <ToggleGroupItem value="outside">Outside stock</ToggleGroupItem>
              <ToggleGroupItem value="pocket">Cleared pocket</ToggleGroupItem>
            </ToggleGroup>
          )}
        </form.Field>
      </Field>
      {value.entryMode === "pocket" && (
        <FieldDescription>
          X/Y and width/depth define the cutter-centre rectangle. The cutter
          extends beyond it by its radius; corners and the tool-setter patch may
          remain unfaced. The entire cutter must fit in the pocket before it
          lowers.
        </FieldDescription>
      )}
      {[
        ...FIELDS.filter(({ key }) => key === "clearance"),
        ...(value.entryMode === "pocket" ? ENTRY_FIELDS : []),
      ].map(measurement)}
      {value.entryMode === "pocket" && (
        <form.Field name="entryConfirmed">
          {(field) => (
            <Field orientation="horizontal">
              <Checkbox
                id={`${id}-entry-confirmed`}
                checked={
                  field.state.value === true &&
                  !!setup &&
                  !facingEntryFrameIssue(value, setup)
                }
                disabled={!setup}
                onCheckedChange={(checked) => {
                  if (!setup) return
                  form.setFieldValue(
                    "entryFrame",
                    structuredClone({
                      deviceId: setup.deviceId,
                      workOrigin: setup.workOrigin,
                      anchors: setup.anchors,
                    })
                  )
                  field.handleChange(checked === true)
                }}
              />
              <FieldLabel htmlFor={`${id}-entry-confirmed`}>
                I checked this pocket's position, opening and clear depth on the
                installed bed, including screws, pins and metal underneath.
              </FieldLabel>
            </Field>
          )}
        </form.Field>
      )}
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">
          Cutting direction and border pass
        </summary>
        <FieldGroup className="mt-2">
          <Field>
            <FieldLabel htmlFor={`${id}-pattern`}>Facing pattern</FieldLabel>
            <form.Field name="pattern">
              {(field) => (
                <OptionSelect
                  id={`${id}-pattern`}
                  value={field.state.value ?? "horizontal"}
                  options={[
                    { value: "horizontal", label: "Horizontal · X" },
                    { value: "vertical", label: "Vertical · Y" },
                    { value: "cross-hatch", label: "Cross-hatch · X then Y" },
                  ]}
                  onValueChange={field.handleChange}
                />
              )}
            </form.Field>
            <FieldDescription>
              Cross-hatch cuts both directions at the same Z for each depth
              pass. It does not double the removal.
            </FieldDescription>
          </Field>
          <form.Field name="borderFirst">
            {(field) => (
              <Field orientation="horizontal">
                <Checkbox
                  id={`${id}-border`}
                  checked={field.state.value ?? false}
                  disabled={value.entryMode !== "pocket"}
                  onCheckedChange={(checked) =>
                    field.handleChange(checked === true)
                  }
                />
                <FieldLabel htmlFor={`${id}-border`}>
                  Border first · requires a verified cleared pocket
                </FieldLabel>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
      </details>
    </FieldGroup>
  )
}

type FacingEditorProps = {
  onPreview?: (params: FacingParams) => void
  plateId?: string
  operationId?: string
  onSaved?: (plateId: string, operationId: string) => void
  onClose?: () => void
}

export function FacingDialog(
  props: FacingEditorProps & { onClose: () => void }
) {
  return <FacingEditor {...props} />
}

export function FacingEditor({
  plateId: requestedPlate,
  operationId,
  onClose,
  onSaved,
  onPreview,
}: FacingEditorProps) {
  const workspace = useWorkspaceStore()
  const selected = useWorkspace(selectedPlate)
  const [plateId] = useState(requestedPlate ?? selected?.id ?? null)
  const plate = useWorkspace((state) =>
    state.plates.find((p) => p.id === plateId)
  )
  const library = useWorkspaceLibrary()
  const { tools } = library
  const [toolLibraryOpen, setToolLibraryOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const step = STEPS[stepIndex]
  const scrollRegion = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRegion.current) scrollRegion.current.scrollTop = 0
  }, [stepIndex])
  const selection = usePrepareSelection()
  const operation = plate?.operations.find((op) => op.id === operationId)
  const source = operation?.source.kind === "facing" ? operation.source : null
  const [revision, setRevision] = useState(operation?.revision)
  const existingToolId = plate?.tools.find(
    (entry) =>
      entry.number ===
      operation?.tools.find((binding) => binding.local === source?.tool)?.plate
  )?.toolId
  const material = plate?.setup.stock?.material
  const range = plate ? kitForPlate(plate).spindleRange : null
  const compatible = tools.filter((tool) => !facingToolIssue(tool))
  const onPlate = compatible.filter((tool) =>
    plate?.tools.some((entry) => entry.toolId === tool.id)
  )
  const initialTool =
    onPlate.find((tool) => materialPreset(tool, material, range)) ??
    onPlate.at(0) ??
    compatible.find((tool) => materialPreset(tool, material, range)) ??
    compatible.at(0)
  const [toolId, setToolId] = useState(
    operationId !== undefined ? (existingToolId ?? "") : (initialTool?.id ?? "")
  )
  const tool = tools.find((item) => item.id === toolId)
  const [params, setParams] = useState<FacingParams>(() => {
    if (source) return source.params
    const stock = plate?.setup.stock
    const origin = plate?.setup.workOrigin ?? [0, 0, 0]
    const anchor = plate?.setup.stockAnchor ?? [0, 0, 0]
    const initial: FacingParams = {
      x: anchor[0] - origin[0],
      y: anchor[1] - origin[1],
      width: stock?.width ?? 100,
      depth: stock?.depth ?? 100,
      top: anchor[2] + (stock?.height ?? 0) - origin[2],
      diameter: tool?.diameter ?? 1,
      removal: 0.1,
      stepdown: 0.1,
      stepover: (tool?.diameter ?? 1) / 2,
      clearance: 5,
      rpm: 0,
      feed: 0,
      plunge: 0,
    }
    const preset = materialPreset(tool, material, range)
    return preset ? applyCuttingPreset(initial, preset) : initial
  })
  useEffect(() => {
    onPreview?.(params)
  }, [onPreview, params])
  const draft = useProbingDraft(params, setParams)
  const [presetId, setPresetId] = useState(() =>
    operationId ? "" : (materialPreset(tool, material, range)?.id ?? "")
  )
  const [presetName, setPresetName] = useState("")
  const presetForm = useForm({
    defaultValues: { name: "" },
    validators: {
      onChange: z.object({ name: z.string().trim().min(1).max(200) }),
    },
    listeners: {
      onChange: ({ formApi }) => setPresetName(formApi.state.values.name),
    },
  })
  const presetNameId = useId()
  const toolButtonId = useId()
  const issue = facingToolIssue(tool)
  const matchingPreset = materialPreset(tool, material, range)
  const preset = tool?.presets.find((item) => item.id === presetId)
  const kit = plate ? kitForPlate(plate) : null
  const keepOuts = plate && kit ? facingKeepOuts(plate.setup, kit, params) : []
  const originUnresolved =
    !!plate && keepOuts.length > 0 && !workOriginOnMachine(plate.setup)
  const anchor = plate?.setup.anchors?.anchors.at(0)
  const readAnchors = useReadAnchorsFix(plate?.id ?? null)
  const usePlateOrigin = () => {
    if (!plate || !anchor) return
    const result = workspace.dispatch({
      type: "plate.setup",
      plateId: plate.id,
      patch: { workOriginAnchor: anchor.id, machineOrigin: false },
    })
    if (!result.ok) toast.error(result.error)
  }
  const pocketIssue =
    plate && kit
      ? (facingEntryFrameIssue(params, plate.setup) ??
        facingPocketPaths(params, keepOuts).issue)
      : null
  const stock = plate?.setup.stock
  const firstTarget =
    plate?.operations.findIndex(
      (item) =>
        !item.suppressed &&
        item.source.kind !== "probing" &&
        item.source.kind !== "facing"
    ) ?? -1
  const footprint = useMemo(() => {
    if (!plate) return null
    const start = operationId
      ? plate.operations.findIndex((item) => item.id === operationId) + 1
      : 0
    const operations = plate.operations
      .slice(start)
      .filter(
        (item) =>
          !item.suppressed &&
          item.source.kind !== "probing" &&
          item.source.kind !== "facing"
      )
    return operations.length
      ? plateMachining({ ...plate, operations }).workArea()
      : null
  }, [plate, operationId])
  const fitArea = (
    min: readonly [number, number],
    max: readonly [number, number]
  ) => {
    if (!plate || !stock) return
    const [x, y, originZ] = plate.setup.workOrigin
    const next = {
      ...params,
      x: min[0] - x,
      y: min[1] - y,
      width: max[0] - min[0],
      depth: max[1] - min[1],
      top: plate.setup.stockAnchor[2] + stock.height - originZ,
      entryConfirmed: false,
    }
    setParams(next)
  }
  const checkedParams = FacingParamsSchema.safeParse(params)
  const valid = checkedParams.success
  const guard =
    !plate ||
    issue !== null ||
    !valid ||
    tool?.diameter !== params.diameter ||
    pocketIssue !== null ||
    (operationId !== undefined && (!source || operation?.revision !== revision))
  const savePreset = () => {
    if (!tool || !valid || !presetName.trim()) return
    const next = {
      ...createPreset(tool.presets),
      name: presetName.trim(),
      material: plate?.setup.stock?.material ?? null,
      rpm: params.rpm,
      feedRate: params.feed,
      plungeFeed: params.plunge,
      stepdown: params.stepdown,
      stepover: params.stepover,
      useStepdown: true,
      useStepover: true,
      feedPerTooth: chipLoad(tool, params),
    }
    const result = workspace.dispatch({
      type: "library.tools",
      tools: workspace.state.tools.map((item) =>
        item.id === tool.id
          ? { ...item, presets: [...item.presets, next] }
          : item
      ),
    })
    if (!result.ok) toast.error(result.error)
    else {
      setPresetId(next.id)
      toast.success("Cutting preset saved to this tool.")
    }
  }
  const apply = () => {
    if (guard) return
    const nextSource = {
      kind: "facing" as const,
      tool: source?.tool ?? 1,
      params,
    }
    let savedId: string
    if (operation) {
      savedId = operation.id
      const result = workspace.dispatch({
        type: "batch",
        commands: [
          {
            type: "operation.source",
            plateId: plate.id,
            operationId: operation.id,
            expectedRevision: revision,
            source: nextSource,
          },
          {
            type: "operation.tools",
            plateId: plate.id,
            operationId: operation.id,
            tools: new Map([[nextSource.tool, tool.id]]),
          },
        ],
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
    } else {
      const added = createOperation("Facing", nextSource)
      const result = workspace.dispatch({
        type: "operation.add",
        plateId: plate.id,
        operation: added,
        index: firstTarget < 0 ? undefined : firstTarget,
        preferredTools: new Map([[nextSource.tool, tool.id]]),
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      savedId = added.id
      selection.selectOperation(plate.id, added.id)
    }
    if (onSaved && operation) {
      const saved = workspace.state.plates
        .find((item) => item.id === plate.id)
        ?.operations.find((item) => item.id === savedId)
      setRevision(saved?.revision)
    }
    onSaved?.(plate.id, savedId)
    onClose?.()
  }
  const footer = (
    <div className="flex w-full justify-between gap-2">
      <Button
        variant="outline"
        disabled={stepIndex === 0}
        onClick={() => setStepIndex(stepIndex - 1)}
      >
        Back
      </Button>
      {step.title === "Review" ? (
        <Button disabled={guard} onClick={apply}>
          {operation ? "Apply parameters" : "Create facing operation"}
        </Button>
      ) : (
        <Button onClick={() => setStepIndex(stepIndex + 1)}>
          Next: {STEPS[stepIndex + 1]?.title}
        </Button>
      )}
    </div>
  )
  const fields = (
    <FieldGroup>
      <nav aria-label="Facing setup steps" className="flex flex-wrap gap-1">
        {STEPS.map((item, index) => (
          <Button
            key={item.title}
            size="sm"
            variant={index === stepIndex ? "secondary" : "ghost"}
            aria-current={index === stepIndex ? "step" : undefined}
            onClick={() => setStepIndex(index)}
          >
            {item.title}
          </Button>
        ))}
      </nav>
      <div aria-live="polite" className="space-y-1">
        <h2 className="font-medium">
          {stepIndex + 1} of {STEPS.length} · {step.title}
        </h2>
        <FieldDescription>{step.help}</FieldDescription>
      </div>
      {step.title === "Area" && (
        <>
          <FacingLegend />
          {originUnresolved && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                Set work XY for fixture clearance
              </p>
              <FieldDescription>
                Facing needs a fixed work origin to locate protected areas.
                Using plate XY keeps the current position in the preview and
                sets that XY from the anchor when the job starts.
              </FieldDescription>
              <div className="flex flex-wrap gap-2">
                {anchor && (
                  <Button variant="outline" size="sm" onClick={usePlateOrigin}>
                    Use plate XY from {anchor.name}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={readAnchors.pending || !!readAnchors.reason}
                  title={readAnchors.reason ?? undefined}
                  onClick={readAnchors.run}
                >
                  Read anchors
                </Button>
              </div>
              {readAnchors.reason && !anchor && (
                <FieldDescription>{readAnchors.reason}</FieldDescription>
              )}
            </div>
          )}
          {keepOuts.length > 0 && (
            <FieldDescription>
              Protected:{" "}
              {[...new Set(keepOuts.map((area) => area.name))].join(", ")}. The
              toolpath leaves these areas uncut.
            </FieldDescription>
          )}
          {!plate && (
            <Button
              variant="outline"
              onClick={() => openDialog({ kind: "guided-setup" })}
            >
              Create a setup first
            </Button>
          )}
          {plate && stock && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  fitArea(
                    [plate.setup.stockAnchor[0], plate.setup.stockAnchor[1]],
                    [
                      plate.setup.stockAnchor[0] + stock.width,
                      plate.setup.stockAnchor[1] + stock.depth,
                    ]
                  )
                }
              >
                Face stock
              </Button>
              <Button
                variant="outline"
                disabled={
                  !footprint?.ok ||
                  footprint.covers !== "cuts" ||
                  footprint.area.min.some(
                    (value, axis) => value >= footprint.area.max[axis]
                  )
                }
                onClick={() => {
                  if (footprint?.ok && footprint.covers === "cuts")
                    fitArea(footprint.area.min, footprint.area.max)
                }}
              >
                Fit to cutting operations
              </Button>
            </div>
          )}
        </>
      )}
      {step.title === "Tool" && (
        <>
          <Field>
            <FieldLabel htmlFor={toolButtonId}>Tool</FieldLabel>
            <Button
              id={toolButtonId}
              variant="outline"
              onClick={() => setToolLibraryOpen(true)}
            >
              {tool ? `Change tool · ${tool.name}` : "Choose a tool"}
            </Button>
          </Field>
          {issue && <FieldDescription>{issue}</FieldDescription>}
          {tool && tool.diameter !== params.diameter && (
            <Button
              variant="outline"
              onClick={() => {
                const diameter = tool.diameter ?? params.diameter
                const next = {
                  ...params,
                  diameter,
                  stepover: Math.min(params.stepover, diameter / 2),
                  entryConfirmed: false,
                }
                setParams(next)
              }}
            >
              Use current cutter diameter · {tool.diameter} mm
            </Button>
          )}
        </>
      )}
      {step.title === "Cut" && (
        <>
          <figure className="space-y-2 rounded-md border p-3 text-xs">
            <figcaption>
              Side view · removal is measured down from the starting surface.
            </figcaption>
            <div aria-hidden="true" className="grid gap-1">
              <div className="border-b-2 border-[#ffc62c] pb-1">
                Starting surface
              </div>
              <div className="border-b-2 border-[#fb8230] bg-[#fb8230]/10 py-2">
                ↓{" "}
                {Number.isFinite(params.removal) && params.removal > 0
                  ? `${params.removal} mm`
                  : "Removal"}
              </div>
              <div>Final surface</div>
            </div>
            <span className="sr-only">Removal: {params.removal} mm.</span>
          </figure>
          <FieldDescription>
            {material ? `Stock: ${material}` : "Stock material not set"}
            {presetId && preset
              ? ` · Preset: ${preset.name}`
              : " · No cutting preset applied"}
          </FieldDescription>
          {matchingPreset && presetId !== matchingPreset.id && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const next = applyCuttingPreset(params, matchingPreset)
                setPresetId(matchingPreset.id)
                setParams(next)
              }}
            >
              Use material preset · {matchingPreset.name}
            </Button>
          )}
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-sm font-medium">
              Choose another cutting preset
            </summary>
            <OptionSelect
              value={presetId}
              options={[
                { value: "", label: "Choose a preset" },
                ...(tool?.presets.map((item) => ({
                  value: item.id,
                  label: item.material
                    ? `${item.name} · ${item.material}`
                    : item.name,
                })) ?? []),
              ]}
              onValueChange={(id) => {
                setPresetId(id)
                const selectedPreset = tool?.presets.find(
                  (item) => item.id === id
                )
                if (!selectedPreset) return
                const next = applyCuttingPreset(params, selectedPreset)
                setParams(next)
              }}
            />
          </details>
        </>
      )}
      <FacingFields
        step={step.title}
        key={`${toolId}-${draft.key}`}
        value={params}
        setup={plate?.setup}
        onChange={draft.onChange}
      />
      {step.title === "Entry" && (
        <>
          {params.entryMode === "pocket" && kit && plate && (
            <>
              <Field>
                <FieldLabel>Modeled MDF recess · candidate only</FieldLabel>
                <OptionSelect
                  value=""
                  options={[
                    {
                      value: "",
                      label:
                        "Choose a recess to inspect, or enter measurements above",
                    },
                    ...kit.facingEntryPockets.map((pocket, index) => ({
                      value: String(index),
                      label: pocket.name,
                    })),
                  ]}
                  onValueChange={(value) => {
                    if (value === "") return
                    const index = Number(value)
                    if (
                      !Number.isInteger(index) ||
                      index < 0 ||
                      index >= kit.facingEntryPockets.length
                    )
                      return
                    const pocket = kit.facingEntryPockets[index]
                    const next = {
                      ...params,
                      entryX:
                        pocket.xy[0] +
                        bedOffsetOf(plate.setup.anchors)[0] -
                        plate.setup.workOrigin[0],
                      entryY:
                        pocket.xy[1] +
                        bedOffsetOf(plate.setup.anchors)[1] -
                        plate.setup.workOrigin[1],
                      entryDiameter: pocket.diameter,
                      entryDepth: pocket.depth,
                      entryConfirmed: false,
                    }
                    setParams(next)
                  }}
                />
              </Field>
              <FieldDescription>
                The STEP model's screw recesses are Ø10 mm × 2 mm deep; the
                smaller through bore is Ø5.4 mm. Screws can reduce the usable
                depth. Choosing a candidate fills modeled dimensions; replace
                them with your measurements.
              </FieldDescription>
              <Button
                variant="outline"
                onClick={() => {
                  const next = {
                    ...params,
                    x: kit.workAreaOrigin[0] - plate.setup.workOrigin[0],
                    y: kit.workAreaOrigin[1] - plate.setup.workOrigin[1],
                    width: kit.workArea[0],
                    depth: kit.workArea[1],
                    entryConfirmed: false,
                  }
                  setParams(next)
                }}
              >
                Use modeled XY travel as cutter-centre rectangle
              </Button>
            </>
          )}
          {pocketIssue && <FieldDescription>{pocketIssue}</FieldDescription>}
        </>
      )}
      {step.title === "Cut" && (
        <>
          <FieldDescription className="font-numeric">
            Diameter: {params.diameter} mm · Chip load:{" "}
            {tool && valid && chipLoad(tool, params) !== null
              ? `${chipLoad(tool, params)?.toFixed(4)} mm/tooth`
              : "Enter RPM, feed and flute count"}
            . Chip load = feed ÷ (RPM × cutting teeth); it is a calculation, not
            a suitability check.
          </FieldDescription>
          {tool && (
            <SpeedsFeeds
              diameter={params.diameter}
              teeth={tool.flutes ?? tool.geometry.numberOfTeeth ?? undefined}
              maxRPM={kit?.spindleRange?.max}
              onApply={(rpm, feed) => {
                const next = { ...params, rpm, feed }
                setParams(next)
              }}
            />
          )}
          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-sm font-medium">
              Save a cutting preset
            </summary>
            <Field>
              <FieldLabel htmlFor={presetNameId}>
                Save these cutting values as a preset
              </FieldLabel>
              <presetForm.Field name="name">
                {(field) => (
                  <Input
                    id={presetNameId}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="Name for this cutter and material"
                    maxLength={200}
                  />
                )}
              </presetForm.Field>
            </Field>
            <Button
              variant="outline"
              disabled={!tool || !valid || !presetName.trim()}
              onClick={savePreset}
            >
              Save named cutting preset
            </Button>
          </details>
        </>
      )}
      {step.title === "Review" && (
        <>
          <FacingLegend />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border p-3 font-numeric text-sm">
            <dt>Tool</dt>
            <dd>
              {tool?.name ?? "Choose a tool"} · Ø{params.diameter} mm
            </dd>
            <dt>Area</dt>
            <dd>
              {params.width} × {params.depth} mm
            </dd>
            <dt>Surface</dt>
            <dd>
              Z {params.top.toFixed(3)} →{" "}
              {(params.top - params.removal).toFixed(3)} mm
            </dd>
            <dt>Cutting</dt>
            <dd>
              {params.rpm} RPM · {params.feed} mm/min
            </dd>
            <dt>Passes</dt>
            <dd>
              {params.stepdown} mm deep · {params.stepover} mm apart
            </dd>
            <dt>Entry</dt>
            <dd>
              {params.entryMode === "pocket"
                ? "Cleared pocket"
                : "Outside stock"}
            </dd>
          </dl>
          {!plate && (
            <FieldDescription>
              Area: Create a setup before saving.
            </FieldDescription>
          )}
          {issue && <FieldDescription>Tool: {issue}</FieldDescription>}
          {tool && tool.diameter !== params.diameter && (
            <FieldDescription>
              Tool: Apply the current diameter in the Tool step.
            </FieldDescription>
          )}
          {originUnresolved && (
            <FieldDescription>
              Area: Set work XY before running the operation to locate protected
              areas.
            </FieldDescription>
          )}
          {pocketIssue && (
            <FieldDescription>Entry: {pocketIssue}</FieldDescription>
          )}
          {!!operation && (
            <Button
              variant="outline"
              onClick={() =>
                openDialog({
                  kind: "source",
                  plateId: plateId!,
                  operationId: operation.id,
                })
              }
            >
              View committed program
            </Button>
          )}
          {!checkedParams.success && (
            <ul
              aria-label="Fields to check"
              className="list-disc space-y-1 pl-4 text-sm text-destructive"
            >
              {checkedParams.error.issues.map((error, index) => {
                const name = error.path[0]
                const label = [...FIELDS, ...ENTRY_FIELDS].find(
                  ({ key }) => key === name
                )?.label
                return (
                  <li key={index}>
                    {label ? `${label}: ` : ""}
                    {error.message}
                  </li>
                )
              })}
            </ul>
          )}
          {!!operationId && operation?.revision !== revision && (
            <FieldDescription>
              This operation changed while the dialog was open. Reopen it to
              edit the current version.
            </FieldDescription>
          )}
        </>
      )}
      {toolLibraryOpen && (
        <ToolLibraryDialog
          title="Choose a tool"
          tools={tools}
          selectedId={toolId}
          selectionOnly
          recommendedKinds={["flat end mill", "face mill"]}
          selectionIssue={facingToolIssue}
          onChange={library.onChange}
          onSelect={(id) => {
            if (id === toolId) return
            const selectedTool = workspace.state.tools.find(
              (item) => item.id === id
            )
            const matching = materialPreset(selectedTool, material, range)
            const diameter = selectedTool?.diameter ?? params.diameter
            const geometry = {
              ...params,
              diameter,
              stepover: Math.min(params.stepover, diameter / 2),
              entryConfirmed: false,
            }
            const next = matching
              ? applyCuttingPreset(geometry, matching)
              : { ...geometry, rpm: 0, feed: 0, plunge: 0 }
            setToolId(id)
            setPresetId(matching?.id ?? "")
            setParams(next)
          }}
          onClose={() => setToolLibraryOpen(false)}
        />
      )}
    </FieldGroup>
  )
  if (onClose)
    return (
      <AppDialog
        title={operation ? "Edit facing" : "Facing wizard"}
        width="wide"
        onClose={onClose}
        footer={footer}
      >
        {fields}
      </AppDialog>
    )
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRegion} className="min-h-0 flex-1 overflow-y-auto p-4">
        {fields}
      </div>
      <div className="shrink-0 border-t p-4">{footer}</div>
    </div>
  )
}

function chipLoad(tool: Tool, params: FacingParams): number | null {
  const teeth = tool.flutes ?? tool.geometry.numberOfTeeth
  return teeth && teeth > 0 && params.rpm > 0
    ? params.feed / (params.rpm * teeth)
    : null
}
