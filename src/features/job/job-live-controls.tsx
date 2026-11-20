import { Alert, AlertDescription } from "@/components/ui/alert"
import { DeviceOverridesCard } from "@/features/device/device-overrides-card"
import { SpindleFanField } from "@/features/device/spindle-fan-field"
import { isJobActive } from "@/machine/contract"
import type { AvailabilityKey, MachineCommand } from "@/machine/contract"
import {
  useFreshTelemetry,
  useMachineCommand,
  useMachineSnapshot,
} from "@/platform/machine"

export function JobLiveControls() {
  const { job, availability, limits, connection } = useMachineSnapshot()
  const telemetry = useFreshTelemetry()
  const command = useMachineCommand()
  if (!isJobActive(job)) return null
  const reason = (key: AvailabilityKey) =>
    availability[key].allowed
      ? null
      : (availability[key].reason ?? "Unavailable.")
  const execute = (action: MachineCommand) => {
    if (!command.isPending && reason(action.type) === null)
      command.mutate(action)
  }
  return (
    <section
      key={connection.id}
      aria-label="Live machine controls"
      className="grid gap-3"
    >
      <DeviceOverridesCard
        telemetry={telemetry}
        limits={limits}
        pending={command.isPending}
        reason={reason}
        execute={execute}
        showTemperatures={false}
      />
      <div className="rounded-md border p-3">
        <SpindleFanField
          duringJob
          telemetry={telemetry}
          pending={command.isPending}
          reason={reason}
          execute={execute}
        />
      </div>
      {command.error && (
        <Alert variant="destructive">
          <AlertDescription>{command.error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  )
}
