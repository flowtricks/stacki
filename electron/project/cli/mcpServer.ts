// `stacki mcp`: a Model Context Protocol server over the same commands, on stdio.
//
// Hand-written on purpose (a written justification, AGENTS.md section 17): the protocol subset an agent needs is small (initialize, tools/list,
// tools/call, resources/list, resources/read, ping, notifications) and is plain newline-delimited JSON-RPC 2.0; the official SDK would add a
// dependency tree to a tool whose whole point is a small, auditable surface, and its server runtime assumes more than stdio. The cost is that
// this file must track the spec: the protocol tests (test/electron/project/cli/mcpServer.test.ts) pin initialize, tools/list, tools/call and the error shapes.
//
// Safety shape: the tool list IS the command table, so the shell and the agent can do the same things and no more. The role is chosen by whoever
// starts the server (`--role`), never by a tool input: tools/list shows only what that role may run, tools/call checks again, and a write tool
// is a dry run unless the call says `apply: true`, which the tool description tells the agent to send only after the person approves the plan.
// Memory per request is bounded by reading the input as a stream of lines, one message at a time; a message is held only until its newline.
import { toRecord } from '../../../shared/core/record';
import { checkArgs } from '../../../shared/properties/cli/stackiArgs';
import { COMMANDS, toolNameOf, type ArgSpec, type CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import { exitCodeOf, type CliEnvelope } from '../../../shared/properties/cli/stackiOutput';
import { STACKI_FILES } from '../../../shared/properties/cli/stackiFiles';
import { describeFileSchema } from '../../../shared/properties/cli/stackiDescribe';
import { findProject, readFileState } from './cliFiles';
import { runCommand, visibleCommands } from './cliRun';
import { resolveRoleContext, roleDenial, type RoleContext } from './cliRole';
import { loadExtensions } from './cliExtensions';
import type { FileWriter } from './cliApply';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LIMITS = {
  /** Characters of one JSON-RPC message; a longer line is refused and skipped, never buffered whole. */
  messageCharsMax: 4_194_304,
} as const satisfies Record<string, number>;

export interface McpOptions {
  readonly project: string;
  /** The role the server is pinned to: set by whoever configures the server, not by a tool call. */
  readonly role?: string | undefined;
  readonly login?: string | undefined;
  readonly writer?: FileWriter;
}

interface Json {
  readonly [key: string]: unknown;
}

const PLAN_FIRST = 'Writes are a DRY RUN by default and return a plan. Show the plan to the user, and call again with apply=true only after they approve it.';

function schemaOfArgument(argument: ArgSpec): Json {
  const description = argument.description;
  switch (argument.kind) {
    case 'string':
      return { type: 'string', description };
    case 'enum':
      return { type: 'string', enum: argument.values ?? [], description };
    case 'integer':
      return { type: 'integer', description };
    case 'number':
      return { type: 'number', description };
    case 'boolean':
      return { type: 'boolean', description };
    case 'json':
      return { description: `${description} Any JSON value.` };
    default: {
      const exhaustive: never = argument.kind;
      return exhaustive;
    }
  }
}

/** The MCP tool of a command: name, text that tells the agent to plan first, and an input schema from the row. */
export function toolOf(spec: CommandSpec): Json {
  const properties: Record<string, unknown> = Object.fromEntries(spec.args.map((argument) => [argument.name, schemaOfArgument(argument)]));
  if (spec.access === 'write') {
    properties['apply'] = {
      type: 'boolean',
      description: 'false (default) returns the plan only. true writes it: send only after the user approved the plan.',
    };
    if (spec.destructive) {
      properties['yes'] = { type: 'boolean', description: 'Required with apply for a command that deletes: the user confirmed the deletion.' };
    }
  }
  const description =
    spec.access === 'write'
      ? `${spec.summary} ${PLAN_FIRST}${spec.destructive ? ' This command deletes: it also needs yes=true with apply=true.' : ''}`
      : spec.summary;
  return {
    name: toolNameOf(spec),
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: spec.args.filter((argument) => argument.required).map((argument) => argument.name),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: spec.access === 'read', destructiveHint: spec.destructive },
  };
}

export class McpSession {
  readonly #options: McpOptions;

  constructor(options: McpOptions) {
    this.#options = options;
  }

  /** One incoming message; undefined for a notification (no reply). */
  async handle(message: unknown): Promise<Json | undefined> {
    const request = toRecord(message);
    if (request === undefined || request['jsonrpc'] !== '2.0' || typeof request['method'] !== 'string') {
      return rpcError(request?.['id'], -32600, 'Invalid Request: expected a JSON-RPC 2.0 object with a method.');
    }
    const id = request['id'];
    if (id === undefined) {
      return undefined;
    }
    const params = toRecord(request['params']) ?? {};
    try {
      return await this.#dispatch(request['method'], params, id);
    } catch (error: unknown) {
      return rpcError(id, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #dispatch(method: string, params: Json, id: unknown): Promise<Json> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        const version = MCP_PROTOCOL_VERSIONS.find((known) => known === asked) ?? MCP_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
          serverInfo: { name: 'stacki', version: '1' },
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return this.#listTools(id);
      case 'tools/call':
        return this.#callTool(id, params);
      case 'resources/list':
        return this.#listResources(id);
      case 'resources/read':
        return this.#readResource(id, params);
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async #context(): Promise<{ readonly root: string; readonly role: RoleContext } | { readonly failure: CliEnvelope }> {
    const root = findProject(this.#options.project);
    if (!root.ok) {
      return { failure: { schemaVersion: 1, ok: false, command: 'mcp', error: root.error } };
    }
    const role = resolveRoleContext(root.value, { role: this.#options.role, login: this.#options.login });
    return role.ok ? { root: root.value, role: role.value } : { failure: { schemaVersion: 1, ok: false, command: 'mcp', error: role.error } };
  }

  async #listTools(id: unknown): Promise<Json> {
    const context = await this.#context();
    if ('failure' in context) {
      return rpcResult(id, { tools: [] });
    }
    const extensions = await loadExtensions(context.root);
    return rpcResult(id, { tools: visibleCommands(context.role, extensions).map(toolOf) });
  }

  async #callTool(id: unknown, params: Json): Promise<Json> {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const context = await this.#context();
    if ('failure' in context) {
      return rpcResult(id, toolResult(context.failure));
    }
    const extensions = await loadExtensions(context.root);
    const spec = visibleCommands(context.role, extensions).find((entry) => toolNameOf(entry) === name);
    if (spec === undefined) {
      // A tool the role cannot see answers the same as one that does not exist, except for a role-denied command, which says so without any plan detail.
      const known = COMMANDS.find((entry) => toolNameOf(entry) === name);
      const denial = known === undefined ? undefined : roleDenial(context.role.view, known.feature, known.featureKey);
      return denial === undefined
        ? rpcError(id, -32602, `Unknown tool: ${name}`)
        : rpcResult(id, toolResult({ schemaVersion: 1, ok: false, command: known?.words.join(' ') ?? name, error: denial }));
    }
    const given = toRecord(params['arguments']) ?? {};
    const { apply, yes, ...rest } = given;
    const checked = checkArgs(spec, rest);
    if (!checked.ok) {
      return rpcResult(id, toolResult({ schemaVersion: 1, ok: false, command: spec.words.join(' '), error: checked.error }));
    }
    const envelope = await runCommand({
      words: spec.words,
      args: checked.value,
      project: this.#options.project,
      role: { role: this.#options.role, login: this.#options.login },
      apply: apply === true ? 'apply' : 'plan',
      yes: yes === true ? 'yes' : 'no',
      waitSeconds: 0,
      ...(this.#options.writer === undefined ? {} : { writer: this.#options.writer }),
      ...(extensions === undefined ? {} : { extensions }),
    });
    return rpcResult(id, toolResult(envelope));
  }

  async #listResources(id: unknown): Promise<Json> {
    const context = await this.#context();
    if ('failure' in context) {
      return rpcResult(id, { resources: [] });
    }
    const schemas = STACKI_FILES.map((file) => ({
      uri: `stacki://schema/${file.id}`,
      name: `Key reference: ${file.file}`,
      mimeType: 'application/json',
      description: file.description,
    }));
    const states = STACKI_FILES.flatMap((file) => {
      const state = readFileState(context.root, file);
      return state.ok && state.value.source !== undefined
        ? [{ uri: `stacki://state/${file.id}`, name: `Current: ${file.file}`, mimeType: 'application/json', description: `What ${file.file} holds now.` }]
        : [];
    });
    return rpcResult(id, { resources: [...schemas, ...(roleDenial(context.role.view, 'cli:read', 'cli.state') === undefined ? states : [])] });
  }

  async #readResource(id: unknown, params: Json): Promise<Json> {
    const uri = typeof params['uri'] === 'string' ? params['uri'] : '';
    const match = /^stacki:\/\/(schema|state)\/([A-Za-z0-9]+)$/.exec(uri);
    const file = match === null ? undefined : STACKI_FILES.find((entry) => entry.id === match[2]);
    const context = await this.#context();
    if (match === null || file === undefined || 'failure' in context || roleDenial(context.role.view, 'cli:read', 'cli.resources') !== undefined) {
      return rpcError(id, -32002, `Resource not found: ${uri}`);
    }
    if (match[1] === 'schema') {
      return rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(describeFileSchema(file)) }] });
    }
    const state = readFileState(context.root, file);
    if (!state.ok || state.value.source === undefined) {
      return rpcError(id, -32002, `Resource not found: ${uri}`);
    }
    return rpcResult(id, { contents: [{ uri, mimeType: 'application/json', text: state.value.source }] });
  }
}

function toolResult(envelope: CliEnvelope): Json {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: exitCodeOf(envelope) !== 0 };
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? undefined, error: { code, message } };
}

/** Parses one line of input into a reply: a parse error is a reply too, never a crash. */
export async function handleLine(session: McpSession, line: string): Promise<Json | undefined> {
  if (line.length > MCP_LIMITS.messageCharsMax) {
    return rpcError(undefined, -32600, 'Invalid Request: the message is too long.');
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return rpcError(undefined, -32700, 'Parse error: the message is not valid JSON.');
  }
  return session.handle(message);
}

/** `stacki mcp [--project <dir>] [--role <id>] [--login <github-login>]`; returns when stdin closes. */
export async function startMcpServer(argv: readonly string[], cwd: string): Promise<number> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!['--project', '--role', '--as-role', '--login'].includes(flag) || value === undefined) {
      process.stderr.write(`stacki mcp: unknown or incomplete option "${flag}". Use --project <dir> --role <role> --login <github-login>.\n`);
      return 2;
    }
    options.set(flag === '--as-role' ? '--role' : flag, value);
  }
  const session = new McpSession({ project: options.get('--project') ?? cwd, role: options.get('--role'), login: options.get('--login') });
  let pending = '';
  let oversized = false;
  const reply = async (line: string): Promise<void> => {
    const answer = await handleLine(session, line);
    if (answer !== undefined) {
      process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  };
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    pending += String(chunk);
    for (let guard = 0; guard < 100_000; guard += 1) {
      const newline = pending.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim() !== '' && !oversized) {
        await reply(line);
      }
      oversized = false;
    }
    if (pending.length > MCP_LIMITS.messageCharsMax) {
      process.stdout.write(`${JSON.stringify(rpcError(undefined, -32600, 'Invalid Request: the message is too long.'))}\n`);
      pending = '';
      oversized = true;
    }
  }
  if (pending.trim() !== '') {
    await reply(pending);
  }
  return 0;
}
