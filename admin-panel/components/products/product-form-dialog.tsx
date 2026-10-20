"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminProduct } from "@/lib/types";

const productSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name must be at most 120 characters"),
  durationDays: z.coerce.number().int().min(1, "Must be at least 1 day").max(3650, "Must be at most 3650 days"),
  trafficGb: z.coerce.number().int().min(1, "Must be at least 1 GB").max(100_000, "Must be at most 100,000 GB"),
  priceToman: z.coerce.number().int().min(1, "Price must be positive").max(2_000_000_000, "Price is too large"),
  costToman: z.coerce.number().int().min(0, "Cost cannot be negative").max(2_000_000_000, "Cost is too large"),
  enabled: z.boolean(),
});

type ProductFormValues = z.infer<typeof productSchema>;

export function ProductFormDialog({
  product,
  open,
  onOpenChange,
}: {
  product: AdminProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const isEditing = Boolean(product);

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: product?.name ?? "",
      durationDays: product?.durationDays ?? 30,
      trafficGb: product?.trafficGb ?? 50,
      priceToman: product?.priceToman ?? 0,
      costToman: product?.costToman ?? 0,
      enabled: product?.enabled ?? true,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      name: product?.name ?? "",
      durationDays: product?.durationDays ?? 30,
      trafficGb: product?.trafficGb ?? 50,
      priceToman: product?.priceToman ?? 0,
      costToman: product?.costToman ?? 0,
      enabled: product?.enabled ?? true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product]);

  async function onSubmit(values: ProductFormValues) {
    setSubmitting(true);
    try {
      if (isEditing && product) {
        await adminMutate(`/products/${product.id}`, "PATCH", csrfToken, { operationId: newOperationId(), ...values });
        toast.success(`"${values.name}" updated.`);
      } else {
        await adminMutate("/products", "POST", csrfToken, { operationId: newOperationId(), ...values, displayOrder: 0 });
        toast.success(`"${values.name}" created.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit plan" : "Create plan"}</DialogTitle>
          <DialogDescription>
            {isEditing ? "Changes apply to new purchases immediately." : "The new plan is disabled by default order; enable it once it looks right."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="1-month · 50GB" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="durationDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Duration (days)</FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="numeric" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="trafficGb"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Traffic (GB)</FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="numeric" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="priceToman"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Price (Toman)</FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="numeric" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="costToman"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cost (Toman)</FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="numeric" {...field} />
                    </FormControl>
                    <FormDescription>Used to estimate profit; never shown to customers.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>Visible to customers</FormLabel>
                    <FormDescription>Disabled plans stay in the catalog but cannot be purchased.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {isEditing ? "Save changes" : "Create plan"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
