/** Probe 5: frontend-exact windows (end = next midnight, full days). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const state = JSON.parse(readFileSync(join(home, 'storages', 'dsh-usage-blance.json'), 'utf8'))
const token = state.userToken
if (!token) { console.error('no token'); process.exit(1) }

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'x-app-version': '1.0.0',
  Origin: 'https://platform.deepseek.com',
  Referer: 'https://platform.deepseek.com/usage'
}
const BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'

// hV/hU port: epoch sec of Beijing local midnight, frontend style.
function hU(parts, tzSec) {
  const { year, month, day = 1 } = parts
  return Date.UTC(year, month, day) / 1000 - tzSec
}
function bjDaySec(utcDateLike, tzSec = 28800) {
  const shifted = new Date(utcDateLike.getTime() + tzSec * 1000)
  return hU({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() }, tzSec)
}

async function query(label, start, end, tz) {
  const url = `${BASE}?start=${start}&end=${end}&tz=${tz}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
  const body = await res.json()
  const biz = body?.data?.biz_data
  let total = 0
  let buckets = 0
  let currencies = new Set()
  let first = null
  let last = null
  for (const entry of Array.isArray(biz?.data) ? biz.data : []) {
    currencies.add(entry.currency)
    for (const s of Array.isArray(entry.series) ? entry.series : []) {
      for (const b of Array.isArray(s.buckets) ? s.buckets : []) {
        const v = Number(b.cost)
        if (Number.isFinite(v)) {
          total += v
          buckets++
          if (first === null || b.time < first) first = b.time
          if (last === null || b.time > last) last = b.time
        }
      }
    }
  }
  const range = first !== null ? `${new Date(first * 1000).toISOString()} .. ${new Date(last * 1000).toISOString()}` : 'none'
  console.log(`${label}: HTTP ${res.status} | biz_code=${body?.data?.biz_code} | bucket_size=${biz?.bucket ?? '?'} | buckets=${buckets} | currencies=${[...currencies]} | total=${Math.round(total * 1e6) / 1e6}`)
  console.log(`   bucket window: ${range}`)
  return total
}

const now = new Date()
const todayStart = bjDaySec(now)
const yesterdayStart = todayStart - 86400
const monthStart = bjDaySec(new Date(now.getFullYear(), now.getMonth(), 1))
const pad = (n) => String(n).padStart(2, '0')
const loc = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

console.log('todayStart(BJ):', new Date(todayStart * 1000).toISOString(), '=', loc(now), '00:00+08')

console.log('\n-- frontend-exact windows (end = next midnight) --')
const today = await query('today     ', todayStart, todayStart + 86400, 28800)
const yesterday = await query('yesterday ', yesterdayStart, todayStart, 28800)
const month = await query('thisMonth ', monthStart, todayStart + 86400, 28800)

console.log('\n-- sanity: yesterday with tz=0 (UTC window) --')
await query('yest tz=0 ', todayStart - 2 * 86400, todayStart - 86400, 0)

console.log('\nsummary: today=', today, 'yesterday=', yesterday, 'month=', month)
