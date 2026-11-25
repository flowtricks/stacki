// A proxy can leave a browser socket OPEN after its upstream stops responding.
// Server heartbeats arrive every 30 seconds; allow two missed beats plus margin.
export function watchConnection(socket: EventTarget, stale: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(stale, 75_000);
  };
  const stop = () => {
    clearTimeout(timer);
    socket.removeEventListener('open', reset);
    socket.removeEventListener('message', reset);
    socket.removeEventListener('close', stop);
  };
  socket.addEventListener('open', reset);
  socket.addEventListener('message', reset);
  socket.addEventListener('close', stop);
  // Connecting can include restoring the Cloudflare container. Use the same
  // four-minute startup budget as HTTP; once open, heartbeats keep 75 seconds.
  timer = setTimeout(stale, 240_000);
  return stop;
}
