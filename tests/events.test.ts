import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayStore } from '../apps/relay-server/store.js';

test('event retention detects actual loss without treating another session cursor as a gap', () => {
  const store = new RelayStore(':memory:');
  try {
    const old = store.event({ session_id: 's1', turn_id: 'turn', type: 'text', data: { text: 'old' } });
    for (let i = 0; i < 20; i++) store.event({ session_id: 's2', turn_id: 'other', type: 'text', data: { text: 'other' } });
    store.event({ session_id: 's1', turn_id: 'turn', type: 'completed', data: {} });
    assert.equal(store.events('s1', old.cursor).length, 1);
    for (let i = 0; i < 300; i++) store.event({ session_id: 's1', turn_id: 'later', type: 'text', data: { text: String(i) } });
    assert.throws(() => store.events('s1', old.cursor), { code: 'CURSOR_EXPIRED' });
    assert.equal(store.events('s1', 0).length, 256);
    assert.equal(store.events('s2', 0).length, 20);
  } finally { store.close(); }
});
