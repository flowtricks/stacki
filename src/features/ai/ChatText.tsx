// An agent's reply as text: the useful Markdown subset (paragraphs, headings,
// lists, inline code, bold, fenced code), drawn without ever interpreting HTML
// the agent wrote. Fenced code is syntax highlighted through CodeBlock, as all
// code in the app is. Ported from Studio's chat (studio/src/features/ai/ChatText.tsx).
import type { ReactNode } from 'react';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { languageNamed } from '../../ui/codeHighlight';

export function ChatText({ text }: { readonly text: string }) {
  return (
    <div className="ai-markdown">
      {text.split(/(```[\s\S]*?```)/g).map((block, index) => {
        if (block.startsWith('```') && block.endsWith('```') && block.length >= 6) {
          const fence = /^([\w+-]*)\n/.exec(block.slice(3, -3));
          return <CodeBlock key={index} text={block.slice(3 + (fence?.[0].length ?? 0), -3)} language={languageNamed(fence?.[1] ?? '')} />;
        }
        return block
          .split(/\n\s*\n/)
          .filter((paragraph) => paragraph.trim() !== '')
          .map((paragraph, part) => <TextBlock key={`${index}-${part}`} text={paragraph} />);
      })}
    </div>
  );
}

function TextBlock({ text }: { readonly text: string }) {
  const heading = /^#{1,6}\s+(.+)$/.exec(text.trim());
  if (heading) {
    return <h3>{inline(heading[1] ?? '')}</h3>;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length > 0 && lines.every((line) => /^\s*[-*]\s/.test(line))) {
    return (
      <ul>
        {lines.map((line, index) => (
          <li key={index}>{inline(line.replace(/^\s*[-*]\s/, ''))}</li>
        ))}
      </ul>
    );
  }
  if (lines.length > 0 && lines.every((line) => /^\s*\d+\.\s/.test(line))) {
    return (
      <ol>
        {lines.map((line, index) => (
          <li key={index}>{inline(line.replace(/^\s*\d+\.\s/, ''))}</li>
        ))}
      </ol>
    );
  }
  return <p>{inline(text)}</p>;
}

function inline(text: string): ReactNode {
  return text.split(/(`[^`\n]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return <CodeInline key={index} text={part.slice(1, -1)} />;
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
