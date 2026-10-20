"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminAccountRow } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function AdminsTable({ items }: { items: AdminAccountRow[] }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<AdminAccountRow | null>(null);
  const [telegramId, setTelegramId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addAdminAccount() {
    if (!/^[1-9]\d{0,19}$/.test(telegramId.trim())) {
      setError("Enter a valid positive Telegram ID.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate("/admins", "POST", csrfToken, {
        operationId: newOperationId(),
        telegramId: telegramId.trim(),
        displayName: displayName.trim() || undefined,
      });
      toast.success(`Admin ${telegramId.trim()} added.`);
      setAddOpen(false);
      setTelegramId("");
      setDisplayName("");
      router.refresh();
    } catch (mutationError) {
      setError(mutationError instanceof AdminApiError ? mutationError.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeAdminAccount() {
    if (!removing) return;
    setSubmitting(true);
    try {
      await adminMutate(`/admins/${removing.telegramId}`, "DELETE", csrfToken, { operationId: newOperationId() });
      toast.success(`Admin ${removing.telegramId} removed.`);
      setRemoving(null);
      router.refresh();
    } catch (mutationError) {
      toast.error(mutationError instanceof AdminApiError ? mutationError.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-end border-b border-border p-4">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Add admin
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Telegram ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Added</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((admin) => (
            <TableRow key={admin.telegramId}>
              <TableCell className="font-medium">{admin.telegramId}</TableCell>
              <TableCell>{admin.displayName ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={admin.role === "owner" ? "default" : "secondary"}>{admin.role}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{admin.source}</TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(admin.addedAt)}</TableCell>
              <TableCell>
                {admin.source === "database" && admin.role !== "owner" ? (
                  <Button variant="ghost" size="icon" aria-label={`Remove ${admin.telegramId}`} onClick={() => setRemoving(admin)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add admin</DialogTitle>
            <DialogDescription>Grants full admin access to this Telegram account. Only the primary owner can do this.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-telegram-id">Telegram ID</Label>
              <Input id="admin-telegram-id" inputMode="numeric" value={telegramId} onChange={(event) => setTelegramId(event.target.value)} placeholder="123456789" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-display-name">Display name (optional)</Label>
              <Input id="admin-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Jane" />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={addAdminAccount} disabled={submitting}>
              Add admin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this admin?</AlertDialogTitle>
            <AlertDialogDescription>{removing?.telegramId} will lose admin access immediately.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={(event) => { event.preventDefault(); removeAdminAccount(); }}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
