/**
 * Probe 3: validate the by_api_key/cost endpoint with Beijing windows.
 * Expected: today(Beijing) = UTC row[18] + morning portion of row[17];
 *           yesterday(Beijing) = UTC row[17] − that morning portion + …
 * Prints sanitized aggregates only — never the token.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const state = JSON.parse(readFileSync(join(home, 'storages', 'dsh-usage-blance.json'), 'utf8'))
const token = state.userToken
if (!token) {
  console.error('no userToken saved')
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'x-app-version': '1.0.0',
  Origin: 'https://platform.deepseek.com',
  Referer: 'https://platform.deepseek.com/usage'
}
const BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const BJ_TZ = 28800

function beijingStartOfDay(d) {
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000)
  const utcDayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / 1000
  return utcDayStart - 8 * 3600
}

async function query(label, start, end) {
  const url = `${BASE}?start=${start}&end=${end}&tz=${BJ_TZ}`
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
    const body = await res.json()
    const biz = body?.data?.biz_data
    let total = 0
    let bucketCount = 0
    let currencies = []
    let bucketSize = biz?.bucket ?? null
    for (const entry of Array.isArray(biz?.data) ? biz.data : []) {
      currencies.push(entry.currency)
      for (const s of Array.isArray(entry.series) ? entry.series : []) {
        for (const b of Array.isArray(s.buckets) ? s.buckets : []) {
          const v = Number(b.cost)
          if (Number.isFinite(v)) {
            total += v
            bucketCount++
          }
        }
      }
    }
    console.log(`${label}: HTTP ${res.status} | bucket_size=${bucketSize} | buckets=${bucketCount} | currencies=${[...new Set(currencies)]} | total=${Math.round(total * 1e6) / 1e6}`)
    // first/last bucket times (sanitized)
    let first = null
    let last = null
    for (const entry of Array.isArray(biz?.data) ? biz.data : []) {
      for (const s of Array.isArray(entry.series) ? entry.series : []) {
        if (Array.isArray(s.buckets) && s.buckets.length > 0) {
          const t0 = s.buckets[0].time
          const t1 = s.buckets[s.buckets.length - 1].time
          if (first === null || t0 < first) first = t0
          if (last === null || t1 > last) last = t1
        }
      }
    }
    if (first !== null) {
      console.log(`   window buckets: ${new Date(first * 1000).toISOString()} .. ${new Date(last * 1000).toISOString()}`)
    }
    return total
  } catch (error) {
    console.log(`${label}: FAILED ${String(error)}`)
    return null
  }
}

const now = new Date()
const nowSec = Math.floor(now.getTime() / 1000)
const todayStart = beijingStartOfDay(now)
const yesterdayStart = todayStart - 86400
const monthStart = beijingStartOfDay(new Date(now.getFullYear(), now.getMonth(), 1))

console.log('now:', now.toString(), '| local tz offset (sec):', -now.getTimezoneOffset() * 60)

const today = await query('today   (Beijing window)', todayStart, nowSec)
const yesterday = await query('yesterday (Beijing window)', yesterdayStart, todayStart - 1)
const month = await query('month   (Beijing window)', monthStart, nowSec)

// Month day-rows (UTC) for reference
const refUrl = `https://platform.deepseek.com/api/v0/usage/cost?month=${now.getMonth() + 1}&year=${now.getFullYear()}`
const refRes = await fetch(refUrl, { headers, signal: AbortSignal.timeout(25_000) })
const refBody = await refRes.json()
const refBiz = Array.isArray(refBody.data.biz_data) ? refBody.data.biz_data[0] : refBody.data.biz_data
const refDays = {}
for (const d of refBiz.days) {
  let s = 0
  for (const m of Array.isArray(d.data) ? d.data : []) {
    for (const u of Array.isArray(m.usage) ? m.usage : []) {
      const v = Number(u.cost ?? u.amount)
      if (Number.isFinite(v)) s += v
    }
  }
  refDays[d.date] = Math.round(s * 1e6) / 1e6
}
const pad = (n) => String(n).padStart(2, '0')
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
console.log('\nUTC day rows:', JSON.stringify(refDays, null, 2))
console.log('\ncomparison:')
console.log(`  UTC row today (${local(now)}): ${refDays[local(now)]}`)
console.log(`  Beijing today: ${today}`)
console.log(`  UTC row yesterday: ${refDays[local(new Date(now.getTime() - 86400000))]}`)
console.log(`  Beijing yesterday: ${yesterday}`)
console.log(`  Beijing month: ${month} | sum of UTC rows: ${Math.round(Object.values(refDays).reduce((a, b) => a + b, 0) * 1e6) / 1e6}`)
