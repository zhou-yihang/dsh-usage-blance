/**
 * End-to-end smoke test for the host half: boots the plugin against a mocked
 * webServer + mocked fetch, and exercises the real route handlers.
 *
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const usageFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'usage-cost.json'), 'utf8'))

// ---- sandbox: temp DSH_HOME with a credentials file + saved token ---------
const home = mkdtempSync(join(tmpdir(), 'dsh-usage-blance-smoke-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-smoke-test-key\n', 'utf8')

// ---- mocked fetch ---------------------------------------------------------
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (String(url).includes('/user/balance')) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }]
        })
      }
    }
  }
  if (String(url).includes('/api/v0/usage/cost')) {
    return { ok: true, status: 200, async json() { return usageFixture } }
  }
  return { ok: false, status: 404, async text() { return '{}' }, async json() { return {} } }
}

// ---- mocked webServer + ctx ------------------------------------------------
const routes = new Map()
const fakeWebServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  }
}

let effectCallback = null
const fakeCtx = {
  webServer: fakeWebServer,
  effect(fn) {
    effectCallback = fn
  }
}

function fakeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers)
    },
    end(text) {
      this.body = text
    }
  }
  return res
}

async function call(method, path, body) {
  const handler = routes.get(path)
  assert.ok(handler, `route ${path} registered`)
  const res = fakeRes()
  await handler(fakeReq(method, body), res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

// ---- run -------------------------------------------------------------------
try {
  const mod = await import('../lib/index.js')
  mod.apply(fakeCtx)
  assert.ok(effectCallback, 'apply registers routes via ctx.effect')
  const disposeRoutes = effectCallback()

  assert.equal(routes.size, 2)

  // No token yet: balance ok, usage reports the no-token hint.
  let out = await call('GET', '/api/dsh-usage/overview')
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.equal(out.json.tokenConfigured, false)
  assert.equal(out.json.balance.total, '110.00')
  assert.equal(out.json.balance.currency, 'USD')
  assert.equal(out.json.usage, null)
  assert.match(out.json.usageError, /userToken/)

  // Save a token via POST: validated against the mocked usage endpoint.
  out = await call('POST', '/api/dsh-usage/token', JSON.stringify({ token: 'smoke-token-123456' }))
  assert.equal(out.json.ok, true)
  assert.equal(out.json.configured, true)
  assert.equal(out.json.validated, true)
  assert.equal(out.json.masked, 'smok…3456')

  // Overview now carries all five figures (fixture is dated around "today").
  out = await call('GET', '/api/dsh-usage/overview')
  assert.equal(out.json.tokenConfigured, true)
  assert.ok(Math.abs(out.json.usage.month - 0.6048) < 1e-9, `month=${out.json.usage.month}`)
  assert.equal(out.json.usage.yesterday, 0.1234)
  assert.equal(out.json.usage.currency, 'CNY')
  assert.equal(out.json.usageError, null)

  // Token status GET.
  out = await call('GET', '/api/dsh-usage/token')
  assert.equal(out.json.configured, true)
  assert.equal(out.json.masked, 'smok…3456')

  // Bad JSON body → 400.
  out = await call('POST', '/api/dsh-usage/token', 'not-json')
  assert.equal(out.status, 400)

  // DELETE clears; overview falls back to the no-token hint.
  out = await call('DELETE', '/api/dsh-usage/token')
  assert.equal(out.json.configured, false)
  out = await call('GET', '/api/dsh-usage/overview')
  assert.equal(out.json.tokenConfigured, false)
  assert.equal(out.json.usage, null)
  assert.match(out.json.usageError, /userToken/)

  // Effect cleanup removes the routes.
  disposeRoutes()
  assert.equal(routes.size, 0)

  console.log('smoke ok: balance + usage + token lifecycle verified')
} finally {
  globalThis.fetch = originalFetch
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
}
