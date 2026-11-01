"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { AdminCard } from "@/components/admins/admin-card";
import { AdminDetailSheet } from "@/components/admins/admin-detail-sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import type { AdminDirectoryData, AdminProfile } from "@/lib/admin-directory";
import { describeError } from "@/lib/errors";

export function AdminDirectory({ directory, filters }: { directory: AdminDirectoryData; filters: React.ReactNode }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [viewing, setViewing] = useState<AdminProfile | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<AdminProfile | null>(null);
  const [telegramId, setTelegramId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { items, presence, truncated, generatedAt } = directory;
  const windowMinutes = Math.round(presence.windowSeconds / 60);

  function openProfile(admin: AdminProfile) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setViewing(admin);
    setDetailOpen(true);
  }

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
      setError(describeError(mutationError));
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
      toast.error(describeError(mutationError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {filters}
        <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Add admin
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState icon={Users} title="No admins match these filters." hint="Try a shorter search, or another role or status." />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="admin-directory-grid">
          {items.map((admin) => (
            <AdminCard key={admin.telegramId} admin={admin} generatedAt={generatedAt} onOpen={() => openProfile(admin)} onRemove={() => setRemoving(admin)} />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {presence.available
          ? `Online means a signed-in panel request in the last ${windowMinutes} minutes. Telegram panel use does not count.`
          : "Online status is unavailable because Redis could not be read. Everything else on this page is current."}
        {" "}Admins from the ADMINS variable can only be changed in server configuration. Only the primary owner can add or remove the others.
        {truncated ? " Only the 500 most recently added accounts are listed." : ""}
      </p>

      <AdminDetailSheet
        admin={viewing}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onCloseAutoFocus={(event) => { if (opener.current?.isConnected) { event.preventDefault(); opener.current.focus(); } }}
      />

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
