// Next prepends this automatically for Link/router/redirect targets — write
// those as bare paths ("/users", not "/panel/users"). This constant and
// stripBasePath() exist only for the reverse case: normalizing a full path
// (from usePathname(), or a manually-constructed URL) for comparison.
export const BASE_PATH = "/panel";

export function stripBasePath(pathname: string): string {
  if (pathname === BASE_PATH) return "/";
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return pathname;
}
