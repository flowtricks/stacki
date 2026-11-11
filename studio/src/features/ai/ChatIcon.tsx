import { centralIcon } from '../../../vendor/stacki/src/ui/central/CentralIcon';
import {
  add as centralAdd,
  arrowUp as centralArrowUp,
  chevronDown as centralChevronDown,
  close as centralClose,
  comment as centralComment,
  file as centralFile,
  microphone as centralMicrophone,
  stop as centralStop,
  trash as centralTrash,
} from '../../../vendor/stacki/src/ui/central/centralGeometry';

const icons = {
  plus: centralIcon(centralAdd),
  chat: centralIcon(centralComment),
  send: centralIcon(centralArrowUp),
  mic: centralIcon(centralMicrophone),
  close: centralIcon(centralClose),
  stop: centralIcon(centralStop),
  chevron: centralIcon(centralChevronDown),
  file: centralIcon(centralFile),
  trash: centralIcon(centralTrash),
};

export function ChatIcon({ name }: { readonly name: keyof typeof icons }) {
  const Icon = icons[name];
  return <Icon />;
}
