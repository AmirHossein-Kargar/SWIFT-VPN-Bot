import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while a new section's server data loads. Held back a moment by CSS so a fast change never flashes it. */
export function SectionSkeleton() {
  return (
    <div className="section-skeleton space-y-4" role="status" aria-label="Loading">
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-full max-w-xs" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-40" />
      </div>
      <Card>
        <CardContent className="space-y-1 p-0">
          <Skeleton className="m-4 h-5 w-1/3" />
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div key={row} className="flex items-center gap-4 border-t border-border p-3">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-4 w-1/6" />
              <Skeleton className="hidden h-4 w-1/6 sm:block" />
              <Skeleton className="ml-auto h-5 w-16" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
