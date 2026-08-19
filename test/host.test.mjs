import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  toFinite,
  parseUsageBuckets,
  parseBalance,
  usageStats,
  beijingDayStartSec,
  beijingMonthStartSec,
  beijingDayOfMonth,
  maskToken,
  sanitizePrefs,
  internals,
  UsageAuthError
} from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'usage-cost-buckets.json'), 'utf8'))

// Fixture epoch seconds (Beijing 00:00 of 08-01 / 08-17 / 08-18 in 2026).
const BJ_AUG_01 = 1785513600
const BJ_AUG_17 = 1786896000
const BJ_AUG_18 = 1786982400

// Fixed "now": 2026-08-18 12:00 Beijing (04:00 UTC).
const NOW = new Date('2026-08-18T04:00:00Z')

test('toFinite coerces string numbers and rejects junk', () => {
  assert.equal(toFinite('0.0352'), 0.0352)
  assert.equal(toFinite(42), 42)
  assert.ok(Number.isNaN(toFinite('abc')))
  assert.ok(Number.isNaN(toFinite(null)))
})

test('beijing calendar helpers pin the UTC+8 day/month boundaries', () => {
  // 08-17 23:59:59 Beijing is still the 17th.
  assert.equal(beijingDayStartSec(new Date('2026-08-17T15:59:59Z')), BJ_AUG_17)
  // 08-18 00:00 Beijing = 08-17 16:00 UTC.
  assert.equal(beijingDayStartSec(new Date('2026-08-17T16:00:00Z')), BJ_AUG_18)
  assert.equal(beijingDayStartSec(NOW), BJ_AUG_18)
  // Month start: 08-01 00:00 Beijing = 07-31 16:00 UTC.
  assert.equal(beijingMonthStartSec(NOW), BJ_AUG_01)
  // Beijing day-of-month: 08-01 00:00 Beijing counts as the 1st.
  assert.equal(beijingDayOfMonth(new Date('2026-07-31T16:00:00Z')), 1)
  assert.equal(beijingDayOfMonth(NOW), 18)
})

test('parseUsageBuckets sums bucket costs keyed by time', () => {
  const map = parseUsageBuckets(fixture)
  assert.equal(map.size, 5)
  assert.equal(map.get(BJ_AUG_01), 1.2)
  assert.equal(map.get(BJ_AUG_17), 0.5)
  assert.equal(map.get(BJ_AUG_17 + 3600), 0.25)
  assert.equal(map.get(BJ_AUG_18), 0.4)
  assert.equal(map.get(BJ_AUG_18 + 3600), 0.6)
})

test('parseUsageBuckets merges duplicate bucket times', () => {
  const body = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        data: [
          {
            currency: 'CNY',
            series: [
              { buckets: [{ time: BJ_AUG_18, cost: 0.5 }] },
              { buckets: [{ time: BJ_AUG_18, cost: 0.5 }] }
            ]
          }
        ]
      }
    }
  }
  assert.equal(parseUsageBuckets(body).get(BJ_AUG_18), 1)
})

test('parseUsageBuckets throws UsageAuthError on expired-session codes', () => {
  for (const code of [40002, 40003]) {
    assert.throws(
      () => parseUsageBuckets({ code, data: { biz_code: code } }),
      (error) => error instanceof UsageAuthError && error.message.includes('已过期')
    )
  }
})

test('parseUsageBuckets throws on non-zero envelope codes', () => {
  assert.throws(() => parseUsageBuckets({ code: 1 }), /code 1/)
  assert.throws(() => parseUsageBuckets({ code: 0, data: { biz_code: 1 } }), /INVALID_PARAM|code 1/)
})

test('parseUsageBuckets tolerates unknown shapes', () => {
  assert.equal(parseUsageBuckets({ code: 0, data: { biz_code: 0, biz_data: { nope: 1 } } }).size, 0)
  assert.throws(() => parseUsageBuckets(null), /无法解析/)
  assert.throws(() => parseUsageBuckets('junk'), /无法解析/)
})

test('usageStats computes Beijing-bucketed month / avg / yesterday / today', () => {
  const map = parseUsageBuckets(fixture)
  const stats = usageStats(map, NOW)
  assert.ok(Math.abs(stats.month - 2.95) < 1e-9)
  assert.ok(Math.abs(stats.monthAvg - 0.163889) < 1e-6)
  assert.equal(stats.yesterday, 0.75)
  assert.equal(stats.today, 1)
  assert.equal(stats.currency, 'CNY')
})

test('usageStats puts a bucket exactly at Beijing midnight into its own day', () => {
  const map = new Map([
    [BJ_AUG_17, 5], // yesterday 00:00
    [BJ_AUG_18, 7], // today 00:00
    [BJ_AUG_18 + 86399, 1] // today 23:59:59 — still today
  ])
  const stats = usageStats(map, NOW)
  assert.equal(stats.yesterday, 5)
  assert.equal(stats.today, 8)
  assert.equal(stats.month, 13)
})

test('usageStats treats missing data as zero', () => {
  const stats = usageStats(new Map(), NOW)
  assert.equal(stats.month, 0)
  assert.equal(stats.monthAvg, 0)
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

    // An empty token reads as "not configured" (clear semantics) while the
    // state object itself survives (it may still hold UI prefs).
    internals.writeState({ userToken: '' })
    assert.deepEqual(internals.readState(), { userToken: '' })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sanitizePrefs keeps known keys in bounds and drops junk', () => {
  assert.deepEqual(sanitizePrefs({
    position: 'below',
    balanceAlert: 200,
    glass: { enabled: false, opacity: 5, blur: 99, saturate: 3 }
  }), {
    position: 'below',
    balanceAlert: 200,
    glass: { enabled: false, opacity: 20, blur: 32, saturate: 2 }
  })
  assert.deepEqual(sanitizePrefs({ balanceAlert: null }), { balanceAlert: null })
  assert.deepEqual(sanitizePrefs({ junk: 1, position: 'sideways', balanceAlert: -1 }), {})
  assert.deepEqual(sanitizePrefs(null), {})
  assert.deepEqual(sanitizePrefs('junk'), {})
})
