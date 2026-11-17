// A dashed box for empty states ("Nothing on Sat, Nov 21.").
export function Status({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-xl border border-dashed border-line p-4 text-center text-muted">{children}</div>
  );
}
