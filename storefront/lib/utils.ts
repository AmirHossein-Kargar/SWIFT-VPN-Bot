import { clsx, type ClassValue } from "clsx";

/**
 * shadcn's cn() is clsx + tailwind-merge. tailwind-merge is ~7 kB gzipped and
 * only resolves conflicting utilities passed through `className`; this
 * storefront never overrides a primitive's own utilities, so it is omitted.
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
