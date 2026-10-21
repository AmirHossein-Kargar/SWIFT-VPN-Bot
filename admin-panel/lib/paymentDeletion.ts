// The shared admin services (also used by the Persian Telegram panel) return
// Persian reasons. This web panel is English-only, so show these by code.
const REASONS: Record<string, string> = {
  not_found: "This payment no longer exists.",
  wallet_order: "Wallet orders cannot be deleted.",
  credited: "It already changed a wallet balance.",
  recovery: "It is in the recovery queue.",
  funds_seen: "Money or a tracking reference was recorded for it.",
  receipt: "A receipt was submitted; an admin must review it.",
  status: "Its status does not allow deletion.",
  too_new: "It has not reached the minimum age for deletion yet.",
  not_expired: "Its provider expiry has not passed yet.",
  changed: "It changed while deleting, so it was kept.",
};

export function deletionReason(code: string | null | undefined): string {
  return (code && REASONS[code]) || "Not eligible for deletion.";
}
