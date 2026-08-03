import React from 'react';

// Minimal stroke-based icon set on a 16px grid, Framer-style.
const I = ({ children, size = 16, className, style, filled = false, strokeWidth = 1.3 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={filled ? 'currentColor' : 'none'}
    stroke={filled ? 'none' : 'currentColor'}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const FileIcon = (p) => (
  <I {...p}>
    <path d="M4.5 1.75h4.4l3.1 3.1v9.15a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V2.25a.5.5 0 0 1 .5-.5Z" />
    <path d="M8.9 1.9v3h3" />
  </I>
);

export const ComponentIcon = (p) => (
  <I {...p}>
    <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" transform="rotate(45 8 8)" />
  </I>
);

export const LayoutIcon = (p) => (
  <I {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12M6 6v7.5" />
  </I>
);

export const TextIcon = (p) => (
  <I {...p}>
    <path d="M3.5 4.5V3.5h9v1M8 3.5v9M6.3 12.5h3.4" />
  </I>
);

export const CommentIcon = (p) => (
  <I {...p}>
    <path d="M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.6-2.5A4.7 4.7 0 0 1 2.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5Z" />
  </I>
);

export const CodeIcon = (p) => (
  <I {...p}>
    <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
  </I>
);

export const TagIcon = (p) => (
  <I {...p}>
    <path d="m6 3.5-4 4.5 4 4.5M10 3.5l4 4.5-4 4.5" />
  </I>
);

export const ChevronLeftIcon = (p) => (
  <I {...p}>
    <path d="m10 4-4 4 4 4" />
  </I>
);

export const ChevronRightIcon = (p) => (
  <I {...p}>
    <path d="m6 4 4 4-4 4" />
  </I>
);

export const ChevronDownIcon = (p) => (
  <I {...p}>
    <path d="m4 6 4 4 4-4" />
  </I>
);

export const PlusIcon = (p) => (
  <I {...p}>
    <path d="M8 3v10M3 8h10" />
  </I>
);

export const ArrowUpIcon = (p) => (
  <I {...p}>
    <path d="M8 13V3.5M4 7.5 8 3.5l4 4" />
  </I>
);

export const StopIcon = (p) => (
  <I {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
  </I>
);

export const RefreshIcon = (p) => (
  <I {...p}>
    <path d="M13 8a5 5 0 1 1-1.47-3.54" />
    <path d="M13.2 2.6v2.6h-2.6" />
  </I>
);

export const CloseIcon = (p) => (
  <I {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </I>
);

export const ComponentPropertiesIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.47885 1.69162C8.18037 1.52882 7.81963 1.52882 7.52115 1.69162L2.52115 4.4189C2.19989 4.59413 2 4.93085 2 5.29679V10.7032C2 11.0691 2.19989 11.4058 2.52115 11.5811L7.52115 14.3083C7.81963 14.4711 8.18037 14.4711 8.47885 14.3083L13.4789 11.5811C13.8001 11.4058 14 11.0691 14 10.7032V5.29679C14 4.93085 13.8001 4.59413 13.4789 4.4189L8.47885 1.69162ZM3.54416 4.99998L8 2.56952L12.4558 4.99998L8 7.43043L3.54416 4.99998ZM3 5.84225L3 10.7032L7.5 13.1577V8.29679L3 5.84225Z"
    />
  </I>
);

export const VariableTextSizeIcon = (p) => (
  <I {...p} filled>
    <path fillRule="evenodd" clipRule="evenodd" d="M5 5H2V4H9V5H6V12H5V5Z" />
    <path fillRule="evenodd" clipRule="evenodd" d="M11 8H9V7H14V8H12V12H11V8Z" />
  </I>
);

export const FieldNumberIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.846 3.13226L11.0637 6.0007H13V7.0007H10.791L10.2455 9.0007H12V10.0007H9.9728L9.11873 13.1323L8.15397 12.8691L8.93627 10.0007H5.9728L5.11873 13.1323L4.15397 12.8691L4.93627 10.0007H3V9.0007H5.209L5.75445 7.0007H4V6.0007H6.02718L6.88124 2.86914L7.84601 3.13226L7.0637 6.0007H10.0272L10.8812 2.86914L11.846 3.13226ZM6.24552 9.0007H9.209L9.75446 7.0007H6.79098L6.24552 9.0007Z"
    />
  </I>
);

export const ElementComponentIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.47885 1.69144C8.18037 1.52863 7.81963 1.52863 7.52115 1.69144L2.52115 4.41871C2.19989 4.59395 2 4.93066 2 5.29661V10.703C2 11.0689 2.19989 11.4056 2.52115 11.5809L7.52115 14.3081C7.81963 14.471 8.18037 14.471 8.47885 14.3081L13.4789 11.5809C13.8001 11.4056 14 11.0689 14 10.703V5.29661C14 4.93066 13.8001 4.59395 13.4789 4.41871L8.47885 1.69144ZM3.54416 4.99979L8 2.56934L12.4558 4.99979L8 7.43025L3.54416 4.99979ZM3 5.84206L3 10.703L7.5 13.1575V8.29661L3 5.84206ZM8.5 13.1575L13 10.703V5.84206L8.5 8.29661V13.1575Z"
    />
  </I>
);

export const ElementSlotIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 3C2 2.44772 2.44772 2 3 2H4.25V3L3 3V4.25H2V3ZM9.25 3H6.75V2H9.25V3ZM13 3H11.75V2H13C13.5523 2 14 2.44772 14 3V4.25H13V3ZM3 6.75V9.25H2V6.75H3ZM13 9.25V6.75H14V9.25H13ZM3 11.75V13H4.25V14H3C2.44772 14 2 13.5523 2 13V11.75H3ZM13 13V11.75H14V13C14 13.5523 13.5523 14 13 14H11.75V13H13ZM6.75 13H9.25V14H6.75V13Z"
    />
  </I>
);

export const ExpandVerticalIcon = (p) => (
  <I {...p} filled>
    <path d="M5.85353 6.85351L8.49998 4.20706L11.1464 6.85351L11.8535 6.1464L8.49998 2.79285L5.14642 6.1464L5.85353 6.85351Z" />
    <path d="M5.85353 9.1464L8.49998 11.7928L11.1464 9.1464L11.8535 9.85351L8.49998 13.2071L5.14642 9.85351L5.85353 9.1464Z" />
  </I>
);

export const CollapseVerticalIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.1464 3.14648L8.5 5.79293L5.85355 3.14648L5.14645 3.85359L8.14645 6.85359L8.5 7.20714L8.85355 6.85359L11.8536 3.85359L11.1464 3.14648ZM11.1464 12.8536L8.5 10.2071L5.85355 12.8536L5.14645 12.1465L8.14645 9.14648L8.5 8.79293L8.85355 9.14648L11.8536 12.1465L11.1464 12.8536Z"
    />
  </I>
);

export const RepeatIcon = (p) => (
  <I {...p}>
    <path d="M3 6.5V6a2.5 2.5 0 0 1 2.5-2.5H13" />
    <path d="m11 1.5 2 2-2 2" />
    <path d="M13 9.5v.5a2.5 2.5 0 0 1-2.5 2.5H3" />
    <path d="m5 10.5-2 2 2 2" />
  </I>
);

export const PreviewIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 3.41881C4 2.63788 4.8551 2.15831 5.52145 2.56552L13.0626 7.174C13.7007 7.56392 13.7007 8.49063 13.0626 8.88056L5.52145 13.489C4.8551 13.8962 4 13.4167 4 12.6357V3.41881ZM12.5411 8.02728L5 3.41881V12.6357L12.5411 8.02728Z"
    />
  </I>
);

export const FolderIcon = (p) => (
  <I {...p}>
    <path d="M2 12.5V3.8a.8.8 0 0 1 .8-.8h3.4l1.5 1.8h5.5a.8.8 0 0 1 .8.8v6.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8Z" />
  </I>
);

export const FolderPlusIcon = (p) => (
  <I {...p}>
    <path d="M2 12.5V3.8a.8.8 0 0 1 .8-.8h3.4l1.5 1.8h5.5a.8.8 0 0 1 .8.8v6.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8Z" />
    <path d="M8 6.8v3.4M6.3 8.5h3.4" />
  </I>
);

export const UploadCloudIcon = (p) => (
  <I {...p}>
    <path d="M8 10.5V4M4.8 7.2 8 4l3.2 3.2" />
    <path d="M2.5 13h11" />
  </I>
);

export const BracesIcon = (p) => (
  <I {...p} filled>
    <path d="M6 3H5.5C4.67157 3 4 3.67157 4 4.5V6C4 6.8178 3.60733 7.54389 3.00024 8C3.60733 8.45612 4 9.1822 4 10V11.5C4 12.3284 4.67157 13 5.5 13H6V14H5.5C4.11929 14 3 12.8807 3 11.5V10C3 9.17157 2.32843 8.5 1.5 8.5H1V7.5H1.5C2.32843 7.5 3 6.82843 3 6V4.5C3 3.11929 4.11929 2 5.5 2H6V3Z" />
    <path d="M10 3H10.5C11.3284 3 12 3.67157 12 4.5V6C12 6.8178 12.3927 7.54389 12.9998 8C12.3927 8.45612 12 9.1822 12 10V11.5C12 12.3284 11.3284 13 10.5 13H10V14H10.5C11.8807 14 13 12.8807 13 11.5V10C13 9.17157 13.6716 8.5 14.5 8.5H15V7.5H14.5C13.6716 7.5 13 6.82843 13 6V4.5C13 3.11929 11.8807 2 10.5 2H10V3Z" />
  </I>
);

// --- Webflow-style element icons (filled, 16px grid) -----------------------

export const CustomElementIcon = (p) => (
  <I {...p} filled>
    <path d="M5.35353 11.3536L11.3535 5.35359L10.6464 4.64648L4.64642 10.6465L5.35353 11.3536Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 2C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H13C13.5523 14 14 13.5523 14 13V3C14 2.44772 13.5523 2 13 2H3ZM3 3L13 3V13H3V3Z"
    />
  </I>
);

export const ElementDivIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3ZM13 3L3 3V13H13V3Z"
    />
  </I>
);

export const ElementImageIcon = (p) => (
  <I {...p} filled>
    <path d="M6 7C6.55228 7 7 6.55228 7 6C7 5.44772 6.55228 5 6 5C5.44772 5 5 5.44772 5 6C5 6.55228 5.44772 7 6 7Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3ZM13 3L3 3V12.2929L8 7.29289L13 12.2929V3ZM8 8.70711L12.2929 13H3.70711L8 8.70711Z"
    />
  </I>
);

export const ElementSectionIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 13C2 13.5523 2.44772 14 3 14L13 14C13.5523 14 14 13.5523 14 13L14 3C14 2.44771 13.5523 2 13 2L3 2C2.44771 2 2 2.44772 2 3L2 13ZM3 4L3 3L13 3L13 4L3 4ZM3 5L3 11L13 11L13 5L3 5ZM13 12L3 12L3 13L13 13L13 12Z"
    />
  </I>
);

export const ElementListDefaultIcon = (p) => (
  <I {...p} filled>
    <path d="M3.5 4.5C4.05228 4.5 4.5 4.05228 4.5 3.5C4.5 2.94772 4.05228 2.5 3.5 2.5C2.94772 2.5 2.5 2.94772 2.5 3.5C2.5 4.05228 2.94772 4.5 3.5 4.5Z" />
    <path d="M6 4H14V3H6V4Z" />
    <path d="M6 8H14V7H6V8Z" />
    <path d="M6 12H14V11H6V12Z" />
    <path d="M4.5 7.5C4.5 8.05228 4.05228 8.5 3.5 8.5C2.94772 8.5 2.5 8.05228 2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5C4.05228 6.5 4.5 6.94772 4.5 7.5Z" />
    <path d="M3.5 12.5C4.05228 12.5 4.5 12.0523 4.5 11.5C4.5 10.9477 4.05228 10.5 3.5 10.5C2.94772 10.5 2.5 10.9477 2.5 11.5C2.5 12.0523 2.94772 12.5 3.5 12.5Z" />
  </I>
);

export const ElementListItemIcon = (p) => (
  <I {...p} filled>
    <g opacity="0.4">
      <path d="M4 10.5C4.27614 10.5 4.5 10.7239 4.5 11V12C4.5 12.2761 4.27614 12.5 4 12.5H3C2.72386 12.5 2.5 12.2761 2.5 12V11C2.5 10.7239 2.72386 10.5 3 10.5H4Z" />
      <path d="M14 12H6V11H14V12Z" />
    </g>
    <path d="M4 6.5C4.27614 6.5 4.5 6.72386 4.5 7V8C4.5 8.27614 4.27614 8.5 4 8.5H3C2.72386 8.5 2.5 8.27614 2.5 8V7C2.5 6.72386 2.72386 6.5 3 6.5H4Z" />
    <path d="M14 8H6V7H14V8Z" />
    <g opacity="0.4">
      <path d="M4 2.5C4.27614 2.5 4.5 2.72386 4.5 3V4C4.5 4.27614 4.27614 4.5 4 4.5H3C2.72386 4.5 2.5 4.27614 2.5 4V3C2.5 2.72386 2.72386 2.5 3 2.5H4Z" />
      <path d="M14 4H6V3H14V4Z" />
    </g>
  </I>
);

export const ElementLinkIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.64643 3.64667C9.67012 2.62298 11.3298 2.62298 12.3535 3.64667C13.3772 4.67036 13.3772 6.33009 12.3535 7.35378L11.3535 8.35378L10.6464 7.64667L11.6464 6.64667C12.2796 6.01351 12.2796 4.98695 11.6464 4.35378C11.0133 3.72062 9.9867 3.72061 9.35354 4.35378L8.35354 5.35378L7.64643 4.64667L8.64643 3.64667ZM6.35354 7.35378L5.35354 8.35378C4.72037 8.98695 4.72037 10.0135 5.35354 10.6467C5.9867 11.2798 7.01326 11.2798 7.64643 10.6467L8.64643 9.64667L9.35354 10.3538L8.35353 11.3538C7.32984 12.3775 5.67012 12.3775 4.64643 11.3538C3.62274 10.3301 3.62274 8.67036 4.64643 7.64667L5.64643 6.64667L6.35354 7.35378ZM7.35354 9.35378L10.3535 6.35378L9.64643 5.64667L6.64643 8.64667L7.35354 9.35378Z"
    />
  </I>
);

export const ElementH1Icon = (p) => (
  <I {...p} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path d="M12 4C12 4.55228 11.5523 5 11 5H10.5V6H11C11.3643 6 11.7058 5.90261 12 5.73244V12H13V4H12Z" />
  </I>
);

export const ElementH2Icon = (p) => (
  <I {...p} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d="M10 7V5.5C10 4.67157 10.6716 4 11.5 4H12.5C13.328 4 13.9993 4.67092 14 5.49879V7.12546C13.9997 7.48837 13.8679 7.83888 13.6289 8.11202L11.1019 11H14V12H10V10.7407L12.8763 7.45352C12.956 7.36237 13 7.24538 13 7.12426V5.5C13 5.22386 12.7761 5 12.5 5H11.5C11.2239 5 11 5.22386 11 5.5V7H10Z" />
  </I>
);

export const ElementH3Icon = (p) => (
  <I {...p} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path d="M12.5 5H10V4H12.5C13.3284 4 14 4.67157 14 5.5V6.5C14 6.88418 13.8556 7.23462 13.6181 7.5C13.8556 7.76538 14 8.11582 14 8.5V10.5C14 11.3284 13.3284 12 12.5 12H10V11H12.5C12.7761 11 13 10.7761 13 10.5V8.5C13 8.22386 12.7761 8 12.5 8H11V7H12.5C12.7761 7 13 6.77614 13 6.5V5.5C13 5.22386 12.7761 5 12.5 5Z" />
  </I>
);

export const ElementH4Icon = (p) => (
  <I {...p} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d="M10 4V6.5C10 7.32843 10.6716 8 11.5 8H13V12H14V4H13V7H11.5C11.2239 7 11 6.77614 11 6.5V4H10Z" />
  </I>
);

export const ElementH5Icon = (p) => (
  <I {...p} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d="M10 4V8H12.5C12.7761 8 13 8.22386 13 8.5V10.5C13 10.7761 12.7761 11 12.5 11H10V12H12.5C13.3284 12 14 11.3284 14 10.5V8.5C14 7.67157 13.3284 7 12.5 7H11V5H14V4H10Z" />
  </I>
);

export const ElementH6Icon = (p) => (
  <I {...p} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M10 5.5C10 4.67157 10.6716 4 11.5 4H13V5H11.5C11.2239 5 11 5.22386 11 5.5V7.08535C11.1564 7.03008 11.3247 7 11.5 7H12.5C13.3284 7 14 7.67157 14 8.5V10.5C14 11.3284 13.3284 12 12.5 12H11.5C10.6716 12 10 11.3284 10 10.5V5.5ZM11 8.5V10.5C11 10.7761 11.2239 11 11.5 11H12.5C12.7761 11 13 10.7761 13 10.5V8.5C13 8.22386 12.7761 8 12.5 8H11.5C11.2239 8 11 8.22386 11 8.5Z"
    />
  </I>
);

export const ElementPIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 4H9C10.1046 4 11 4.89543 11 6V7C11 8.10457 10.1046 9 9 9H6V12H5V4ZM6 8H9C9.55228 8 10 7.55228 10 7V6C10 5.44772 9.55228 5 9 5H6V8Z"
    />
  </I>
);

export const ElementVideoIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 3.41905C4 2.63812 4.8551 2.15855 5.52145 2.56577L13.0626 7.17424C13.7007 7.56417 13.7007 8.49087 13.0626 8.8808L5.52145 13.4893C4.8551 13.8965 4 13.4169 4 12.636V3.41905ZM12.5411 8.02752L5 3.41905V12.636L12.5411 8.02752Z"
    />
  </I>
);

export const ElementFormBlockIcon = (p) => (
  <I {...p} filled>
    <path d="M14 5H2V4H14V5Z" />
    <path d="M14 8H2V7H14V8Z" />
    <path d="M2.5 11C2.22386 11 2 11.2239 2 11.5V12.5C2 12.7761 2.22386 13 2.5 13H7.5C7.77614 13 8 12.7761 8 12.5V11.5C8 11.2239 7.77614 11 7.5 11H2.5Z" />
  </I>
);

export const ElementInputIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 4C2 3.44772 2.44771 3 3 3H13C13.5523 3 14 3.44772 14 4V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4ZM13 4L3 4V12H13V4Z"
    />
    <path
      opacity="0.6"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 11V5H5V11H4Z"
    />
  </I>
);

export const ElementSelectIcon = (p) => (
  <I {...p} filled>
    <path d="M10.1464 6.14648L7.99996 8.29293L5.85352 6.14648L5.14641 6.85359L7.99996 9.70714L10.8535 6.85359L10.1464 6.14648Z" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 2C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H13C13.5523 14 14 13.5523 14 13V3C14 2.44772 13.5523 2 13 2H3ZM3 3L13 3V13H3V3Z"
    />
  </I>
);

export const ElementButtonIcon = (p) => (
  <I {...p} filled>
    <path d="M6 3H7.5V7.00001L11 7C11.5523 7 12 7.44771 12 8V10.5858C12 10.851 11.8946 11.1054 11.7071 11.2929L10.2929 12.7071C10.1054 12.8946 9.851 13 9.58579 13L6.1894 13.0001L2.96973 9.78039L4.03039 8.71973L6 10.6893V3Z" />
  </I>
);

export const ResetIcon = (p) => (
  <I {...p}>
    <path d="M6.5 3.5 3.5 6.5l3 3" />
    <path d="M3.5 6.5h5.25a3.75 3.75 0 0 1 3.75 3.75v2.25" />
  </I>
);

export const DragIcon = (p) => (
  <I {...p} filled>
    <circle cx="6" cy="4" r="1" />
    <circle cx="10" cy="4" r="1" />
    <circle cx="6" cy="8" r="1" />
    <circle cx="10" cy="8" r="1" />
    <circle cx="6" cy="12" r="1" />
    <circle cx="10" cy="12" r="1" />
  </I>
);

export const CheckIcon = (p) => (
  <I {...p} strokeWidth={1.6}>
    <path d="m3.5 8.5 3 3 6-7" />
  </I>
);

export const BranchIcon = (p) => (
  <I {...p}>
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="5" r="1.6" />
    <path d="M4.5 5.1v5.8" />
    <path d="M11.5 6.6c0 2.6-3.2 2.8-5.2 3.6" />
  </I>
);

export const ExternalIcon = (p) => (
  <I {...p}>
    <path d="M12.5 9.5v3.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5H7" />
    <path d="M9.5 2.5h4v4M13.2 2.8 7.8 8.2" />
  </I>
);

export const MaximizeIcon = (p) => (
  <I {...p}>
    <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />
  </I>
);

export const DesktopIcon = (p) => (
  <I {...p}>
    <rect x="2" y="3" width="12" height="8.5" rx="1.2" />
    <path d="M6 14h4M8 11.5V14" />
  </I>
);

export const TabletIcon = (p) => (
  <I {...p}>
    <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
    <path d="M7 12h2" />
  </I>
);

export const PhoneIcon = (p) => (
  <I {...p}>
    <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" />
    <path d="M7 12.25h2" />
  </I>
);

// Webflow-style filled icons on a 24px grid (used by the left rail).
const I24 = ({ children, size = 24, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const AssetManagerIcon = (p) => (
  <I24 {...p}>
    <path
      d="M9 10C9.55228 10 10 9.55228 10 9C10 8.44772 9.55228 8 9 8C8.44772 8 8 8.44772 8 9C8 9.55228 8.44772 10 9 10Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 6.5C5 5.67157 5.67157 5 6.5 5H18.5C19.3284 5 20 5.67157 20 6.5V18.5C20 19.3284 19.3284 20 18.5 20H6.5C5.67157 20 5 19.3284 5 18.5V6.5ZM6.5 6C6.22386 6 6 6.22386 6 6.5V18.2929L12.5 11.7929L19 18.2929V6.5C19 6.22386 18.7761 6 18.5 6H6.5ZM12.5 13.2071L18.2929 19H6.70711L12.5 13.2071Z"
      fill="currentColor"
    />
    <g opacity="0.4">
      <path
        d="M9.79307 1.30827C10.1836 0.91775 10.8168 0.91775 11.2073 1.30827L13.899 3.99994H7.1014L9.79307 1.30827Z"
        fill="currentColor"
      />
      <path
        d="M3.99993 7.10141V13.8999L1.30779 11.2078C0.917262 10.8172 0.917261 10.1841 1.30779 9.79356L3.99993 7.10141Z"
        fill="currentColor"
      />
      <path
        d="M12.5 18.9999H8L11.6464 15.3535C11.9614 15.0385 12.5 15.2616 12.5 15.707V18.9999Z"
        fill="currentColor"
      />
    </g>
  </I24>
);

// Webflow's CMS icon, drawn on a 16px grid — scaled up for the rail.
export const CmsIcon = ({ size = 24, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4.5752 2.79515C5.47691 2.2942 6.68875 2 8 2C9.31125 2 10.5231 2.2942 11.4248 2.79515C12.3096 3.2867 13 4.04561 13 5V11C13 11.9544 12.3096 12.7133 11.4248 13.2048C10.5231 13.7058 9.31125 14 8 14C6.68875 14 5.47691 13.7058 4.5752 13.2048C3.69042 12.7133 3 11.9544 3 11V5C3 4.04561 3.69042 3.2867 4.5752 2.79515ZM4 9.82287V11C4 11.4263 4.31694 11.9174 5.06084 12.3307C5.7878 12.7346 6.82597 13 8 13C9.17403 13 10.2122 12.7346 10.9392 12.3307C11.6831 11.9174 12 11.4263 12 11V9.82287C11.8227 9.96383 11.6289 10.0915 11.4248 10.2048C10.5231 10.7058 9.31125 11 8 11C6.68875 11 5.47691 10.7058 4.5752 10.2048C4.37109 10.0915 4.17733 9.96383 4 9.82287ZM12 8C12 8.42632 11.6831 8.91741 10.9392 9.33069C10.2122 9.73456 9.17403 10 8 10C6.82597 10 5.7878 9.73456 5.06084 9.33069C4.31694 8.91741 4 8.42632 4 8V6.82287C4.17733 6.96383 4.37109 7.09145 4.5752 7.20485C5.47691 7.7058 6.68875 8 8 8C9.31125 8 10.5231 7.7058 11.4248 7.20485C11.6289 7.09145 11.8227 6.96383 12 6.82287V8ZM10.9392 3.66931C11.6831 4.08259 12 4.57368 12 5C12 5.42632 11.6831 5.91741 10.9392 6.33069C10.2122 6.73456 9.17403 7 8 7C6.82597 7 5.7878 6.73456 5.06084 6.33069C4.31694 5.91741 4 5.42632 4 5C4 4.57368 4.31694 4.08259 5.06084 3.66931C5.7878 3.26544 6.82597 3 8 3C9.17403 3 10.2122 3.26544 10.9392 3.66931Z"
      fill="currentColor"
    />
  </svg>
);

// Four-point sparkle: the shorthand for "this is the AI bit".

export const TerminalIcon = (p) => (
  <I strokeWidth={1.3} {...p}>
    <path d="M2.5 4.5 6 8l-3.5 3.5" />
    <path d="M8 12h5.5" />
  </I>
);

export const PagePanelIcon = (p) => (
  <I24 {...p}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6.5 4C6.22386 4 6 4.22386 6 4.5V19.5C6 19.7761 6.22386 20 6.5 20H18.5C18.7761 20 19 19.7761 19 19.5V9.70711L13.2929 4H6.5ZM5 4.5C5 3.67157 5.67157 3 6.5 3H13.7071L20 9.29289V19.5C20 20.3284 19.3284 21 18.5 21H6.5C5.67157 21 5 20.3284 5 19.5V4.5Z"
      fill="currentColor"
    />
    <path
      opacity="0.4"
      d="M16.7929 10H13.5C13.2239 10 13 9.77614 13 9.5V6.20711C13 5.76165 13.5386 5.53857 13.8536 5.85355L17.1464 9.14645C17.4614 9.46143 17.2383 10 16.7929 10Z"
      fill="currentColor"
    />
  </I24>
);

export const NavigatorIcon = (p) => (
  <I24 {...p}>
    <path d="M2 7H17V6H2V7Z" fill="currentColor" />
    <path d="M22 12H7V11H22V12Z" fill="currentColor" />
    <path d="M22 17H7V16H22V17Z" fill="currentColor" />
  </I24>
);

export const ComponentFillIcon = (p) => (
  <I24 {...p}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.2354 2.83998C12.7788 2.58313 12.2212 2.58313 11.7646 2.83998L4.76461 6.77748C4.29229 7.04315 4 7.54293 4 8.08484V15.9151C4 16.4571 4.29229 16.9568 4.76461 17.2225L11.7646 21.16C12.2212 21.4169 12.7788 21.4169 13.2354 21.16L20.2354 17.2225C20.7077 16.9568 21 16.4571 21 15.9151V8.08484C21 7.54293 20.7077 7.04315 20.2354 6.77747L13.2354 2.83998ZM12.2549 3.71155C12.4071 3.62593 12.5929 3.62593 12.7451 3.71155L19.4801 7.49999L12.5 11.4263L5.51987 7.49999L12.2549 3.71155ZM5 8.35491V15.9151C5 16.0958 5.09743 16.2624 5.25487 16.3509L12 20.1451V12.2924L5 8.35491ZM13 20.1451L19.7451 16.3509C19.9026 16.2624 20 16.0958 20 15.9151V8.35491L13 12.2924V20.1451Z"
      fill="currentColor"
    />
    <g opacity="0.4">
      <path
        d="M12.5 9.6169C12.5 10.0056 12.076 10.2456 11.7428 10.0457L8.21458 7.92875C7.89091 7.73454 7.89091 7.26545 8.21458 7.07125L11.7428 4.95435C12.076 4.75439 12.5 4.99445 12.5 5.3831V9.6169Z"
        fill="currentColor"
      />
      <path
        d="M10.2854 13.4287C10.6091 13.2345 10.6091 12.7655 10.2854 12.5713L6.75725 10.4543C6.42399 10.2544 6 10.4944 6 10.8831V15.1169C6 15.5056 6.42399 15.7456 6.75725 15.5457L10.2854 13.4287Z"
        fill="currentColor"
      />
    </g>
  </I24>
);

export const LayersIcon = (p) => (
  <I {...p}>
    <path d="m8 1.8 6 3.2-6 3.2-6-3.2 6-3.2Z" />
    <path d="m2.5 8.2 5.5 3 5.5-3" />
    <path d="m2.5 11.2 5.5 3 5.5-3" />
  </I>
);

export const CanvasIcon = (p) => (
  <I {...p}>
    <rect x="1.75" y="3" width="7" height="10" rx="1" />
    <rect x="10.75" y="4.75" width="3.5" height="6.5" rx="0.8" />
  </I>
);

export const CopyIcon = (p) => (
  <I {...p}>
    <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    <path d="M10.5 3.4a1.5 1.5 0 0 0-1.5-1.65H3.25A1.5 1.5 0 0 0 1.75 3.25V9a1.5 1.5 0 0 0 1.65 1.5" />
  </I>
);

// --- CMS field types -------------------------------------------------------

export const ParagraphIcon = (p) => (
  <I {...p}>
    <path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" />
  </I>
);

export const SwitchIcon = (p) => (
  <I {...p}>
    <rect x="1.75" y="4.75" width="12.5" height="6.5" rx="3.25" />
    <circle cx="11" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </I>
);

export const CalendarIcon = (p) => (
  <I {...p}>
    <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
    <path d="M2.25 6.5h11.5M5.5 1.75v2.5M10.5 1.75v2.5" />
  </I>
);

export const MailIcon = (p) => (
  <I {...p}>
    <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5" />
    <path d="m2.5 5 5.5 4 5.5-4" />
  </I>
);

export const PhoneCallIcon = (p) => (
  <I {...p}>
    <path d="M5.6 2.5 7 5.1 5.7 6.6c.6 1.3 1.7 2.4 3 3l1.5-1.3 2.6 1.4-.6 2.1c-.2.6-.8 1-1.4.9C7.2 12.2 3.8 8.8 3.1 5.2c-.1-.6.3-1.2.9-1.4l1.6-.5Z" />
  </I>
);

export const DropletIcon = (p) => (
  <I {...p}>
    <path d="M8 2.2s4 4 4 6.6a4 4 0 0 1-8 0C4 6.2 8 2.2 8 2.2Z" />
  </I>
);

export const GearIcon = (p) => (
  <I {...p}>
    <circle cx="8" cy="8" r="2.15" />
    <path d="M13 8a5 5 0 0 0-.08-.87l1.2-.93-1.25-2.17-1.42.52A5 5 0 0 0 9.9 3.8L9.7 2.3H7.2L7 3.8a5 5 0 0 0-1.55.75l-1.42-.52-1.25 2.17 1.2.93a5 5 0 0 0 0 1.74l-1.2.93 1.25 2.17 1.42-.52a5 5 0 0 0 1.55.75l.2 1.5h2.5l.2-1.5a5 5 0 0 0 1.55-.75l1.42.52 1.25-2.17-1.2-.93c.05-.28.08-.57.08-.87Z" />
  </I>
);

export const TrashIcon = (p) => (
  <I {...p}>
    <path d="M3 4.5h10M6.5 2.5h3M5.5 4.5l.5 9h4l.5-9" />
  </I>
);

export const FolderOpenIcon = (p) => (
  <I {...p}>
    <path d="M2 12.5V3.8a.8.8 0 0 1 .8-.8h3.4l1.5 1.8h5.5a.8.8 0 0 1 .8.8v1" />
    <path d="M2 12.5 3.8 7h10.7l-1.8 5.5H2Z" />
  </I>
);

export const SparkleIcon = (p) => (
  <I {...p}>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l1.8 1.8M10 10l1.8 1.8M11.8 4.2 10 6M6 10l-1.8 1.8" />
  </I>
);

export const UploadIcon = (p) => (
  <I {...p}>
    <path d="M8 10.5V3M4.8 6.2 8 3l3.2 3.2" />
    <path d="M2.5 13h11" />
  </I>
);

// Tag-specific element icons; anything without a dedicated icon gets the
// generic custom-element box.
export const HomeIcon = (p) => (
  <I {...p} filled>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.35356 1.64645C8.1583 1.45118 7.84172 1.45118 7.64645 1.64645L1.14645 8.14645L1.85356 8.85355L3.00001 7.70711V12C3.00001 12.5523 3.44772 13 4.00001 13H12C12.5523 13 13 12.5523 13 12V7.70711L14.1465 8.85355L14.8536 8.14645L8.35356 1.64645ZM12 6.70711L8.00001 2.70711L4.00001 6.70711V12H12V6.70711Z"
    />
  </I>
);

const TAG_ICONS = {
  div: ElementDivIcon,
  nav: HomeIcon,
  img: ElementImageIcon,
  section: ElementSectionIcon,
  ul: ElementListDefaultIcon,
  ol: ElementListDefaultIcon,
  li: ElementListItemIcon,
  a: ElementLinkIcon,
  h1: ElementH1Icon,
  h2: ElementH2Icon,
  h3: ElementH3Icon,
  h4: ElementH4Icon,
  h5: ElementH5Icon,
  h6: ElementH6Icon,
  p: ElementPIcon,
  video: ElementVideoIcon,
  form: ElementFormBlockIcon,
  input: ElementInputIcon,
  textarea: ElementInputIcon,
  select: ElementSelectIcon,
  button: ElementButtonIcon,
};

export const SearchIcon = (p) => (
  <I {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </I>
);

export function elementIcon(tag, size = 12, className) {
  const Icon = TAG_ICONS[String(tag).toLowerCase()] || CustomElementIcon;
  return <Icon size={size} className={className} />;
}

// Harness marks for the terminal panel, from the Simple Icons set (CC0), drawn
// in currentColor so they take the row's colour like every other icon here.

export const ClaudeMarkIcon = ({ size = 16, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

export const OpenAIMarkIcon = ({ size = 16, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

export const OpenCodeMarkIcon = ({ size = 16, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
  </svg>
);

export const GeminiMarkIcon = ({ size = 16, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  </svg>
);

// pi's own mark (pi.dev/logo-auto.svg): a blocky P plus the dot of the i. The
// viewBox is cropped to the artwork so it reads at the same optical size as
// the marks above, which have no padding.
export const PiMarkIcon = ({ size = 16, className, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="150 150 500 500"
    fill="currentColor"
    fillRule="evenodd"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
    <path d="M517.36 400H634.72V634.72H517.36Z" />
  </svg>
);
