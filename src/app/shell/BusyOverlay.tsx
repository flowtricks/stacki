// The full-window "working" cover. Its own module so the start screen can show it
// without pulling the editor shell's modules into the first paint (WelcomeView.tsx).
export function BusyOverlay({ message }: { readonly message: string }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}
