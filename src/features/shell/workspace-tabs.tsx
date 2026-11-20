import { useLocation, useNavigate } from "@tanstack/react-router"
import { Cpu, Layers, Layers3, Play, Waves } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isJobActive } from "@/machine/contract"
import { useMachineSnapshot } from "@/platform/machine"

const SECTIONS = ["prepare", "patterns", "facing", "job", "device"] as const
type Section = (typeof SECTIONS)[number]

const isSection = (value: unknown): value is Section =>
  SECTIONS.some((section) => section === value)

/**
 * The workspace sections as tabs over routes: the URL is the source of truth. A red dot beside
 * Job shows that a job is under way.
 */
export function WorkspaceTabs() {
  const section = useLocation({
    select: (location) => location.pathname.split("/")[1],
  })
  const navigate = useNavigate()
  const running = isJobActive(useMachineSnapshot().job)
  return (
    <Tabs
      className="@container min-w-0"
      value={isSection(section) ? section : "prepare"}
      onValueChange={(value) => {
        if (isSection(value)) void navigate({ to: `/${value}` })
      }}
    >
      <TabsList
        variant="line"
        className="h-12 w-full justify-start gap-0 p-0"
        aria-label="Workspace"
      >
        <TabsTrigger
          value="prepare"
          title="Prepare"
          className="min-w-0 px-0 @[360px]:px-2"
        >
          <Layers3 />
          <span className="sr-only @[360px]:not-sr-only">Prepare</span>
        </TabsTrigger>
        <TabsTrigger
          value="patterns"
          title="Patterns"
          className="min-w-0 px-0 @[360px]:px-2"
        >
          <Waves />
          <span className="sr-only @[360px]:not-sr-only">Patterns</span>
        </TabsTrigger>
        <TabsTrigger
          value="facing"
          title="Facing"
          className="min-w-0 px-0 @[360px]:px-2"
        >
          <Layers />
          <span className="sr-only @[360px]:not-sr-only">Facing</span>
        </TabsTrigger>
        <TabsTrigger
          value="job"
          title="Job"
          className="min-w-0 px-0 @[360px]:px-2"
        >
          <Play />
          <span className="sr-only @[360px]:not-sr-only">Job</span>
          {running && (
            <>
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-destructive"
              />
              <span className="sr-only">(running)</span>
            </>
          )}
        </TabsTrigger>
        <TabsTrigger
          value="device"
          title="Device"
          className="min-w-0 px-0 @[360px]:px-2"
        >
          <Cpu />
          <span className="sr-only @[360px]:not-sr-only">Device</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}
