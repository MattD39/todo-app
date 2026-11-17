// The app icon: a white tick on the app's green. Drawn with code so there's no
// image file to keep in sync. Used by src/app/icon.tsx and src/app/apple-icon.tsx.

const GREEN = "#2e6a44"; // same as --accent in globals.css (light mode)

// `rounded` adds curved corners. Leave it off for the iPhone icon: iOS rounds the
// corners itself, and see-through corners would show up black.
export function AppIconArt({ size, rounded = false }: { size: number; rounded?: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: GREEN,
        borderRadius: rounded ? size * 0.22 : 0,
      }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <path d="M4.5 12.5l5 5L19.5 7" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
