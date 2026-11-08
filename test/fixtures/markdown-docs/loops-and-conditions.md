---
title: Loops and conditions
description: Repeating markup over data and showing it conditionally, as nodes you can select.
group: building
order: 3
keywords: ["map", "repeat", "if", "else", "ternary", "list", "collection"]
---

A loop and a condition are ordinary nodes in the tree. They are selectable,
they have children, and they are written back as the expressions you would have
typed.

## Loops

Insert **Loop** from the palette. Its Data field takes whatever can be looped:
a collection query, a prop, an array on `Astro.props`, chosen from the same
[data picker](/docs/binding-data) the prop fields use, filtered to things that
can be iterated.

The children of the loop are the template for one item. Every instance is
outlined on the canvas and labelled, so a list of eight posts shows eight
outlines, not one.

Inside a loop, the item is in scope for every field beneath it: binding a
`Heading` to `post.data.title` is a click, not a path you have to remember.

```astro
{
  posts.map((post) => (
    <Card title={post.data.title} href={`/blog/${post.id}`} />
  ))
}
```

## Conditions

Insert **Condition** for a ternary. It has two branches, `then` and `else`,
each holding its own children. A new condition starts with the test `true` so
the `then` branch renders immediately and you can see what you are building.

The `else` branch can be dropped entirely, which writes the short form:

```astro
{featured && <Badge>Featured</Badge>}
```

## When the code wins

A test that is a function call or an arrow keeps the code editor rather than
being chipped into parts, because that is the only honest way to show it. The
loop or condition still holds its children as nodes; only the expression itself
is text.
