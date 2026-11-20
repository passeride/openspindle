import { useState } from "react"
import { Field, FieldDescription } from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"

export function MachinePercentField({
  label,
  min,
  max,
  reported,
  pending,
  reason,
  onCommit,
}: {
  label: string
  min: number
  max: number
  reported: number | null | undefined
  pending: boolean
  reason: string | null
  onCommit: (percent: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const value = Math.max(min, Math.min(max, draft ?? reported ?? min))
  return (
    <Field>
      <div className="flex justify-between gap-2 text-sm font-medium">
        {label}
        <span className="font-numeric text-muted-foreground">
          {draft ?? reported ?? "—"}
          {(draft ?? reported) != null ? "%" : ""}
        </span>
      </div>
      <Slider
        className="py-2"
        value={[value]}
        min={min}
        max={max}
        step={1}
        disabled={pending || reason !== null}
        thumbProps={{ "aria-label": label, "aria-valuetext": `${value}%` }}
        onValueChange={(next) =>
          setDraft(typeof next === "number" ? next : next[0])
        }
        onValueCommitted={(next) => {
          setDraft(null)
          const percent = typeof next === "number" ? next : next[0]
          if (!pending && !reason && percent !== reported) onCommit(percent)
        }}
      />
      {reason && <FieldDescription>{reason}</FieldDescription>}
    </Field>
  )
}
