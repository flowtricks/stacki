// One row per UTC day is enough to count active installations without keeping
// requests, IP addresses, device identifiers, or project information.

interface CounterStatement {
  bind(value: string): { run(): Promise<unknown> };
}

interface CounterDatabase {
  prepare(query: string): CounterStatement;
}

interface Environment {
  readonly COUNTS: CounterDatabase;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 366;
const INSERT_DAY = 'INSERT INTO activity_days (day, count) VALUES (?1, 1) ' + 'ON CONFLICT(day) DO UPDATE SET count = count + 1';

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(undefined, { status: 204 });
    }
    if (request.method !== 'POST' || url.pathname !== '/daily') {
      return new Response('Not found', { status: 404 });
    }
    const day = new Date().toISOString().slice(0, 10);
    await env.COUNTS.prepare(INSERT_DAY).bind(day).run();
    return new Response(undefined, { status: 204 });
  },

  async scheduled(_event: unknown, env: Environment): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
    await env.COUNTS.prepare('DELETE FROM activity_days WHERE day < ?1').bind(cutoff).run();
  },
};
