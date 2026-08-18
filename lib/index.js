/**
 * dsh-usage-blance — host half.
 *
 * A plugin for the DeepSeek Harness (DSH) web GUI that shows DeepSeek API
 * usage and balance below the chat dialog. The host half registers three
 * local HTTP routes on the dsh web server:
 *
 *   GET    /api/dsh-usage/overview — balance + this month's usage in one call
 *   GET    /api/dsh-usage/token    — whether a platform userToken is saved
 *   POST   /api/dsh-usage/token    — save / validate / clear the userToken
 *
 * Data sources:
 *   - Balance:  GET https://api.deepseek.com/user/balance
 *               (official public endpoint, authenticated with DEEPSEEK_API_KEY)
 *   - Usage:    GET https://platform.deepseek.com/api/v0/usage/cost?month=&year=
 *               (private dashboard endpoint, authenticated with the platform
 *               `userToken` found in localStorage after signing in — the
 *               official API does not expose usage queries)
 *
 * Secrets never leave the host: the browser only talks to these local routes.
 * The API key is resolved from the environment or ~/.dsh/.credentials.yaml;
 * the userToken is saved (by the control panel) to
 * $DSH_HOME/storages/dsh-usage-blance.json.
 *
 * All date math uses the local calendar day; DeepSeek Platform bills on UTC+8
 * (China Standard Time), which matches the local timezone for most users.
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

export const name = 'dsh-usage-blance'
export const inject = ['webServer']

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_COST_URL = 'https://platform.deepseek.com/api/v0/usage/cost'
const TIMEOUT_MS = 15_000
/** Local response cache: balance and usage are cached independently. */
const TTL_MS = 60_000
/** State file inside `$DSH_HOME/storages`. */
const STATE_FILE = 'dsh-usage-blance.json'
/** Max accepted request-body size for the token route. */
const MAX_BODY_BYTES = 1_000_000

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
}

// ---- homes / state --------------------------------------------------------

function homeCandidates() {
  const list = []
  if (process.env.DSH_HOME) list.push(process.env.DSH_HOME)
  if (process.env.USERPROFILE) list.push(join(process.env.USERPROFILE, '.dsh'))
  if (process.env.HOME) list.push(join(process.env.HOME, '.dsh'))
  return list
}

function storagesDir() {
  const home = homeCandidates()[0]
  return join(home || homedir(), 'storages')
}

function statePath() {
  return join(storagesDir(), STATE_FILE)
}

/** Read the persisted plugin state; `null` when absent or malformed. */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.userToken === 'string' && parsed.userToken !== '') {
      return parsed
    }
  } catch {
    /* absent or unreadable */
  }
  return null
}

/** Persist the plugin state (atomic best-effort write). */
function writeState(state) {
  try {
    const dir = dirname(statePath())
    mkdirSync(dir, { recursive: true })
    const tmp = `${statePath()}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, statePath())
    return true
  } catch (error) {
    console.error('[dsh-usage-blance] failed to persist state:', error)
    return false
  }
}

/**
 * Resolve the DeepSeek API key, same precedence the harness adapter uses:
 * DEEPSEEK_API_KEY env var, then `DEEPSEEK_API_KEY:` in `.credentials.yaml`
 * of each candidate dsh home.
 */
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  for (const home of homeCandidates()) {
    try {
      const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
      const m = text.match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)
      if (m) return m[1].trim()
    } catch {
      /* try next candidate */
    }
  }
  return ''
}

// ---- shared helpers -------------------------------------------------------

/** Local calendar day as `YYYY-MM-DD`. */
export function localDate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Coerce a possibly-string number to a finite number, or NaN. */
export function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** Extract a readable message from a DeepSeek provider error body. */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text)
    if (
      parsed && typeof parsed === 'object' && parsed !== null &&
      parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string'
    ) {
      return parsed.error.message
    }
  } catch {
    /* not json */
  }
  return `DeepSeek 接口返回 HTTP ${status}`
}

/** Auth-specific platform error — the userToken is expired/revoked. */
export class UsageAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageAuthError'
  }
}

class NoApiKeyError extends Error {
  constructor() {
    super('no-api-key')
    this.name = 'NoApiKeyError'
  }
}

class NoTokenError extends Error {
  constructor() {
    super('no-token')
    this.name = 'NoTokenError'
  }
}

function friendlyBalanceError(error) {
  if (error instanceof NoApiKeyError) return '未配置 DEEPSEEK_API_KEY：请设置 DeepSeek API Key 后即可显示余额'
  if (error instanceof UsageAuthError) return error.message
  if (error && error.name === 'TimeoutError') return '余额接口请求超时'
  if (error && error.cause && error.cause.name === 'TimeoutError') return '余额接口请求超时'
  return error instanceof Error ? error.message : String(error)
}

function friendlyUsageError(error) {
  if (error instanceof NoTokenError) return '未配置 userToken：点击任意账单行打开控制面板获取'
  if (error instanceof UsageAuthError) return error.message
  if (error && error.name === 'TimeoutError') return '用量接口请求超时'
  if (error && error.cause && error.cause.name === 'TimeoutError') return '用量接口请求超时'
  return error instanceof Error ? error.message : String(error)
}

// ---- balance (official public API) ---------------------------------------

/**
 * Normalize the `/user/balance` payload into a small wire object.
 * `balance_infos[0]` is the primary currency entry.
 */
export function parseBalance(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : []
  const info = infos.length > 0 ? infos[0] : null
  return {
    total: info && typeof info.total_balance === 'string' ? info.total_balance : null,
    currency: info && typeof info.currency === 'string' ? info.currency : '',
    granted: info && typeof info.granted_balance === 'string' ? info.granted_balance : null,
    toppedUp: info && typeof info.topped_up_balance === 'string' ? info.topped_up_balance : null,
    available: body ? body.is_available !== false : true
  }
}

async function fetchBalance(apiKey) {
  const response = await fetch(BALANCE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(providerMessage(text, response.status))
  try {
    return parseBalance(JSON.parse(text))
  } catch {
    throw new Error('余额接口返回了无法解析的数据')
  }
}

// ---- usage (private platform dashboard API) -------------------------------

/**
 * Parse the platform usage envelope into a `Map<"YYYY-MM-DD", cost>`.
 *
 * Envelope: `{ code: 0, data: { biz_code: 0, biz_data: { days: [
 *   { date: "YYYY-MM-DD", data: [ { usage: [ { cost|amount, ... } ] } ] }
 * ] } } }` (some accounts answer `biz_data` as a one-element array).
 * Parsing is defensive; unknown shapes yield an empty map.
 *
 * @throws {UsageAuthError} on expired-session codes (40002/40003)
 * @throws {Error} on non-zero envelope codes
 */
export function parseUsageEnvelope(body) {
  if (body === null || typeof body !== 'object') {
    throw new Error('平台用量接口返回了无法解析的数据')
  }
  const biz = body.data
  if (body.code !== 0 || biz === undefined || biz.biz_code !== 0) {
    const code = body.code ?? biz?.biz_code
    if (code === 40002 || code === 40003) {
      throw new UsageAuthError('userToken 已过期：请重新登录 platform.deepseek.com 并更新 userToken')
    }
    throw new Error(`平台用量接口错误 (code ${code ?? 'unknown'})`)
  }
  const bizData = biz.biz_data
  const container = Array.isArray(bizData) ? bizData[0] : bizData
  const days = container && typeof container === 'object' ? container.days : undefined
  const map = new Map()
  if (!Array.isArray(days)) return map
  for (const day of days) {
    if (!day || typeof day.date !== 'string') continue
    let total = 0
    for (const modelEntry of Array.isArray(day.data) ? day.data : []) {
      if (!modelEntry || typeof modelEntry !== 'object') continue
      for (const u of Array.isArray(modelEntry.usage) ? modelEntry.usage : []) {
        if (!u || typeof u !== 'object') continue
        const value = toFinite(u.cost ?? u.amount)
        if (Number.isFinite(value)) total += value
      }
    }
    map.set(day.date, Math.round(total * 1e6) / 1e6)
  }
  return map
}

async function fetchUsageCostMap(token, month, year) {
  const url = `${USAGE_COST_URL}?month=${month}&year=${year}`
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'x-app-version': '1.0.0',
      Origin: 'https://platform.deepseek.com',
      Referer: 'https://platform.deepseek.com/usage'
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`平台用量接口返回 HTTP ${response.status}`)
  let body = null
  try {
    body = await response.json()
  } catch {
    throw new Error('平台用量接口返回了无法解析的数据')
  }
  return parseUsageEnvelope(body)
}

/**
 * Derive the four usage figures from one month's per-day cost map.
 * `monthAvg` divides by the number of elapsed days (today's day-of-month),
 * i.e. "how much this month costs per day so far".
 */
export function usageStats(map, now = new Date()) {
  let month = 0
  for (const value of map.values()) month += value
  month = Math.round(month * 1e6) / 1e6

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const today = localDate(now)
  const yesterdayKey = localDate(yesterday)

  const elapsed = Math.max(1, now.getDate())
  const monthAvg = Math.round((month / elapsed) * 1e6) / 1e6

  return {
    month,
    monthAvg,
    yesterday: map.get(yesterdayKey) ?? 0,
    today: map.get(today) ?? 0,
    currency: 'CNY'
  }
}

// ---- route handlers -------------------------------------------------------

const cache = {
  balance: null, // { at, value }
  usage: null // { at, value }
}

async function handleOverview(_req, res) {
  const now = Date.now()
  const out = {
    ok: true,
    at: now,
    tokenConfigured: readState() !== null,
    balance: null,
    balanceError: null,
    usage: null,
    usageError: null
  }

  // Balance from the official public endpoint (API-key authenticated).
  try {
    if (!cache.balance || now - cache.balance.at > TTL_MS) {
      const key = readApiKey()
      if (!key) throw new NoApiKeyError()
      cache.balance = { at: now, value: await fetchBalance(key) }
    }
    out.balance = cache.balance.value
  } catch (error) {
    out.balanceError = friendlyBalanceError(error)
  }

  // Usage from the platform dashboard endpoint (userToken authenticated).
  try {
    const state = readState()
    if (!state) throw new NoTokenError()
    if (!cache.usage || now - cache.usage.at > TTL_MS) {
      const d = new Date()
      const map = await fetchUsageCostMap(state.userToken, d.getMonth() + 1, d.getFullYear())
      cache.usage = { at: now, value: map }
    }
    out.usage = usageStats(cache.usage.value)
  } catch (error) {
    out.usageError = friendlyUsageError(error)
  }

  sendJson(res, 200, out)
}

/** Read a request body as UTF-8 text (bounded). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Mask a token for display: `abcd…wxyz`. */
export function maskToken(token) {
  if (!token) return ''
  if (token.length <= 10) return `${token.slice(0, 2)}…`
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/**
 * GET/POST/DELETE /api/dsh-usage/token — one route, method-dispatched
 * (the web server forbids duplicate exact paths).
 */
async function handleToken(req, res) {
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'GET') {
    const state = readState()
    sendJson(res, 200, {
      ok: true,
      configured: state !== null,
      masked: state ? maskToken(state.userToken) : ''
    })
    return
  }

  if (method === 'DELETE') {
    writeState({ userToken: '', clearedAt: Date.now() })
    cache.usage = null
    sendJson(res, 200, { ok: true, configured: false })
    return
  }

  if (method === 'POST') {
    let body = null
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-json', message: '请求体不是合法 JSON' })
      return
    }
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (token === '') {
      // Empty token = clear.
      writeState({ userToken: '', clearedAt: Date.now() })
      cache.usage = null
      sendJson(res, 200, { ok: true, configured: false })
      return
    }
    writeState({ userToken: token, updatedAt: Date.now() })
    cache.usage = null
    // Validate eagerly so the panel can tell the user right away.
    try {
      const d = new Date()
      await fetchUsageCostMap(token, d.getMonth() + 1, d.getFullYear())
      sendJson(res, 200, {
        ok: true,
        configured: true,
        masked: maskToken(token),
        validated: true
      })
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        configured: true,
        masked: maskToken(token),
        validated: false,
        message: friendlyUsageError(error)
      })
    }
    return
  }

  sendJson(res, 405, { ok: false, error: 'method', message: 'method not allowed' })
}

function guarded(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      console.error('[dsh-usage-blance] route failed:', error)
      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: 'internal',
          message: error instanceof Error ? error.message : String(error)
        })
      } else {
        res.end()
      }
    }
  }
}

// ---- plugin body ----------------------------------------------------------

export function apply(ctx) {
  ctx.effect(() => {
    const disposeOverview = ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-usage/overview',
      handler: guarded(handleOverview)
    })
    const disposeToken = ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-usage/token',
      handler: guarded(handleToken)
    })
    return () => {
      disposeOverview()
      disposeToken()
    }
  }, 'dsh-usage-blance: routes')
}

/** Test seam: state primitives (paths resolve at call time, honoring DSH_HOME). */
export const internals = { readState, writeState, statePath }
