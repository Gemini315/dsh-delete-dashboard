'use strict'

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  ipcMain,
  dialog,
  shell,
  desktopCapturer,
} = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const TITLE_BAR_HEIGHT = 42
const STARTUP_TIMEOUT_MS = 90_000
const DASHBOARD_WIDTH = 288
// DeepSeek v4-flash 新计费（2026-08-16 16:00 UTC 生效）：峰值/非峰值，USD / 1M tokens。
// 峰值时段（UTC）：01:00-04:00 与 06:00-10:00；其余非峰值（= 峰值一半）。
// 如需 v4-pro，把单价换成 PEAK/OFFPEAK_PRO 即可。
const DASHBOARD_PRICES = {
  peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
}
const PEAK_HOUR_RANGES = [[1, 4], [6, 10]]
let dashboardOpen = false

let mainWindow
let harnessView
let harnessProcess
let harnessOrigin
let startupTimer
let quitting = false

function dataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts)
}

function writeLog(message) {
  try {
    const logDirectory = dataPath('logs')
    fs.mkdirSync(logDirectory, { recursive: true })
    fs.appendFileSync(
      path.join(logDirectory, 'desktop.log'),
      `${new Date().toISOString()} ${message}\n`,
      'utf8',
    )
  } catch {
    // Logging must never prevent the desktop shell from starting.
  }
}

function harnessRuntimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'harness')
    : path.join(__dirname, 'harness')
}


function harnessCliPath() {
  return path.join(
    harnessRuntimeRoot(),
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
}

function harnessNodePath() {
  return path.join(harnessRuntimeRoot(), 'runtime', 'node.exe')
}

async function startHarness() {
  const harnessHome = dataPath('harness-home')
  fs.mkdirSync(harnessHome, { recursive: true })

  return new Promise((resolve, reject) => {
    const cliPath = harnessCliPath()
    if (!fs.existsSync(cliPath)) {
      reject(new Error(`Bundled Harness CLI was not found: ${cliPath}`))
      return
    }

    const nodePath = harnessNodePath()
    if (!fs.existsSync(nodePath)) {
      reject(new Error(`Bundled Node.js runtime was not found: ${nodePath}`))
      return
    }

    writeLog(`Starting Harness from ${cliPath} with ${nodePath}`)
    harnessProcess = spawn(nodePath, [cliPath, 'web', '--port', '0'], {
      cwd: app.getPath('home'),
      env: {
        ...process.env,
        DSH_HOME: harnessHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let settled = false
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(startupTimer)
      if (error) reject(error)
      else resolve(url)
    }

    const inspectOutput = (source, chunk) => {
      const output = chunk
        .toString('utf8')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')

      for (const line of output.split(/\r?\n/)) {
        if (line.trim()) writeLog(`[dsh:${source}] ${line}`)
      }

      const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i)
      if (match) {
        harnessOrigin = new URL(match[0]).origin
        finish(undefined, match[0])
      }
    }

    harnessProcess.stdout.on('data', chunk => inspectOutput('out', chunk))
    harnessProcess.stderr.on('data', chunk => inspectOutput('err', chunk))

    harnessProcess.once('error', error => {
      writeLog(`[dsh:error] ${error.stack || error.message}`)
      finish(error)
    })

    harnessProcess.once('exit', (code, signal) => {
      writeLog(`[dsh:exit] code=${code} signal=${signal}`)
      harnessProcess = undefined

      if (!settled) {
        finish(new Error(`Harness exited during startup (code=${code}, signal=${signal})`))
      } else if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Harness service stopped',
          message: 'The DeepSeek Harness background service exited unexpectedly.',
          detail: `Exit code: ${code ?? 'unknown'}\nLogs: ${dataPath('logs')}`,
        })
      }
    })

    startupTimer = setTimeout(() => {
      finish(new Error(`Harness startup exceeded ${STARTUP_TIMEOUT_MS / 1000} seconds.`))
    }, STARTUP_TIMEOUT_MS)
  })
}

function stopHarness() {
  clearTimeout(startupTimer)
  if (!harnessProcess || harnessProcess.killed) return

  writeLog(`[desktop] Stopping Harness pid=${harnessProcess.pid}`)
  try {
    harnessProcess.kill()
  } catch (error) {
    writeLog(`[desktop] Failed to stop Harness: ${error.message}`)
  }
}

function isHarnessUrl(rawUrl) {
  if (!harnessOrigin) return false
  try {
    return new URL(rawUrl).origin === harnessOrigin
  } catch {
    return false
  }
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      writeLog(`[desktop] Blocked external protocol: ${url.protocol}`)
      return
    }
    void shell.openExternal(url.toString())
  } catch {
    writeLog('[desktop] Blocked malformed external URL.')
  }
}

function configureHarnessNavigation(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHarnessUrl(url)) {
      void webContents.loadURL(url)
    } else {
      openExternalUrl(url)
    }
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    if (isHarnessUrl(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })

  webContents.on('will-attach-webview', event => event.preventDefault())
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop:window-state', {
    maximized: mainWindow.isMaximized(),
    fullScreen: mainWindow.isFullScreen(),
  })
}

function setupWindowControlIpc() {
  ipcMain.on('desktop:window-control', (event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (event.sender !== mainWindow.webContents) return

    switch (action) {
      case 'minimize':
        mainWindow.minimize()
        break
      case 'toggle-maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
        break
      case 'close':
        mainWindow.close()
        break
      default:
        break
    }
  })

  ipcMain.handle('desktop:get-window-state', event => {
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, fullScreen: false }
    if (event.sender !== mainWindow.webContents) return { maximized: false, fullScreen: false }
    return {
      maximized: mainWindow.isMaximized(),
      fullScreen: mainWindow.isFullScreen(),
    }
  })
}

function layoutHarnessView() {
  if (!mainWindow || mainWindow.isDestroyed() || !harnessView) return
  const [width, height] = mainWindow.getContentSize()
  // 展开时预留仪表盘宽度；收起时预留右侧竖条标签的宽度，保证标签不被遮挡。
  const reserved = dashboardOpen ? DASHBOARD_WIDTH : 34
  harnessView.setBounds({
    x: 0,
    y: TITLE_BAR_HEIGHT,
    width: Math.max(0, width - reserved),
    height: Math.max(0, height - TITLE_BAR_HEIGHT),
  })
}

async function attachHarnessView(url) {
  harnessView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (typeof harnessView.setBackgroundColor === 'function') {
    harnessView.setBackgroundColor('#ffffff')
  }

  mainWindow.contentView.addChildView(harnessView)
  layoutHarnessView()
  configureHarnessNavigation(harnessView.webContents)

  harnessView.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    const nextTitle = title?.trim() || 'DeepSeek Harness'
    mainWindow?.setTitle(nextTitle)
    mainWindow?.webContents.send('desktop:page-title', nextTitle)
  })

  harnessView.webContents.on('render-process-gone', (_event, details) => {
    writeLog(`[desktop] Harness renderer gone: ${JSON.stringify(details)}`)
  })

  await harnessView.webContents.loadURL(url)
}

async function captureComposedWindow(filename) {
  await new Promise(resolve => setTimeout(resolve, 2_000))
  const screenshotPath = path.resolve(filename)
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })

  const bounds = mainWindow.getBounds()
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    },
    fetchWindowIcons: false,
  })

  const source = sources.find(item => item.name === mainWindow.getTitle())
    ?? sources.find(item => /DeepSeek Harness/i.test(item.name))

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('The composed Electron window was not available to desktopCapturer.')
  }

  fs.writeFileSync(screenshotPath, source.thumbnail.toPNG())
  writeLog(`[desktop] QA screenshot saved to ${screenshotPath}`)
}

function waitForWindowState(predicate, description, timeoutMs = 5_000) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const check = () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        reject(new Error(`Window was destroyed while waiting for ${description}.`))
        return
      }

      if (predicate(mainWindow)) {
        resolve()
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`))
        return
      }

      setTimeout(check, 50)
    }

    check()
  })
}

async function clickTitleBarButton(buttonId) {
  const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.getElementById(${JSON.stringify(buttonId)})
    if (!button) return false
    button.click()
    return true
  })()`)

  if (!clicked) throw new Error(`Title-bar button was not found: ${buttonId}`)
}

async function exerciseWindowControls() {
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  if (mainWindow.isMinimized()) mainWindow.restore()

  await clickTitleBarButton('maximize')
  await waitForWindowState(window => window.isMaximized(), 'the custom maximize action')

  await clickTitleBarButton('maximize')
  await waitForWindowState(window => !window.isMaximized(), 'the custom restore action')

  await clickTitleBarButton('minimize')
  await waitForWindowState(window => window.isMinimized(), 'the custom minimize action')

  mainWindow.restore()
  mainWindow.show()
  await waitForWindowState(window => !window.isMinimized(), 'the restored test window')

  writeLog('[desktop] Window controls QA passed: maximize, restore, minimize')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    icon: path.join(__dirname, 'build', 'deepseek-harness.svg'),
    backgroundColor: '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.removeMenu()
  mainWindow.setMenuBarVisibility(false)
  mainWindow.on('resize', layoutHarnessView)
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.on('enter-full-screen', sendWindowState)
  mainWindow.on('leave-full-screen', sendWindowState)
  mainWindow.on('closed', () => {
    harnessView = undefined
    mainWindow = undefined
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  await mainWindow.loadFile(path.join(__dirname, 'shell.html'))
  sendWindowState()

  try {
    const url = await startHarness()
    writeLog(`[desktop] Loading ${url}`)
    await attachHarnessView(url)

    const rendererState = await harnessView.webContents.executeJavaScript(`({
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.length ?? 0,
    })`)
    writeLog(`[desktop] Renderer ready ${JSON.stringify(rendererState)}`)

    const qaScreenshot = process.env.DSH_DESKTOP_QA_SCREENSHOT
    if (qaScreenshot) await captureComposedWindow(qaScreenshot)

    const qaWindowControls = process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1'
    if (qaWindowControls) await exerciseWindowControls()

    if (process.env.DSH_DESKTOP_QA_AUTO_QUIT === '1') {
      if (qaWindowControls) {
        writeLog('[desktop] Testing the custom close action')
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return
          void clickTitleBarButton('close').catch(error => {
            writeLog(`[desktop:error] Custom close QA failed: ${error.message}`)
            app.quit()
          })
        }, 250)
      } else {
        setTimeout(() => app.quit(), 250)
      }
    }
  } catch (error) {
    writeLog(`[desktop:error] ${error.stack || error.message}`)
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Startup failed',
      message: 'DeepSeek Harness could not be started.',
      detail: `${error.message}\n\nLogs: ${dataPath('logs')}`,
    })
    app.quit()
  }
}

setupWindowControlIpc()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setName(PRODUCT_NAME)
    app.setAppUserModelId('ai.deepseek.harness.desktop.unofficial')
    Menu.setApplicationMenu(null)
    return createWindow()
  }).catch(error => {
    writeLog(`[desktop:fatal] ${error.stack || error.message}`)
    dialog.showErrorBox('Startup failed', error.message)
    app.quit()
  })
}

app.on('before-quit', () => {
  quitting = true
  stopHarness()
})

app.on('window-all-closed', () => app.quit())

// ---------------------------------------------------------------------------
// 会话仪表盘（只统计当前会话）：余额来自 DeepSeek 账户，其余指标仅针对
// 当前打开的会话（新开会话从零开始）。
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 0xFD2FB528

/** 解析输入中的所有 zstd 帧范围（上游同款逻辑）。 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push(buffer.subarray(start, offset))
  }
  return frames
}

/** 在 sessions 根下递归查找指定会话的日志文件。 */
async function findSessionArtifact(sessionsRoot, sessionId) {
  let entries
  try { entries = await fs.promises.readdir(sessionsRoot, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    const full = path.join(sessionsRoot, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === sessionId) {
        const zstd = path.join(full, 'session.jsonl.zstd')
        const plain = path.join(full, 'session.jsonl')
        try { await fs.promises.access(zstd); return zstd } catch { /* fall through */ }
        try { await fs.promises.access(plain); return plain } catch { /* keep scanning */ }
      }
      const nested = await findSessionArtifact(full, sessionId)
      if (nested) return nested
    }
  }
  return null
}

/** 只统计指定会话的 tokens/请求/时间/费用（新开会话从零开始）。 */
async function readSessionStats(sessionId) {
  const sessionsRoot = path.join(dataPath('harness-home'), 'sessions')
  const artifact = await findSessionArtifact(sessionsRoot, sessionId)
  if (!artifact) return { tokens: 0, cost: null, requests: 0, runtimeText: '—' }
  let promptTokens = 0
  let completionTokens = 0
  let costUsd = 0
  let requests = 0
  let firstTime = Infinity
  let lastTime = 0
  try {
    let text
    if (artifact.endsWith('.zstd')) {
      const { zstdDecompress } = require('node:zlib')
      const { promisify } = require('node:util')
      const decompress = promisify(zstdDecompress)
      const raw = await fs.promises.readFile(artifact)
      let out = ''
      for (const frame of scanZstdFrames(raw)) out += (await decompress(frame)).toString('utf8')
      text = out
    } else {
      text = await fs.promises.readFile(artifact, 'utf8')
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const type = event && event.type
      if (type === 'user/message') requests++
      else if (type === 'assistant/chunk') {
        const chunk = event && event.data && event.data.chunk
        if (chunk && chunk.type === 'usage' && chunk.usage) {
          promptTokens += Number(chunk.usage.inputTokens ?? 0) || 0
          completionTokens += Number(chunk.usage.outputTokens ?? 0) || 0
          const input = Number(chunk.usage.inputTokens ?? 0) || 0
          const output = Number(chunk.usage.outputTokens ?? 0) || 0
          const cacheRead = Number(chunk.usage.cacheReadTokens ?? 0) || 0
          const cacheWrite = Number(chunk.usage.cacheWriteTokens ?? 0) || 0
          // 峰值/非峰值按该次请求的发生时间（UTC 小时）判定。
          const utcHour = new Date(event.time ?? Date.now()).getUTCHours()
          const isPeak = PEAK_HOUR_RANGES.some(([s, e]) => utcHour >= s && utcHour < e)
          const p = isPeak ? DASHBOARD_PRICES.peak : DASHBOARD_PRICES.offPeak
          costUsd += input / 1e6 * p.cacheMiss
          costUsd += (cacheRead + cacheWrite) / 1e6 * p.cacheHit
          costUsd += output / 1e6 * p.output
        }
      }
      if (typeof event.time === 'number') {
        if (event.time < firstTime) firstTime = event.time
        if (event.time > lastTime) lastTime = event.time
      }
    }
  } catch { /* 统计失败时返回零值 */ }
  const total = promptTokens + completionTokens
  const cost = costUsd
  const runtimeMs = lastTime - firstTime
  const runtimeText = runtimeMs > 0 ? `${Math.floor(runtimeMs / 60000)}分${Math.floor((runtimeMs % 60000) / 1000)}秒` : '—'
  return { tokens: total, cost, requests, runtimeText }
}

/** 查询当前会话：优先读 harness 前端暴露的当前会话，失败时回退到 session.list 最近活跃。 */
async function getCurrentSessionId() {
  // 前端 sessions.open() 时设置 window.__dshCurrentSession（上游 runtime 已注入）。
  try {
    if (harnessView && !harnessView.webContents.isDestroyed()) {
      const value = await harnessView.webContents.executeJavaScript('window.__dshCurrentSession || null', true)
      if (value && typeof value === 'string') return value
    }
  } catch { /* 前端不可达时走 session.list 回退 */ }
  if (!harnessOrigin) return null
  try {
    const response = await fetch(harnessOrigin + '/api/session.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'dash-list', method: 'session.list', payload: {} }),
    })
    const body = await response.json()
    const items = body && body.result && body.result.value && body.result.value.items
    if (!items || !items.length) return null
    let best = items[0]
    for (const item of items) { if (item.updatedAt > best.updatedAt) best = item }
    return best.sessionId || null
  } catch { return null }
}

/** 查询 DeepSeek 账户余额（全局实际值）。 */
async function fetchDeepSeekBalance() {
  let key = ''
  try {
    const text = await fs.promises.readFile(path.join(dataPath('harness-home'), '.credentials.yaml'), 'utf8')
    const line = text.split('\n').find(l => l.startsWith('DEEPSEEK_API_KEY:'))
    if (line) key = line.split(/:\s*/)[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* 无凭据文件时跳过 */ }
  if (!key) return null
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!response.ok) return null
    const body = await response.json()
    const total = body && body.balance_infos && body.balance_infos[0] && body.balance_infos[0].total_balance
    return total === undefined || total === null ? null : Number(total)
  } catch { return null }
}

/** 注册仪表盘 IPC（可在模块加载时注册，event.sender 校验窗口）。 */
let lastBalanceFetch = 0
let cachedBalance = null
let statsCache = { sessionId: null, mtimeMs: 0, stats: null }

function registerDashboardIpc() {
  ipcMain.handle('desktop:dashboard-data', async event => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) return null
    try {
      const sessionId = await getCurrentSessionId()
      // 会话统计缓存：文件未变化就不重读（避免反复解压大日志）。
      let stats
      if (sessionId) {
        const artifact = await findSessionArtifact(path.join(dataPath('harness-home'), 'sessions'), sessionId)
        if (artifact) {
          const stat = await fs.promises.stat(artifact)
          if (statsCache.sessionId === sessionId && statsCache.mtimeMs === stat.mtimeMs) {
            stats = statsCache.stats
          } else {
            stats = await readSessionStats(sessionId)
            statsCache = { sessionId, mtimeMs: stat.mtimeMs, stats }
          }
        } else {
          stats = await readSessionStats(sessionId)
        }
      } else {
        stats = { tokens: 0, cost: null, requests: 0, runtimeText: '—' }
      }
      // 余额缓存 60 秒（避免频繁调外部 API）。
      const now = Date.now()
      if (now - lastBalanceFetch > 60_000) {
        cachedBalance = await fetchDeepSeekBalance()
        lastBalanceFetch = now
      }
      // 读取 harness 前端当前主题 token（跟随 dsh 通用设置里的浅色/深色）。
      let theme = null
      try {
        if (harnessView && !harnessView.webContents.isDestroyed()) {
          theme = await harnessView.webContents.executeJavaScript(`(() => {
            const s = getComputedStyle(document.documentElement)
            const v = (n) => s.getPropertyValue(n).trim()
            return {
              panel: v('--dsw-alias-bg-layer-1') || v('--dsw-alias-bg-base'),
              border: v('--dsw-alias-border-l1'),
              text: v('--dsw-alias-label-primary'),
              label: v('--dsw-alias-label-secondary'),
            }
          })()`, true)
        }
      } catch { /* 前端不可达时保持默认主题 */ }
      return { ...stats, balance: cachedBalance, sessionId, theme }
    } catch (error) {
      writeLog(`[desktop:dashboard] error: ${error.message}`)
      return { tokens: 0, cost: null, requests: 0, runtimeText: '—', balance: null, sessionId: null }
    }
  })

  ipcMain.handle('desktop:dashboard-toggle', async event => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) return dashboardOpen
    dashboardOpen = !dashboardOpen
    layoutHarnessView()
    if (dashboardOpen) {
      // 以当前会话为基线（外壳打开面板时也会立即刷新一次），后续轮询只对
      // “会话发生变化”推送刷新事件，避免打开面板时的冗余刷新。
      lastDashboardSessionId = await getCurrentSessionId()
      startDashboardWatcher()
    } else {
      stopDashboardWatcher()
    }
    return dashboardOpen
  })

  ipcMain.handle('desktop:dashboard-state', event => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) return dashboardOpen
    return dashboardOpen
  })
}

registerDashboardIpc()

// ---------------------------------------------------------------------------
// 会话切换监听：仪表盘展开期间轮询前端注入的当前会话 id。前端每次
// sessions.open() 都会同步更新 window.__dshCurrentSession（上游 runtime 注入），
// 因此一旦检测到切换就推送刷新事件，仪表盘立即重算目标会话的统计——
// 无需在目标会话里发送任何消息。
// ---------------------------------------------------------------------------
const DASHBOARD_POLL_INTERVAL_MS = 1000
let dashboardWatcherTimer
let lastDashboardSessionId

async function pollDashboardSession() {
  if (!dashboardOpen || !harnessView || harnessView.webContents.isDestroyed()) return
  let sessionId
  try {
    sessionId = await getCurrentSessionId()
  } catch {
    return
  }
  if (sessionId === lastDashboardSessionId) return
  lastDashboardSessionId = sessionId
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:dashboard-refresh', sessionId)
  }
}

function startDashboardWatcher() {
  if (dashboardWatcherTimer) return
  dashboardWatcherTimer = setInterval(() => {
    void pollDashboardSession()
  }, DASHBOARD_POLL_INTERVAL_MS)
}

function stopDashboardWatcher() {
  clearInterval(dashboardWatcherTimer)
  dashboardWatcherTimer = undefined
  lastDashboardSessionId = undefined
}
