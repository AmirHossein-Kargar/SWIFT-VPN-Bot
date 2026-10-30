import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { guideImage, type GuideStep } from "@/components/payment-guide";
import { fa } from "@/lib/format";

/** Enlarged guide image. Stays in step with the guide behind it, so closing leaves the visitor where they ended up. */
export function GuideLightbox({ steps, index, onIndex, onClose }: { steps: GuideStep[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const step = steps[index];
  if (!step) return null;
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Arrow keys follow the reading direction, like the stepper.
    const target = event.key === "ArrowLeft" ? index + 1 : event.key === "ArrowRight" ? index - 1 : -1;
    if (target < 0 || target >= steps.length) return;
    event.preventDefault();
    onIndex(target);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[560px]" onKeyDown={onKeyDown}>
        <div className="p-5 pb-3 pe-16">
          <p className="mb-0.5 text-[13px] font-extrabold text-brand" aria-live="polite">مرحلهٔ {fa(index + 1)} از {fa(steps.length)}</p>
          <DialogTitle>{step.title}</DialogTitle>
        </div>
        <div className="px-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={step.id} src={guideImage(step)} alt={step.alt} width={400} height={500} className="animate-rise mx-auto aspect-[4/5] max-h-[62dvh] w-auto max-w-full rounded-2xl border border-border-strong" />
        </div>
        <DialogDescription className="px-5 pt-3 text-center">{step.caption}</DialogDescription>
        <div className="flex justify-between gap-2.5 p-5">
          <Button variant="outline" disabled={index === 0} onClick={() => onIndex(index - 1)}><ChevronRight aria-hidden="true" />قبلی</Button>
          <Button disabled={index === steps.length - 1} onClick={() => onIndex(index + 1)}>بعدی<ChevronLeft aria-hidden="true" /></Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
