---
title: Props and settings
description: Typed fields generated from each component's Props interface, plus tag, class, attributes and slots.
group: building
order: 2
keywords:
  [
    "settings",
    "props",
    "interface",
    "typescript",
    "attributes",
    "class",
    "slot",
    "tag",
  ]
---

The Settings tab (<kbd>D</kbd>) edits what the selected node _is_ and what it is
given.

## Props come from your types

Stacki reads the component's `interface Props`, or its `Astro.props`
destructure, and builds a field for each prop:

| Type in your component           | Field you get                                    |
| -------------------------------- | ------------------------------------------------ |
| `string`                         | Text field                                       |
| `number`                         | Number field, with drag-to-change and arrow keys |
| `boolean`                        | Toggle                                           |
| A union of string literals       | Dropdown of exactly those values                 |
| `ImageMetadata` or an image path | Asset picker                                     |
| Anything else                    | Text field, or the code editor for an expression |

Default values in the component show as the field's placeholder, so you can see
what you get by leaving it alone. JSDoc comments above a prop become its help
text, and `@min`, `@max` and `@int` constrain the number field.

Nothing about this is configured. It is your component's own type declaration,
read at open time: change the interface and the fields change.

## The Settings group

Under the component's own props sits a collapsible **Settings** group with the
four fields every node has. It is shut by default so a component's props are
what the panel opens on, and it shows a count when something in it is set.

| Field      | What it does                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Tag        | What the node is. Changing a `<div>` to a component name, or the reverse, happens here                                    |
| Class      | The element's classes, as reorderable tags. The Style tab's [selector box](/docs/classes-and-states) is a different field |
| Attributes | Any attribute, for elements and for components that spread `...rest`                                                      |
| Comment    | The HTML comment above the node                                                                                           |
| Slot       | Which named slot of the parent this node fills                                                                            |

## Text and slot content

A node whose content is text edits it in place. A component that takes default
slot content gets a field for it, so you are not opening the code editor to
change a label.

## Frontmatter

Selecting the page's frontmatter row opens the imports, constants and data for
the page in a floating code editor you can move and resize while the canvas
stays live. Press <kbd>Enter</kbd> on the selection to open it.
