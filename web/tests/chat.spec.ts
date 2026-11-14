import { join } from 'node:path';
import { expect, test, type Route } from '@playwright/test';

/**
 * The chat, against a stand-in for Anthropic's API: the first answer calls a tool, which the page
 * runs on the model in its worker; the second links the object the tool found.
 */

const EQ = join(import.meta.dirname, 'fixtures', 'small_EQ.xml');
const KEY = 'sk-ant-test';

type Event = { type: string } & Record<string, unknown>;
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

const sse = (events: Event[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A streamed Messages API answer of these blocks. */
function message(content: Block[], stop: string) {
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } };
  const blocks = content.flatMap((b, index): Event[] => [
    { type: 'content_block_start', index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } },
    {
      type: 'content_block_delta',
      index,
      delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
    },
    { type: 'content_block_stop', index },
  ]);
  return sse([start, ...blocks, { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]);
}

// Requests through the PWA's service worker pass WebKit's routes by.
test.use({ serviceWorkers: 'block' });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

test('answers with the model, by its tools, and links what it found', async ({ page }) => {
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const keys: (string | null)[] = [];
  await page.route('https://api.anthropic.com/**', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON();
    bodies.push(body);
    keys.push(await request.headerValue('x-api-key'));
    const results = JSON.stringify(body.messages);
    const id = /"id\\?":\\?"([^"\\]+)/.exec(results.slice(results.indexOf('tool_result')))?.[1];
    const reply =
      bodies.length === 1
        ? message([{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'Line 1' } }], 'tool_use')
        : message([{ type: 'text', text: `It is [Line 1](#object:${id}).` }], 'end_turn');
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: reply });
  });

  await page.goto('./');
  await page.getByLabel('Choose files').setInputFiles(EQ);
  await page.getByTestId('chat-toggle').click();
  const chat = page.getByTestId('chat-panel');
  await expect(chat.getByTestId('chat-notice')).toContainText('Nothing is sent until you ask');

  await chat.getByTestId('chat-key').fill(KEY);
  await chat.getByRole('button', { name: 'Done' }).click();
  await chat.getByTestId('chat-input').fill('Where is Line 1?');
  await chat.getByTestId('chat-input').press('Enter');

  await expect(chat.getByText('Searched the model')).toBeVisible();
  const link = chat.getByRole('link', { name: 'Line 1' });
  await expect(link).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(keys).toEqual([KEY, KEY]);
  // The second request carries what the tool found in the model.
  expect(JSON.stringify(bodies[1].messages)).toContain('Line 1');

  await link.click();
  await expect(page.getByRole('link', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('inspector')).toContainText('Line 1');
});

test('sends nothing until asked', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith('http://localhost')) sent.push(r.url());
  });
  await page.goto('./');
  await page.getByLabel('Choose files').setInputFiles(EQ);
  await page.getByTestId('chat-toggle').click();
  await page.getByTestId('chat-key').fill(KEY);
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  expect(sent).toEqual([]);
});

/** Answers each request to the stand-in API in turn, by `reply(n)`, n from 1, after `delay(n)` ms. */
async function standIn(page: import('@playwright/test').Page, reply: (n: number) => string, delay: (n: number) => number = () => 0) {
  let n = 0;
  await page.route('https://api.anthropic.com/**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    n += 1;
    const at = n;
    await new Promise((done) => setTimeout(done, delay(at)));
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: reply(at) });
  });
}

async function askAbout(page: import('@playwright/test').Page, question: string) {
  await page.goto('./');
  await page.getByLabel('Choose files').setInputFiles(EQ);
  await page.getByTestId('chat-toggle').click();
  const chat = page.getByTestId('chat-panel');
  await chat.getByTestId('chat-key').fill(KEY);
  await chat.getByRole('button', { name: 'Done' }).click();
  await chat.getByTestId('chat-input').fill(question);
  await chat.getByTestId('chat-input').press('Enter');
  return chat;
}

test('says what it waits for while the model is slow after a tool', async ({ page }) => {
  await standIn(
    page,
    (n) =>
      n === 1
        ? message([{ type: 'tool_use', id: 'toolu_1', name: 'validation', input: {} }], 'tool_use')
        : message([{ type: 'text', text: 'Nothing is broken.' }], 'end_turn'),
    (n) => (n === 2 ? 4500 : 0),
  );
  const chat = await askAbout(page, 'What does the validation say?');
  await expect(chat.getByText('Read the validation')).toBeVisible();
  // The model has the tool's result, and has not answered yet: the panel says so, and for how long.
  await expect(chat.getByTestId('chat-status')).toContainText(/Waiting for the model… \d+ s/);
  await expect(chat.getByText('Nothing is broken.')).toBeVisible();
  await expect(chat.getByTestId('chat-status')).toHaveCount(0);
});

test('says when it ran out of steps without an answer', async ({ page }) => {
  await standIn(page, (n) => message([{ type: 'tool_use', id: `toolu_${n}`, name: 'summary', input: {} }], 'tool_use'));
  const chat = await askAbout(page, 'Tell me everything.');
  await expect(chat.getByTestId('chat-note')).toContainText('stopped after 12 steps without an answer');
  await expect(chat.getByTestId('chat-status')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Send' })).toBeVisible();
});

test('a stopped turn leaves no tool running', async ({ page }) => {
  await standIn(
    page,
    (n) =>
      n === 1
        ? message([{ type: 'tool_use', id: 'toolu_1', name: 'summary', input: {} }], 'tool_use')
        : message([{ type: 'text', text: 'Too late.' }], 'end_turn'),
    (n) => (n === 2 ? 30_000 : 0),
  );
  const chat = await askAbout(page, 'Summarise the model.');
  // The tool done, and the model not yet answering: stopped then.
  await expect(chat.getByText('Read the summary', { exact: true })).toBeVisible();
  await expect(chat.getByTestId('chat-status')).toContainText('Waiting for the model');
  await chat.getByRole('button', { name: 'Stop' }).click();
  await expect(chat.getByRole('alert')).toHaveText('Stopped.');
  await expect(chat.getByText('Read the summary', { exact: true })).toBeVisible();
  await expect(chat.getByTestId('chat-status')).toHaveCount(0);
});

test('the chat is as wide as dragged or keyed, and stays so', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel('Choose files').setInputFiles(EQ);
  await page.getByTestId('chat-toggle').click();
  const panel = page.getByTestId('chat-panel');
  const edge = page.getByRole('separator', { name: 'Width of the chat' });
  const before = (await panel.boundingBox())!.width;
  const at = (await edge.boundingBox())!;
  // Its edge is on the left: dragged left, it widens.
  await page.mouse.move(at.x + at.width / 2, at.y + 200);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 - 150, at.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 130);
  const dragged = Number(await edge.getAttribute('aria-valuenow'));
  await edge.focus();
  await page.keyboard.press('ArrowRight');
  await expect(edge).toHaveAttribute('aria-valuenow', String(dragged - 16));
  await page.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', '280');
  // After a reload, where the browser keeps the files and so shows the model, and the chat, again.
  if (await page.getByTestId('kept').isVisible()) {
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Width of the chat' })).toHaveAttribute('aria-valuenow', '280');
  }
});
