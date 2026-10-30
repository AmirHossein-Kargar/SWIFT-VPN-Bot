"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

/** A page failed to load. Only the message is ours: the error itself is never shown, so it cannot leak server details. */
export default function SectionError({ reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  return (
    <div role="alert" className="animate-in fade-in-0 flex flex-col items-center gap-2 px-6 py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-warning" aria-hidden />
      <p className="text-sm font-medium">This page could not be loaded.</p>
      <p className="max-w-sm text-sm text-muted-foreground">Its data is unavailable right now, so nothing here should be read as current.</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => startTransition(() => { router.refresh(); reset(); })}
      >
        Try again
      </Button>
    </div>
  );
}
