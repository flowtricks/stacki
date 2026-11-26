// The extension a full code editor takes to know the project behind its file. The editor reads its extensions once,
// when it is made, so the extension asks which file it shows each time rather than being told once.
import { useMemo, useRef } from 'react';
import type { Extension } from '@codemirror/state';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { codeIntelExtension } from './codeIntelExtension';

export function useCodeIntel(projectPath: string, path: string | undefined): Extension {
  const translate = useTranslate();
  const latest = useRef({ projectPath, path, translate });
  latest.current = { projectPath, path, translate };
  return useMemo(
    () =>
      codeIntelExtension(
        { required: () => latest.current.translate('props.sections.required') },
        // A path main spelled for Windows is asked about with forward slashes, as the contract writes paths.
        () => (latest.current.path === undefined ? undefined : { projectPath: latest.current.projectPath, path: latest.current.path.replace(/\\/g, '/') }),
      ),
    [],
  );
}
