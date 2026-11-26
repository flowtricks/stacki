// What `netlify login --request … --json` and `netlify login --check … --json` print, parsed at this boundary. The
// token never appears in either: the CLI stores it itself, and only these two facts leave the output.
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import { parseSignInURL } from '../../shared/ipc/publishAccount';
import type { NetlifySignInTiming } from './publishAccount';

/** How often approval is asked for, how long one ask may take, and how many may fail in a row. */
export const NETLIFY_SIGN_IN: NetlifySignInTiming = { intervalMs: 3000, checkTimeoutMs: 30_000, failuresMax: 3 };

// A ticket is passed back as a command argument, so it can never start with a hyphen.
const TICKET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const OUTPUT_CHARS_MAX = 8192;

export interface NetlifyTicket {
  readonly ticket: string;
  readonly url: string;
}

/** The ticket and its approval page, or undefined when the reply is not exactly that. */
export function netlifySignInTicket(output: string): NetlifyTicket | undefined {
  const fields = printedRecord(output);
  const ticket = fields?.['ticket_id'];
  const url = fields?.['url'];
  if (typeof ticket !== 'string' || typeof url !== 'string' || !TICKET_PATTERN.test(ticket)) {
    return undefined;
  }
  try {
    const checked = parseSignInURL(url);
    const page = new URL(checked);
    // The page Stacki opens must be Netlify's own, for the ticket Stacki will check.
    if (page.origin !== 'https://app.netlify.com' || page.searchParams.get('ticket') !== ticket) {
      return undefined;
    }
    return { ticket, url: checked };
  } catch {
    return undefined;
  }
}

export type NetlifySignInStatus = 'pending' | 'authorized' | 'denied';

export function netlifySignInCheck(output: string): NetlifySignInStatus | undefined {
  const status = printedRecord(output)?.['status'];
  return status === 'pending' || status === 'authorized' || status === 'denied' ? status : undefined;
}

function printedRecord(output: string): Readonly<Record<string, unknown>> | undefined {
  assert(output.length <= OUTPUT_CHARS_MAX, 'Netlify sign-in output stays bounded');
  try {
    const value: unknown = JSON.parse(output.trim());
    return toRecord(value);
  } catch {
    return undefined;
  }
}
