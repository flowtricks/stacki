// The fields of an element's settings panel: its content, loose text, schema
// and extra fields, and the settings group — tag, class, style, attributes
// and slot (PropsPanel.tsx).

import { useTranslate } from '../../lib/i18n/useTranslate';
import type { RichContext } from './RichContent';
import { dataPickerPosition } from './dataPickerPosition';
import { useState } from 'react';
import { ResetMenu } from '../../ui/ResetLabel';
import type { FieldPosition } from './propBindings';
import { TagField } from './propNodeEditors';
import PropField from './PropField';
import { ListPropField } from './ListPropField';
import type { ValueChange } from './bindingTypes';
import { AttributesSection } from './propAttributes';
import { BindHandle, FieldDataPicker } from './propBindings';
import AutoTextarea from '../../ui/AutoTextarea';
import RichContent, { isInlineOnly } from './RichContent';
import { VariableTextSizeIcon, ChevronRightIcon } from '../../ui/Icons';
import { noLabelActivation, CommentField } from './SourcePanels';
import { type ElementState } from './elementState';
import { canvasDraftProp, canvasDraftValue, useCanvasTextDraft } from '../../ui/canvasTextDraft';
import { canvasDraftInline } from './canvasDraftInline';
import { assert } from '../../../shared/core/assert';
import type { FieldFocus } from './fieldFocus';

export function ElementContent({ state }: { readonly state: ElementState }) {
  const translate = useTranslate();
  const draft = useCanvasTextDraft(state);
  const { node, loopContext, bindContext, onSetInline, showContentField, isSlot, contentPicker, setContentPicker, contentInsertRef } = state;
  const contentSet = (node.children?.length ?? 0) > 0;
  return (
    <>
      {showContentField && (
        <div className="props-field" key="content">
          <label onClick={noLabelActivation}>
            <ContentLabel
              active={contentSet}
              name={isSlot ? translate('props.element.fallback') : translate('props.element.content')}
              onReset={() => onSetInline([])}
            />
            {/* Text can hold data too — the same handle, the same picker,
                  dropping the same chip in at the caret. Without it, putting a
                  field into a sentence means knowing to type
                  `{post.data.title}`. */}
            <BindHandle active={!!contentPicker} onOpen={(host, focus) => elementOpenContentPicker(state, host ?? undefined, focus)} />
          </label>
          <RichContent
            key={node.id}
            nodes={canvasDraftInline(isInlineOnly(node.children) ? node.children : [], draft)}
            {...richContextProp(bindContext || loopContext)}
            insertRef={contentInsertRef}
            onChange={onSetInline}
          />
          {contentPicker && (
            <FieldDataPicker
              pos={contentPicker}
              bindContext={bindContext || loopContext}
              // i18n-ignore: the label seeds a prop name (text), written as code.
              seed={{ fit: 'content', label: 'Text', value: plainContent(node.children) }}
              // A new prop lands where a picked one would: its words are the prop's default.
              onBindNew={(path) => {
                setContentPicker(undefined);
                elementPlaceContentChip(state, contentPicker.focus, path);
              }}
              onPick={(path) => {
                setContentPicker(undefined);
                elementPlaceContentChip(state, contentPicker.focus, path);
              }}
              onClose={() => setContentPicker(undefined)}
            />
          )}
          {isSlot && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-faint)',
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              {translate('props.element.fallbackNote')}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ContentLabel(props: { readonly active: boolean; readonly name: string; readonly onReset: () => void }) {
  const translate = useTranslate();
  const [position, setPosition] = useState<FieldPosition>();
  return (
    <>
      <span
        className={`prop-label${props.active ? ' set' : ''}`}
        title={props.active ? translate('props.element.resetHint') : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (!props.active) {
            return;
          }
          if (event.altKey) {
            props.onReset();
          } else {
            const bounds = event.currentTarget.getBoundingClientRect();
            setPosition({ left: bounds.left, top: bounds.bottom + 4 });
          }
        }}
      >
        <VariableTextSizeIcon size={12} className="prop-label-icon" />
        {props.name}
      </span>
      {position && (
        <ResetMenu
          position={position}
          onReset={() => {
            props.onReset();
            setPosition(undefined);
          }}
          unbindLabel=""
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}

// RichContent spells a missing context by leaving the prop out.
export function richContextProp(context: RichContext | undefined): {
  readonly bindContext?: RichContext;
} {
  return context === undefined ? {} : { bindContext: context };
}

export function ElementLooseText({ state }: { readonly state: ElementState }) {
  const translate = useTranslate();
  const draft = useCanvasTextDraft(state);
  const { node, onSetContent, showLooseTextField, looseText } = state;
  return (
    <>
      {showLooseTextField && (
        <div className="props-field" key="loose-text">
          <label onClick={noLabelActivation}>
            <ContentLabel active={!!looseText} name={translate('props.element.content')} onReset={() => onSetContent('')} />
          </label>
          <AutoTextarea
            key={node.id}
            minRows={1}
            value={looseText ? canvasDraftValue(looseText, draft) : ''}
            placeholder={translate('props.element.looseText')}
            onChange={(event) => onSetContent(event.target.value)}
          />
        </div>
      )}
    </>
  );
}

export function ElementSchemaFields({ state }: { readonly state: ElementState }) {
  // Words typed on the canvas into text this instance's prop sets show here as
  // they are typed; the attribute itself is written when typing ends.
  const draft = useCanvasTextDraft(state);
  const {
    node,
    schema,
    slotOptions,
    projectClasses,
    loopContext,
    bindContext,
    linkContext,
    dataContext,
    appliesNow,
    branchDefault,
    narrowOptions,
    setPropCascading,
    styleField,
    assetContext,
    listProps,
    projectPath,
  } = state;
  return (
    <>
      {schema
        .filter(appliesNow)
        .filter((field) => field.name !== 'class' && !(styleField && field.name === 'style'))
        .map((field) => {
          const value = canvasDraftProp(node.id, field.name, draft) ?? node.props?.[field.name];
          const onChange: ValueChange = (next, immediate) => setPropCascading(field.name, next, immediate);
          const plain = (
            <PropField
              key={field.name}
              nodeKey={node.id}
              bindContext={bindContext || loopContext}
              field={narrowOptions(field)}
              branchDefault={branchDefault(field.name)}
              value={value}
              slotOptions={slotOptions}
              projectClasses={projectClasses}
              assetContext={assetContext}
              linkContext={linkContext}
              dataContext={dataContext}
              onChange={onChange}
            />
          );
          // A prop the component's loop reads its filters, sort or picked items from
          // is edited with the loop's own editor; Show and Skip are numbers.
          const listProp = listProps?.get(field.name);
          return listProp !== undefined && (listProp.setting === 'filter' || listProp.setting === 'sort' || listProp.setting === 'curated') ? (
            <ListPropField
              key={field.name}
              name={field.name}
              listProp={listProp}
              value={value}
              projectPath={projectPath}
              fallback={plain}
              onChange={onChange}
            />
          ) : (
            plain
          );
        })}
    </>
  );
}

export function ElementExtraFields({ state }: { readonly state: ElementState }) {
  const { node, slotOptions, projectClasses, loopContext, bindContext, linkContext, onSetProp, dataContext, extraProps, styleField, assetContext } = state;
  return (
    <>
      {extraProps
        .filter((name) => name !== 'class' && !(styleField && name === 'style'))
        .map((name) => (
          <PropField
            key={name}
            nodeKey={node.id}
            bindContext={bindContext || loopContext}
            field={{ name, type: 'other' }}
            value={node.props?.[name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetContext={assetContext}
            linkContext={linkContext}
            dataContext={dataContext}
            onChange={(next, immediate) => onSetProp(name, next, immediate)}
          />
        ))}
    </>
  );
}

export function ElementSettingsHeader({ state }: { readonly state: ElementState }) {
  const translate = useTranslate();
  const { settingsOpen, setSettingsOpen, hasSettings, settingsCount } = state;
  return (
    <>
      {hasSettings && (
        <div className={`props-group ${settingsOpen ? 'open' : ''}`}>
          <button type="button" className="props-group-head" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            <span className="props-group-name">{translate('props.element.settings')}</span>
            {/* Something set in there is worth knowing about without opening
                  it — otherwise a class you gave the element looks lost. */}
            {!settingsOpen && settingsCount > 0 && <span className="props-group-count">{settingsCount}</span>}
            <ChevronRightIcon size={11} className="props-group-chevron" />
          </button>
        </div>
      )}
    </>
  );
}

export function ElementTag({ state }: { readonly state: ElementState }) {
  const { node, layouts, currentLayoutName, tagOptions, onChangeTag, layoutTag, changeToLayout, showTagField } = state;
  return (
    <>
      {showTagField && (
        <TagField
          key="tag"
          // A layout shows (and offers) the layout it resolves to, not the
          // local name the page imported it under — that name is a detail of
          // this page, while the file is what you're choosing between.
          tag={layoutTag ? currentLayoutName || node.name : node.name}
          options={layoutTag ? layouts.map((option) => ({ name: option.name, kind: 'layout' })) : tagOptions}
          onChangeTag={layoutTag ? changeToLayout : (name) => onChangeTag?.(name)}
        />
      )}
    </>
  );
}

export function ElementClass({ state }: { readonly state: ElementState }) {
  const { node, slotOptions, projectClasses, loopContext, bindContext, linkContext, dataContext, setPropCascading, classField, assetContext } = state;
  return (
    <>
      {classField && (
        <PropField
          key="class"
          nodeKey={node.id}
          bindContext={bindContext || loopContext}
          field={classField}
          value={node.props?.['class']}
          slotOptions={slotOptions}
          projectClasses={projectClasses}
          assetContext={assetContext}
          linkContext={linkContext}
          dataContext={dataContext}
          onChange={(next, immediate) => setPropCascading('class', next, immediate)}
        />
      )}
    </>
  );
}

export function ElementStyle({ state }: { readonly state: ElementState }) {
  const { node, slotOptions, projectClasses, loopContext, bindContext, linkContext, dataContext, setPropCascading, styleField } = state;
  return (
    <>
      {styleField && (
        <PropField
          // The editor is mounted with its text and doesn't re-sync, so it
          // has to be a new one per node — otherwise selecting a sibling
          // would leave the previous element's CSS sitting in the field.
          key={`style:${node.id}`}
          nodeKey={node.id}
          bindContext={bindContext || loopContext}
          field={styleField}
          value={node.props?.['style']}
          slotOptions={slotOptions}
          projectClasses={projectClasses}
          linkContext={linkContext}
          dataContext={dataContext}
          onChange={(next, immediate) => setPropCascading('style', next, immediate)}
        />
      )}
    </>
  );
}

export function ElementAttributes({ state }: { readonly state: ElementState }) {
  const { node, allowAttrs, loopContext, bindContext, onSetProp, onSetProps, onRenameProp, projectPath, attrNames, onReplaceProps, onSetFrontmatter, schema } =
    state;
  // An HTML element is checked against its tag and can be connected to the
  // component's attributes prop; an instance's attributes would collide with
  // the props its component declares.
  const element = node.kind === 'element' && /^[a-z][a-z0-9-]*$/.test(String(node.name));
  return (
    <>
      {allowAttrs && (
        <AttributesSection
          key="attrs"
          node={node}
          names={attrNames}
          tag={element ? String(node.name) : undefined}
          reservedNames={node.kind === 'component' ? schema.map((field) => field.name) : undefined}
          onReplaceProps={onReplaceProps === undefined || !element ? undefined : (props) => onReplaceProps(node.id, props)}
          onReplaceAttributes={onReplaceProps === undefined ? undefined : (props) => onReplaceProps(node.id, props)}
          onSetFrontmatter={onSetFrontmatter}
          projectPath={projectPath}
          bindContext={bindContext || loopContext}
          onSetProp={onSetProp}
          onSetProps={onSetProps}
          onRenameProp={onRenameProp}
        />
      )}
    </>
  );
}

export function ElementSlot({ state }: { readonly state: ElementState }) {
  const { node, slotOptions, onSetProp, showSlotField } = state;
  return (
    <>
      {showSlotField && (
        <PropField
          key="slot"
          field={{ name: 'slot', type: 'slot' }}
          value={node.props?.['slot']}
          slotOptions={slotOptions}
          onChange={(next, immediate) => onSetProp('slot', next, immediate)}
        />
      )}
    </>
  );
}

export function ElementSettings({ state }: { readonly state: ElementState }) {
  const { node, comment, onSetComment, settingsOpen, hasSettings } = state;
  return (
    <>
      {hasSettings && settingsOpen && (
        <>
          {/* First in Settings, and on every node: the tag is what the node IS,
            and it's how a <div> becomes a component (or a component becomes a
            <div>) without going to the code. */}
          <ElementTag state={state} />
          <ElementClass state={state} />
          <ElementStyle state={state} />
          <ElementAttributes state={state} />
          {onSetComment && (node.kind === 'element' || node.kind === 'component') && <CommentField key="comment" value={comment} onCommit={onSetComment} />}
          {/* `slot` is not a prop of this component — it tells the PARENT where to
            put it — so it sits apart from the component's own props, last of
            all, below even the comment. */}
          <ElementSlot state={state} />
        </>
      )}
    </>
  );
}

export function elementOpenContentPicker(state: ElementState, host: Element | undefined, focus: FieldFocus): void {
  if (state.contentPicker) {
    state.setContentPicker(undefined);
    return;
  }
  const rectangle = host?.getBoundingClientRect();
  if (!rectangle) {
    return;
  }
  state.setContentPicker({ ...dataPickerPosition(rectangle), focus });
}

// A picked chip in the Content field: at the caret while the words are being
// typed, the words around it kept; the whole of the content when the dot was
// pressed from outside the field (fieldFocus.ts). A node's expression is
// written with its braces — `{title}` — where an attribute's is not.
export function elementPlaceContentChip(state: Pick<ElementState, 'contentInsertRef' | 'onSetInline'>, focus: FieldFocus, path: string): void {
  assert(path.length > 0, 'A picked chip names a value');
  switch (focus.kind) {
    case 'focused': {
      const insert = state.contentInsertRef.current;
      assert(insert !== undefined, 'The Content field is mounted while its picker is open');
      insert.insert(path);
      return;
    }
    case 'unfocused':
      state.onSetInline([{ kind: 'expr', value: `{${path}}` }]);
      return;
    default: {
      const exhaustive: never = focus;
      return exhaustive;
    }
  }
}

// The element's content as words, when it is only words; '' otherwise.
function plainContent(children: ElementState['node']['children']): string {
  const kids = children ?? [];
  return kids.every((child) => child.kind === 'text')
    ? kids
        .map((child) => (child.kind === 'text' ? String(child.value ?? '') : ''))
        .join('')
        .trim()
    : '';
}
