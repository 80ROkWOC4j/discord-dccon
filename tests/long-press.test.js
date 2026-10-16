const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createPickerUI} = require('../src/core/ui/picker.ts');
function fixture(t) {
  t.mock.timers.enable({apis: ['setTimeout']});
  const calls = [];
  const react = {Component: class {
    constructor(props) {this.props = props;}
    setState(value) {Object.assign(this.state, value);}
  }, createElement: (type, props, ...children) => ({type, props, children})};
  const {DCConItem} = createPickerUI({react}, {
    settings: {loadData: (_, fallback) => fallback}, packs: {}, images: {}, embedding: {}, media: {},
    events: {subscribe() {}, unsubscribe() {}},
    sending: {sendDCConMessage: async (con, options) => {calls.push({con, ...options});}},
  });
  const item = new DCConItem({con: {path: 'test', title: 'test'}, packageIdx: 'pack'});
  const button = item.render().children[0].props;
  const pointer = (extra = {}) => ({pointerType: 'touch', isPrimary: true, button: 0, pointerId: 1, clientX: 20, clientY: 20, ...extra});
  const event = () => ({shiftKey: false, prevented: false, stopped: false, preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}});
  const tick = async milliseconds => {t.mock.timers.tick(milliseconds); await Promise.resolve();};
  return {item, button, calls, pointer, event, tick};
}

test('touch hold queues exactly once and release never falls through to immediate sending', async t => {
  const {button, calls, pointer, event, tick} = fixture(t);
  button.onPointerDown(pointer());
  await tick(449); assert.equal(calls.length, 0);
  await tick(1); assert.equal(calls.length, 1); assert.equal(calls[0].keepOpen, true);
  const menu = event(); button.onContextMenu(menu);
  assert.equal(menu.prevented, true); assert.equal(menu.stopped, true);
  await tick(1000); assert.equal(calls.length, 1);
  button.onPointerUp(pointer());
  const click = event(); button.onClick(click);
  assert.equal(click.prevented, true); assert.equal(calls.length, 1);
  button.onPointerDown(pointer()); button.onPointerUp(pointer()); button.onClick(event());
  await tick(500); assert.equal(calls.length, 2); assert.equal(calls[1].keepOpen, false);
});

test('native touch contextmenu can complete a hold before the timer without a duplicate queue entry', async t => {
  const {button, calls, pointer, event, tick} = fixture(t);
  button.onPointerDown(pointer());
  await tick(300);
  const menu = event(); button.onContextMenu(menu);
  await tick(500); button.onPointerUp(pointer()); button.onClick(event());
  assert.equal(menu.prevented, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].keepOpen, true);
});

for (const reason of ['move', 'cancel', 'leave', 'unmount']) test(`touch ${reason} cancels a pending hold`, async t => {
  const {item, button, calls, pointer, event, tick} = fixture(t);
  button.onPointerDown(pointer());
  await tick(200);
  if (reason === 'move') button.onPointerMove(pointer({clientX: 31}));
  if (reason === 'cancel') button.onPointerCancel(pointer());
  if (reason === 'leave') button.onPointerLeave(pointer());
  if (reason === 'unmount') item.componentWillUnmount();
  await tick(1000);
  if (reason !== 'unmount') {
    const menu = event(); button.onContextMenu(menu); assert.equal(menu.prevented, true);
    button.onPointerUp(pointer()); button.onClick(event());
  }
  assert.equal(calls.length, 0);
});

test('short taps, desktop Shift clicks and keyboard activation retain their existing behavior', async t => {
  const {button, calls, pointer, event, tick} = fixture(t);
  button.onPointerDown(pointer()); await tick(100); button.onPointerUp(pointer()); button.onClick(event());
  await tick(500); assert.equal(calls.length, 1); assert.equal(calls[0].keepOpen, false);
  button.onPointerDown(pointer({pointerType: 'mouse'})); await tick(1000);
  const menu = event(); button.onContextMenu(menu); assert.equal(menu.prevented, false);
  button.onClick({...event(), shiftKey: true}); await tick(0);
  assert.equal(calls.length, 2); assert.equal(calls[1].keepOpen, true);
  button.onPointerDown(pointer()); button.onPointerCancel(pointer());
  button.onKeyDown(); button.onClick(event()); await tick(0);
  assert.equal(calls.length, 3); assert.equal(calls[2].keepOpen, false);
});

test('minor finger jitter is allowed; secondary touches and disabled tiles cannot start a hold', async t => {
  const {item, button, calls, pointer, tick} = fixture(t);
  button.onPointerDown(pointer()); button.onPointerMove(pointer({clientX: 25, clientY: 23}));
  await tick(450); assert.equal(calls.length, 1);
  button.onPointerUp(pointer());
  button.onPointerDown(pointer({isPrimary: false})); await tick(500); assert.equal(calls.length, 1);
  item.state.busy = true; button.onPointerDown(pointer()); await tick(500); assert.equal(calls.length, 1);
  item.state.busy = false; item.state.error = true;
  button.onPointerDown(pointer()); await tick(500); assert.equal(calls.length, 1);
});

test('a second finger on the same tile cancels the hold without becoming a normal click', async t => {
  const {button, calls, pointer, event, tick} = fixture(t);
  button.onPointerDown(pointer()); await tick(200);
  button.onPointerDown(pointer({isPrimary: false, pointerId: 2}));
  await tick(500); button.onPointerUp(pointer()); button.onClick(event());
  assert.equal(calls.length, 0);
});
