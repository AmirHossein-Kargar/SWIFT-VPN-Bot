import { BASE_PATH } from "@/lib/basePath";
import { cn } from "@/lib/utils";

// Official Swift brand-kit lockups (public/brand). Intrinsic aspect ratios
// come from the source SVG viewBoxes so the marks are never stretched.
const VARIANTS = {
  horizontal: { light: "logo-horizontal.svg", dark: "logo-horizontal-on-dark.svg", ratio: 146.03 / 55.5 },
  stacked: { light: "logo-stacked.svg", dark: "logo-stacked-on-dark.svg", ratio: 73.3247 / 91.88 },
  icon: { light: "icon.svg", dark: "icon-on-dark.svg", ratio: 1 },
} as const;

/**
 * Both theme variants are rendered and CSS (globals.css .brand-on-*) shows the
 * one matching the active theme. Choosing in JSX would read the theme on the
 * client only and mismatch the server render. The hidden variant is
 * display:none, so assistive tech announces the logo once.
 */
export function Logo({
  variant = "horizontal",
  height = 28,
  className,
  alt = "Swift",
}: {
  variant?: keyof typeof VARIANTS;
  height?: number;
  className?: string;
  alt?: string;
}) {
  const config = VARIANTS[variant];
  const width = config.ratio ? Math.round(height * config.ratio) : undefined;
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${BASE_PATH}/brand/${config.light}`} alt={alt} height={height} width={width} className="brand-on-light" style={{ height, width: width ?? "auto" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${BASE_PATH}/brand/${config.dark}`} alt={alt} height={height} width={width} className="brand-on-dark" style={{ height, width: width ?? "auto" }} />
    </span>
  );
}
