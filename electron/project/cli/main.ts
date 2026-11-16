// The `stacki` executable: `node dist/electron/project/cli/main.js <command>`, or the bundled bin.
import { main } from './cliMain';

main(process.argv.slice(2), process.cwd(), (text) => process.stdout.write(text)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`stacki failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 4;
  },
);
