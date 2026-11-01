import { availableModels } from './configuration';
import { parseChatInput } from './chatContracts';
import { randomUUID } from 'node:crypto';
import { aiConfiguration, propose, proposedSource, type Proposal } from './agent';
import type { createRooms } from '../collaboration/rooms';
import { changeFiles } from '../project/changeFiles';
import { record, sourcePath, string } from '../../shared/validation';

export class ProposalStore {
  private readonly proposals = new Map<string, { proposal: Proposal; expires: number }>();
  constructor(
    readonly root: string,
    readonly rooms: ReturnType<typeof createRooms>,
  ) {}
  private active = 0;
  async create(value: unknown, signal?: AbortSignal) {
    if (this.active >= 3) {
      throw new Error('Three chats are already working. Wait for one to finish.');
    }
    this.active++;
    try {
      return await this.generate(value, signal);
    } finally {
      this.active--;
    }
  }
  private async generate(value: unknown, signal?: AbortSignal) {
    const config = aiConfiguration();
    if (!config) {
      throw new Error('Set AI_BASE_URL and AI_MODEL on the server to connect an AI provider. AI_API_KEY is optional for local providers.');
    }
    const input = record(value);
    const models = await availableModels();
    const model = string(input['model'] ?? models.defaultModel, 160);
    if (!models.models.includes(model)) {
      throw new Error('Choose a configured AI model');
    }
    for (const [id, entry] of this.proposals) {
      if (entry.expires < Date.now()) {
        this.proposals.delete(id);
      }
    }
    if (this.proposals.size + this.active > 30) {
      throw new Error('Too many pending AI proposals');
    }
    const proposal = await propose(this.root, sourcePath(input['file']), string(input['prompt'], 12_000), { ...config, model }, parseChatInput(input), signal);
    signal?.throwIfAborted();
    const id = randomUUID();
    if (proposal.changes.length) {
      this.proposals.set(id, { proposal, expires: Date.now() + 900_000 });
    }
    return {
      id,
      summary: proposal.summary,
      files: proposal.changes.map((change) => change.file),
      changes: proposal.changes,
    };
  }
  async apply(value: unknown) {
    const id = string(record(value)['id'], 100);
    const entry = this.proposals.get(id);
    if (!entry || entry.expires < Date.now()) {
      throw new Error('Proposal expired. Generate it again.');
    }
    await this.rooms.coordinator.run(async () => {
      const files = await Promise.all(
        entry.proposal.changes.map(async (change) => ({
          file: change.file,
          source: await proposedSource(this.root, change),
        })),
      );
      if (new Set(files.map((file) => file.file)).size !== files.length) {
        throw new Error('AI must return one change per file');
      }
      await changeFiles(this.root, this.rooms, files);
    });
    this.proposals.delete(id);
    return { applied: true };
  }
}
