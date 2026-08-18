/**
 * API probe: figure out how the platform's usage/cost endpoint buckets days
 * (UTC vs Beijing) and whether it accepts tz / start / end params.
 * Prints sanitized response shapes only — never the token.
 *
 *   node scripts/probe-api.mjs
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
const BASE = 'https://platform.deepseek.com/api/v0/usage/cost'

function sumDay(day) {
  let total = 0
  for (const m of Array.isArray(day?.data) ? day.data : []) {
    for (const u of Array.isArray(m?.usage) ? m.usage : []) {
      const v = Number(u?.cost ?? u?.amount)
      if (Number.isFinite(v)) total += v
    }
  }
  return Math.round(total * 1e6) / 1e6
}

function describe(body) {
  const data = body?.data
  const biz = Array.isArray(data?.biz_data) ? data.biz_data[0] : data?.biz_data
  const days = biz?.days
  const desc = {
    code: body?.code,
    biz_code: data?.biz_code,
    biz_keys: biz && typeof biz === 'object' ? Object.keys(biz) : typeof biz,
    total: biz?.total ?? null,
    currency: biz?.currency ?? null,
    day_count: Array.isArray(days) ? days.length : null
  }
  if (Array.isArray(days) && days.length > 0) {
    const rows = days.map((d) => ({ date: d.date, sum: sumDay(d) }))
    desc.first_days = rows.slice(0, 3)
    desc.last_days = rows.slice(-3)
  }
  return desc
}

async function probe(label, url) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
    const text = await res.text()
    console.log(`\n=== ${label} (HTTP ${res.status}) ===`)
    console.log(`${url}`)
    try {
      const body = JSON.parse(text)
      console.log(JSON.stringify(describe(body), null, 2))
    } catch {
      console.log('non-json body:', text.slice(0, 300))
    }
  } catch (error) {
    console.log(`\n=== ${label} FAILED ===`)
    console.log(String(error))
  }
}

// ---- queries --------------------------------------------------------------

const now = new Date()

// Beijing (UTC+8, no DST) start-of-day in epoch seconds.
function beijingStartOfDay(d) {
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000)
  const utcDayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / 1000
  return utcDayStart - 8 * 3600
}

const todayStartSec = beijingStartOfDay(now)
const yesterdayStartSec = todayStartSec - 86400
const nowSec = Math.floor(now.getTime() / 1000)
const BJ_TZ = 28800

// 1. current plugin behavior: plain month query
await probe('month query (no tz)', `${BASE}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`)

// 2. month query with tz=Beijing
await probe('month query tz=28800', `${BASE}?month=${now.getMonth() + 1}&year=${now.getFullYear()}&tz=${BJ_TZ}`)

// 3. today (Beijing) via start/end/tz
await probe('today Beijing start/end/tz', `${BASE}?start=${todayStartSec}&end=${nowSec}&tz=${BJ_TZ}`)

// 4. yesterday (Beijing) via start/end/tz
await probe('yesterday Beijing start/end/tz', `${BASE}?start=${yesterdayStartSec}&end=${todayStartSec - 1}&tz=${BJ_TZ}`)

// 5. month as Beijing window via start/end/tz
const monthStartSec = beijingStartOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
await probe('month Beijing start/end/tz', `${BASE}?start=${monthStartSec}&end=${nowSec}&tz=${BJ_TZ}`)
