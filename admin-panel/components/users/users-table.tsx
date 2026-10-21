"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BalanceDialog } from "@/components/users/balance-dialog";
import { BlockDialog } from "@/components/users/block-dialog";
import { MessageDialog } from "@/components/users/message-dialog";
import { ResetEligibilityDialog } from "@/components/users/reset-eligibility-dialog";
import { UserDetailSheet } from "@/components/users/user-detail-sheet";
import type { AdminUser } from "@/lib/types";
import { formatDateTime, formatNumber, formatToman } from "@/lib/utils";

type RowAction = { kind: "credit" | "debit" | "message" | "block" | "eligibility"; user: AdminUser } | null;

export function UsersTable({ items }: { items: AdminUser[] }) {
  const router = useRouter();
  const [action, setAction] = useState<RowAction>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No users match these filters.</p>;
  }

  const close = (next: boolean) => { if (!next) setAction(null); };
  const done = () => router.refresh();
  const openDetail = (id: string) => { setDetailId(id); setDetailOpen(true); };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead className="hidden sm:table-cell">Payments</TableHead>
            <TableHead className="hidden sm:table-cell">Services</TableHead>
            <TableHead className="hidden md:table-cell">Registered</TableHead>
            <TableHead className="hidden lg:table-cell">Last active</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((user) => (
            <TableRow key={user.telegramId}>
              <TableCell>
                <button className="text-left hover:underline" onClick={() => openDetail(user.telegramId)}>
                  <p className="font-medium">{user.name ?? user.username ?? user.telegramId}</p>
                  <p className="text-xs text-muted-foreground">{user.telegramId}</p>
                </button>
              </TableCell>
              <TableCell>{formatToman(user.balance)}</TableCell>
              <TableCell className="hidden sm:table-cell">{formatNumber(user.successfulPayments)}</TableCell>
              <TableCell className="hidden sm:table-cell">{formatNumber(user.serviceCount)}</TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(user.createdAt)}</TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDateTime(user.lastActivityAt)}</TableCell>
              <TableCell>
                {user.isBanned ? <Badge variant="destructive">Blocked</Badge> : <Badge variant="success">Active</Badge>}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Actions for ${user.telegramId}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openDetail(user.telegramId)}>View details</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setAction({ kind: "credit", user })}>Credit wallet</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAction({ kind: "debit", user })} disabled={user.balance <= 0}>Debit wallet</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAction({ kind: "message", user })}>Send message</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAction({ kind: "eligibility", user })}>Restore test eligibility</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setAction({ kind: "block", user })} className={user.isBanned ? undefined : "text-destructive focus:text-destructive"}>
                      {user.isBanned ? "Unblock" : "Block"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {action?.kind === "credit" || action?.kind === "debit" ? (
        <BalanceDialog key={`${action.kind}-${action.user.telegramId}`} user={action.user} direction={action.kind === "credit" ? "add" : "remove"} open onOpenChange={close} onDone={done} />
      ) : null}
      {action?.kind === "message" ? <MessageDialog key={action.user.telegramId} user={action.user} open onOpenChange={close} /> : null}
      {action?.kind === "block" ? <BlockDialog key={action.user.telegramId} user={action.user} open onOpenChange={close} onDone={done} /> : null}
      {action?.kind === "eligibility" ? <ResetEligibilityDialog key={action.user.telegramId} user={action.user} open onOpenChange={close} onDone={done} /> : null}
      <UserDetailSheet telegramId={detailId} open={detailOpen} onOpenChange={setDetailOpen} />
    </>
  );
}
