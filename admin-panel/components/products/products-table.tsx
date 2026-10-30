"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal, Plus } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProductFormDialog } from "@/components/products/product-form-dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";
import { AdminApiError } from "@/lib/types";
import type { AdminProduct } from "@/lib/types";
import { formatDate, formatNumber, formatToman } from "@/lib/utils";
import { useNavigate } from "@/components/shared/navigation-pending";

type Confirmation = { kind: "archive" | "delete"; product: AdminProduct };

const SORTABLE: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "duration", label: "Duration" },
  { key: "traffic", label: "Traffic" },
  { key: "price", label: "Price" },
];

function StatusBadges({ product }: { product: AdminProduct }) {
  if (product.archived) return <Badge variant="muted">Archived</Badge>;
  return (
    <div className="flex flex-wrap gap-1">
      {product.enabled ? <Badge variant="success">On sale</Badge> : <Badge variant="muted">Off sale</Badge>}
      {product.enabled && !product.published ? <Badge variant="warning">Hidden from storefront</Badge> : null}
      {!product.supportedDuration ? <Badge variant="warning">Unsupported duration</Badge> : null}
    </div>
  );
}

export function ProductsTable({
  items, total, filteredTotal, sort, order, status,
}: {
  items: AdminProduct[];
  total: number;
  filteredTotal: number;
  sort: string;
  order: string;
  status: string;
}) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [editing, setEditing] = useState<AdminProduct | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);

  const canReorder = sort === "order" && order === "asc" && status === "current" && !searchParams.get("search") && !searchParams.get("duration");

  function fail(error: unknown, fallback: string) {
    if (error instanceof AdminApiError && error.code === "product_stale") {
      toast.error("This plan was changed by someone else. The list has been refreshed — review it and try again.");
      router.refresh();
      return;
    }
    toast.error(error instanceof AdminApiError ? error.message : fallback);
  }

  async function run(product: AdminProduct, action: () => Promise<unknown>, success: string, failure: string) {
    if (busyId) return;
    setBusyId(product.id);
    try {
      await action();
      toast.success(success);
      router.refresh();
    } catch (error) {
      fail(error, failure);
    } finally {
      setBusyId(null);
    }
  }

  const mutate = (product: AdminProduct, path: string, method: "POST" | "PATCH" | "DELETE", payload: Record<string, unknown> = {}) =>
    adminMutate(`/products/${product.id}${path}`, method, csrfToken, { operationId: newOperationId(), expectedRevision: product.revision, ...payload });

  const setEnabled = (product: AdminProduct) =>
    run(product, () => mutate(product, "", "PATCH", { enabled: !product.enabled }),
      product.enabled ? `"${product.name}" is off sale. Existing customers keep their service.` : `"${product.name}" is on sale.`, "Could not update the plan.");
  const setPublished = (product: AdminProduct) =>
    run(product, () => mutate(product, "", "PATCH", { published: !product.published }),
      product.published ? `"${product.name}" is hidden from the storefront.` : `"${product.name}" is shown on the storefront.`, "Could not update the plan.");
  const duplicate = (product: AdminProduct) =>
    run(product, () => adminMutate(`/products/${product.id}/duplicate`, "POST", csrfToken, { operationId: newOperationId() }),
      `Duplicated "${product.name}" (off sale until you enable it).`, "Could not duplicate the plan.");
  const restore = (product: AdminProduct) =>
    run(product, () => mutate(product, "/restore", "POST"), `"${product.name}" restored. It is off sale until you enable it.`, "Could not restore the plan.");
  const move = (product: AdminProduct, direction: "up" | "down") =>
    run(product, () => adminMutate(`/products/${product.id}/move`, "POST", csrfToken, { operationId: newOperationId(), direction }), "Order updated.", "Could not reorder the plans.");

  async function confirmed() {
    if (!confirming) return;
    const { kind, product } = confirming;
    setConfirming(null);
    if (kind === "archive") {
      await run(product, () => mutate(product, "/archive", "POST"), `"${product.name}" archived. Existing customers keep their service.`, "Could not archive the plan.");
    } else {
      await run(product, () => mutate(product, "", "DELETE"), `"${product.name}" deleted.`, "Could not delete the plan.");
    }
  }

  function sortBy(key: string) {
    const next = new URLSearchParams(searchParams.toString());
    const descending = sort === key && order === "asc";
    next.set("sort", key);
    next.set("order", descending ? "desc" : "asc");
    next.delete("page");
    navigate(`${pathname}?${next.toString()}`);
  }

  function SortHead({ column }: { column: { key: string; label: string } }) {
    const active = sort === column.key;
    const Icon = !active ? ArrowUpDown : order === "desc" ? ArrowDown : ArrowUp;
    return (
      <TableHead aria-sort={active ? (order === "desc" ? "descending" : "ascending") : "none"}>
        <button type="button" onClick={() => sortBy(column.key)} className="inline-flex items-center gap-1 hover:text-foreground">
          {column.label}
          <Icon className="h-3 w-3" aria-hidden />
        </button>
      </TableHead>
    );
  }

  const blockedDeleteReason = (product: AdminProduct) =>
    product.system ? "Default plans can only be archived." : (product.references ?? 0) > 0 ? "Used by existing orders — archive instead." : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {filteredTotal === total ? `${formatNumber(total)} services` : `${formatNumber(filteredTotal)} of ${formatNumber(total)} services match`}
        </p>
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4" />
          Add service
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {total === 0 ? "No services yet. Add the first one." : "No services match these filters."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {canReorder ? <TableHead className="w-16">Order</TableHead> : null}
                <SortHead column={SORTABLE[0]!} />
                <SortHead column={SORTABLE[1]!} />
                <SortHead column={SORTABLE[2]!} />
                <SortHead column={SORTABLE[3]!} />
                <TableHead>Profit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead aria-sort={sort === "updated" ? (order === "desc" ? "descending" : "ascending") : "none"}>
                  <button type="button" onClick={() => sortBy("updated")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Updated
                    {sort === "updated" ? (order === "desc" ? <ArrowDown className="h-3 w-3" aria-hidden /> : <ArrowUp className="h-3 w-3" aria-hidden />) : <ArrowUpDown className="h-3 w-3" aria-hidden />}
                  </button>
                </TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((product, index) => {
                const blocked = blockedDeleteReason(product);
                return (
                  <TableRow key={product.id} className={product.archived ? "opacity-60" : undefined}>
                    {canReorder ? (
                      <TableCell>
                        <div className="flex items-center gap-0.5">
                          <Button variant="ghost" size="icon" className="h-6 w-6" disabled={busyId !== null || (index === 0 && !searchParams.get("page"))} onClick={() => move(product, "up")} aria-label={`Move ${product.name} up`}>
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6" disabled={busyId !== null} onClick={() => move(product, "down")} aria-label={`Move ${product.name} down`}>
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                    <TableCell className="min-w-[11rem]">
                      <div className="font-medium">{product.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{product.id}</div>
                    </TableCell>
                    <TableCell>{formatNumber(product.durationDays)} days</TableCell>
                    <TableCell>{formatNumber(product.trafficGb)} GB</TableCell>
                    <TableCell>{formatToman(product.priceToman)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatToman(product.profitToman)}</TableCell>
                    <TableCell><StatusBadges product={product} /></TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(product.updatedAt)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" disabled={busyId === product.id} aria-label={`Actions for ${product.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {product.archived ? (
                            <DropdownMenuItem onClick={() => restore(product)}>Restore</DropdownMenuItem>
                          ) : (
                            <>
                              <DropdownMenuItem onClick={() => setEditing(product)}>Edit</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => duplicate(product)}>Duplicate</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setEnabled(product)}>{product.enabled ? "Take off sale" : "Put on sale"}</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setPublished(product)}>{product.published ? "Hide from storefront" : "Show on storefront"}</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => setConfirming({ kind: "archive", product })}>Archive…</DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuItem
                            disabled={blocked !== null}
                            title={blocked ?? undefined}
                            className="text-destructive focus:text-destructive"
                            onClick={() => setConfirming({ kind: "delete", product })}
                          >
                            Delete permanently…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ProductFormDialog
        key={`${editing?.id ?? "new"}:${editing?.revision ?? 0}`}
        product={editing ?? null}
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.kind === "delete" ? "Delete this service permanently?" : "Archive this service?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "delete"
                ? `“${confirming.product.name}” will be removed from the catalog for good. This is only possible because no order or VPN service refers to it. This cannot be undone.`
                : `“${confirming?.product.name ?? ""}” stops being sold in the bot and on the storefront and moves out of the default list. Existing orders and customers' active VPN services are not affected, and you can restore it later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmed}>{confirming?.kind === "delete" ? "Delete permanently" : "Archive"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
