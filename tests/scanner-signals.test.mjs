import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEY_IDS } from '../scanner/scanner-logic.mjs';

const signals = JSON.parse(readFileSync(new URL('../scanner/signals.json', import.meta.url), 'utf8'));
const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
const listed = new Set(data.sectors.flatMap(sector => sector.stocks.map(stock => stock.symbol)));

test('signals.json: valid meta, labelled keys, no stock outside the Shariah list', () => {
  assert.equal(signals.meta.valid, true);
  assert.deepEqual(Object.keys(signals.keys), KEY_IDS);
  assert.ok(signals.meta.scanned > 0 && signals.meta.scanned <= signals.meta.universe);
  for (const symbol of Object.keys(signals.stocks)) assert.ok(listed.has(symbol), symbol);
});

test('signals.json: score equals the number of 1+ keys and matches bits', () => {
  for (const [symbol, s] of Object.entries(signals.stocks)) {
    const ones = KEY_IDS.filter(id => s.keys[id][0] === 1).length;
    assert.equal(s.score, ones, symbol);
    assert.equal(s.bits, KEY_IDS.map(id => s.keys[id][0]).join(''), symbol);
    assert.ok(s.score >= 0 && s.score <= 6);
  }
});

test('signals.json: the market key is the same for every stock', () => {
  const values = new Set(Object.values(signals.stocks).map(s => s.keys.market[0]));
  assert.equal(values.size, 1);
});
