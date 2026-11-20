import { Gauge } from "lucide-react"
import { FieldGroup } from "@/components/ui/field"
import type {
  AvailabilityKey,
  ControlLimits,
  MachineCommand,
  Telemetry,
} from "@/machine/contract"
import { MachinePercentField } from "./machine-percent-field"
import { numberText } from "./device-format"
import { ControlCard } from "./device-control-card"

/** The feed and spindle overrides: their reported percent and sliders to adjust them. */
export function DeviceOverridesCard({
  telemetry,
  limits,
  pending,
  reason,
  execute,
  showTemperatures = true,
}: {
  telemetry: Telemetry | null
  limits: ControlLimits | null
  pending: boolean
  reason: (key: AvailabilityKey, action?: MachineCommand) => string | null
  execute: (action: MachineCommand) => void
  showTemperatures?: boolean
}) {
  return (
    <ControlCard title="Overrides" icon={<Gauge size={16} />}>
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        {(["feedOverride", "spindleOverride"] as const).map((type) => (
          <MachinePercentField
            key={type}
            label={
              type === "feedOverride" ? "Feed override" : "Spindle override"
            }
            min={limits?.overrideMin ?? 10}
            max={limits?.overrideMax ?? 200}
            reported={telemetry?.[type]}
            pending={pending}
            reason={reason(type)}
            onCommit={(percent) => execute({ type, percent })}
          />
        ))}
      </FieldGroup>
      {showTemperatures && (
        <dl className="grid gap-4 sm:grid-cols-2 [&_dd]:font-numeric">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Spindle</dt>
            <dd>{numberText(telemetry?.spindleTemperature)} °C</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Controller</dt>
            <dd>{numberText(telemetry?.controllerTemperature)} °C</dd>
          </div>
        </dl>
      )}
    </ControlCard>
  )
}
