// Detaching an instance of a component into the page that holds it.
//
//   node test/unlink-component.js
//
// The direction that can go wrong quietly. Extraction refuses and costs a
// rename; detaching succeeds, the page still builds, and a prop that used to
// carry a heading is now the word `undefined` in the middle of it. So what the
// instance was being given has to be resolved into the markup on the way in,
// and everything below is a way that has failed to happen:
//
//   props        `{title}` left standing, reading a name the page never had
//   strings      a prop's name rewritten INSIDE a string literal, producing
//                `{cond ? ""Hi"" : "Hi"}`, which compiles as nothing
//   scope        the caller's own expressions rewritten with the callee's
//                values, because slot content was substituted along with the
//                component's markup
//   slots        content dropped, because <slot /> was inlined as a <slot />
//   styles       a component's scoped rules left in a file the page no longer
//                imports, so the markup lands naked
//   refusals     a component whose frontmatter works something out, inlined
//                anyway, referencing a binding that did not come with it

const path = require('path');
const { pathToFileURL } = require('url');
const { parsePage, serializeNodes, parsePropSchema } = require('../electron/astroParser.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const parse = (source, what) => {
  const r = parsePage(source);
  if (!r.editable) throw new Error(`${what} did not parse: ${r.reason}`);
  return r.model;
};

// The page's `<Hero …>` node, and the component it points at.
const setup = (componentSource, pageBody) => {
  const component = parse(componentSource, 'component');
  const page = parse(`---\nimport Hero from '../components/Hero.astro';\n---\n${pageBody}`, 'page');
  const instance = (function find(list) {
    for (const n of list) {
      if (n.kind === 'component' && n.name === 'Hero') return n;
      const deeper = Array.isArray(n.children) ? find(n.children) : null;
      if (deeper) return deeper;
    }
    return null;
  })(page.nodes);
  return { component, page, instance, schema: parsePropSchema(componentSource) };
};

(async () => {
  const { planUnlink, substituteOutsideStrings } = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'componentUnlink.js')).href
  );

  let n = 0;
  const newId = () => `u${++n}`;
  const run = (fixture, opts = {}) =>
    planUnlink({ ...fixture, newId, ...opts });
  const markupOf = (plan) => serializeNodes(plan.nodes);

  // --- substitution, and where it must not reach ---------------------------

  {
    const values = new Map([['title', '"Hi"']]);
    check(
      'a bare reference is substituted',
      substituteOutsideStrings('title + x', values) === '"Hi" + x'
    );
    check(
      'a member of something else is not',
      substituteOutsideStrings('post.title', values) === 'post.title'
    );
    check(
      'a longer name that merely starts the same is not',
      substituteOutsideStrings('titles.length', values) === 'titles.length'
    );
    check(
      'the same word inside a string is left alone',
      substituteOutsideStrings('cond ? "title" : title', values) === 'cond ? "title" : "Hi"',
      substituteOutsideStrings('cond ? "title" : title', values)
    );
    check(
      'and inside a template literal',
      substituteOutsideStrings('`a title ${title}`', values) === '`a title ${"Hi"}`',
      substituteOutsideStrings('`a title ${title}`', values)
    );
  }

  // --- props ----------------------------------------------------------------

  {
    const fixture = setup(
      "---\ninterface Props { title: string; tone?: string; count?: number }\nconst { title, tone = 'plain', count = 3 } = Astro.props;\n---\n<section class={tone}>\n  <h1>{title}</h1>\n  <span>{count}</span>\n</section>\n",
      '<Hero title="Our team" tone="wide" />'
    );
    const plan = run(fixture);
    check('nothing is refused', !plan.problems, JSON.stringify(plan.problems));
    const markup = markupOf(plan);
    check('a string prop becomes the text it rendered', /<h1>Our team<\/h1>/.test(markup), markup);
    check('and an attribute becomes a plain attribute', /class="wide"/.test(markup), markup);
    check('a prop left unset falls back to its default', /<span>\{3\}<\/span>/.test(markup), markup);
    check('the name it came from is gone', !/\btitle\b|\btone\b/.test(markup), markup);
  }

  {
    // A value the PAGE computes stays the page's expression.
    const fixture = setup(
      '---\ninterface Props { title: string }\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n',
      '<Hero title={post.data.title} />'
    );
    const markup = markupOf(run(fixture));
    check('an expression prop arrives as itself', /<h1>\{post\.data\.title\}<\/h1>/.test(markup), markup);
  }

  {
    const fixture = setup(
      '---\ninterface Props { featured?: boolean }\nconst { featured } = Astro.props;\n---\n<div>{featured}</div>\n',
      '<Hero featured />'
    );
    const markup = markupOf(run(fixture));
    check('a bare attribute is the boolean it meant', /\{true\}/.test(markup), markup);
  }

  // --- slots ----------------------------------------------------------------

  {
    const fixture = setup(
      '---\n---\n<section class="card">\n  <slot />\n</section>\n',
      '<Hero><p>Page content</p></Hero>'
    );
    const markup = markupOf(run(fixture));
    check('what the instance wrapped lands in the slot', /<p>Page content<\/p>/.test(markup), markup);
    check('and the slot itself is gone', !/<slot/.test(markup), markup);
  }

  {
    const fixture = setup(
      '---\n---\n<article>\n  <slot name="head" />\n  <slot />\n</article>\n',
      '<Hero><h2 slot="head">Title</h2><p>Body</p></Hero>'
    );
    const markup = markupOf(run(fixture));
    check('a named slot takes the child that named it', /<h2>Title<\/h2>/.test(markup), markup);
    check('and that child drops the attribute naming it', !/slot="head"/.test(markup), markup);
    check('the rest goes to the default slot', /<p>Body<\/p>/.test(markup), markup);
  }

  {
    const fixture = setup(
      '---\n---\n<div><slot>Nothing here yet</slot></div>\n',
      '<Hero />'
    );
    const markup = markupOf(run(fixture));
    check('an unfilled slot keeps its fallback', /Nothing here yet/.test(markup), markup);
  }

  {
    // The caller's expression must survive: it is written in the page's scope,
    // where `title` is the page's own, not the component's prop.
    const fixture = setup(
      "---\ninterface Props { title: string }\nconst { title } = Astro.props;\n---\n<section>\n  <h1>{title}</h1>\n  <slot />\n</section>\n",
      '<Hero title="Ours"><p>{title}</p></Hero>'
    );
    const markup = markupOf(run(fixture));
    check('the component’s own use is resolved', /<h1>Ours<\/h1>/.test(markup), markup);
    check('the caller’s use of the same name is not', /<p>\{title\}<\/p>/.test(markup), markup);
  }

  // --- what comes with it ---------------------------------------------------

  {
    const fixture = setup(
      "---\nimport Button from './Button.astro';\nimport Unused from './Unused.astro';\n---\n<div class=\"wrap\">\n  <Button label=\"Go\" />\n</div>\n",
      '<Hero />'
    );
    const plan = run(fixture);
    const markup = markupOf(plan);
    check('a component inside stays a component', /<Button label="Go" \/>/.test(markup), markup);
    check('and its import comes along', plan.imports.some((i) => i.name === 'Button'));
    check('one it does not use does not', !plan.imports.some((i) => i.name === 'Unused'));
  }

  {
    const fixture = setup(
      '---\n---\n<div class="box">text</div>\n<style>\n  .box { color: red }\n</style>\n',
      '<Hero />'
    );
    const kept = run(fixture);
    check('its styles are counted', kept.styleCount === 1, String(kept.styleCount));
    check('and come along when asked for', /<style>/.test(markupOf(kept)), markupOf(kept));
    const dropped = run(fixture, { keepStyles: false });
    check('and are left behind when not', !/<style>/.test(markupOf(dropped)), markupOf(dropped));
  }

  // --- refusals -------------------------------------------------------------

  {
    const fixture = setup(
      "---\nconst items = ['a', 'b'];\n---\n<ul>{items.map((i) => (<li>{i}</li>))}</ul>\n",
      '<Hero />'
    );
    const plan = run(fixture);
    check(
      'a component whose frontmatter works something out is refused',
      plan.problems?.length === 1,
      JSON.stringify(plan.problems)
    );
    check('and the refusal names it', /items/.test(plan.problems?.[0] || ''), plan.problems?.[0]);
    check('nothing comes back to inline', !plan.nodes);
  }

  {
    const fixture = setup(
      '---\ninterface Props { title: string }\nconst { title } = Astro.props;\n---\n<h1>{title}</h1>\n',
      '<Hero {...rest} />'
    );
    const plan = run(fixture);
    check('an instance called with a spread is refused', !!plan.problems?.length, JSON.stringify(plan.problems));
  }

  {
    const fixture = setup(
      "---\nconst Tag = 'section';\n---\n<Tag class=\"box\">text</Tag>\n",
      '<Hero />'
    );
    const plan = run(fixture);
    check(
      'so is one built on a dynamic tag',
      /Tag/.test(plan.problems?.[0] || ''),
      JSON.stringify(plan.problems)
    );
  }

  {
    const fixture = setup(
      '---\n---\n<div data-x={Astro.props.x}>hi</div>\n',
      '<Hero x="1" />'
    );
    const plan = run(fixture);
    check(
      'and one reading Astro.props directly',
      /Astro\.props/.test(plan.problems?.[0] || ''),
      JSON.stringify(plan.problems)
    );
  }

  // --- the nodes are the page's now -----------------------------------------

  {
    const fixture = setup('---\n---\n<div class="a"><span>x</span></div>\n', '<Hero />');
    const plan = run(fixture);
    const ids = [];
    (function walk(list) {
      for (const node of list) {
        ids.push(node.id);
        if (Array.isArray(node.children)) walk(node.children);
      }
    })(plan.nodes);
    check('every node arrives with an id of its own', new Set(ids).size === ids.length, ids.join(','));
    check(
      'none of them the id it had in the component file',
      ids.every((id) => /^u\d+$/.test(id)),
      ids.join(',')
    );
  }

  if (failures.length) {
    console.error(`unlink-component: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`unlink-component: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
