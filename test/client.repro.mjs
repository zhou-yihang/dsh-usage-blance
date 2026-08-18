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
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true })

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

// Fake slots ctx: capture components by registration id (two dock slots).
const components = {}
const fakeCtx = {
  slots: {
    inject(_name, fn) { fn() },
    register(spec, comp) { components[spec.id] = comp }
  }
}
moduleExports.apply(fakeCtx)
const Above = components['dsh-usage-blance-above']
const Below = components['dsh-usage-blance-below']
if (!Above || !Below) throw new Error('expected two slot registrations (above/below)')

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
  // Default preference is 'above' → the above instance renders.
  root.render(React.createElement(Above, { position: 'above' }))
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
  if (panel && !panel.textContent.includes('主题')) throw new Error('panel missing 主题 column')
  if (panel && !panel.textContent.includes('账单条位置')) throw new Error('panel missing 账单条位置 radios')
  if (panel && panel.querySelectorAll('input[type="radio"]').length !== 2) throw new Error('expected 2 position radios')
  if (panel && !panel.querySelector('.dshub-panel-cols')) throw new Error('panel missing two-column layout')
  console.log('theme controls ok: radios=' + panel.querySelectorAll('input[type="radio"]').length + ' cols=' + !!panel.querySelector('.dshub-panel-cols'))

  // The inactive twin (below slot, default pref = above) renders nothing.
  const belowContainer = document.createElement('div')
  document.body.appendChild(belowContainer)
  const belowRoot = createRoot(belowContainer)
  belowRoot.render(React.createElement(Below, { position: 'below' }))
  await sleep(50)
  const belowStrip = belowContainer.querySelector('[data-plugin="dsh-usage-blance"]')
  console.log('below twin (inactive) renders:', !!belowStrip)
  if (belowStrip) throw new Error('expected inactive below twin to render nothing')

  // Real flow: pick 输入框下方 in the panel → the above instance hides AND
  // the already-mounted below twin appears (shared store, both subscribed).
  const belowRadio = panel.querySelectorAll('input[type="radio"]')[1]
  try {
    belowRadio.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }))
  } catch (error) {
    console.log('radio click threw:', error && error.stack ? error.stack : String(error))
    captured = captured ?? error
  }
  await sleep(100)
  const aboveAfter = container.querySelector('[data-plugin="dsh-usage-blance"]')
  console.log('above twin hidden after switch:', !aboveAfter)
  if (aboveAfter) throw new Error('expected above twin to hide after switching position')
  const belowAfter = belowContainer.querySelector('[data-plugin="dsh-usage-blance"]')
  console.log('below twin visible after switch:', !!belowAfter)
  if (!belowAfter) throw new Error('expected below twin to render after switching position (cross-instance sync)')
  if (belowAfter.querySelectorAll('[role="button"]').length !== 5) throw new Error('expected 5 rows in the below twin')
  const belowWidth = belowAfter.style.width
  console.log('below twin width style:', belowWidth)
  if (!belowWidth.includes('var(--dsh-composer-side-clearance')) {
    throw new Error('expected below twin to keep the input-box width formula, got ' + belowWidth)
  }
  console.log('position persisted:', localStorage.getItem('dsh-usage-blance:position'))
  if (localStorage.getItem('dsh-usage-blance:position') !== 'below') throw new Error('expected position pref persisted as below')

  // Hero fallback: when the below slot instance goes away (fresh
  // conversation — composer.dock is not rendered there), the above twin
  // must re-appear even though the preference is still 'below'.
  belowRoot.unmount()
  belowContainer.remove()
  await sleep(80)
  const aboveFallback = container.querySelector('[data-plugin="dsh-usage-blance"]')
  console.log('above twin fallback after below unmount:', !!aboveFallback)
  if (!aboveFallback) throw new Error('expected above twin to fall back when the below slot has no live instance (hero)')
  if (aboveFallback.querySelectorAll('[role="button"]').length !== 5) throw new Error('expected 5 rows in the fallback twin')
  // The hero fallback must flow BELOW the input bar: flex `order` on the
  // strip (the outlet anchor is display:contents, so the strip is a direct
  // flex item of the composer stack).
  console.log('fallback order style:', aboveFallback.style.order)
  if (aboveFallback.style.order !== '10') throw new Error('expected fallback strip to reorder below the input (order 10), got ' + aboveFallback.style.order)
  localStorage.removeItem('dsh-usage-blance:position')

  console.log('data-slot-error cells:', container.querySelectorAll('[data-slot-error]').length)
  console.log('--- container html (trimmed) ---')
  console.log(container.innerHTML.slice(0, 500))
} finally {
  root.unmount()
  process.exit(captured ? 1 : 0)
}
