import { useEffect, useRef, useState } from "react";
import { Menu, Send, X } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function Container({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-page px-4", className)} {...props} />;
}

/** Shared section title block; the id feeds aria-labelledby on the section. */
export function SectionHeading({ id, eyebrow, title, children }: { id: string; eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mb-9 max-w-[720px] text-center">
      {eyebrow ? <p className="mb-2.5 text-[13px] font-extrabold tracking-wide text-brand">{eyebrow}</p> : null}
      <h2 id={id} className="text-[clamp(24px,3.2vw,34px)] font-extrabold leading-snug">{title}</h2>
      {children ? <p className="mt-2.5 text-muted-foreground">{children}</p> : null}
    </div>
  );
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

/** [href, label]: the same list drives the desktop bar, the mobile menu and the footer. */
export const NAV_LINKS = [
  ["#plans", "پلن‌ها"],
  ["#features", "ویژگی‌ها"],
  ["#payment", "راهنمای پرداخت"],
  ["#devices", "راهنمای اتصال"],
  ["#faq", "سوالات متداول"],
] as const;

const navLink = "nav-link rounded-[10px] px-3 py-2 text-[14.5px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-[current=true]:text-foreground";

/** The section at the middle of the screen, for the "you are here" mark in the header. */
function useActiveSection() {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(`#${entry.target.id}`);
          else setActive((current) => (current === `#${entry.target.id}` ? null : current));
        }
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    for (const [href] of NAV_LINKS) {
      const section = document.querySelector(href);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

function MobileNav({ botUrl, active }: { botUrl: string | null; active: string | null }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "بستن منو" : "باز کردن منو"}
        onClick={() => setOpen((value) => !value)}
        className="press inline-grid size-11 place-items-center rounded-xl border border-border-strong bg-card text-foreground hover:border-faint"
      >
        {open ? <X key="close" className="animate-rise size-5" aria-hidden="true" /> : <Menu key="open" className="animate-rise size-5" aria-hidden="true" />}
      </button>
      {open ? (
        <div ref={panelRef} id="mobile-nav" className="absolute inset-x-0 top-full border-b bg-background/95 shadow-lg backdrop-blur-md animate-rise">
          <nav aria-label="بخش‌های صفحه" className="mx-auto grid max-w-page gap-1 px-4 py-3">
            {NAV_LINKS.map(([href, label], index) => (
              <a
                key={href}
                href={href}
                aria-current={active === href ? "true" : undefined}
                onClick={() => setOpen(false)}
                style={{ animationDelay: `${index * 35}ms` }}
                className="animate-rise flex min-h-12 items-center rounded-xl px-3 text-base font-bold transition-[background-color,transform] duration-150 hover:bg-secondary active:scale-[0.98] active:bg-secondary aria-[current=true]:bg-secondary"
              >
                {label}
              </a>
            ))}
            {botUrl ? (
              <a href={botUrl} target="_blank" rel="noopener" className="mt-1 flex min-h-12 items-center gap-2 rounded-xl border border-border-strong px-3 text-base font-bold transition-[background-color,transform] duration-150 hover:bg-secondary active:scale-[0.98] active:bg-secondary">
                <Send className="size-[18px] text-brand" aria-hidden="true" />باز کردن ربات تلگرام
              </a>
            ) : null}
          </nav>
        </div>
      ) : null}
    </div>
  );
}

export function SiteHeader({ botUrl }: { botUrl: string | null }) {
  const active = useActiveSection();
  return (
    <header id="top" className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <Container className="relative flex min-h-[68px] items-center gap-3 sm:gap-4">
        <a href="/" aria-label="Swift VPN — صفحه اصلی" className="inline-flex min-h-11 min-w-0 items-center gap-3 rounded-lg">
          <Logo width={74} height={28} className="w-auto max-sm:!h-6" />
          <span className="hidden border-s border-border-strong ps-3 text-xs leading-snug text-faint xl:block">اینترنت سریع و پایدار</span>
        </a>
        <nav aria-label="بخش‌های صفحه" className="ms-2 hidden gap-0.5 lg:flex">
          {NAV_LINKS.map(([href, label]) => (
            <a key={href} href={href} aria-current={active === href ? "true" : undefined} className={navLink}>{label}</a>
          ))}
        </nav>
        <div className="ms-auto flex items-center gap-2 sm:gap-2.5">
          {botUrl ? (
            <a href={botUrl} target="_blank" rel="noopener" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "press hidden xl:inline-flex")}>
              <Send aria-hidden="true" />ربات تلگرام
            </a>
          ) : null}
          <ThemeToggle />
          <a href="#plans" className={cn(buttonVariants({ size: "sm" }), "press")}>خرید اشتراک</a>
          <MobileNav botUrl={botUrl} active={active} />
        </div>
      </Container>
    </header>
  );
}

/** The bot's own terms post (the link its order confirmation shows as «قوانین و مقررات»). */
const TERMS_URL = "https://t.me/swift_shield/4";

export function SiteFooter({ botUrl, supportUrl, year }: { botUrl: string | null; supportUrl: string | null; year: string }) {
  const link = "inline-flex min-h-10 items-center rounded-lg px-1 text-sm text-muted-foreground transition-colors hover:text-foreground";
  const heading = "mb-2 text-[13px] font-extrabold text-foreground";
  return (
    <footer className="border-t bg-alt pb-[calc(1.75rem+env(safe-area-inset-bottom))] pt-10">
      <Container className="grid gap-9 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="max-w-[340px]">
          <a href="#top" aria-label="Swift VPN — بازگشت به بالا" className="inline-flex min-h-11 items-center rounded-lg">
            <Logo width={84} height={32} className="w-auto" />
          </a>
          <p className="mt-3.5 text-sm text-muted-foreground">
            اشتراک اختصاصی VLESS با تحویل خودکار در تلگرام. پلن را اینجا انتخاب می‌کنید و خرید و دریافت سرویس در ربات انجام می‌شود.
          </p>
        </div>
        <nav aria-label="بخش‌های صفحه (پایین صفحه)">
          <p className={heading}>صفحه</p>
          <ul className="grid list-none p-0">
            {NAV_LINKS.map(([href, label]) => <li key={href}><a className={link} href={href}>{label}</a></li>)}
          </ul>
        </nav>
        <nav aria-label="راهنماها">
          <p className={heading}>راهنما</p>
          <ul className="grid list-none p-0">
            <li><a className={link} href="#how">مراحل خرید</a></li>
            <li><a className={link} href="#trial">سرویس تست رایگان</a></li>
            <li><a className={link} href={TERMS_URL} target="_blank" rel="noopener">قوانین و مقررات</a></li>
          </ul>
        </nav>
        <nav aria-label="ارتباط">
          <p className={heading}>ارتباط</p>
          <ul className="grid list-none p-0">
            {botUrl ? <li><a className={link} href={botUrl} target="_blank" rel="noopener">ربات تلگرام</a></li> : null}
            {supportUrl ? <li><a className={link} href={supportUrl} target="_blank" rel="noopener">پشتیبانی</a></li> : null}
            <li className="py-2 text-[13px] text-faint">تیکت پشتیبانی: ربات، دکمهٔ «🛠 پشتیبانی»</li>
          </ul>
        </nav>
      </Container>
      <Container className="mt-9 border-t pt-5">
        <p className="text-[13px] text-faint">© {year} Swift VPN · قیمت‌ها به تومان</p>
      </Container>
    </footer>
  );
}
