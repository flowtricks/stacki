// The slice of Node's built-in `node:sqlite` that Stacki uses to read a project's local EmDash database. The
// installed @types/node predates the module, and a hand-written declaration of only what is called keeps the
// surface (read-only open, prepared read, close) visible in one place. Nothing here can write: the only
// constructor option declared is `readOnly`, and callers always pass it as true.
declare module 'node:sqlite' {
  export interface StatementSync {
    all(...parameters: readonly (string | number)[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options: { readonly readOnly: boolean });
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
