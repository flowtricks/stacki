// Dev supervisor for the Electron process.
//
// `npm run dev` runs Vite and Electron side by side under `concurrently -k`,
// which kills every command as soon as one exits. That makes app.relaunch()
// unusable for "Reload All Code": Electron quitting would take Vite down with
// it, and the relaunched process would find nothing at localhost:5173.
//
// So Electron runs under this instead. The supervisor is the long-lived
// command concurrently watches; Electron exiting with RELAUNCH_CODE just means
// "start me again", and Vite never notices. Any other exit code is a real
// quit and ends the supervisor too, so Ctrl+C still tears everything down.
import { spawn } from 'node:child_process';
import electron from 'electron';

const RELAUNCH_CODE = 42; // keep in sync with electron/main.js
const args = process.argv.slice(2);
let child = null;

function run() {
  child = spawn(electron, ['.', ...args], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    child = null;
    if (code === RELAUNCH_CODE) {
      console.log('[dev] reloading all code…');
      run();
      return;
    }
    // Mirror the child's fate so concurrently tears the rest down with us.
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

run();
