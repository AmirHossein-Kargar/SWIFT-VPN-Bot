import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function Container({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-page px-4", className)} {...props} />;
}

/** Official Swift lockups, one per theme (CSS shows the matching one); aspect ratios match the SVG viewBoxes. */
export function Logo({ width, height, className }: { width: number; height: number; className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img loading="lazy" decoding="async" className={cn("logo-light h-auto", className)} src="/brand/logo-horizontal.svg" alt="" width={width} height={height} style={{ height }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img loading="lazy" decoding="async" className={cn("logo-dark h-auto", className)} src="/brand/logo-horizontal-on-dark.svg" alt="" width={width} height={height} style={{ height }} />
    </>
  );
}

export function SiteHeader() {
  return (
    <header id="top" className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <Container className="flex min-h-[68px] items-center gap-4">
        <a href="/" aria-label="Swift VPN — صفحه اصلی" className="inline-flex min-w-0 items-center gap-3 rounded-lg">
          <Logo width={74} height={28} className="w-auto max-sm:!h-6" />
          <span className="hidden border-s border-border-strong ps-3 text-xs leading-snug text-faint sm:block">اینترنت سریع و پایدار</span>
        </a>
        <nav aria-label="بخش‌های صفحه" className="ms-4 hidden gap-1.5 lg:flex">
          {[["#plans", "پلن‌ها"], ["#how", "مراحل خرید"], ["#faq", "سوالات متداول"]].map(([href, label]) => (
            <a key={href} href={href} className="rounded-[10px] px-3 py-2 text-[14.5px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-2.5">
          <ThemeToggle />
          <a href="#plans" className={buttonVariants({ size: "sm" })}>خرید اشتراک</a>
        </div>
      </Container>
    </header>
  );
}

export function SiteFooter({ botUrl, supportUrl, year }: { botUrl: string | null; supportUrl: string | null; year: string }) {
  const link = "rounded-lg p-2.5 text-sm text-muted-foreground hover:text-foreground";
  return (
    <footer className="border-t pb-[calc(1.75rem+env(safe-area-inset-bottom))] pt-7">
      <Container className="flex flex-wrap items-center gap-x-6 gap-y-3.5">
        <a href="#top" aria-label="Swift VPN — بازگشت به بالا" className="inline-flex items-center rounded-lg">
          <Logo width={58} height={22} className="w-auto" />
        </a>
        <nav aria-label="پیوندهای پایانی" className="flex flex-wrap gap-x-1.5">
          <a className={link} href="#plans">پلن‌ها</a>
          <a className={link} href="#faq">سوالات متداول</a>
          {botUrl ? <a className={link} href={botUrl} target="_blank" rel="noopener">ربات تلگرام</a> : null}
          {supportUrl ? <a className={link} href={supportUrl} target="_blank" rel="noopener">پشتیبانی</a> : null}
        </nav>
        <p className="w-full text-[13px] text-faint sm:ms-auto sm:w-auto">© {year} Swift VPN · قیمت‌ها به تومان</p>
      </Container>
    </footer>
  );
}
