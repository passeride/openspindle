import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function SpeedsFeeds({
  diameter,
  teeth,
  maxRPM = 13000,
  onApply,
}: {
  diameter?: number
  teeth?: number
  maxRPM?: number
  onApply: (rpm: number, feed: number) => void
}) {
  const [effective, setEffective] = useState("")
  const [edges, setEdges] = useState("")
  const [speed, setSpeed] = useState("")
  const [chip, setChip] = useState("")
  const d = Number(effective || diameter)
  const count = Number(edges || teeth)
  const vc = Number(speed)
  const fz = Number(chip)
  const requested = Math.floor((1000 * vc) / (Math.PI * d))
  const rpm = Math.min(maxRPM, requested)
  const feed = Math.round(rpm * count * fz)
  const ready =
    [d, count, rpm, feed].every(Number.isFinite) &&
    d > 0 &&
    Number.isInteger(count) &&
    count > 0 &&
    rpm >= 1000 &&
    feed >= 1 &&
    feed <= 10000
  return (
    <details className="rounded-md border p-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Calculate speeds and feeds
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label>
          Effective Ø (mm)
          <Input
            type="number"
            step="any"
            value={effective}
            placeholder={diameter?.toString()}
            onChange={(e) => setEffective(e.target.value)}
          />
        </label>
        <label>
          Cutting edges
          <Input
            type="number"
            step="1"
            value={edges}
            placeholder={teeth?.toString()}
            onChange={(e) => setEdges(e.target.value)}
          />
        </label>
        <label>
          Cutting speed (m/min)
          <Input
            type="number"
            step="any"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          />
        </label>
        <label>
          Chip load (mm/tooth)
          <Input
            type="number"
            step="any"
            value={chip}
            onChange={(e) => setChip(e.target.value)}
          />
        </label>
      </div>
      <p className="my-2 text-muted-foreground">
        Use cutter data for the material. For a V-bit, enter the cutting
        diameter at the engraving depth.
      </p>
      {ready && (
        <p>
          {rpm} RPM · {feed} mm/min
          {requested > maxRPM && " · spindle limit applied"}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!ready}
        onClick={() => onApply(rpm, feed)}
      >
        Apply RPM and feed
      </Button>
    </details>
  )
}
