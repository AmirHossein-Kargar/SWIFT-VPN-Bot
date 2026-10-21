import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;

// Bottom sheet on phones, centred dialog from sm up. Close button uses logical
// `end-*` so it sits on the correct side in RTL.
export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(
  ({ className, children, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-3xl border bg-card pb-[env(safe-area-inset-bottom)] shadow-lg",
          "sm:inset-x-auto sm:bottom-auto sm:start-1/2 sm:top-1/2 sm:w-full sm:max-w-[480px] sm:-translate-y-1/2 sm:rounded-3xl sm:ltr:-translate-x-1/2 sm:rtl:translate-x-1/2",
          "duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute end-4 top-4 inline-grid size-11 place-items-center rounded-xl border bg-card text-muted-foreground hover:text-foreground">
          <X className="size-[19px]" />
          <span className="sr-only">بستن</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
);
DialogContent.displayName = "DialogContent";

export const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(
  ({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-[19px] font-extrabold", className)} {...props} />
);
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(
  ({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn("text-[13.5px] text-faint", className)} {...props} />
);
DialogDescription.displayName = "DialogDescription";
