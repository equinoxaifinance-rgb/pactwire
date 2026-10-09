// Boot a local Pactwire service (sandbox rail, in-memory database, local agents allowed)
// for the Python interop test. Prints the base URL as the first line of stdout and stays
// up until stdin closes or the process gets SIGINT / SIGTERM.
import { bootPactwire } from '../../test/helpers.mjs';

const hs = await bootPactwire();
process.stdout.write(`${hs.base}\n`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await hs.close().catch(() => {});
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
