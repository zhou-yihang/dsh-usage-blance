/**
 * Probe 2: dump the raw structure of specific day rows from the usage/cost
 * month query — do days contain per-hour entries or timestamps?
 * Prints sanitized shapes only — never the token.
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

const now = new Date()
const url = `https://platform.deepseek.com/api/v0/usage/cost?month=${now.getMonth() + 1}&year=${now.getFullYear()}`
const res = await fetch(url, { headers, signal: AbortSignal.timeout(25_000) })
const body = await res.json()
const biz = Array.isArray(body.data.biz_data) ? body.data.biz_data[0] : body.data.biz_data
const days = biz.days

console.log('HTTP', res.status, '| days:', days.length)

// The last few non-zero days carry the interesting data.
for (const day of days) {
  const total = day.data.reduce((acc, m) => {
    for (const u of Array.isArray(m.usage) ? m.usage : []) {
      const v = Number(u.cost ?? u.amount)
      if (Number.isFinite(v)) acc += v
    }
    return acc
  }, 0)
  if (total === 0) continue
  console.log(`\n===== day ${day.date} (sum ${Math.round(total * 1e6) / 1e6}) =====`)
  console.log('data entries:', day.data.length)
  for (const m of day.data.slice(0, 2)) {
    console.log('  model entry keys:', Object.keys(m))
    console.log('  model:', m.model)
    console.log('  usage entries:', m.usage.length)
    for (const u of m.usage.slice(0, 4)) {
      console.log('    item:', JSON.stringify(u))
    }
    if (m.usage.length > 4) console.log(`    ... ${m.usage.length - 4} more`)
  }
  if (day.data.length > 2) console.log(`  ... ${day.data.length - 2} more model entries`)
}
