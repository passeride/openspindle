import { plateMachining } from "@/domain/compile/toolpath-bounds"
import { SpeedsFeeds } from "./speeds-feeds"
import { bedOffsetOf } from "@/domain/anchors/stored-anchors"
import { useEffect, useId, useMemo, useState } from "react"
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
import { createPreset } from "@/domain/tools/tool"
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
  const key = (name: string) =>
    name
      .toLowerCase()
      .replace(/aluminium/g, "aluminum")
      .replace(/[^a-z0-9]/g, "")
  const matches = tool.presets.filter((preset) => {
    const rpm = preset.rpm ?? 0
    return (
      preset.material &&
      key(preset.material) === key(material) &&
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
    rpm: preset.rpm ?? params.rpm,
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

function FacingFields({
  value,
  setup,
  onChange,
  onValidityChange,
}: {
  value: FacingParams
  setup: PlateSetup | undefined
  onChange: (p: FacingParams) => void
  onValidityChange: (valid: boolean) => void
}) {
  // Keep raw drafts, including invalid geometry, when presets replace cutting fields.
  const schema: z.ZodType<FacingParams, FacingParams> = FacingParamsSchema
  const form = useForm({
    defaultValues: value,
    validators: { onChange: schema },
    listeners: {
      onChange: ({ formApi }) => {
        onValidityChange(
          FacingParamsSchema.safeParse(formApi.state.values).success
        )
        onChange(formApi.state.values)
      },
    },
  })
  const id = useId()
  const primary = new Set(["removal", "rpm", "feed", "plunge"])
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
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-2">
        {FIELDS.filter(({ key }) => primary.has(key)).map(measurement)}
      </div>
      <details
        className="rounded-md border p-2"
        open={value.entryMode === "pocket" || undefined}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Area, passes and entry
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
                  <ToggleGroupItem value="outside">
                    Outside stock
                  </ToggleGroupItem>
                  <ToggleGroupItem value="pocket">
                    Cleared pocket
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
            </form.Field>
          </Field>
          {value.entryMode === "pocket" && (
            <FieldDescription>
              X/Y and width/depth define the cutter-centre rectangle. The cutter
              extends beyond it by its radius; corners and the tool-setter patch
              may remain unfaced. The entire cutter must fit in the pocket
              before it lowers.
            </FieldDescription>
          )}
          {[
            ...FIELDS.filter(({ key }) => !primary.has(key)),
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
                    I checked this pocket's position, opening and clear depth on
                    the installed bed, including screws, pins and metal
                    underneath.
                  </FieldLabel>
                </Field>
              )}
            </form.Field>
          )}
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
  const tools = useWorkspace((state) => state.tools)
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
  const available = [
    ...onPlate,
    ...compatible.filter((tool) => !onPlate.includes(tool)),
  ]
  const initialTool =
    onPlate.find((tool) => materialPreset(tool, material, range)) ??
    onPlate.at(0) ??
    compatible.find((tool) => materialPreset(tool, material, range)) ??
    available.at(0)
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
  const [valid, setValid] = useState(
    FacingParamsSchema.safeParse(params).success
  )
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
  const issue = facingToolIssue(tool)
  const matchingPreset = materialPreset(tool, material, range)
  const preset = tool?.presets.find((item) => item.id === presetId)
  const kit = plate ? kitForPlate(plate) : null
  const keepOuts = plate && kit ? facingKeepOuts(plate.setup, kit, params) : []
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
    setValid(FacingParamsSchema.safeParse(next).success)
  }
  const guard =
    !plate ||
    issue !== null ||
    !valid ||
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
    if (guard || !tool || !FacingParamsSchema.safeParse(params).success) return
    const nextSource = {
      kind: "facing" as const,
      tool: source?.tool ?? 1,
      params,
    }
    let savedId: string
    if (operation) {
      savedId = operation.id
      const result = workspace.dispatch({
        type: "operation.source",
        plateId: plate.id,
        operationId: operation.id,
        expectedRevision: revision,
        source: nextSource,
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
    <Button disabled={guard} onClick={apply}>
      {operation ? "Apply parameters" : "Create facing operation"}
    </Button>
  )
  const fields = (
    <FieldGroup>
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
      <Field>
        <FieldLabel>Tool</FieldLabel>
        <OptionSelect
          value={toolId}
          disabled={!!operation}
          options={available.map((item) => ({
            value: item.id,
            label: `${onPlate.includes(item) ? "On plate · " : ""}${item.name} · Ø${item.diameter} mm`,
          }))}
          onValueChange={(id) => {
            setToolId(id)
            const selectedTool = tools.find((t) => t.id === id)
            const matching = materialPreset(selectedTool, material, range)
            setPresetId(matching?.id ?? "")
            const diameter = selectedTool?.diameter ?? 1
            const geometry = {
              ...params,
              diameter,
              stepover: Math.min(params.stepover, diameter / 2),
              entryConfirmed: false,
            }
            const next = matching
              ? applyCuttingPreset(geometry, matching)
              : {
                  ...geometry,
                  rpm: 0,
                  feed: 0,
                  plunge: 0,
                }
            setParams(next)
            setValid(FacingParamsSchema.safeParse(next).success)
          }}
        />
      </Field>
      {issue && (
        <FieldDescription>
          {issue}{" "}
          {operation
            ? "Assign a suitable cutter in the plate's tool table before editing Facing."
            : "Edit the tool library before continuing."}
        </FieldDescription>
      )}
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
            setValid(FacingParamsSchema.safeParse(next).success)
          }}
        >
          Use current cutter diameter · {tool.diameter} mm
        </Button>
      )}
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
            setValid(FacingParamsSchema.safeParse(next).success)
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
            const selectedPreset = tool?.presets.find((item) => item.id === id)
            if (!selectedPreset) return
            const next = applyCuttingPreset(params, selectedPreset)
            setParams(next)
            setValid(FacingParamsSchema.safeParse(next).success)
          }}
        />
      </details>
      <FacingFields
        key={`${toolId}-${draft.key}`}
        value={params}
        setup={plate?.setup}
        onChange={draft.onChange}
        onValidityChange={setValid}
      />
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
                setValid(false)
              }}
            />
          </Field>
          <FieldDescription>
            The STEP model's screw recesses are Ø10 mm × 2 mm deep; the smaller
            through bore is Ø5.4 mm. Screws can reduce the usable depth.
            Choosing a candidate fills modeled dimensions; replace them with
            your measurements.
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
              setValid(false)
            }}
          >
            Use modeled XY travel as cutter-centre rectangle
          </Button>
        </>
      )}
      {pocketIssue && <FieldDescription>{pocketIssue}</FieldDescription>}
      <FieldDescription className="font-numeric">
        Diameter: {params.diameter} mm · Chip load:{" "}
        {tool && valid && chipLoad(tool, params) !== null
          ? `${chipLoad(tool, params)?.toFixed(4)} mm/tooth`
          : "Enter RPM, feed and flute count"}
        . Chip load = feed ÷ (RPM × cutting teeth); it is a calculation, not a
        suitability check.
      </FieldDescription>
      {tool && (
        <SpeedsFeeds
          diameter={params.diameter}
          teeth={tool.flutes ?? tool.geometry.numberOfTeeth ?? undefined}
          maxRPM={kit?.spindleRange?.max}
          onApply={(rpm, feed) => {
            const next = { ...params, rpm, feed }
            setParams(next)
            setValid(FacingParamsSchema.safeParse(next).success)
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
      {!valid && (
        <FieldDescription>
          Complete all numeric fields with valid cutting data. Invalid drafts
          cannot be applied.
        </FieldDescription>
      )}
      {!!operationId && operation?.revision !== revision && (
        <FieldDescription>
          This operation changed while the dialog was open. Reopen it to edit
          the current version.
        </FieldDescription>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{fields}</div>
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
