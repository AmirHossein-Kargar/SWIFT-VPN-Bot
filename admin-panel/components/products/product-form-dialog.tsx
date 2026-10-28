"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from "@/components/ui/form";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminProduct } from "@/lib/types";
import { productSchema, SUBSCRIPTION_DURATION_DAYS, type ProductFormValues } from "@/lib/form-schemas";
import { formatNumber, formatToman } from "@/lib/utils";

function defaultsFor(product: AdminProduct | null): ProductFormValues {
  return {
    name: product?.name ?? "",
    productId: "",
    durationDays: product?.durationDays ?? 30,
    trafficGb: product?.trafficGb ?? 50,
    priceToman: product?.priceToman ?? 0,
    costToman: product?.costToman ?? 0,
    enabled: product?.enabled ?? false,
    published: product?.published ?? true,
  };
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name",
  durationDays: "Duration",
  trafficGb: "Traffic",
  priceToman: "Price",
  costToman: "Cost",
  enabled: "Available for purchase",
  published: "Shown on storefront",
};

function display(field: string, value: unknown): string {
  if (field === "durationDays") return `${value} days`;
  if (field === "trafficGb") return `${formatNumber(Number(value))} GB`;
  if (field === "priceToman" || field === "costToman") return formatToman(Number(value));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

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

  const form = useForm<ProductFormValues>({ resolver: zodResolver(productSchema), defaultValues: defaultsFor(product) });

  useEffect(() => {
    if (open) form.reset(defaultsFor(product));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product]);

  const watched = form.watch();
  const price = Number(watched.priceToman) || 0;
  const cost = Number(watched.costToman) || 0;
  const changes = product
    ? (Object.keys(FIELD_LABELS) as (keyof ProductFormValues)[])
        .filter((field) => String(watched[field]) !== String(product[field as keyof AdminProduct]))
        .map((field) => ({ field, from: product[field as keyof AdminProduct], to: watched[field] }))
    : [];

  async function onSubmit(values: ProductFormValues) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const { productId, ...fields } = values;
      if (isEditing && product) {
        await adminMutate(`/products/${product.id}`, "PATCH", csrfToken, { operationId: newOperationId(), expectedRevision: product.revision, ...fields });
        toast.success(`"${values.name}" updated.`);
      } else {
        await adminMutate("/products", "POST", csrfToken, { operationId: newOperationId(), ...fields, ...(productId ? { productId } : {}), displayOrder: 0 });
        toast.success(`"${values.name}" created.`);
      }
      onOpenChange(false);
      router.refresh();
    } catch (error) {
      if (error instanceof AdminApiError && error.code === "product_stale") {
        toast.error("This plan was changed by someone else after you opened it. Close the form and reopen it to see the latest values.");
        router.refresh();
      } else {
        toast.error(error instanceof AdminApiError ? error.message : "The request failed.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit service" : "Add service"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Changes apply to new purchases immediately. Existing orders and active VPN services keep their original terms."
              : "New services start off sale by default. Turn on “Available for purchase” when the details look right."}
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
                    <Input placeholder="50 GB — 1 month" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!isEditing ? (
              <FormField
                control={form.control}
                name="productId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ID (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="generated automatically" autoComplete="off" spellCheck={false} {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormDescription>Permanent. Lowercase letters, digits and _ only.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                ID <span className="font-mono">{product?.id}</span> · revision {product?.revision}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="durationDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Duration</FormLabel>
                    <Select value={String(field.value)} onValueChange={(value) => field.onChange(Number(value))}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a duration" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SUBSCRIPTION_DURATION_DAYS.map((days) => (
                          <SelectItem key={days} value={String(days)}>{days} days</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                    <FormLabel>Available for purchase</FormLabel>
                    <FormDescription>Off: nobody can buy it in the bot or on the storefront. Existing customers are not affected.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="published"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>Show on storefront</FormLabel>
                    <FormDescription>Off: hidden from the website but still purchasable in the bot while available.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <section aria-label="Review" className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Review</p>
              <p className="text-muted-foreground">
                Customers pay {formatToman(price)} for {formatNumber(Number(watched.trafficGb) || 0)} GB over {watched.durationDays} days
                {price > 0 ? ` · estimated profit ${formatToman(price - cost)}` : ""}.
              </p>
              <p className="text-muted-foreground">
                {watched.enabled ? (watched.published ? "Sold in the bot and shown on the storefront." : "Sold in the bot only.") : "Not for sale."}
              </p>
              {price > 0 && price < cost ? <p className="text-warning">Price is below cost — this plan sells at a loss.</p> : null}
              {isEditing && changes.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {changes.map(({ field, from, to }) => (
                    <li key={field}>
                      {FIELD_LABELS[field]}: <span className="text-muted-foreground">{display(field, from)}</span> → {display(field, to)}
                    </li>
                  ))}
                </ul>
              ) : null}
              {isEditing && changes.length === 0 ? <p className="text-muted-foreground">No changes yet.</p> : null}
            </section>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || (isEditing && changes.length === 0)}>
                {submitting ? "Saving…" : isEditing ? "Save changes" : "Add service"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
