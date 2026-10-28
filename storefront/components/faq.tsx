import { useEffect } from "react";
import { ChevronDown, Send } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Container, SectionHeading } from "@/components/site-chrome";
import { cn } from "@/lib/utils";

/**
 * Answers describe the bot as implemented (card-to-card = HooshPay gateway,
 * crypto = NOWPayments, refunds from services/buyService/orderService.js).
 * No refund policy, response time or compatibility guarantee is invented.
 */
export interface FaqItem { id?: string; q: string; a: string; links?: { href: string; label: string }[] }

export const FAQ_ITEMS: FaqItem[] = [
  { q: "چطور اشتراک بخرم؟", a: "در بخش پلن‌ها مدت و حجم را انتخاب کنید و «ادامه خرید در تلگرام» را بزنید. ربات همان پلن را نشان می‌دهد؛ با «✅ تایید سفارش» مبلغ از کیف پول کسر و سرویس ساخته می‌شود. اگر موجودی کافی نباشد، ابتدا کیف پول را شارژ کنید.", links: [{ href: "#plans", label: "مشاهده پلن‌ها" }, { href: "#how", label: "مراحل خرید" }] },
  { q: "پرداخت کارت‌به‌کارت چطور کار می‌کند؟", a: "در ربات «💰 افزایش موجودی» و سپس «💳 پرداخت آنلاین کارت به کارت» را بزنید، مبلغ را به تومان وارد کنید و مبلغ قابل پرداختِ فاکتور را طبق راهنمای ربات واریز کنید. بعد «✅ پرداخت کردم» را بزنید؛ موجودی پس از تأیید درگاه اضافه می‌شود. ارسال رسید در این روش لازم نیست.", links: [{ href: "#payment", label: "راهنمای تصویری" }] },
  { q: "پرداخت با ارز دیجیتال چطور کار می‌کند؟", a: "در ربات «🪙 پرداخت با کریپتو» را بزنید، رمزارز و شبکه را انتخاب کنید، مبلغ را به تومان وارد و فاکتور را بسازید. سپس همان رمزارز را روی همان شبکه و به مبلغ فاکتور ارسال کنید. موجودی پس از تأیید معتبر پرداخت اضافه می‌شود و زمان تأیید ثابتی ندارد.", links: [{ href: "#payment", label: "راهنمای تصویری" }] },
  { q: "کدام رمزارزها و شبکه‌ها پشتیبانی می‌شوند؟", a: "فهرست دقیق، لحظهٔ پرداخت در ربات نمایش داده می‌شود و به تنظیمات درگاه بستگی دارد. گزینه‌های تعریف‌شده شامل USDT (روی شبکه‌های TRC20، BEP20، TON، SOL و Polygon)، TRX، TON، LTC، BTC و BNB است، به شرط آن‌که در درگاه فعال باشند. حداقل مبلغ هر رمزارز را هم ربات هنگام ساخت فاکتور بررسی می‌کند." },
  { q: "سرویس چه زمانی تحویل می‌شود؟", a: "پس از تأیید سفارش و کسر مبلغ از کیف پول، سرویس به‌صورت خودکار ساخته و لینک اشتراک همراه با QR در ربات ارسال می‌شود. زمان دقیق تضمین نمی‌شود، چون به پاسخ پنل سرویس بستگی دارد. هر سرویس از «📦 سرویس‌های من» هم در دسترس است." },
  { q: "چطور نصب کنم و وصل شوم؟", a: "یک برنامهٔ سازگار با VLESS و لینک اشتراک روی دستگاه نصب کنید و لینک یا QR دریافتی از ربات را در آن وارد کنید. مراحل هر سیستم‌عامل در بخش راهنمای اتصال آمده است.", links: [{ href: "#devices", label: "راهنمای اتصال" }] },
  { q: "VLESS چیست؟", a: "VLESS نام پروتکلی است که سرویس شما از آن استفاده می‌کند. برای استفاده لازم نیست جزئیات فنی آن را بدانید؛ فقط به برنامه‌ای نیاز دارید که از VLESS و لینک اشتراک (Subscription) پشتیبانی کند." },
  { q: "تفاوت اشتراک و موجودی کیف پول چیست؟", a: "موجودی کیف پول پولی است که با کارت‌به‌کارت یا ارز دیجیتال در حساب تلگرام شما شارژ می‌شود. اشتراک همان سرویس VPN است که با کسر مبلغ پلن از کیف پول ساخته می‌شود. شارژ کیف پول به‌تنهایی سرویسی نمی‌سازد." },
  { q: "روی چند دستگاه می‌توانم استفاده کنم؟", a: "حداکثر اتصال در پلن‌ها نامحدود است و لینک اشتراک را می‌توانید روی اندروید، آیفون، ویندوز، مک و سایر دستگاه‌های دارای برنامهٔ سازگار وارد کنید." },
  { q: "اگر پرداخت کردم ولی موجودی اضافه نشد چه کنم؟", a: "در کارت‌به‌کارت چند لحظه بعد دوباره «✅ پرداخت کردم» را بزنید؛ در ارز دیجیتال «🔍 بررسی وضعیت پرداخت» وضعیت فاکتور را نشان می‌دهد (مثلاً در انتظار تأیید شبکه). اگر فاکتور منقضی یا پرداخت ناقص شده بود یا مبلغ را پرداخت کرده‌اید و موجودی اضافه نشد، شناسهٔ فاکتور را با تیکت پشتیبانی بفرستید.", links: [{ href: "#payment", label: "راهنمای پرداخت" }] },
  { q: "اگر ساخت سرویس ناموفق باشد چه می‌شود؟", a: "اگر پنل سرویس درخواست را رد کند، مبلغ رزروشده به کیف پول شما برمی‌گردد. اگر نتیجه مشخص نباشد، سفارش برای جلوگیری از کسر یا ساخت تکراری تا بررسی نگه داشته می‌شود؛ در این حالت سفارش جدید ثبت نکنید." },
  { q: "لینک و پیکربندی سرویس را دوباره از کجا بگیرم؟", a: "در ربات از منوی اصلی «📦 سرویس‌های من» را بزنید؛ مشخصات و لینک هر سرویس خریداری‌شده آن‌جا در دسترس است." },
  { id: "faq-trial", q: "آیا سرویس تست رایگان دارید؟", a: "بله. هر حساب تلگرام یک‌بار می‌تواند از دکمهٔ «🎁 سرویس تست» در منوی اصلی ربات یک سرویس تست یک‌روزه بگیرد.", links: [{ href: "#trial", label: "جزئیات سرویس تست" }] },
  { q: "چطور با پشتیبانی تماس بگیرم؟", a: "در ربات «🛠 پشتیبانی» را بزنید و تیکت ثبت کنید؛ پاسخ را در تلگرام یا پنل وب پشتیبانی (با لینک ورودی که ربات می‌دهد) می‌بینید. اگر راه ارتباط مستقیم تعریف شده باشد، پیوند «پشتیبانی» پایین صفحه هم کار می‌کند. زمان پاسخ‌گویی تضمین نمی‌شود." },
  { q: "اگر وصل نمی‌شوم چه کنم؟", a: "برنامه را به‌روز کنید، لینک اشتراک را دوباره وارد و فهرست لوکیشن‌ها را به‌روزرسانی کنید، یک لوکیشن دیگر یا «لینک تکی» را امتحان کنید و ساعت و تاریخ دستگاه را بررسی کنید. اگر مشکل ماند، همراه با نام دستگاه و برنامه، تیکت پشتیبانی ثبت کنید." },
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
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-[72px] border-t bg-alt py-[52px] sm:py-[72px]">
      <Container className="max-w-[820px]">
        <SectionHeading id="faq-title" eyebrow="پرسش‌های رایج" title="سوالات متداول">پاسخ کوتاه به پرسش‌هایی که پیش از خرید معمولاً مطرح می‌شود.</SectionHeading>
        <div data-reveal className="grid gap-3">
          {FAQ_ITEMS.map((item) => (
            <details key={item.q} id={item.id} className="group rounded-lg border bg-card transition-colors hover:border-border-strong open:border-brand/40 open:shadow-[var(--shadow-card)]">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-[18px] font-bold [&::-webkit-details-marker]:hidden">
                {item.q}
                <ChevronDown className="size-5 flex-none text-faint transition-transform duration-300 group-open:rotate-180 group-open:text-brand" aria-hidden="true" />
              </summary>
              <div className="faq-body px-5 pb-[18px]">
                <p className="text-muted-foreground">{item.a}</p>
                {item.links || (item.id === "faq-trial" && botUrl) ? (
                  <p className="mt-3 flex flex-wrap gap-2">
                    {item.links?.map((link) => (
                      <a key={link.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "press")} href={link.href}>{link.label}</a>
                    ))}
                    {item.id === "faq-trial" && botUrl ? (
                      <a className={cn(buttonVariants({ variant: "outline", size: "sm" }), "press")} href={botUrl} target="_blank" rel="noopener"><Send aria-hidden="true" />باز کردن ربات</a>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}
