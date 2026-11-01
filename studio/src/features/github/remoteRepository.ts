import { gitDraftHeaders } from '../history/gitWorkspaceStorage';
import { boundedText } from '../updates/catalog';
import { parsePublishConnection } from '../../shared/publishConnection';
import type { IncomingChanges } from './github';
import { record, string, sourcePath } from '../../shared/validation';

export class RemoteRepository {
  constructor(
    readonly backend: string,
    readonly token: string,
    readonly root?: string,
  ) {}
  async incoming(base: string): Promise<IncomingChanges> {
    const result = await this.call('/incoming', { base });
    const files = result['files'];
    if (!Array.isArray(files) || files.length > 100_000) {
      throw new Error('Invalid GitHub changes');
    }
    return {
      sha: string(result['sha'], 64),
      files: files.map((value) => {
        const item = record(value);
        return {
          file: sourcePath(item['file']),
          before: item['before'] === null ? null : string(item['before']),
          after: item['after'] === null ? null : string(item['after']),
        };
      }),
    };
  }
  async acceptBase(sha: string) {
    await this.call('/base', { sha });
  }
  private async call(route: string, body: unknown) {
    const response = await fetch(this.backend + '/studio/internal' + route, {
      method: 'POST',
      headers: {
        ...(this.root ? await gitDraftHeaders(this.root) : {}),
        'Content-Type': 'application/json',
        'x-studio-token': this.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const input: unknown = route === '/incoming' ? await response.json() : JSON.parse(await boundedText(new Response(response.body), 16_384));
    const result = record(input);
    if (!response.ok) {
      throw new Error(string(result['error'] ?? 'GitHub request failed'));
    }
    return result;
  }
  async reviewConnection() {
    return parsePublishConnection(await this.call('/review-connection', {}));
  }
  async publishConnection() {
    return parsePublishConnection(await this.call('/publish-connection', {}));
  }
}
