/**
 * Live verification: run the plugin's own parsing/stats functions against
 * the real API with the saved token. Prints only the computed figures.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUsageBuckets, usageStats, beijingDayStartSec } from '../lib/index.js'

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

const now = new Date()
const todayStart = beijingDayStartSec(now)
const monthStart = beijingDayStartSec(new Date(now.getTime())) // recompute via helper below

// Month start (Beijing): reuse the module helper indirectly through the
// window the host would use — recompute here for clarity.
const shifted = new Date(now.getTime() + 8 * 3600 * 1000)
const monthStartSec = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) / 1000 - 8 * 3600

const url = `https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${monthStartSec}&end=${todayStart + 86400}&tz=28800`
const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
const body = await res.json()
const buckets = parseUsageBuckets(body)
const stats = usageStats(buckets, now)

console.log('HTTP', res.status, '| bucket count:', buckets.size)
console.log('本月消费:', stats.month)
console.log('本月日均:', stats.monthAvg)
console.log('昨日消费:', stats.yesterday)
console.log('今日消费:', stats.today)
console.log('currency:', stats.currency)
