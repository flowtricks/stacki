import type { ReactNode } from 'react';
import { CodeBlock } from '../../../vendor/stacki/src/ui/CodeBlock';
import { languageNamed } from '../../../vendor/stacki/src/ui/codeHighlight';

// Render the useful Markdown subset without interpreting provider-authored HTML.
export function ChatText({ text }: { readonly text: string }) {
  return (
    <div className="chat-markdown">
      {text.split(/(```[\s\S]*?```)/g).map((block, index) => {
        if (block.startsWith('```')) {
          const fence = /^([\w+-]*)\n/.exec(block.slice(3, -3));
          return <CodeBlock key={index} text={block.slice(3 + (fence?.[0].length ?? 0), -3)} language={languageNamed(fence?.[1] ?? '')} />;
        }
        return block
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((paragraph, part) => <TextBlock key={`${index}-${part}`} text={paragraph} />);
      })}
    </div>
  );
}
function TextBlock({ text }: { readonly text: string }) {
  const heading = /^#{1,6}\s+(.+)$/.exec(text);
  if (heading) {
    return <h3>{inline(heading[1] ?? '')}</h3>;
  }
  const lines = text.split('\n');
  if (lines.every((line) => /^[-*]\s/.test(line))) {
    return (
      <ul>
        {lines.map((line, index) => (
          <li key={index}>{inline(line.slice(2))}</li>
        ))}
      </ul>
    );
  }
  if (lines.every((line) => /^\d+\.\s/.test(line))) {
    return (
      <ol>
        {lines.map((line, index) => (
          <li key={index}>{inline(line.replace(/^\d+\.\s/, ''))}</li>
        ))}
      </ol>
    );
  }
  return <p>{inline(text)}</p>;
}
function inline(text: string): ReactNode {
  return text.split(/(`[^`\n]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
