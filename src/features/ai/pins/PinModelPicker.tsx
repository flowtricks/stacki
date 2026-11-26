// The model a pin will run on, chosen in its box: a quiet dropdown of the panel's own models for the agent the pins
// go to. The first row follows the chat's model (the default, named), so a pin keeps following it until the person
// picks another. Only models that can really run one pin are listed (pinModel.ts pinModelChoices). Effort is not
// chosen here: it stays the chat's setting for every pin. A choice that is not usable now shows as the chat's model,
// and the send says so in a toast.
import { pinSendMode } from '../../../../shared/properties/ai/agentPresentation';
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import Dropdown, { type DropdownOption } from '../../../ui/Dropdown';
import { useAiState } from '../aiStore';
import { sessionModelName } from '../subagents';
import { pinModelChoices, resolvePinModel } from './pinModel';
import { pinAgent, pinAgentOptions, setPinModel } from './pinStore';

/** The row that follows the chat's model: no model id is empty. */
const CHAT_MODEL = '';

export function PinModelPicker({ pin }: { readonly pin: CommentPin }) {
  const translate = useTranslate();
  const ai = useAiState();
  const agent = pinAgent(ai);
  const options = pinAgentOptions(ai, agent);
  const choices = pinModelChoices(pinSendMode(agent), options);
  // Until the agent has reported its models there is nothing to choose between.
  if (choices.length === 0) {
    return undefined;
  }
  const resolved = resolvePinModel(pin, agent, options);
  const current = sessionModelName(options);
  const chat = current === undefined ? translate('ai.pins.model.chatPlain') : translate('ai.pins.model.chat', { model: current });
  const rows: readonly DropdownOption[] = [{ value: CHAT_MODEL, label: chat }, ...choices.map((choice) => ({ value: choice.value, label: choice.name }))];
  return (
    <Dropdown
      className="ai-pin-model"
      menuClassName="ai-pin-model-menu"
      menuWidthMin={220}
      ariaLabel={translate('ai.pins.model')}
      value={resolved.kind === 'chosen' ? resolved.model.value : CHAT_MODEL}
      options={rows}
      onChange={(value) => {
        const choice = choices.find((candidate) => candidate.value === value);
        setPinModel(pin.id, choice === undefined ? undefined : { agent, ...choice });
      }}
    />
  );
}
