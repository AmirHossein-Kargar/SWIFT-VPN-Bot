import { ProgressLink } from "@/components/shared/progress-link";
import { ArrowRight } from "lucide-react";
import type { Metadata } from "next";

import { NewTicketForm } from "@/components/support/new-ticket-form";

export const metadata: Metadata = { title: "تیکت جدید" };

export default function NewTicketPage() {
  return (
    <div className="space-y-4">
      <ProgressLink pendingLabel="در حال بارگذاری" href="/support" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline"><ArrowRight className="size-4" aria-hidden="true" />بازگشت به تیکت‌های من</ProgressLink>
      <h1 className="text-lg font-semibold">ثبت تیکت جدید</h1>
      <NewTicketForm />
    </div>
  );
}
