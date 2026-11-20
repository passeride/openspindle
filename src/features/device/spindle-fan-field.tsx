import type {
  AvailabilityKey,
  MachineCommand,
  Telemetry,
} from "@/machine/contract"
import { MachinePercentField } from "./machine-percent-field"

export function SpindleFanField({
  telemetry,
  pending,
  reason,
  execute,
  duringJob = false,
}: {
  telemetry: Telemetry | null
  pending: boolean
  reason: (key: AvailabilityKey) => string | null
  execute: (action: MachineCommand) => void
  duringJob?: boolean
}) {
  const canSwitchOff =
    !duringJob &&
    telemetry?.state === "Idle" &&
    telemetry.job === null &&
    telemetry.spindleOn === false
  return (
    <MachinePercentField
      label="Spindle fan"
      min={canSwitchOff ? 0 : 1}
      max={100}
      reported={telemetry?.spindleAirPower}
      pending={pending}
      reason={reason("spindleFan")}
      onCommit={(percent) => execute({ type: "spindleFan", percent })}
    />
  )
}
