/**
 * Client-side reproduction harness: boots the browser half under jsdom +
 * react-dom, renders the strip, simulates a row click, and dumps what the
 * slot would show (strip alive? panel present? crash stack?).
 *
 *   node test/client.repro.mjs
 */
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import jsxRuntime from 'react/jsx-runtime'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true
})

globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Capture the bundle handoff.
let handoff = null
globalThis.window.__ModuleLoader__ = { load: (h) => { handoff = h } }

// Mock the host routes.
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/dsh-usage/overview')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          at: Date.now(),
          tokenConfigured: false,
          balance: { total: '110.00', currency: 'USD', granted: '10.00', toppedUp: '100.00', available: true },
          balanceError: null,
          // Truncation-sensitive values: 32.317153 → ¥32.31 (not 32.32),
          // 11.359155 → ¥11.35 (not 11.36) — matching the platform's
          // round-down-to-cents display.
          usage: { month: 46.764115, monthAvg: 2.598007, yesterday: 32.317153, today: 11.359155, currency: 'CNY' },
          usageError: null
        }
      }
    }
  }
  if (String(url).includes('/api/dsh-usage/token')) {
    return { ok: true, status: 200, async json() { return { ok: true, configured: false, masked: '' } } }
  }
  return { ok: false, status: 404, async json() { return {} } }
}

// Load the client bundle (registers the handoff).
await import('../lib/client.js')

const moduleExports = handoff.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return jsxRuntime
  throw new Error('unexpected require spec: ' + spec)
})

// Fake slots ctx: capture the registered component.
let Component = null
const fakeCtx = {
  slots: {
    inject(_name, fn) { fn() },
    register(_spec, comp) { Component = comp }
  }
}
moduleExports.apply(fakeCtx)

// Any render/event error surfaces here (React rethrows render errors
// through the root unless an error boundary swallows them).
let captured = null
const onError = (error) => { captured = error }
process.on('uncaughtException', onError)
process.on('unhandledRejection', (reason) => { captured = captured ?? reason })

const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)

try {
  root.render(React.createElement(Component))
  await sleep(100)

  const stripBefore = container.querySelector('[data-plugin="dsh-usage-blance"]')
  console.log('before click: strip present =', !!stripBefore, '| rows =', stripBefore ? stripBefore.querySelectorAll('[role="button"]').length : 0)

  // Platform-consistent truncation display: 32.317153 → 32.31, 11.359155 → 11.35.
  const stripText = stripBefore ? stripBefore.textContent : ''
  const rowValues = stripBefore ? [...stripBefore.querySelectorAll('[role="button"] span:last-child')].map((el) => el.textContent) : []
  console.log('row values:', rowValues.join(' | '))
  if (!rowValues.includes('¥32.31')) throw new Error('expected truncated ¥32.31, got: ' + rowValues.join(' | '))
  if (!rowValues.includes('¥11.35')) throw new Error('expected truncated ¥11.35, got: ' + rowValues.join(' | '))
  if (!stripText.includes('$110.00')) throw new Error('expected balance $110.00')

  // Glass material: default preference is applied via class + CSS vars.
  if (!stripBefore.className.includes('dshub-strip')) throw new Error('strip missing dshub-strip class')
  if (stripBefore.style.getPropertyValue('--dshub-glass-opacity') !== '52%') {
    throw new Error('expected default glass opacity 52%, got ' + stripBefore.style.getPropertyValue('--dshub-glass-opacity'))
  }
  if (stripBefore.style.getPropertyValue('--dshub-glass-blur') !== '16px') {
    throw new Error('expected default glass blur 16px')
  }
  console.log('glass vars ok:', stripBefore.style.getPropertyValue('--dshub-glass-opacity'), stripBefore.style.getPropertyValue('--dshub-glass-blur'))

  const firstRow = stripBefore && stripBefore.querySelector('[role="button"]')
  try {
    firstRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }))
  } catch (error) {
    captured = captured ?? error
  }
  await sleep(100)

  const stripAfter = container.querySelector('[data-plugin="dsh-usage-blance"]')
  const panel = container.querySelector('div[style*="bottom: calc(100% + 10px)"]')
  console.log('error:', captured ? (captured.stack || String(captured)) : 'none')
  console.log('after click: strip present =', !!stripAfter)
  console.log('panel present =', !!panel)
  if (panel) console.log('panel text head:', panel.textContent.slice(0, 80))
  if (panel && !panel.textContent.includes('玻璃质感')) throw new Error('panel missing 玻璃质感 controls')
  if (panel && panel.querySelectorAll('input[type="range"]').length !== 3) throw new Error('expected 3 glass sliders')
  console.log('glass controls ok: toggle=' + !!panel.querySelector('input[type="checkbox"]') + ' sliders=' + panel.querySelectorAll('input[type="range"]').length)
  console.log('data-slot-error cells:', container.querySelectorAll('[data-slot-error]').length)
  console.log('--- container html (trimmed) ---')
  console.log(container.innerHTML.slice(0, 500))
} finally {
  root.unmount()
  process.exit(captured ? 1 : 0)
}
