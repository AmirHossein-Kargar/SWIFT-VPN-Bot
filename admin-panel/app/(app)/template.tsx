/** Re-mounted on every section change, which is what restarts the entrance animation. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
