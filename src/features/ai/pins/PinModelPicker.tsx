// The model a pin will run on, chosen in its box: a quiet dropdown of the panel's own models for the agent the pins
// go to, showing model names only. An untouched pin follows the chat's model, whose row is the checked one; picking
// that row makes a pin follow the chat again (pinModel.ts pinModelRows). Only models that can really run one pin are
// listed (pinModelChoices). Effort is not chosen here: it stays the chat's setting for every pin. A choice that is
// not usable now shows as the chat's model, and the send says so in a toast.
import { pinSendMode } from '../../../../shared/properties/ai/agentPresentation';
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import Dropdown from '../../../ui/Dropdown';
import { useAiState } from '../aiStore';
import { pinModelChoices, pinModelRows, resolvePinModel } from './pinModel';
import { pinAgent, pinAgentOptions, setPinModel } from './pinStore';

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
  const { rows, selected } = pinModelRows({ choices, options, resolved, unnamed: translate('ai.pins.model.chatPlain') });
  return (
    <Dropdown
      className="ai-pin-model"
      menuClassName="ai-pin-model-menu"
      menuWidthMin={220}
      ariaLabel={translate('ai.pins.model')}
      value={selected}
      options={rows}
      onChange={(value) => {
        const choice = choices.find((candidate) => candidate.value === value);
        setPinModel(pin.id, choice === undefined ? undefined : { agent, ...choice });
      }}
    />
  );
}
