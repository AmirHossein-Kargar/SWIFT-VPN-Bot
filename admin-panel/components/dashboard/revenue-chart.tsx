"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatToman, formatDate } from "@/lib/utils";

const PRIMARY = "hsl(217 91% 60%)";

export function RevenueChart({ data }: { data: { date: string; value: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue, last 30 days</CardTitle>
        <CardDescription>Wallet top-ups actually credited to user wallets.</CardDescription>
      </CardHeader>
      <CardContent className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="hsl(0 0% 16%)" />
            <XAxis
              dataKey="date"
              tickFormatter={(value) => formatDate(value)}
              tick={{ fill: "hsl(0 0% 63%)", fontSize: 11 }}
              axisLine={{ stroke: "hsl(0 0% 16%)" }}
              tickLine={false}
              minTickGap={32}
            />
            <Tooltip
              contentStyle={{ background: "hsl(0 0% 9%)", border: "1px solid hsl(0 0% 16%)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "hsl(0 0% 63%)" }}
              formatter={(value: number) => [formatToman(value), "Revenue"]}
              labelFormatter={(value) => formatDate(value)}
            />
            <Area type="monotone" dataKey="value" stroke={PRIMARY} strokeWidth={2} fill="url(#revenueFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
