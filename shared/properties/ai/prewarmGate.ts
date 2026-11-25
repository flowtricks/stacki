// When the panel asks the main process to start an agent early. Opening the panel and
// focusing the composer both want it, often within the same second, and focus comes and
// goes as a person clicks around; the gate turns that stream into at most one request per
// agent per `AI_LIMITS.prewarmRepeatMs`, and sends a release only for what it asked for.
// The main process is single-flight as well (electron/handlers/ai/sessionPool.ts), so this
// is about not chattering over IPC, not about safety.
import { assert } from '../../core/assert';
import type { AgentId } from './agentIds';
import { AI_LIMITS } from './aiLimits';

export type PrewarmRequest = 'warm' | 'release';

interface Asked {
  readonly key: string;
  readonly at: number;
}

export class PrewarmGate {
  private warmed: Asked | undefined = undefined;

  /** Whether a request should go out now. `at` is a monotonic clock in milliseconds. */
  decide(projectPath: string, agent: AgentId, request: PrewarmRequest, at: number): boolean {
    assert(Number.isFinite(at), 'PrewarmGate.decide: a finite time');
    assert(projectPath.length > 0, 'PrewarmGate.decide: a project');
    const key = `${agent}\0${projectPath}`;
    if (request === 'release') {
      // Nothing was asked for this agent here, so there is nothing to let go of.
      if (this.warmed === undefined || this.warmed.key !== key) {
        return false;
      }
      this.warmed = undefined;
      return true;
    }
    const earlier = this.warmed;
    if (earlier !== undefined && earlier.key === key && at - earlier.at < AI_LIMITS.prewarmRepeatMs) {
      return false;
    }
    this.warmed = { key, at };
    return true;
  }
}
