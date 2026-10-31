import { adminApiGet } from "@/lib/adminApi.server";
import { EVENT_TYPES, RANGES, type EventPage, type Snapshot } from "@/lib/reliability";
import { EventTimeline } from "@/components/reliability/event-timeline";
import { UrlFilters } from "@/components/sentinel/url-filters";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function ReliabilityEventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const range = first(params.range) || "1h";
  const severity = first(params.severity);
  const component = first(params.component);
  const type = first(params.type);
  const before = first(params.before);
  const [page, snapshot] = await Promise.all([
    adminApiGet<EventPage>("/reliability/events", { range, severity, component, type, before, limit: 50 }),
    adminApiGet<Snapshot>("/reliability/snapshot").catch(() => null),
  ]);

  return (
    <div className="space-y-4">
      <UrlFilters
        filters={[
          { kind: "select", name: "range", label: "Time range", value: range, width: "w-40", options: RANGES.map((item) => ({ value: item.value, label: `Last ${item.value}` })) },
          { kind: "select", name: "severity", label: "Minimum severity", value: severity || "all", width: "w-40", options: [{ value: "all", label: "All severities" }, { value: "warning", label: "Warning and up" }, { value: "error", label: "Error and up" }, { value: "critical", label: "Critical only" }] },
          { kind: "select", name: "component", label: "Component", value: component || "all", options: [{ value: "all", label: "All components" }, ...(snapshot?.components ?? []).map((item) => ({ value: item.id, label: item.label }))] },
          { kind: "select", name: "type", label: "Event type", value: type || "all", options: [{ value: "all", label: "All event types" }, ...EVENT_TYPES] },
        ]}
      />
      <EventTimeline key={`${range}:${severity}:${component}:${type}:${before}`} page={page} filters={{ severity, component, type }} range={range} paged={Boolean(before)} />
    </div>
  );
}
