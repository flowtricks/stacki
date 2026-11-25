// Goal: no soak child outlives its runner, even when the runner is SIGKILLed and runs no
// cleanup. Loaded into every Node process of a soak run through NODE_OPTIONS (--require), it
// polls the runner pid named in STACKI_SOAK_RUNNER_PID and exits the process once that pid is
// gone. The timer is unref'd so it never keeps a process alive on its own. Anywhere the
// variable is absent (any process outside a soak run) it does nothing.

const WATCHDOG_POLL_MS = 1000;

const runnerText = process.env.STACKI_SOAK_RUNNER_PID ?? '';
const runnerPid = Number.parseInt(runnerText, 10);
if (Number.isSafeInteger(runnerPid) && runnerPid > 0 && runnerPid !== process.pid) {
  const timer = setInterval(() => {
    try {
      process.kill(runnerPid, 0);
    } catch (error) {
      // EPERM means the pid exists (another user's); anything else means the runner is gone.
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) {
        process.exit(1);
      }
    }
  }, WATCHDOG_POLL_MS);
  timer.unref();
}
