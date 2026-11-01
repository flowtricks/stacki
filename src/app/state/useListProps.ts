// The list props of the selected instance's component (listProps.ts): read
// from the component's file whenever another component is selected, so the
// page's props panel can draw them with the loop's own editors. Read here, in
// the app, because the props panel may not reach the properties bridge.

import { useEffect, useState } from 'react';
import { readComponentProperties } from '../../features/componentProperties/propertiesBridge';
import { listPropsOf, type ListProp } from '../../editor/listProps';

const NO_LIST_PROPS: ReadonlyMap<string, ListProp> = new Map();

/** The component's list props by prop name; empty until read, or for no component. */
export function useListProps(projectPath: string | undefined, componentPath: string | undefined): ReadonlyMap<string, ListProp> {
  const [read, setRead] = useState<{ readonly key: string; readonly props: ReadonlyMap<string, ListProp> } | undefined>(undefined);
  const key = `${projectPath ?? ''}|${componentPath ?? ''}`;
  useEffect(() => {
    if (projectPath === undefined || componentPath === undefined) {
      return undefined;
    }
    let live = true;
    // A component whose properties can't be read just has no list props: its
    // props keep their ordinary fields.
    readComponentProperties(projectPath, componentPath).then(
      (result) => {
        if (live && result.ok) {
          setRead({ key, props: listPropsOf(frontmatterOf(result.value.source)) });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectPath, componentPath, key]);
  return read?.key === key ? read.props : NO_LIST_PROPS;
}

// The frontmatter of a component's source: the code between its `---` fences.
function frontmatterOf(source: string): string {
  const match = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  return match?.[1] ?? '';
}
