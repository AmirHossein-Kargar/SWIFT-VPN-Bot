"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { useNavigate } from "@/components/shared/navigation-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ORDER_ID = /^(wallet:)?[A-Za-z0-9_-]{1,128}$/;
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;

/** A number is a customer, anything else is an order id. An invalid value never reaches the server. */
export function OrderSearch({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(userId);
  const valid = value === "" || ORDER_ID.test(value) || TELEGRAM_ID.test(value);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    if (!value) navigate("/reliability/orders");
    else if (TELEGRAM_ID.test(value)) navigate(`/reliability/orders?userId=${value}`);
    else navigate(`/reliability/orders/${encodeURIComponent(value.replace(/^wallet:/, ""))}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" role="search">
      <Input value={value} onChange={(event) => setValue(event.target.value.trim())} placeholder="Order id or Telegram ID" aria-label="Order id or customer Telegram ID" aria-invalid={!valid} className="w-full max-w-sm" />
      <Button type="submit" variant="outline" disabled={!valid}><Search aria-hidden />Trace</Button>
    </form>
  );
}
