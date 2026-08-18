// dsh-usage-blance — browser half.
//
// Registers a billing strip into the `conversation.input.dock` slot — the
// dock rendered directly below the chat dialog (above the input box). It
// shows, in order: 本月消费 · 本月日均 · 昨日消费 · 今日消费 · 账户余额,
// polls the host route `/api/dsh-usage/overview` every minute, and offers a
// manual refresh button.
//
// Clicking any billing row opens the control panel: a userToken input with
// save / clear actions, the current token status, and step-by-step
// instructions for finding the userToken on platform.deepseek.com.
//
// Styling uses only `--dsw-*` theme tokens so it follows light/dark mode.
window.__ModuleLoader__.load({
  id: 'dsh-usage-blance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var jsxRuntime = require('react/jsx-runtime')
    var { useState, useEffect, useRef, useCallback, useSyncExternalStore } = react
    var { jsx, jsxs, Fragment } = jsxRuntime

    // ---- constants -----------------------------------------------------
    var POLL_MS = 60 * 1000
    var OVERVIEW_PATH = '/api/dsh-usage/overview'
    var TOKEN_PATH = '/api/dsh-usage/token'
    var PLATFORM_URL = 'https://platform.deepseek.com'

    // ---- helpers -------------------------------------------------------
    function symbolFor(code) {
      switch (code) {
        case 'CNY': return '¥'
        case 'USD': return '$'
        case 'EUR': return '€'
        case 'GBP': return '£'
        case 'JPY': return '¥'
        case 'HKD': return 'HK$'
        default: return code ? code + ' ' : '¥'
      }
    }

    // 金额展示与平台用量页一致：截断到分（不进位），千分位分隔；
    // 0 < x < 0.01 显示为 <¥0.01。平台实现为 roundDown 到 2 位小数
    // （platform 前端 JS：a.round(2, roundDown).toFixed(2)）。
    function formatCost(value, currency) {
      var symbol = symbolFor(currency)
      if (value === null || value === undefined || !Number.isFinite(value)) return symbol + '—'
      if (value > 0 && value < 0.01) return '<' + symbol + '0.01'
      // Costs are non-negative; floor === truncate for positive values.
      var truncated = Math.floor(value * 100) / 100
      var parts = truncated.toFixed(2).split('.')
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return symbol + parts.join('.')
    }

    function formatTime(date) {
      function p(n) { return (n < 10 ? '0' : '') + n }
      return p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds())
    }

    // ---- glass preference (persisted in localStorage) --------------------
    var GLASS_KEY = 'dsh-usage-blance:glass'
    var GLASS_DEFAULTS = { enabled: true, opacity: 52, blur: 16, saturate: 1.4 }

    function clampNumber(value, min, max, fallback) {
      var n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    function loadGlass() {
      try {
        var raw = localStorage.getItem(GLASS_KEY)
        if (!raw) return Object.assign({}, GLASS_DEFAULTS)
        var parsed = JSON.parse(raw)
        return {
          enabled: parsed.enabled !== false,
          opacity: clampNumber(parsed.opacity, 20, 90, 52),
          blur: clampNumber(parsed.blur, 0, 32, 16),
          saturate: clampNumber(parsed.saturate, 0.5, 2, 1.4)
        }
      } catch (e) {
        return Object.assign({}, GLASS_DEFAULTS)
      }
    }

    function saveGlass(glass) {
      try {
        localStorage.setItem(GLASS_KEY, JSON.stringify(glass))
      } catch (e) { /* storage unavailable — keep in-memory only */ }
    }

    // ---- strip position preference (persisted in localStorage) -----------
    var POSITION_KEY = 'dsh-usage-blance:position'
    var POSITION_DEFAULT = 'above' // 'above' = input dock, 'below' = composer dock

    function loadPosition() {
      try {
        var value = localStorage.getItem(POSITION_KEY)
        return value === 'below' ? 'below' : 'above'
      } catch (e) {
        return POSITION_DEFAULT
      }
    }

    function savePosition(position) {
      try {
        localStorage.setItem(POSITION_KEY, position)
      } catch (e) { /* ignore */ }
    }

    // ---- shared preference stores ----------------------------------------
    // Module-level stores backed by localStorage. Both dock-slot instances
    // (above/below) subscribe through useSyncExternalStore, so a preference
    // change made in one instance's panel re-renders the other immediately —
    // per-instance mount-time snapshots would leave the newly selected slot
    // stale (the "old position disappears, new one never appears" bug).
    function createPrefStore(loadFn, saveFn) {
      var store = {
        value: loadFn(),
        listeners: new Set()
      }
      store.subscribe = function (listener) {
        store.listeners.add(listener)
        return function () { store.listeners.delete(listener) }
      }
      store.get = function () { return store.value }
      store.set = function (next) {
        if (store.value === next) return
        store.value = next
        saveFn(next)
        store.listeners.forEach(function (listener) { listener() })
      }
      return store
    }

    var positionStore = createPrefStore(loadPosition, savePosition)
    var glassStore = createPrefStore(loadGlass, saveGlass)
    var alertStore = createPrefStore(loadBalanceAlert, saveBalanceAlert)

    // Presence of the below-slot instance. The composer.dock footer is not
    // rendered by the conversation bundle in the hero state (fresh empty
    // conversation), so the above-slot instance falls back to rendering
    // whenever the below slot has no live instance (counter-based: strict
    // mode / HMR may mount more than once).
    var belowPresence = {
      value: false,
      count: 0,
      listeners: new Set()
    }
    belowPresence.subscribe = function (listener) {
      belowPresence.listeners.add(listener)
      return function () { belowPresence.listeners.delete(listener) }
    }
    belowPresence.get = function () { return belowPresence.value }
    belowPresence.set = function (next) {
      if (belowPresence.value === next) return
      belowPresence.value = next
      belowPresence.listeners.forEach(function (listener) { listener() })
    }
    belowPresence.inc = function () {
      belowPresence.count += 1
      belowPresence.set(true)
    }
    belowPresence.dec = function () {
      belowPresence.count = Math.max(0, belowPresence.count - 1)
      belowPresence.set(belowPresence.count > 0)
    }

    // ---- balance alert preference (persisted in localStorage) ------------
    var ALERT_KEY = 'dsh-usage-blance:balance-alert'
    var TOP_UP_URL = 'https://platform.deepseek.com/top_up'

    function loadBalanceAlert() {
      try {
        var raw = localStorage.getItem(ALERT_KEY)
        if (!raw) return null
        var n = Number(raw)
        if (!Number.isFinite(n) || n < 0) return null
        return n
      } catch (e) {
        return null
      }
    }

    function saveBalanceAlert(value) {
      try {
        if (value === null) localStorage.removeItem(ALERT_KEY)
        else localStorage.setItem(ALERT_KEY, String(value))
      } catch (e) { /* ignore */ }
    }

    // ---- inline styles --------------------------------------------------
    // Layout only — the glass material (translucent background, backdrop
    // blur, sheen) lives in the `.dshub-strip` CSS block injected in apply()
    // so it can use fallback declarations + pseudo-free vendor prefixes.
    var stripStyle = {
      position: 'relative',
      boxSizing: 'border-box',
      // Same width as the chat input dialog (the composer card):
      // the composer stack is full-column width and the card is inset by
      // `--dsh-composer-side-clearance` on each side, capped at
      // `--dsh-composer-card-max-width` (see dsh-client-ui-conversation CSS).
      width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px))',
      maxWidth: 'var(--dsh-composer-card-max-width, 780px)',
      margin: '0 auto 4px',
      borderRadius: 12,
      color: 'var(--dsw-alias-label-primary)',
      display: 'flex',
      alignItems: 'stretch',
      flexWrap: 'wrap',
      fontSize: 12,
      lineHeight: '16px'
    }

    var rowStyle = {
      flex: '1 1 0',
      minWidth: 96,
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '6px 10px',
      cursor: 'pointer',
      borderRight: '1px solid var(--dsw-alias-border-l1)',
      transition: 'background .15s ease'
    }

    var rowLastStyle = { borderRight: 'none' }

    var rowLabelStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '14px',
      whiteSpace: 'nowrap'
    }

    var rowValueStyle = {
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }

    var rowErrorStyle = { color: 'var(--dsw-alias-state-error-primary)' }

    var refreshButtonStyle = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      borderRadius: '0 12px 12px 0'
    }

    var hintStyle = {
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 11,
      padding: '0 8px',
      whiteSpace: 'nowrap'
    }

    var panelStyle = {
      position: 'absolute',
      bottom: 'calc(100% + 10px)',
      right: 0,
      zIndex: 60,
      boxSizing: 'border-box',
      width: 620,
      maxWidth: 'calc(100vw - 24px)',
      maxHeight: 'min(60vh, 520px)',
      overflowY: 'auto',
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)',
      padding: '12px 14px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      lineHeight: '18px',
      textAlign: 'left'
    }

    var panelHeaderStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10
    }

    var panelTitleStyle = {
      flex: 1,
      minWidth: 0,
      fontWeight: 600,
      fontSize: 13,
      lineHeight: '18px'
    }

    var panelCloseStyle = {
      flex: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      fontSize: 14,
      lineHeight: '18px',
      padding: '2px 6px',
      borderRadius: 6
    }

    var sectionTitleStyle = {
      fontWeight: 600,
      fontSize: 12,
      lineHeight: '18px',
      margin: '10px 0 4px',
      color: 'var(--dsw-alias-label-primary)'
    }

    var mutedStyle = { color: 'var(--dsw-alias-label-secondary)' }

    var okStyle = { color: 'var(--dsw-alias-state-success-primary)' }
    var errStyle = { color: 'var(--dsw-alias-state-error-primary)' }

    var inputRowStyle = { display: 'flex', gap: 6, alignItems: 'center' }

    var inputStyle = {
      flex: 1,
      minWidth: 0,
      boxSizing: 'border-box',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-control, transparent)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '6px 8px',
      fontSize: 12,
      lineHeight: '16px',
      outline: 'none'
    }

    var buttonStyle = {
      flex: 'none',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-interactive-bg-hover)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '6px 12px',
      fontSize: 12,
      lineHeight: '16px',
      cursor: 'pointer',
      fontFamily: 'inherit'
    }

    var dangerButtonStyle = {
      flex: 'none',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-state-error-primary)',
      borderRadius: 8,
      padding: '6px 12px',
      fontSize: 12,
      lineHeight: '16px',
      cursor: 'pointer',
      fontFamily: 'inherit'
    }

    var codeStyle = {
      display: 'block',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-interactive-bg-hover)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8,
      padding: '6px 8px',
      margin: '4px 0 6px',
      fontSize: 11,
      lineHeight: '16px',
      fontFamily: 'Consolas, Menlo, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      userSelect: 'all',
      cursor: 'text'
    }

    var olStyle = { margin: '4px 0', paddingLeft: 18 }

    var footerStyle = {
      marginTop: 10,
      paddingTop: 8,
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '16px'
    }

    // Glass-panel controls.
    var glassToggleRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      margin: '6px 0 8px',
      cursor: 'pointer',
      userSelect: 'none'
    }

    var glassSliderRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      margin: '4px 0'
    }

    var glassSliderLabelStyle = {
      flex: 'none',
      width: 44,
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      lineHeight: '16px'
    }

    var glassSliderValueStyle = {
      flex: 'none',
      width: 52,
      textAlign: 'right',
      fontVariantNumeric: 'tabular-nums',
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-primary)'
    }

    var glassRangeStyle = {
      flex: 1,
      minWidth: 0,
      accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      cursor: 'pointer'
    }

    var glassResetRowStyle = {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 6
    }

    // ---- the widget ----------------------------------------------------
    // Rendered once per dock slot ('above' and 'below' registrations); the
    // instance whose `position` does not match the saved preference renders
    // nothing and skips polling.
    function UsageDock(props) {
      var position = props.position === 'below' ? 'below' : 'above'
      var [data, setData] = useState(null) // overview payload
      var [phase, setPhase] = useState('loading') // loading | ready | error
      var [message, setMessage] = useState('')
      var [updatedAt, setUpdatedAt] = useState(null)
      var [spinning, setSpinning] = useState(false)
      var [panelOpen, setPanelOpen] = useState(false)

      // panel state
      var [tokenInput, setTokenInput] = useState('')
      var [showToken, setShowToken] = useState(false)
      var [saving, setSaving] = useState(false)
      var [tokenNote, setTokenNote] = useState(null) // {tone:'ok'|'err', text}
      var [tokenStatus, setTokenStatus] = useState({ configured: false, masked: '' })

      // Shared, cross-instance preferences (localStorage-backed stores).
      var positionPref = useSyncExternalStore(positionStore.subscribe, positionStore.get)
      var glass = useSyncExternalStore(glassStore.subscribe, glassStore.get)
      var alertThreshold = useSyncExternalStore(alertStore.subscribe, alertStore.get)
      var belowMounted = useSyncExternalStore(belowPresence.subscribe, belowPresence.get)

      var stripRef = useRef(null)
      var panelRef = useRef(null)
      var mounted = useRef(true)

      // Report this instance's slot presence so the above twin can fall
      // back in the hero state (where composer.dock is not rendered).
      useEffect(function () {
        if (position !== 'below') return
        belowPresence.inc()
        return function () { belowPresence.dec() }
      }, [position])

      // The above twin also renders when the preference is 'below' but the
      // below slot has no live instance (hero / fresh conversation).
      var active = position === 'below'
        ? positionPref === 'below'
        : (positionPref === 'above' || !belowMounted)

      var updateGlass = function (patch) {
        glassStore.set(Object.assign({}, glassStore.get(), patch))
      }

      var resetGlass = function () {
        glassStore.set(Object.assign({}, GLASS_DEFAULTS))
      }

      var changePosition = function (next) {
        positionStore.set(next)
      }

      var load = useCallback(async function () {
        setSpinning(true)
        try {
          var res = await fetch(OVERVIEW_PATH, { cache: 'no-store' })
          var body = null
          try { body = await res.json() } catch (e) { /* ignore */ }
          if (!mounted.current) return
          if (res.ok && body && body.ok) {
            setData(body)
            setPhase('ready')
            setMessage('')
            setUpdatedAt(new Date())
          } else {
            throw new Error(body && typeof body.message === 'string' ? body.message : '请求失败 (HTTP ' + res.status + ')')
          }
        } catch (error) {
          if (!mounted.current) return
          setPhase('error')
          setMessage(error instanceof Error ? error.message : String(error))
        } finally {
          if (mounted.current) setSpinning(false)
        }
      }, [])

      var loadTokenStatus = useCallback(async function () {
        try {
          var res = await fetch(TOKEN_PATH, { cache: 'no-store' })
          var body = await res.json()
          if (body && body.ok) {
            setTokenStatus({ configured: !!body.configured, masked: body.masked || '' })
          }
        } catch (e) { /* ignore */ }
      }, [])

      useEffect(function () {
        if (!active) return
        mounted.current = true
        load()
        var timer = setInterval(load, POLL_MS)
        return function () {
          mounted.current = false
          clearInterval(timer)
        }
      }, [active, load])

      // Close the panel on Escape or outside pointer-down, and keep the
      // height cap in sync with the visible space above the strip (the
      // composer seat lives inside the conversation scrollport, whose
      // overflow would otherwise clip the panel's top in the hero state).
      var [panelCap, setPanelCap] = useState(520)

      var recomputePanelCap = function () {
        var el = stripRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        var vh = window.innerHeight || 800
        // Not laid out (e.g. synthetic test DOM): keep the full cap.
        if (rect.width === 0 && rect.height === 0 && rect.top === 0) {
          setPanelCap(520)
          return
        }
        var spaceAbove = Math.max(0, rect.top - 12)
        setPanelCap(Math.max(120, Math.min(520, Math.floor(vh * 0.6), Math.floor(spaceAbove))))
      }

      useEffect(function () {
        if (!panelOpen) return
        recomputePanelCap()
        var onKey = function (ev) {
          if (ev.key === 'Escape') {
            ev.stopPropagation()
            setPanelOpen(false)
          }
        }
        var onPointer = function (ev) {
          var insidePanel = panelRef.current && panelRef.current.contains(ev.target)
          var insideStrip = stripRef.current && stripRef.current.contains(ev.target)
          if (!insidePanel && !insideStrip) setPanelOpen(false)
        }
        window.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointer, true)
        window.addEventListener('resize', recomputePanelCap)
        document.addEventListener('scroll', recomputePanelCap, true)
        return function () {
          window.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointer, true)
          window.removeEventListener('resize', recomputePanelCap)
          document.removeEventListener('scroll', recomputePanelCap, true)
        }
      }, [panelOpen])

      var openPanel = function () {
        setPanelOpen(true)
        if (!panelOpen) {
          // Freshly opened: show the current token status, don't clobber a
          // half-typed token when a different row is clicked while open.
          setTokenNote(null)
          setTokenInput('')
          loadTokenStatus()
        }
      }

      var saveToken = async function () {
        var token = tokenInput.trim()
        if (!token || saving) return
        setSaving(true)
        setTokenNote(null)
        try {
          var res = await fetch(TOKEN_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: token })
          })
          var body = await res.json()
          if (body && body.ok) {
            setTokenStatus({ configured: true, masked: body.masked || '' })
            setTokenInput('')
            setTokenNote(body.validated
              ? { tone: 'ok', text: '已保存，并验证通过。账单数据即将更新。' }
              : { tone: 'err', text: '已保存，但验证失败：' + (body.message || '未知错误') })
          } else {
            setTokenNote({ tone: 'err', text: (body && body.message) || '保存失败' })
          }
          await load()
        } catch (error) {
          setTokenNote({ tone: 'err', text: '保存失败：' + (error instanceof Error ? error.message : String(error)) })
        } finally {
          setSaving(false)
        }
      }

      var clearToken = async function () {
        if (saving) return
        setSaving(true)
        setTokenNote(null)
        try {
          var res = await fetch(TOKEN_PATH, { method: 'DELETE' })
          var body = await res.json()
          if (body && body.ok) {
            setTokenStatus({ configured: false, masked: '' })
            setTokenNote({ tone: 'ok', text: '已清除本地保存的 userToken。' })
          }
          await load()
        } catch (error) {
          setTokenNote({ tone: 'err', text: '清除失败：' + (error instanceof Error ? error.message : String(error)) })
        } finally {
          setSaving(false)
        }
      }

      // ---- derived values ----------------------------------------------
      var balance = data ? data.balance : null
      var usage = data ? data.usage : null
      var balanceError = data ? data.balanceError : null
      var usageError = data ? data.usageError : null

      var balanceValue = balance && balance.total !== null ? Number(balance.total) : null
      // Balance alert: balance at or below the configured threshold.
      var alertOn = alertThreshold !== null && balanceValue !== null && balanceValue <= alertThreshold

      var rows = [
        { key: 'month', label: '本月消费', value: usage ? usage.month : null, currency: usage ? usage.currency : 'CNY', error: usageError },
        { key: 'monthAvg', label: '本月日均', value: usage ? usage.monthAvg : null, currency: usage ? usage.currency : 'CNY', error: usageError },
        { key: 'yesterday', label: '昨日消费', value: usage ? usage.yesterday : null, currency: usage ? usage.currency : 'CNY', error: usageError },
        { key: 'today', label: '今日消费', value: usage ? usage.today : null, currency: usage ? usage.currency : 'CNY', error: usageError },
        { key: 'balance', label: '账户余额', value: balanceValue, currency: balance ? balance.currency : '', error: balanceError }
      ]

      var rowNodes = rows.map(function (row, index) {
        var err = row.error
        var isBalance = row.key === 'balance'
        var warn = isBalance && alertOn
        var valueStyle = Object.assign({}, rowValueStyle, err || warn ? rowErrorStyle : null)
        var title = err
          ? row.label + '：' + err + '（点击配置）'
          : warn
            ? '余额已不高于预警值 ' + formatCost(alertThreshold, balance.currency) + '，点击前往充值或调整预警'
            : '点击打开控制面板'
        return jsxs('div', {
          key: row.key,
          role: 'button',
          tabIndex: 0,
          title: title,
          style: Object.assign({}, rowStyle, index === rows.length - 1 ? rowLastStyle : null),
          onClick: openPanel,
          onKeyDown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPanel() } },
          children: [
            jsx('span', { style: rowLabelStyle, children: row.label }),
            jsxs('span', { style: { display: 'flex', alignItems: 'baseline', gap: 4 }, children: [
              jsx('span', { style: valueStyle, children: formatCost(row.value, row.currency) }),
              warn ? jsx('span', {
                style: { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700, fontSize: 13, lineHeight: '16px' },
                'aria-label': '余额预警',
                children: '!'
              }) : null
            ] })
          ]
        })
      })

      var refreshIcon = jsx('svg', {
        width: 13,
        height: 13,
        viewBox: '0 0 16 16',
        fill: 'none',
        style: spinning ? { animation: 'dsh-usage-blance-spin 0.8s linear infinite' } : undefined,
        children: jsx('path', {
          d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      })

      var panel = null
      if (panelOpen) {
        var tokenStep = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: 'userToken 配置' }),
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }, children: [
            jsx('span', { style: mutedStyle, children: '状态' }),
            tokenStatus.configured
              ? jsx('span', { style: okStyle, children: '已配置 ' + tokenStatus.masked })
              : jsx('span', { style: errStyle, children: '未配置（用量数据不可用）' })
          ] }),
          jsxs('div', { style: inputRowStyle, children: [
            jsx('input', {
              type: showToken ? 'text' : 'password',
              value: tokenInput,
              placeholder: '粘贴 userToken',
              spellCheck: false,
              autoComplete: 'off',
              style: inputStyle,
              onChange: function (ev) { setTokenInput(ev.target.value) },
              onKeyDown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); saveToken() } }
            }),
            jsx('button', { type: 'button', style: buttonStyle, title: '显示/隐藏', onClick: function () { setShowToken(function (v) { return !v }) }, children: showToken ? '隐藏' : '显示' }),
            jsx('button', { type: 'button', style: buttonStyle, disabled: saving || tokenInput.trim() === '', onClick: saveToken, children: saving ? '保存中…' : '保存' }),
            tokenStatus.configured ? jsx('button', { type: 'button', style: dangerButtonStyle, disabled: saving, onClick: clearToken, children: '清除' }) : null
          ] }),
          tokenNote ? jsx('div', { style: Object.assign({ marginTop: 6 }, tokenNote.tone === 'ok' ? okStyle : errStyle), children: tokenNote.text }) : null
        ] })

        // Glass material controls: applied live to the strip and persisted
        // to localStorage — no host round-trip.
        var glassSlider = function (label, value, min, max, step, unit) {
          return jsxs('div', { style: glassSliderRowStyle, children: [
            jsx('span', { style: glassSliderLabelStyle, children: label }),
            jsx('input', {
              type: 'range',
              min: min,
              max: max,
              step: step,
              value: value,
              disabled: !glass.enabled,
              style: glassRangeStyle,
              'aria-label': label,
              onChange: function (ev) {
                var next = Number(ev.target.value)
                if (unit === '%') updateGlass({ opacity: next })
                else if (unit === 'px') updateGlass({ blur: next })
                else updateGlass({ saturate: next })
              }
            }),
            jsx('span', { style: glassSliderValueStyle, children: unit === '%' ? value + '%' : unit === 'px' ? value + 'px' : value.toFixed(1) + '×' })
          ] })
        }

        var glassStep = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: '玻璃质感' }),
          jsxs('label', { style: glassToggleRowStyle, children: [
            jsx('input', {
              type: 'checkbox',
              checked: glass.enabled,
              style: { accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', cursor: 'pointer' },
              onChange: function (ev) { updateGlass({ enabled: ev.target.checked }) }
            }),
            jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: '启用玻璃效果' }),
            jsx('span', { style: mutedStyle, children: '（调节实时生效并自动保存）' })
          ] }),
          glassSlider('透明度', glass.opacity, 20, 90, 1, '%'),
          glassSlider('模糊', glass.blur, 0, 32, 1, 'px'),
          glassSlider('饱和度', glass.saturate, 0.5, 2, 0.1, '×'),
          jsx('div', { style: glassResetRowStyle, children: jsx('button', { type: 'button', style: buttonStyle, onClick: resetGlass, children: '恢复默认' }) })
        ] })

        var howTo = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: '如何获取 userToken' }),
          jsx('ol', { style: olStyle, children: [
            jsx('li', { children: jsxs(Fragment, { children: [
              jsx('span', { children: '登录 ' }),
              jsx('a', {
                href: PLATFORM_URL,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { color: 'var(--dsw-alias-link-primary, var(--dsw-alias-label-primary))' },
                children: 'platform.deepseek.com'
              })
            ] }) }),
            jsx('li', { children: jsxs(Fragment, { children: [
              jsx('span', { children: '按 F12 打开开发者工具，切到 Console（控制台），粘贴执行下面的命令并复制输出：' }),
              jsx('code', { style: codeStyle, children: 'JSON.parse(localStorage.getItem(\'userToken\')).value' })
            ] }) }),
            jsx('li', { children: '或：Application（应用）→ Local Storage → 点击 platform.deepseek.com → 找到 userToken 一项，复制其 value 字段。' }),
            jsx('li', { children: '粘贴到上方输入框，点击「保存」。' })
          ] }),
          jsx('div', { style: footerStyle, children: [
            jsx('div', { children: 'userToken 仅保存在本机 ' + '$DSH_HOME/storages/dsh-usage-blance.json' + '，只用于查询用量；余额读取 DEEPSEEK_API_KEY（设置 → 模型）。' }),
            jsx('div', { children: 'token 过期（如退出登录）后需重新获取并保存。' })
          ] })
        ] })

        // Position radios.
        var positionRadio = function (label, value) {
          return jsxs('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', margin: '2px 0' }, children: [
            jsx('input', {
              type: 'radio',
              name: 'dshub-position',
              checked: positionPref === value,
              style: { accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', cursor: 'pointer' },
              onChange: function () { changePosition(value) }
            }),
            jsx('span', { style: { color: 'var(--dsw-alias-label-primary)' }, children: label })
          ] })
        }

        var positionStep = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: '账单条位置' }),
          positionRadio('输入框上方', 'above'),
          positionRadio('输入框下方', 'below')
        ] })

        // Theme column: strip position + glass material.
        var themeStep = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: '主题' }),
          positionStep,
          glassStep
        ] })

        // Balance alert: threshold in the balance currency; empty = off.
        var alertStep = jsx('div', { children: [
          jsx('div', { style: sectionTitleStyle, children: '余额预警' }),
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [
            jsx('input', {
              type: 'number',
              min: 0,
              step: '0.01',
              value: alertThreshold === null ? '' : String(alertThreshold),
              placeholder: '预警值（留空关闭）',
              style: inputStyle,
              'aria-label': '余额预警值',
              onChange: function (ev) {
                var raw = ev.target.value
                if (raw === '') {
                  alertStore.set(null)
                  return
                }
                var n = Number(raw)
                if (Number.isFinite(n) && n >= 0) alertStore.set(n)
              }
            }),
            jsx('span', { style: mutedStyle, children: balance && balance.currency ? balance.currency : 'USD' }),
            alertThreshold !== null ? jsx('button', { type: 'button', style: dangerButtonStyle, onClick: function () { alertStore.set(null) }, children: '关闭' }) : null
          ] }),
          jsx('div', { style: Object.assign({}, mutedStyle, { marginTop: 4 }), children: '余额 ≤ 预警值时：账户余额后显示红色感叹号，并在「更新于」下方显示充值入口。' })
        ] })

        // Two-column layout: userToken on the left, theme on the right;
        // stacks on narrow screens via the `.dshub-panel-cols` CSS.
        panel = jsx('div', { ref: panelRef, className: 'dshub-panel', style: Object.assign({}, panelStyle, { maxHeight: panelCap + 'px' }), children: jsxs(Fragment, { children: [
          jsxs('div', { style: panelHeaderStyle, children: [
            jsx('span', { style: panelTitleStyle, children: 'DeepSeek 用量控制面板' }),
            jsx('button', {
              type: 'button',
              style: panelCloseStyle,
              'aria-label': '关闭',
              title: '关闭 (Esc)',
              onClick: function () { setPanelOpen(false) },
              children: '✕'
            })
          ] }),
          jsxs('div', { className: 'dshub-panel-cols', children: [
            jsx('div', { className: 'dshub-panel-col', children: jsxs(Fragment, { children: [tokenStep, alertStep, howTo] }) }),
            jsx('div', { className: 'dshub-panel-col', children: themeStep })
          ] })
        ] }) })
      }

      var statusText = phase === 'loading'
        ? '加载中…'
        : phase === 'error'
          ? '获取失败'
          : updatedAt
            ? '更新于 ' + formatTime(updatedAt)
            : ''

      // The inactive twin (other dock slot) renders nothing.
      if (!active) return null

      // Fallback for the hero state: the preference says 'below' but the
      // composer.dock footer is not rendered there, so the above-slot
      // instance stands in. The slot outlet anchor is display:contents, so
      // the strip IS a direct flex item of the composer stack — `order`
      // flows it after the input bar, visually below the input box.
      var fallbackBelow = position === 'above' && positionPref === 'below' && !belowMounted

      // Both dock zones are full-column width (the built-in stats line
      // constrains itself via its own max-width CSS), so keep the same
      // input-box width formula in both positions; only margin/radius
      // differ (the below strip hugs the card footer, not the composer).
      var positionedStripStyle = Object.assign({}, stripStyle, position === 'below'
        ? { margin: '4px auto 0', borderRadius: 10 }
        : {})

      if (fallbackBelow) {
        positionedStripStyle = Object.assign({}, positionedStripStyle, {
          order: 10,
          flexShrink: 0
        })
      }

      return jsxs('div', {
        ref: stripRef,
        role: 'status',
        'aria-live': 'polite',
        'data-plugin': 'dsh-usage-blance',
        className: 'dshub-strip' + (glass.enabled ? '' : ' dshub-glass-off'),
        style: Object.assign({}, positionedStripStyle, {
          '--dshub-glass-opacity': glass.opacity + '%',
          '--dshub-glass-blur': glass.blur + 'px',
          '--dshub-glass-saturate': String(glass.saturate)
        }),
        children: [
          rowNodes,
          jsxs('div', { style: {
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            padding: '4px 8px'
          }, children: [
            jsx('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '14px', whiteSpace: 'nowrap' }, title: phase === 'error' ? message : undefined, children: statusText }),
            alertOn ? jsx('a', {
              href: TOP_UP_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: {
                // Match the width of the "更新于 …" status line above:
                // width:100% inside this column, whose width is driven by
                // the status text's intrinsic width.
                width: '100%',
                boxSizing: 'border-box',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 10px',
                borderRadius: 999,
                background: 'var(--dsw-alias-state-error-primary)',
                color: '#fff',
                fontSize: 11,
                lineHeight: '18px',
                fontWeight: 600,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                cursor: 'pointer'
              },
              children: '去官网充值'
            }) : null
          ] }),
          jsx('button', {
            type: 'button',
            style: refreshButtonStyle,
            'aria-label': '刷新',
            title: '刷新',
            disabled: spinning,
            onClick: function () { load() },
            children: refreshIcon
          }),
          panel
        ]
      })
    }

    // ---- client plugin body ---------------------------------------------
    var inject = ['slots']

    function apply(ctx) {
      try {
        // Keyframes + the strip's glass material; tagged so the module
        // system can reclaim it on HMR invalidate (same contract as CSS).
        if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin="dsh-usage-blance"]')) {
          var style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-usage-blance')
          style.textContent = [
            '@keyframes dsh-usage-blance-spin{to{transform:rotate(360deg)}}',
            // Glass: translucent theme-tinted surface + backdrop blur +
            // top sheen. `color-mix` keeps it theme-aware (light/dark);
            // the preceding opaque declaration is the fallback when
            // color-mix is unavailable. The material reads the live
            // preference through the --dshub-glass-* custom properties
            // set on the strip element by the control panel.
            '.dshub-strip{',
            'background:var(--dsw-specific-tip, #121c34);',
            'background:color-mix(in srgb, var(--dsw-specific-tip, #121c34) var(--dshub-glass-opacity, 52%), transparent);',
            '-webkit-backdrop-filter:blur(var(--dshub-glass-blur, 16px)) saturate(var(--dshub-glass-saturate, 1.4));',
            'backdrop-filter:blur(var(--dshub-glass-blur, 16px)) saturate(var(--dshub-glass-saturate, 1.4));',
            'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16));',
            'border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(255,255,255,.16)) 72%, transparent);',
            'box-shadow:0 6px 22px rgba(6,12,26,.18), inset 0 1px 0 rgba(255,255,255,.14);',
            '}',
            '.dshub-strip.dshub-glass-off{',
            'background:var(--dsw-specific-tip, #121c34);',
            '-webkit-backdrop-filter:none;',
            'backdrop-filter:none;',
            'border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.16));',
            '}',
            // Control panel columns: userToken left / theme right, stacked
            // on narrow screens.
            '.dshub-panel-cols{display:flex;gap:14px;align-items:flex-start}',
            '.dshub-panel-col{flex:1;min-width:0}',
            '.dshub-panel-col+.dshub-panel-col{border-left:1px solid var(--dsw-alias-border-l1);padding-left:14px}',
            '@media (max-width:680px){',
            '.dshub-panel-cols{flex-direction:column}',
            '.dshub-panel-col+.dshub-panel-col{border-left:none;padding-left:0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;margin-top:2px}',
            '}'
          ].join('')
          document.head.appendChild(style)
        }
        // The dock slots are declared by the conversation bundle;
        // `slots.inject` parks these registrations until each slot exists
        // (any load order). Both positions stay registered; the widget
        // renders only in the slot matching the saved preference.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-usage-blance-above',
          order: 0,
          label: 'DeepSeek 用量'
        }, function (slotProps) {
          return jsx(UsageDock, Object.assign({}, slotProps, { position: 'above' }))
        }))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-usage-blance-below',
          // Before the built-in "stats" entry (order 0 — the token
          // input/output/cache-hit line), so the strip sits directly
          // below the input box, above the stats line.
          order: -10,
          label: 'DeepSeek 用量'
        }, function (slotProps) {
          return jsx(UsageDock, Object.assign({}, slotProps, { position: 'below' }))
        }))
      } catch (err) {
        // Never crash the loader entry: log and degrade silently.
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-usage-blance]', err)
        }
      }
    }

    exports.apply = apply
    exports.inject = inject
    // Test seam: the shared preference stores (used by test/client.repro.mjs
    // to drive state without depending on synthetic input-event dispatch).
    exports._stores = { alertStore: alertStore }
    return module.exports
  }
})
