import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  localDate,
  toFinite,
  parseUsageEnvelope,
  parseBalance,
  usageStats,
  maskToken,
  internals,
  UsageAuthError
} from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'usage-cost.json'), 'utf8'))

test('localDate formats YYYY-MM-DD', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('toFinite coerces string numbers and rejects junk', () => {
  assert.equal(toFinite('0.0352'), 0.0352)
  assert.equal(toFinite(42), 42)
  assert.ok(Number.isNaN(toFinite('abc')))
  assert.ok(Number.isNaN(toFinite(null)))
})

test('parseUsageEnvelope sums per-day costs across models', () => {
  const map = parseUsageEnvelope(fixture)
  assert.equal(map.size, 3)
  assert.ok(Math.abs(map.get('2026-08-16') - 0.4764) < 1e-9)
  assert.equal(map.get('2026-08-17'), 0.1234)
  assert.equal(map.get('2026-08-18'), 0.005)
})

test('parseUsageEnvelope accepts biz_data as a one-element array', () => {
  const map = parseUsageEnvelope({
    code: 0,
    data: { biz_code: 0, biz_data: [fixture.data.biz_data] }
  })
  assert.equal(map.size, 3)
})

test('parseUsageEnvelope throws UsageAuthError on expired-session codes', () => {
  for (const code of [40002, 40003]) {
    assert.throws(
      () => parseUsageEnvelope({ code, data: { biz_code: code } }),
      (error) => error instanceof UsageAuthError && error.message.includes('已过期')
    )
  }
})

test('parseUsageEnvelope throws on non-zero envelope codes', () => {
  assert.throws(() => parseUsageEnvelope({ code: 1 }), /code 1/)
})

test('parseUsageEnvelope tolerates unknown shapes with an empty map', () => {
  assert.equal(parseUsageEnvelope({ code: 0, data: { biz_code: 0, biz_data: { nope: 1 } } }).size, 0)
  assert.throws(() => parseUsageEnvelope(null), /无法解析/)
  assert.throws(() => parseUsageEnvelope('junk'), /无法解析/)
})

test('usageStats computes month / avg / yesterday / today', () => {
  const map = parseUsageEnvelope(fixture)
  // Fixed "now": 2026-08-18 noon, local time.
  const now = new Date(2026, 7, 18, 12, 0, 0)
  const stats = usageStats(map, now)
  assert.ok(Math.abs(stats.month - 0.6048) < 1e-9)
  assert.ok(Math.abs(stats.monthAvg - 0.6048 / 18) < 1e-9)
  assert.equal(stats.yesterday, 0.1234)
  assert.equal(stats.today, 0.005)
  assert.equal(stats.currency, 'CNY')
})

test('usageStats treats missing rows as zero', () => {
  const stats = usageStats(new Map([['2026-08-01', 3]]), new Date(2026, 7, 18, 9, 0, 0))
  assert.equal(stats.month, 3)
  assert.equal(stats.yesterday, 0)
  assert.equal(stats.today, 0)
})

test('parseBalance normalizes the provider payload', () => {
  const body = {
    is_available: true,
    balance_infos: [{
      currency: 'USD',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00'
    }]
  }
  assert.deepEqual(parseBalance(body), {
    total: '110.00',
    currency: 'USD',
    granted: '10.00',
    toppedUp: '100.00',
    available: true
  })
  assert.equal(parseBalance({ is_available: false, balance_infos: [] }).available, false)
  assert.equal(parseBalance(null).total, null)
})

test('maskToken hides the middle of the token', () => {
  assert.equal(maskToken('abcdefghijklmnop'), 'abcd…mnop')
  assert.equal(maskToken('short'), 'sh…')
  assert.equal(maskToken(''), '')
})

test('state roundtrip persists and clears the userToken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-blance-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    // State paths resolve at call time, so redirecting DSH_HOME is enough.
    const saved = internals.writeState({ userToken: 'test-token-value', updatedAt: Date.now() })
    assert.ok(saved)
    assert.ok(existsSync(join(dir, 'storages', 'dsh-usage-blance.json')))
    assert.equal(internals.readState().userToken, 'test-token-value')

    // An empty token reads as "not configured" (clear semantics).
    internals.writeState({ userToken: '' })
    assert.equal(internals.readState(), null)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})
