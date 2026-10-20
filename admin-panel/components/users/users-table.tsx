"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BalanceDialog } from "@/components/users/balance-dialog";
import { BlockDialog } from "@/components/users/block-dialog";
import { ResetEligibilityDialog } from "@/components/users/reset-eligibility-dialog";
import { UserDetailSheet } from "@/components/users/user-detail-sheet";
import type { AdminUser } from "@/lib/types";
import { formatDateTime, formatNumber, formatToman } from "@/lib/utils";

export function UsersTable({ items }: { items: AdminUser[] }) {
  const [balanceUser, setBalanceUser] = useState<AdminUser | null>(null);
  const [blockUser, setBlockUser] = useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No users match these filters.</p>;
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead>Payments</TableHead>
            <TableHead>Services</TableHead>
            <TableHead>Registered</TableHead>
            <TableHead>Last active</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((user) => (
            <TableRow key={user.telegramId}>
              <TableCell>
                <button
                  className="text-left hover:underline"
                  onClick={() => { setDetailId(user.telegramId); setDetailOpen(true); }}
                >
                  <p className="font-medium">{user.name ?? user.username ?? user.telegramId}</p>
                  <p className="text-xs text-muted-foreground">{user.telegramId}</p>
                </button>
              </TableCell>
              <TableCell>{formatToman(user.balance)}</TableCell>
              <TableCell>{formatNumber(user.successfulPayments)}</TableCell>
              <TableCell>{formatNumber(user.serviceCount)}</TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(user.createdAt)}</TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(user.lastActivityAt)}</TableCell>
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
                    <DropdownMenuItem onClick={() => { setDetailId(user.telegramId); setDetailOpen(true); }}>View details</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setBalanceUser(user)}>Adjust balance</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setBlockUser(user)}>{user.isBanned ? "Unblock" : "Block"}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setResetUser(user)}>Reset test eligibility</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {balanceUser ? <BalanceDialog user={balanceUser} open={Boolean(balanceUser)} onOpenChange={(open) => !open && setBalanceUser(null)} /> : null}
      {blockUser ? <BlockDialog user={blockUser} open={Boolean(blockUser)} onOpenChange={(open) => !open && setBlockUser(null)} /> : null}
      {resetUser ? <ResetEligibilityDialog user={resetUser} open={Boolean(resetUser)} onOpenChange={(open) => !open && setResetUser(null)} /> : null}
      <UserDetailSheet telegramId={detailId} open={detailOpen} onOpenChange={setDetailOpen} />
    </>
  );
}
