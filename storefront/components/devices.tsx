import { useState } from "react";
import { Apple, BookOpen, Link2, Monitor, QrCode, Smartphone, TabletSmartphone } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Container, SectionHeading } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Simple brand-neutral glyphs for the two platforms Lucide has no icon for. */
function AndroidIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M6 8.2a6 6 0 0 1 12 0H6Z" />
      <path d="M6 9.4h12v7.2A1.4 1.4 0 0 1 16.6 18H15.5v2.6a1.1 1.1 0 0 1-2.2 0V18h-2.6v2.6a1.1 1.1 0 0 1-2.2 0V18H7.4A1.4 1.4 0 0 1 6 16.6V9.4Z" />
      <rect x="2.6" y="9.4" width="2.2" height="6.4" rx="1.1" />
      <rect x="19.2" y="9.4" width="2.2" height="6.4" rx="1.1" />
      <path d="m8.4 3.2 1.1 1.7m6.1-1.7-1.1 1.7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M3 5.4 10.5 4.4v7H3v-6Zm8.7-1.2L21 3v8.4h-9.3V4.2ZM3 12.6h7.5v7L3 18.6v-6Zm8.7 0H21V21l-9.3-1.3v-7.1Z" />
    </svg>
  );
}

/** Step-by-step posts the bot itself links from «📖 راهنما» (handlers/message/handleGuide.js). */
const GUIDE_POSTS = { android: "https://t.me/swift_shield/7", ios: "https://t.me/swift_shield/6", windows: "https://t.me/swift_shield/8" } as const;

interface Platform {
  id: "android" | "ios" | "windows" | "macos";
  label: string;
  icon: React.ReactNode;
  intro: string;
  steps: string[];
  guide?: string;
  note?: string;
}

const PLATFORMS: Platform[] = [
  {
    id: "android",
    label: "اندروید",
    icon: <AndroidIcon className="size-[19px]" />,
    intro: "روی گوشی و تبلت اندروید، QR یا لینک اشتراک را در یک برنامهٔ سازگار با VLESS وارد می‌کنید.",
    steps: [
      "سرویس را از ربات بخرید یا سرویس تست را بگیرید تا پیام تحویل (لینک اشتراک و QR) برایتان بیاید.",
      "یک برنامهٔ سازگار با VLESS و لینک اشتراک را از فروشگاه رسمی دستگاه نصب کنید؛ نام برنامه‌های توصیه‌شده را در آموزش گام‌به‌گام پایین می‌بینید.",
      "لینک اشتراک را در پیام ربات با لمس طولانی کپی کنید و در برنامه از بخش افزودن اشتراک یا وارد کردن از کلیپ‌بورد اضافه کنید. اگر QR را روی دستگاه دیگری باز کرده‌اید، با دوربینِ خودِ برنامه اسکنش کنید.",
      "در برنامه یک لوکیشن از فهرست انتخاب کنید و اتصال را روشن کنید.",
    ],
    guide: GUIDE_POSTS.android,
  },
  {
    id: "ios",
    label: "آیفون و آیپد",
    icon: <TabletSmartphone className="size-[19px]" aria-hidden="true" />,
    intro: "روی iOS و iPadOS هم همین الگو برقرار است: برنامهٔ سازگار نصب می‌کنید و لینک یا QR را در آن وارد می‌کنید.",
    steps: [
      "سرویس را از ربات بخرید یا سرویس تست را بگیرید تا لینک اشتراک و QR را دریافت کنید.",
      "یک برنامهٔ سازگار با VLESS و لینک اشتراک را از اپ‌استور نصب کنید؛ نام برنامه‌های توصیه‌شده در آموزش گام‌به‌گام آمده است.",
      "لینک اشتراک را کپی و در برنامه وارد کنید، یا QR را از دستگاه دیگر با برنامه اسکن کنید. هنگام اولین اتصال، iOS اجازهٔ افزودن پیکربندی VPN را می‌پرسد.",
      "یک لوکیشن انتخاب و اتصال را روشن کنید.",
    ],
    guide: GUIDE_POSTS.ios,
  },
  {
    id: "windows",
    label: "ویندوز",
    icon: <WindowsIcon className="size-[19px]" />,
    intro: "روی ویندوز معمولاً لینک اشتراک را کپی و در برنامهٔ سازگار وارد می‌کنید؛ برای QR نیازی به دوربین نیست.",
    steps: [
      "سرویس را بخرید یا سرویس تست را بگیرید. می‌توانید تلگرام را روی همان ویندوز باز کنید تا لینک اشتراک را مستقیم کپی کنید.",
      "یک برنامهٔ دسکتاپ سازگار با VLESS و لینک اشتراک نصب کنید؛ نام برنامه‌های توصیه‌شده در آموزش گام‌به‌گام ویندوز آمده است.",
      "لینک اشتراک را در برنامه از بخش افزودن اشتراک وارد کنید و به‌روزرسانی را بزنید تا لوکیشن‌ها بیایند.",
      "یک لوکیشن انتخاب و اتصال را روشن کنید.",
    ],
    guide: GUIDE_POSTS.windows,
  },
  {
    id: "macos",
    label: "مک",
    icon: <Apple className="size-[19px]" aria-hidden="true" />,
    intro: "روی macOS هر برنامهٔ سازگار با VLESS و لینک اشتراک می‌تواند سرویس را بگیرد.",
    steps: [
      "سرویس را بخرید یا سرویس تست را بگیرید و لینک اشتراک را از ربات کپی کنید.",
      "یک برنامهٔ سازگار با VLESS و لینک اشتراک برای macOS نصب کنید (از منبع رسمی خود برنامه).",
      "لینک اشتراک را در بخش افزودن اشتراک وارد کنید و لوکیشن‌ها را به‌روز کنید.",
      "یک لوکیشن انتخاب و اتصال را روشن کنید.",
    ],
    note: "برای macOS آموزش اختصاصی در ربات وجود ندارد. اگر برنامه‌ای را نمی‌شناسید یا لینک را قبول نکرد، از «🛠 پشتیبانی» در ربات کمک بگیرید.",
  },
];

const GLOSSARY = [
  { icon: Link2, term: "VLESS چیست؟", text: "نام پروتکلی است که سرویس شما با آن کار می‌کند. شما فقط به برنامه‌ای نیاز دارید که از VLESS پشتیبانی کند." },
  { icon: Link2, term: "لینک اشتراک چیست؟", text: "یک آدرس اینترنتی است که ربات تحویل می‌دهد. برنامه با آن لیست لوکیشن‌های سرویس شما را می‌گیرد؛ «لینک هوشمند» همه لوکیشن‌ها و «لینک تکی» فقط یک لوکیشن را می‌دهد." },
  { icon: QrCode, term: "QR چیست؟", text: "همان لینک اشتراک به‌شکل تصویر است تا بدون تایپ و کپی، با دوربینِ برنامه وارد شود. اگر QR و برنامه روی یک دستگاه‌اند، به‌جای اسکن، لینک را کپی کنید." },
] as const;

export function DeviceGuide() {
  const [platform, setPlatform] = useState<Platform["id"]>("android");
  return (
    <section id="devices" aria-labelledby="devices-title" className="scroll-mt-[72px] border-y bg-alt py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="devices-title" eyebrow="راهنمای اتصال" title="روی کدام دستگاه استفاده می‌کنید؟">
          خرید در ربات انجام می‌شود و اتصال در یک برنامهٔ جداگانه. سویفت برنامهٔ اختصاصی ندارد؛ خروجی خرید یک لینک اشتراک و QR است که در برنامه‌ای سازگار با VLESS وارد می‌کنید.
        </SectionHeading>
        <div data-reveal>
          <Tabs value={platform} onValueChange={(value) => setPlatform(value as Platform["id"])} dir="rtl">
            <TabsList aria-label="سیستم‌عامل" className="mb-8 w-fit max-w-full max-sm:grid max-sm:w-full max-sm:grid-cols-2">
              {PLATFORMS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id} className="min-w-24 gap-2 px-4">
                  {entry.icon}
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {PLATFORMS.map((entry) => (
              <TabsContent key={entry.id} value={entry.id} forceMount>
                <div className="mx-auto grid max-w-[860px] gap-5 lg:grid-cols-[1fr_1.15fr] lg:items-start">
                  <div className="rounded-lg border bg-card p-5">
                    <span className="mb-3 inline-grid size-12 place-items-center rounded-2xl bg-brand/10 text-brand [&_svg]:size-6">{entry.icon}</span>
                    <h3 className="mb-1.5 text-lg font-extrabold">{entry.label}</h3>
                    <p className="text-[14.5px] text-muted-foreground">{entry.intro}</p>
                    {entry.guide ? (
                      <a href={entry.guide} target="_blank" rel="noopener" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "press mt-4")}>
                        <BookOpen aria-hidden="true" />آموزش گام‌به‌گام و معرفی برنامه
                      </a>
                    ) : null}
                    {entry.note ? <p className="mt-4 rounded-lg bg-secondary p-3 text-[13.5px] text-muted-foreground">{entry.note}</p> : null}
                  </div>
                  <ol className="grid list-none gap-3 p-0">
                    {entry.steps.map((step, index) => (
                      <li key={step} className="lift flex gap-3 rounded-lg border bg-card p-4">
                        <span className="inline-grid size-8 flex-none place-items-center rounded-lg bg-brand/10 text-sm font-extrabold text-brand"><span className="sr-only">مرحلهٔ </span>{fa(index + 1)}</span>
                        <p className="text-[14.5px] text-muted-foreground">{step}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              </TabsContent>
            ))}
          </Tabs>
          <div className="mx-auto mt-10 grid max-w-[980px] gap-4 md:grid-cols-3">
            {GLOSSARY.map((item) => (
              <div key={item.term} className="lift rounded-lg border bg-card p-4">
                <div className="mb-1.5 flex items-center gap-2.5"><item.icon className="icon-pop size-[18px] text-brand" aria-hidden="true" /><h3 className="text-[15.5px] font-extrabold">{item.term}</h3></div>
                <p className="text-[13.5px] text-muted-foreground">{item.text}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 flex flex-wrap items-center justify-center gap-2 text-center text-[13px] text-faint">
            <Smartphone className="size-4" aria-hidden="true" /><Monitor className="size-4" aria-hidden="true" />
            همهٔ پلن‌ها اتصال نامحدود کاربر دارند؛ یک سرویس را می‌توان روی چند دستگاه وارد کرد.
          </p>
        </div>
      </Container>
    </section>
  );
}
