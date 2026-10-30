const test = require('node:test')
const assert = require('node:assert/strict')
const { safeFileName, generatePairingCode, formatDeviceName } = require('../dist-electron/electron/core/util.js')

test('safeFileName removes Windows reserved path characters', () => {
  assert.equal(safeFileName('a:b?.txt'), 'a_b_.txt')
  assert.equal(safeFileName('../'), '_')
  assert.equal(safeFileName('  '), 'unnamed')
})

test('pairing code is six digits', () => {
  assert.match(generatePairingCode(), /^\d{6}$/)
})

test('device name is trimmed and bounded', () => {
  assert.equal(formatDeviceName('  PC A  '), 'PC A')
  assert.equal(formatDeviceName(''), '未命名设备')
  assert.equal(formatDeviceName('A'.repeat(100)).length, 60)
})
