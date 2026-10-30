import { Infinity as InfinityIcon, LifeBuoy, ReceiptText, RotateCcw, Wallet, Zap } from "lucide-react";

import { Container, SectionHeading } from "@/components/site-chrome";

/**
 * Only things the code does today: automatic delivery (services/buyService),
 * the server-side re-pricing at confirmation, the automatic one-time refund
 * when the panel rejects creation (orderService), two top-up methods, and the
 * ticket-based support. No ratings, counts or uptime numbers on purpose.
 */
const ITEMS = [
  { icon: Zap, title: "تحویل خودکار", text: "پس از تأیید سفارش، سرویس بدون دخالت دستی ساخته می‌شود و لینک و QR در تلگرام می‌آید." },
  { icon: ReceiptText, title: "قیمت شفاف", text: "قیمت پلن‌ها به تومان از کاتالوگ فروش خوانده می‌شود و هنگام تأیید سفارش دوباره روی سرور کنترل می‌شود." },
  { icon: InfinityIcon, title: "اتصال نامحدود کاربر", text: "در همهٔ پلن‌ها حداکثر اتصال نامحدود است؛ پلن‌ها در حجم و مدت تفاوت دارند." },
  { icon: Wallet, title: "دو روش شارژ کیف پول", text: "کارت‌به‌کارت (از طریق درگاه) و ارز دیجیتال، بسته به روش‌های فعال در ربات." },
  { icon: RotateCcw, title: "بازگشت مبلغ در خطای ساخت", text: "اگر پنل سرویس ساخت سرویس را رد کند، مبلغ رزروشده به کیف پول شما برمی‌گردد." },
  { icon: LifeBuoy, title: "پشتیبانی داخل ربات", text: "از «🛠 پشتیبانی» تیکت ثبت کنید و پاسخ را در تلگرام یا پنل وب پیگیری کنید." },
] as const;

export function Trust() {
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-[72px] py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="features-title" eyebrow="چرا سویفت" title="آنچه از این سرویس انتظار دارید">
          بدون عدد و آمار ساختگی؛ فقط روندی که واقعاً در ربات اجرا می‌شود.
        </SectionHeading>
        <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map((item, index) => (
            <li key={item.title} data-reveal style={{ "--reveal-delay": `${index * 60}ms` } as React.CSSProperties} className="lift rounded-lg border bg-card p-5">
              <span className="mb-3.5 inline-grid size-11 place-items-center rounded-xl bg-brand/10 text-brand"><item.icon className="icon-pop size-5" aria-hidden="true" /></span>
              <h3 className="mb-1.5 text-[17px] font-extrabold">{item.title}</h3>
              <p className="text-[14.5px] text-muted-foreground">{item.text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
