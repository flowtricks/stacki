// Goal: the demo previews a prop's options on hover with no Astro and no server. The
// frame's stand-in hands the dev server's variant request to the demo window, which
// renders the page once as it is (the baseline a cancel restores) and once per option
// from a copy of the file's text with that one attribute set — a copy that is never
// stored. A cancel stops the work between two renders, the option the pointer rests
// on is rendered next, and a request the protocol refuses renders nothing.
// Method: DemoVariants is driven with the messages staticHot.ts sends, over a page
// with a Heading instance; its renderer is a stand-in that records the text it was
// asked to render, so each case reads exactly which texts were rendered and which
// renders were posted back to the frame, in order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAKE_MESSAGES } from '../src/features/bake/bakeProtocol';
import { flatten, parsePage } from '../src/features/source/source';
import { DemoVariants, variantAttr, variantText } from '../demo/variantRender';

const PAGE = `---
import Heading from "../components/typography/Heading.astro";
---
<main>
  <Heading variant="h2">Welcome</Heading>
</main>
`;
const FILE = 'src/pages/index.astro';

function headingId(): string {
  const parsed = parsePage(PAGE);
  assert.ok(parsed.editable, 'the page parses');
  const heading = flatten(parsed.model.nodes).find((node) => node.name === 'Heading');
  assert.ok(heading?.id, 'the page has a Heading instance');
  return heading.id;
}

function request(values: readonly (string | number | null)[], id = 'r1') {
  return {
    type: BAKE_MESSAGES.variantRequest,
    data: {
      request: id,
      path: '/',
      file: FILE,
      node: headingId(),
      component: 'src/components/typography/Heading.astro',
      source: PAGE,
      prop: 'variant',
      values,
    },
  };
}

// A demo window: the texts it rendered, the messages it posted, and a way to wait for both.
function harness() {
  const rendered: (string | undefined)[] = [];
  const posted: Record<string, unknown>[] = [];
  const variants = new DemoVariants('https://stacki.build', async (path, change) => {
    assert.equal(path, '/');
    rendered.push(change?.text);
    return change === undefined ? '<html>baseline</html>' : `<html>${change.text.length}</html>`;
  });
  const frame = {
    postMessage: (message: Record<string, unknown>) => posted.push(message),
  } as unknown as MessageEventSource;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  // Until `count` renders are recorded: a fixed pause is too short on a slow runner
  // (GitHub's Windows runner rendered two of three in 20 ms). Bounded at 5 seconds.
  const rendersReach = async (count: number) => {
    for (let attempt = 0; attempt < 250 && rendered.length < count; attempt += 1) {
      await settle();
    }
  };
  return { rendered, posted, variants, frame, settle, rendersReach };
}

test('an option is written into a copy of the text as the attribute an instance carries', () => {
  assert.deepEqual(variantAttr('h1'), { type: 'string', value: 'h1' });
  assert.deepEqual(variantAttr(3), { type: 'expr', value: '3' });
  assert.equal(variantAttr(null), undefined);
  const id = headingId();
  assert.match(variantText({ source: PAGE, node: id, prop: 'variant' }, 'display'), /<Heading variant="display">Welcome<\/Heading>/);
  assert.match(variantText({ source: PAGE, node: id, prop: 'variant' }, null), /<Heading\s*>Welcome<\/Heading>/, 'unset removes it');
});

test('a request renders the baseline first, then every option, and posts each back', async () => {
  const { rendered, posted, variants, frame, settle, rendersReach } = harness();
  assert.equal(variants.receive(frame, request(['h1', 'display'])), true);
  await rendersReach(3);
  await settle();
  assert.equal(rendered[0], undefined, 'the page as it is comes first');
  assert.equal(rendered.length, 3);
  assert.ok(rendered[1]?.includes('variant="h1"'));
  assert.ok(rendered[2]?.includes('variant="display"'));
  assert.deepEqual(
    posted.map((message) => message['type']),
    [BAKE_MESSAGES.variantRender, BAKE_MESSAGES.variantRender, BAKE_MESSAGES.variantRender],
  );
  const renders = posted.map((message) => message['render'] as Record<string, unknown>);
  assert.equal('value' in (renders[0] ?? {}), false, 'the baseline carries no value');
  assert.deepEqual(
    renders.slice(1).map((render) => render['value']),
    ['h1', 'display'],
  );
  assert.ok(renders.every((render) => render['request'] === 'r1'));
});

test('the hovered option is rendered next, and a cancel stops the rest', async () => {
  const { rendered, posted, variants, frame, settle } = harness();
  variants.receive(frame, request(['h1', 'h2', 'h3', 'large']));
  variants.receive(frame, { type: BAKE_MESSAGES.variantPriority, request: 'r1', value: 'large' });
  await settle();
  assert.ok(rendered[1]?.includes('variant="large"'), 'the option under the pointer goes first');
  const cancelled = harness();
  cancelled.variants.receive(cancelled.frame, request(['h1', 'h2', 'h3']));
  cancelled.variants.receive(cancelled.frame, { type: BAKE_MESSAGES.variantCancel });
  await cancelled.settle();
  assert.ok(cancelled.rendered.length <= 1, 'nothing past the baseline is rendered after a cancel');
  assert.deepEqual(cancelled.posted, [], 'and nothing is posted to a frame that stopped asking');
  assert.ok(posted.length > 0);
});

test('a newer request replaces the older, and a refused one renders nothing', async () => {
  const { rendered, posted, variants, frame, settle } = harness();
  variants.receive(frame, request(['h1', 'h2', 'h3'], 'old'));
  variants.receive(frame, request(['display'], 'new'));
  await settle();
  const requests = posted.map((message) => (message['render'] as Record<string, unknown>)['request']);
  assert.ok(
    requests.every((id) => id === 'new'),
    'the older request posts nothing once replaced',
  );
  const refused = harness();
  assert.equal(refused.variants.receive(refused.frame, { ...request(['h1']), data: { ...request(['h1']).data, prop: '__proto__' } }), true);
  assert.equal(refused.variants.receive(refused.frame, { type: 'studio:bake-render' }), false, 'other messages pass through');
  await refused.settle();
  assert.deepEqual(refused.rendered, []);
  assert.deepEqual(refused.posted, []);
  assert.ok(rendered.length >= 2);
});
