import { useState } from "react";
import { BadgeCheck, CircleAlert, Coins, CreditCard, FileSearch, Hourglass, Network, Receipt, Send, Wallet } from "lucide-react";

import { BotMock, type MockButton, type MockLine } from "@/components/bot-mock";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Container, SectionHeading } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Everything on this page describes what the bot does today
 * (paymentHandlers/payHoosh.js for card-to-card, paymentHandlers/payNowPayments.js
 * for crypto). Mockups use placeholder values only: no real card, address or amount.
 */
interface Step { title: string; text: string; mock: { title: string; lines?: MockLine[]; rows?: MockButton[][] } }
interface FlowNode { label: string; icon: typeof Send }

const MENU_ROWS: MockButton[][] = [[{ label: "🛒 خرید سرویس" }], [{ label: "📦 سرویس‌های من" }, { label: "💰 افزایش موجودی", hot: true }]];

const CARD_FLOW: FlowNode[] = [
  { label: "ربات تلگرام", icon: Send },
  { label: "انتخاب کارت‌به‌کارت", icon: CreditCard },
  { label: "پرداخت طبق فاکتور", icon: Receipt },
  { label: "بررسی درگاه", icon: Hourglass },
  { label: "شارژ کیف پول", icon: Wallet },
];

const CARD_STEPS: Step[] = [
  {
    title: "ورود به افزایش موجودی",
    text: "ربات سویفت را باز کنید و از منوی اصلی «💰 افزایش موجودی» را بزنید.",
    mock: { title: "منوی اصلی", rows: MENU_ROWS },
  },
  {
    title: "انتخاب کارت‌به‌کارت",
    text: "از میان روش‌های پرداخت، «💳 پرداخت آنلاین کارت به کارت» را انتخاب کنید.",
    mock: { title: "💰 افزایش موجودی کیف پول", lines: [{ text: "لطفاً روش پرداخت را انتخاب کنید.", muted: true }], rows: [[{ label: "💳 پرداخت آنلاین کارت به کارت", hot: true }], [{ label: "🪙 پرداخت با کریپتو" }]] },
  },
  {
    title: "مبلغ را وارد کنید",
    text: `مبلغ شارژ را به تومان و با کاما بنویسید، مثلاً 50,000. حداقل ${fa(10000)} و حداکثر ${fa(50000000)} تومان.`,
    mock: { title: "💳 پرداخت آنلاین کارت به کارت", lines: [{ text: "مبلغ را به تومان وارد کنید", muted: true }, { text: "مثال: 50,000", strong: true }, { text: `حداقل: ${fa(10000)} تومان`, muted: true }] },
  },
  {
    title: "فاکتور را بررسی و پرداخت کنید",
    text: "ربات فاکتور می‌سازد: مبلغ درخواستی، کارمزد درگاه (در صورت وجود)، مبلغ قابل پرداخت و مشخصات کارت مقصد. دقیقاً همان مبلغ قابل پرداخت را با «پرداخت اکنون» یا به کارت مقصد واریز کنید. فاکتور مهلت محدودی دارد.",
    mock: { title: "✅ فاکتور پرداخت ایجاد شد", lines: [{ text: "مبلغ قابل پرداخت: ••• تومان" }, { text: "کارت مقصد: •••• •••• •••• ••••" }, { text: "مهلت پرداخت محدود است", muted: true }], rows: [[{ label: "💳 پرداخت اکنون", hot: true }], [{ label: "✅ پرداخت کردم" }]] },
  },
  {
    title: "«پرداخت کردم» و تأیید درگاه",
    text: "بعد از پرداخت، «✅ پرداخت کردم» را بزنید تا ربات وضعیت را از درگاه بپرسد. ارسال رسید لازم نیست. اگر پرداخت هنوز تأیید نشده، کمی بعد دوباره بزنید؛ موجودی فقط پس از تأیید درگاه به کیف پول اضافه می‌شود.",
    mock: { title: "⏳ در حال بررسی وضعیت پرداخت…", lines: [{ text: "پس از تأیید درگاه، موجودی کیف پول شما اضافه می‌شود.", muted: true }], rows: [[{ label: "✅ پرداخت کردم", hot: true }]] },
  },
];

const CRYPTO_FLOW: FlowNode[] = [
  { label: "انتخاب رمزارز", icon: Coins },
  { label: "انتخاب شبکه", icon: Network },
  { label: "ساخت فاکتور", icon: Receipt },
  { label: "ارسال پرداخت", icon: Send },
  { label: "تأیید تراکنش", icon: BadgeCheck },
];

const CRYPTO_STEPS: Step[] = [
  {
    title: "ورود به افزایش موجودی",
    text: "در ربات «💰 افزایش موجودی» را بزنید و «🪙 پرداخت با کریپتو» را انتخاب کنید.",
    mock: { title: "💰 افزایش موجودی کیف پول", lines: [{ text: "لطفاً روش پرداخت را انتخاب کنید.", muted: true }], rows: [[{ label: "💳 پرداخت آنلاین کارت به کارت" }], [{ label: "🪙 پرداخت با کریپتو", hot: true }]] },
  },
  {
    title: "رمزارز را انتخاب کنید",
    text: "ربات فهرست رمزارزهای فعال را نشان می‌دهد؛ همان را انتخاب کنید که در کیف پول مبدأ شما موجود است.",
    mock: { title: "🪙 ارز دیجیتال موردنظر را انتخاب کنید", lines: [{ text: "شبکهٔ انتقال را در مرحلهٔ بعد انتخاب می‌کنید.", muted: true }], rows: [[{ label: "USDT", hot: true }, { label: "TRX" }], [{ label: "TON" }, { label: "BTC" }]] },
  },
  {
    title: "شبکه را انتخاب کنید",
    text: "اگر رمزارز در چند شبکه فعال باشد، شبکه‌ای را بزنید که کیف پول مبدأ شما پشتیبانی می‌کند. ارسال از شبکهٔ اشتباه ممکن است به از دست رفتن وجه منجر شود.",
    mock: { title: "🌐 شبکه انتقال USDT را انتخاب کنید", lines: [{ text: "⚠️ ارسال از شبکه اشتباه باعث از دست رفتن وجه می‌شود.", muted: true }], rows: [[{ label: "TRC20", hot: true }, { label: "BEP20" }]] },
  },
  {
    title: "مبلغ را وارد و تأیید کنید",
    text: "مبلغ شارژ را به تومان بنویسید؛ حداقل و حداکثر مجاز در همان مرحله در ربات نوشته می‌شود و هر رمزارز ممکن است حداقل مبلغ خودش را هم داشته باشد. ربات برآورد مبلغ رمزارز را نشان می‌دهد؛ این عدد تقریبی است.",
    mock: { title: "🪙 تأیید افزایش موجودی", lines: [{ text: "مبلغ شارژ: ••• تومان" }, { text: "برآورد پرداخت: ≈ ••• USDT" }, { text: "مبلغ تقریبی است و ممکن است کمی تفاوت داشته باشد", muted: true }], rows: [[{ label: "✅ تأیید و ایجاد فاکتور پرداخت", hot: true }]] },
  },
  {
    title: "فاکتور را پرداخت کنید",
    text: "با «🔗 پرداخت فاکتور» صفحهٔ پرداخت درگاه باز می‌شود. مبلغ قابل پرداخت و مشخصات انتقال را همان‌جا و در پیام ربات بررسی و دقیقاً همان رمزارز را روی همان شبکه ارسال کنید.",
    mock: { title: "✅ فاکتور پرداخت ایجاد شد", lines: [{ text: "مبلغ قابل پرداخت: ••• USDT (TRC20)" }, { text: "آدرس در صفحهٔ پرداخت درگاه نمایش داده می‌شود", muted: true }], rows: [[{ label: "🔗 پرداخت فاکتور", hot: true }], [{ label: "🔍 بررسی وضعیت پرداخت" }]] },
  },
  {
    title: "تأیید تراکنش و شارژ کیف پول",
    text: "با «🔍 بررسی وضعیت پرداخت» وضعیت را ببینید: منتظر پرداخت، در انتظار تأیید شبکه یا تأییدشده. موجودی فقط پس از تأیید معتبر پرداخت اضافه می‌شود؛ زمان تأیید ثابت نیست و به شبکه بستگی دارد.",
    mock: { title: "🔍 وضعیت پرداخت", lines: [{ text: "🔄 پرداخت دریافت شد و در انتظار تأیید شبکه است." }, { text: "✅ پس از تأیید، کیف پول شارژ می‌شود", muted: true }], rows: [[{ label: "🔍 بررسی وضعیت پرداخت", hot: true }]] },
  },
];

function FlowStrip({ nodes, label }: { nodes: FlowNode[]; label: string }) {
  return (
    <ol aria-label={label} className="relative mx-auto mb-8 grid max-w-[720px] list-none grid-cols-5 gap-1 p-0">
      <span aria-hidden="true" className="absolute inset-x-[10%] top-[21px] h-px bg-gradient-to-l from-brand/60 via-brand/30 to-border" />
      {nodes.map((node, index) => (
        <li key={node.label} className="group relative grid justify-items-center gap-2 text-center">
          <span className="relative grid size-[42px] place-items-center rounded-full border border-brand/40 bg-card text-brand shadow-[var(--shadow-card)] transition-transform duration-300 group-hover:scale-110 [&_svg]:size-[19px]">
            <node.icon aria-hidden="true" />
            <span className="absolute -end-1 -top-1 grid size-[18px] place-items-center rounded-full bg-primary text-[10.5px] font-extrabold text-primary-foreground">{fa(index + 1)}</span>
          </span>
          <span className="text-[11.5px] font-bold leading-tight text-muted-foreground sm:text-[13px]">{node.label}</span>
        </li>
      ))}
    </ol>
  );
}

function StepGrid({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
      {steps.map((step, index) => (
        <li key={step.title} className="lift flex flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex items-center gap-3">
            <span className="inline-grid size-9 flex-none place-items-center rounded-xl bg-brand/10 text-[15px] font-extrabold text-brand"><span className="sr-only">مرحلهٔ </span>{fa(index + 1)}</span>
            <h3 className="text-[16px] font-extrabold leading-snug">{step.title}</h3>
          </div>
          <p className="text-[14px] text-muted-foreground">{step.text}</p>
          <BotMock className="mt-auto" title={step.mock.title} lines={step.mock.lines} rows={step.mock.rows} />
        </li>
      ))}
    </ol>
  );
}

function Callout({ tone, title, children }: { tone: "warn" | "info"; title: string; children: React.ReactNode }) {
  return (
    <div className={cn("mt-6 flex gap-3 rounded-lg border p-4", tone === "warn" ? "border-destructive/40 bg-destructive/10" : "border-border-strong bg-card")}>
      {tone === "warn" ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" /> : <FileSearch className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />}
      <div>
        <p className="mb-1.5 font-extrabold">{title}</p>
        <div className="text-[14px] text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function PaymentGuide({ botUrl }: { botUrl: string | null }) {
  const [method, setMethod] = useState("card");
  return (
    <section id="payment" aria-labelledby="payment-title" className="scroll-mt-[72px] py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="payment-title" eyebrow="راهنمای تصویری" title="شارژ کیف پول: کارت‌به‌کارت یا ارز دیجیتال">
          پرداخت‌ها داخل ربات تلگرام انجام می‌شود، نه روی این صفحه. قبل از شروع ببینید هر روش دقیقاً چه مراحلی دارد. روش‌هایی که در لحظهٔ خرید در ربات فعال باشند قابل انتخاب‌اند.
        </SectionHeading>
        <div data-reveal>
          <Tabs value={method} onValueChange={setMethod} dir="rtl">
            <TabsList aria-label="روش پرداخت" className="mb-8 grid w-full max-w-[460px] grid-cols-2">
              <TabsTrigger value="card" className="gap-2 px-3 max-sm:flex-col max-sm:gap-1 max-sm:py-2 max-sm:leading-snug max-sm:text-balance"><CreditCard className="size-[18px]" aria-hidden="true" />پرداخت کارت به کارت</TabsTrigger>
              <TabsTrigger value="crypto" className="gap-2 px-3 max-sm:flex-col max-sm:gap-1 max-sm:py-2 max-sm:leading-snug max-sm:text-balance"><Coins className="size-[18px]" aria-hidden="true" />پرداخت کریپتو</TabsTrigger>
            </TabsList>

            <TabsContent value="card" forceMount>
              <FlowStrip nodes={CARD_FLOW} label="مسیر پرداخت کارت‌به‌کارت" />
              <StepGrid steps={CARD_STEPS} />
              <Callout tone="info" title="نکته‌هایی که پرسش پشتیبانی را کم می‌کند">
                <ul className="grid list-disc gap-1 ps-5">
                  <li>همیشه مبلغ «قابل پرداخت» فاکتور را واریز کنید؛ ممکن است با مبلغ درخواستی شما فرق داشته باشد، چون کارمزد درگاه، اگر وجود داشته باشد، در فاکتور نوشته می‌شود.</li>
                  <li>فاکتور مهلت دارد. اگر منقضی شد، فاکتور جدید بسازید و به فاکتور قدیمی پرداخت نکنید.</li>
                  <li>تأیید پرداخت با درگاه است و زمان ثابتی ندارد. اگر پرداخت کرده‌اید اما موجودی اضافه نشد، شناسهٔ فاکتور را برای پشتیبانی بفرستید.</li>
                </ul>
              </Callout>
            </TabsContent>

            <TabsContent value="crypto" forceMount>
              <FlowStrip nodes={CRYPTO_FLOW} label="مسیر پرداخت با ارز دیجیتال" />
              <StepGrid steps={CRYPTO_STEPS} />
              <Callout tone="warn" title="قبل از ارسال حتماً بررسی کنید">
                <ul className="grid list-disc gap-1 ps-5">
                  <li>رمزارز و شبکه باید دقیقاً همان باشند که در فاکتور آمده است؛ ارسال از شبکهٔ دیگر ممکن است باعث از دست رفتن وجه شود.</li>
                  <li>مبلغ و آدرس را از فاکتور یا صفحهٔ پرداخت کپی کنید و پیش از تأیید دوباره بررسی کنید.</li>
                  <li>کارمزد انتقال شبکه معمولاً از کیف پول مبدأ شما کسر می‌شود و جدا از مبلغ فاکتور است؛ مبلغی کمتر از مبلغ فاکتور به دست درگاه نرسانید. پرداخت ناقص برای بررسی به پشتیبانی ارجاع داده می‌شود.</li>
                  <li>فهرست رمزارزها و شبکه‌ها به تنظیمات درگاه بستگی دارد و در خود ربات نمایش داده می‌شود؛ احتمالاً USDT (در چند شبکه)، TRX، TON، BTC، LTC و BNB را می‌بینید.</li>
                </ul>
              </Callout>
            </TabsContent>
          </Tabs>
          <div className="mt-8 flex flex-col items-center gap-3">
            {botUrl ? (
              <a href={botUrl} target="_blank" rel="noopener" className={cn(buttonVariants({ size: "lg" }), "press")}><Send aria-hidden="true" />باز کردن ربات و شارژ کیف پول</a>
            ) : (
              <a href="#plans" className={cn(buttonVariants({ size: "lg" }), "press")}>انتخاب پلن و ادامه در تلگرام</a>
            )}
            <p className="max-w-[560px] text-center text-[13px] text-faint">اگر هنوز پلنی انتخاب نکرده‌اید، می‌توانید اول پلن را از بخش پلن‌ها انتخاب کنید؛ ربات در صورت کمبود موجودی شما را به شارژ کیف پول هدایت می‌کند.</p>
          </div>
        </div>
      </Container>
    </section>
  );
}
