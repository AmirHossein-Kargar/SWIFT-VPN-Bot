import { useEffect } from "react";
import { Coins, CreditCard, Send, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/site-chrome";
import { PAY_LABELS, type StoreCatalog, visiblePayMethods } from "@/lib/store";
import { fa } from "@/lib/format";

const STEPS = [
  ["انتخاب پلن", "مدت و حجم دلخواه را از جدول بالا انتخاب و مشخصات را بررسی کنید."],
  ["ادامه در ربات", "با دکمه «ادامه خرید در تلگرام»، ربات همان پلن را برای تأیید به شما نشان می‌دهد."],
  ["شارژ کیف پول", "اگر موجودی کافی نیست، از بخش «💰 افزایش موجودی» با روش‌های پرداخت فعال، کیف پول را شارژ کنید."],
  ["تحویل سرویس", "با تأیید سفارش، مبلغ از کیف پول کسر و سرویس ساخته می‌شود؛ لینک و QR اتصال در همان چت ارسال می‌شود."],
] as const;

export function HowItWorks({ catalog }: { catalog: StoreCatalog | null }) {
  const methods = catalog ? visiblePayMethods(catalog) : [];
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-[72px] border-y bg-alt py-[52px] sm:py-[72px]">
      <Container>
        <div className="mx-auto mb-8 max-w-[720px] text-center">
          <h2 id="how-title" className="text-[clamp(24px,3.2vw,34px)] font-extrabold leading-snug">خرید در چهار مرحله</h2>
          <p className="mt-2.5 text-muted-foreground">کیف پول، پرداخت و تحویل سرویس به حساب تلگرام شما متصل است؛ به همین دلیل نهایی‌کردن خرید در ربات انجام می‌شود.</p>
        </div>
        <ol className="grid list-none gap-[18px] p-0 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([title, text], index) => (
            <li key={title} className="rounded-lg border bg-card px-5 py-6">
              <span className="mb-3 inline-grid size-[38px] place-items-center rounded-xl bg-brand/10 font-extrabold text-brand">{fa(index + 1)}</span>
              <h3 className="mb-1.5 text-[17px] font-extrabold">{title}</h3>
              <p className="text-[14.5px] text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
        <div aria-label="روش‌های پرداخت فعال" className="mt-7 flex flex-wrap justify-center gap-3">
          {methods.length > 0 ? (
            <>
              <Badge variant="chip"><Wallet className="size-[18px] text-brand" aria-hidden="true" />شارژ کیف پول در ربات با:</Badge>
              {methods.map((method) => {
                const entry = PAY_LABELS[method.id];
                if (!entry) return null;
                const Icon = entry.icon === "card" ? CreditCard : Coins;
                return <Badge key={method.id} variant="chip"><Icon className="size-[18px] text-brand" aria-hidden="true" />{entry.label}</Badge>;
              })}
            </>
          ) : (
            <Badge variant="chipMuted"><Wallet className="size-[18px] text-brand" aria-hidden="true" />روش‌های پرداخت فعال در ربات نمایش داده می‌شوند</Badge>
          )}
        </div>
      </Container>
    </section>
  );
}

// Native <details>: shadcn's Accordion would add Radix JS for behaviour the browser already provides.
const FAQ: { id?: string; q: string; a: string }[] = [
  { q: "پرداخت کجا و چگونه انجام می‌شود؟", a: "پرداخت در ربات تلگرام و از طریق شارژ کیف پول انجام می‌شود. روش‌های پرداخت فعال در بخش «مراحل خرید» نمایش داده شده‌اند. مبلغ شارژ فقط پس از تأیید پرداخت توسط درگاه به کیف پول اضافه می‌شود." },
  { q: "پس از خرید، سرویس چه زمانی تحویل می‌شود؟", a: "بلافاصله پس از تأیید سفارش، سرویس به‌صورت خودکار ساخته می‌شود و لینک اتصال همراه با QR در ربات ارسال می‌شود. مشخصات سرویس همیشه از بخش «📦 سرویس‌های من» در دسترس است." },
  { q: "اگر ساخت سرویس ناموفق باشد چه می‌شود؟", a: "اگر پنل سرویس درخواست را رد کند، مبلغ به‌طور خودکار و فقط یک بار به کیف پول شما برمی‌گردد. اگر نتیجه ساخت مشخص نباشد، سفارش برای جلوگیری از کسر یا ساخت تکراری تا بررسی پشتیبانی نگه داشته می‌شود." },
  { id: "faq-trial", q: "آیا سرویس تست رایگان دارید؟", a: "بله، هر حساب تلگرام می‌تواند یک سرویس تست رایگان یک‌روزه از دکمه «🎁 سرویس تست» در ربات دریافت کند." },
  { q: "روی چند دستگاه می‌توانم استفاده کنم؟", a: "حداکثر اتصال در پلن‌ها نامحدود است و سرویس روی اندروید، آیفون، ویندوز، مک و سایر دستگاه‌های سازگار با VLESS قابل استفاده است." },
];

/** Browsers do not open a <details> that is itself the target of a #fragment; do it for links to FAQ entries. */
function openFaqForHash(hash: string) {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return; // malformed %-escape in a crafted link: ignore it rather than crash the page
  }
  const target = id ? document.getElementById(id) : null;
  if (target instanceof HTMLDetailsElement) {
    target.open = true;
    target.scrollIntoView({ block: "center" });
  }
}

export function Faq({ botUrl }: { botUrl: string | null }) {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href^="#"]');
      if (link) openFaqForHash(link.getAttribute("href") ?? "");
    };
    const onHashChange = () => openFaqForHash(window.location.hash);
    onHashChange();
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-[72px] py-[52px] sm:py-[72px]">
      <Container className="max-w-[820px]">
        <div className="mx-auto mb-8 max-w-[720px] text-center">
          <h2 id="faq-title" className="text-[clamp(24px,3.2vw,34px)] font-extrabold leading-snug">سوالات متداول</h2>
        </div>
        <div className="grid gap-3">
          {FAQ.map((item) => (
            <details key={item.q} id={item.id} className="group rounded-lg border bg-card open:border-border-strong">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-[18px] font-bold after:flex-none after:text-[22px] after:font-medium after:text-faint after:transition-transform after:content-['+'] group-open:after:rotate-45 [&::-webkit-details-marker]:hidden">
                {item.q}
              </summary>
              <p className="px-5 pb-[18px] text-muted-foreground">{item.a}</p>
              {item.id === "faq-trial" && botUrl ? (
                <p className="px-5 pb-[18px]">
                  <a className={buttonVariants({ variant: "outline", size: "sm" })} href={botUrl} target="_blank" rel="noopener"><Send aria-hidden="true" />باز کردن ربات</a>
                </p>
              ) : null}
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}
