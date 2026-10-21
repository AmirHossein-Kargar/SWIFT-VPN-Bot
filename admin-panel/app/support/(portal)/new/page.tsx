import Link from "next/link";
import type { Metadata } from "next";

import { NewTicketForm } from "@/components/support/new-ticket-form";

export const metadata: Metadata = { title: "تیکت جدید" };

export default function NewTicketPage() {
  return (
    <div className="space-y-4">
      <Link href="/support" className="text-sm text-muted-foreground hover:underline">→ بازگشت به تیکت‌های من</Link>
      <h1 className="text-lg font-semibold">ثبت تیکت جدید</h1>
      <NewTicketForm />
    </div>
  );
}
