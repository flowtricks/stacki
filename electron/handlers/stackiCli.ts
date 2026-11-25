// The `stacki` executable: `node dist/electron/handlers/stackiCli.js <command>`, or the bundle (npm run build:cli).
//
// It lives here, beside the component planner, because the component commands (cliComponentCommands.ts) register themselves at load and the
// layers allow `handlers` to reach `project` but not the other way; importing the registration first is what makes them available to the shell
// and to `stacki mcp`.
import './cliComponentCommands';
import { main } from '../project/cli/cliMain';

main(process.argv.slice(2), process.cwd(), (text) => process.stdout.write(text)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`stacki failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 4;
  },
);
