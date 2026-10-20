"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, ArrowDown, MoreHorizontal, Plus } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProductFormDialog } from "@/components/products/product-form-dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminProduct } from "@/lib/types";
import { formatNumber, formatToman } from "@/lib/utils";

export function ProductsTable({ items }: { items: AdminProduct[] }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [editing, setEditing] = useState<AdminProduct | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  const ordered = [...items].sort((a, b) => a.displayOrder - b.displayOrder);

  async function reorder(productIds: string[]) {
    try {
      await adminMutate("/products/reorder", "POST", csrfToken, { operationId: newOperationId(), productIds });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not reorder plans.");
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    await reorder(next.map((item) => item.id));
  }

  async function duplicate(product: AdminProduct) {
    setBusyId(product.id);
    try {
      await adminMutate(`/products/${product.id}/duplicate`, "POST", csrfToken, { operationId: newOperationId() });
      toast.success(`Duplicated "${product.name}".`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not duplicate the plan.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(product: AdminProduct) {
    setBusyId(product.id);
    try {
      await adminMutate(`/products/${product.id}`, "PATCH", csrfToken, { operationId: newOperationId(), enabled: !product.enabled });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not update the plan.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end border-b border-border p-4">
        <Button size="sm" onClick={() => setEditing(null)}>
          <Plus className="h-4 w-4" />
          New plan
        </Button>
      </div>
      {ordered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No plans yet. Create the first one.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Order</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Traffic</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Profit</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((product, index) => (
              <TableRow key={product.id}>
                <TableCell>
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === ordered.length - 1} onClick={() => move(index, 1)} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="font-medium">{product.name}</TableCell>
                <TableCell>{formatNumber(product.durationDays)} days</TableCell>
                <TableCell>{formatNumber(product.trafficGb)} GB</TableCell>
                <TableCell>{formatToman(product.priceToman)}</TableCell>
                <TableCell className="text-muted-foreground">{formatToman(product.profitToman)}</TableCell>
                <TableCell>
                  {product.enabled ? <Badge variant="success">Live</Badge> : <Badge variant="muted">Hidden</Badge>}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" disabled={busyId === product.id} aria-label={`Actions for ${product.name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditing(product)}>Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => duplicate(product)}>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleEnabled(product)}>{product.enabled ? "Hide from catalog" : "Show in catalog"}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ProductFormDialog
        key={editing?.id ?? "new"}
        product={editing ?? null}
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />
    </>
  );
}
