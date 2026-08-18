/** Probe 4: raw envelope shape of by_api_key/cost. Never prints the token. */
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

function beijingStartOfDay(d) {
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000)
  const utcDayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) / 1000
  return utcDayStart - 8 * 3600
}

const now = new Date()
const nowSec = Math.floor(now.getTime() / 1000)
const start = beijingStartOfDay(now) - 86400
const url = `https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${start}&end=${nowSec}&tz=28800`
const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
const text = await res.text()
console.log('HTTP', res.status)
console.log('raw length:', text.length)
console.log('raw head:', text.slice(0, 800))
