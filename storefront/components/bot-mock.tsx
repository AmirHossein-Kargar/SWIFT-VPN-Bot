import { cn } from "@/lib/utils";

/**
 * A stylised Telegram bot message used to illustrate a step. It reproduces the
 * real button labels of the bot but never real data: card numbers, addresses
 * and amounts shown in mockups are placeholders. Purely decorative (the same
 * information is in the step text), so it is hidden from assistive technology.
 */
export interface MockButton { label: string; hot?: boolean }
export interface MockLine { text: string; muted?: boolean; mono?: boolean; strong?: boolean }

export function BotMock({ title, lines = [], rows = [], className }: { title: string; lines?: MockLine[]; rows?: MockButton[][]; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("overflow-hidden rounded-xl border border-border-strong bg-secondary/60 text-[12.5px] leading-relaxed", className)}>
      <div className="flex items-center gap-2 border-b bg-card/70 px-3 py-2">
        <span className="size-2 rounded-full bg-brand" />
        <span className="font-bold text-muted-foreground">ربات سویفت</span>
      </div>
      <div className="grid gap-1 px-3 pb-2.5 pt-2.5">
        <p className="font-extrabold text-foreground">{title}</p>
        {lines.map((line) => (
          <p key={line.text} className={cn(line.muted ? "text-faint" : "text-muted-foreground", line.strong && "font-bold text-foreground", line.mono && "font-mono text-[12px] tracking-wider [direction:ltr] [unicode-bidi:plaintext] text-start")}>{line.text}</p>
        ))}
      </div>
      {rows.length > 0 ? (
        <div className="grid gap-1.5 px-2.5 pb-2.5">
          {rows.map((row, index) => (
            <div key={index} className="flex gap-1.5">
              {row.map((button) => (
                <span
                  key={button.label}
                  className={cn(
                    "flex min-h-8 flex-1 items-center justify-center rounded-lg border px-2 text-center text-[12px] font-bold",
                    button.hot ? "border-brand bg-brand/15 text-foreground shadow-[0_0_0_3px_hsl(var(--brand)/0.15)]" : "border-border-strong bg-card text-muted-foreground"
                  )}
                >
                  {button.label}
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
