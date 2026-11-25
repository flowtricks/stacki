const ICON_BUTTON_LABELS: Readonly<Record<string, string>> = {
  XIcon: 'Close',
  'cards/assign-issue.tsx:PlusIcon': 'Assign issue',
  'cards/codespaces-card.tsx:CopyIcon': 'Copy command',
  'cards/codespaces-card.tsx:InfoIcon': 'About local development',
  'cards/codespaces-card.tsx:MoreHorizontalIcon': 'Codespace options',
  'cards/codespaces-card.tsx:PlusIcon': 'Create codespace',
  'cards/recent-transactions.tsx:MoreHorizontalIcon': 'Transaction options',
  'cards/ui-elements.tsx:ChevronUpIcon': 'Open quick actions',
};

const CONTROL_LABELS: Readonly<Record<string, string>> = {
  'activity-private-profile': 'Make profile private',
  'bug-component': 'Affected component',
  'bug-severity': 'Bug severity',
  'default-currency': 'Default currency',
  'email-notifications': 'Email notifications',
  'from-account': 'Source account',
  'method-bank': 'Bank transfer',
  'method-paypal': 'PayPal',
  'notify-all': 'Select all notifications',
  'preferred-currency': 'Preferred currency',
  'public-statistics': 'Public statistics',
  'shipping-country': 'Shipping country',
  'shipping-save': 'Save shipping address',
  'shipping-state': 'Shipping state or province',
  'to-account': 'Destination account',
};

/** Adapt the pinned demo markup before the icon placeholders are compiled away. */
export function shadcnGalleryAuditFixes(file: string, source: string): string {
  const withNamedControls = source.replace(
    /<(SelectTrigger|Checkbox|Switch|RadioGroupItem)\b([^<>]*?)\bid="([^"]+)"([^<>]*?)>/g,
    (match: string, tag: string, prefix: string, id: string, suffix: string) => {
      const label = CONTROL_LABELS[id];
      if (label === undefined || (prefix + suffix).includes('aria-label')) {
        return match;
      }
      return `<${tag} aria-label="${label}"${match.slice(tag.length + 1)}`;
    },
  );
  const named = withNamedControls.replace(
    /<((?:\w+Trigger\s+render=\{<Button\b)|(?:Button|InputGroupButton)\b)([^<>]*?)(?:\/\s*>\})?\s*>\s*<IconPlaceholder\s+lucide="([^"]+)"[^>]*\/>\s*<\/(?:Button|InputGroupButton|\w+Trigger)>/g,
    (match: string, opening: string, attributes: string, icon: string) => {
      const label = ICON_BUTTON_LABELS[`${file}:${icon}`] ?? ICON_BUTTON_LABELS[icon];
      if (label === undefined || attributes.includes('aria-label=')) {
        return match;
      }
      return `<${opening} aria-label="${label}"${match.slice(opening.length + 1)}`;
    },
  );
  switch (file) {
    case 'cards/codespaces-card.tsx':
      return named.replaceAll('href="#learn-more"', 'href="https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces"');
    case 'cards/github-profile.tsx':
      return named.replace('href="#email-settings"', 'href="https://github.com/settings/notifications"');
    case 'cards/faq.tsx':
      return named.replace('<Card>', '<Card>\n      <h2 className="sr-only">Frequently asked questions</h2>');
    case 'cards/invite-team.tsx':
      return named.replace('<SelectTrigger className="w-24">', '<SelectTrigger className="w-24" aria-label="Invitation role">');
    case 'cards/kitchen-island.tsx':
      return named.replace('<Switch checked={enabled}', '<Switch aria-label="Kitchen island lights" checked={enabled}');
    case 'cards/notification-settings.tsx':
      return named.replace('id={`notify-${n.id}`}', 'id={`notify-${n.id}`} aria-label={n.label}');
    case 'cards/recent-transactions.tsx':
      return named.replace('<Table>', '<Table aria-label="Recent transactions">');
    case 'cards/stock-performance.tsx':
      // The labelled search input opens the list itself and remains keyboard operable.
      return named.replace('<ComboboxInput', '<ComboboxInput showTrigger={false}');
    case 'cards/ui-elements.tsx':
      return named
        .replace('<RadioGroupItem value="apple"', '<RadioGroupItem aria-label="Apple" value="apple"')
        .replace('<RadioGroupItem value="banana"', '<RadioGroupItem aria-label="Banana" value="banana"')
        .replace('<Checkbox defaultChecked', '<Checkbox aria-label="First option" defaultChecked')
        .replace('<Switch defaultChecked', '<Switch aria-label="Sample setting" defaultChecked');
    default:
      return named;
  }
}
