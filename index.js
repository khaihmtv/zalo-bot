/**
 * Zalo Bot - Simplified (no Redis/BullMQ)
 *
 * API:
 *   GET  /qr        → QR đăng nhập (live refresh)
 *   GET  /qr-image  → QR ảnh PNG
 *   GET  /status    → Trạng thái bot
 *   POST /send      → Gửi tin nhắn { "to": "...", "message": "..." }
 *   GET  /logs      → Xem log HTML
 *   GET  /logsjson  → Xem log JSON
 *   GET  /logout    → Đăng xuất
 */

const express = require("express")
const { chromium } = require("playwright")
const fs = require("fs")
const path = require("path")

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000
const SESSION_FILE = path.resolve(__dirname, "session.json")
const LOG_FILE = path.resolve(__dirname, "logs.json")

// ──────────────────────────────────────────────
// Trạng thái
// ──────────────────────────────────────────────
let browser = null
let context = null
let page = null
let qrBuffer = null
let loggedIn = false
let isSending = false  // tránh gửi đồng thời

// ──────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────
function readLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const raw = fs.readFileSync(LOG_FILE, "utf-8").trim()
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function writeLog(entry) {
  const logs = readLogs()
  logs.unshift(entry)
  if (logs.length > 500) logs.splice(500)
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), "utf-8")
  const icon = entry.status === "success" ? "✓" : entry.status === "warning" ? "⚠" : "✗"
  console.log(`[Log] ${icon} to="${entry.to}" | ${entry.status} | ${entry.note || ""}`)
}

// ──────────────────────────────────────────────
// Browser
// ──────────────────────────────────────────────
async function startBrowser() {
  if (browser) return

  console.log("[Browser] Đang khởi động...")

  browser = await chromium.launch({
    headless: true,
    slowMo: 300,
    args: [
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ]
  })

  browser.on("disconnected", async () => {
    console.log("[Browser] Bị ngắt, khởi động lại...")
    browser = null; context = null; page = null; loggedIn = false
    await startBrowser()
  })

  // Load session nếu có và hợp lệ
  let contextOptions = {}
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, "utf-8").trim()
      if (raw && raw.startsWith("{")) {
        contextOptions = { storageState: SESSION_FILE }
        console.log("[Browser] Load session cũ...")
      }
    }
  } catch {}

  context = await browser.newContext(contextOptions)
  page = await context.newPage()

  await page.goto("https://chat.zalo.me", { waitUntil: "domcontentloaded", timeout: 60000 })
  await page.waitForTimeout(5000)

  // Thử nhiều selector để xác nhận đã login
  const isLoggedIn = await (async () => {
    const selectors = ["#contact-search-input", "[placeholder*='Tìm']", "[class*='main-panel']", "[class*='sidebar']"]
    for (const sel of selectors) {
      const v = await page.locator(sel).isVisible({ timeout: 4000 }).catch(() => false)
      if (v) return true
    }
    return false
  })()

  if (isLoggedIn) {
    loggedIn = true
    console.log("[Browser] Đã đăng nhập ✓")
    await closePopupIfAny()
  } else {
    console.log("[Browser] Chưa đăng nhập, chờ quét QR...")
    startQrLoop()
    waitForLogin()
  }
}

async function closePopupIfAny() {
  try {
    const closeBtn = page.locator('text=Đóng')
    if (await closeBtn.isVisible({ timeout: 2000 })) await closeBtn.click()
  } catch {}
}

function startQrLoop() {
  const interval = setInterval(async () => {
    if (loggedIn) return clearInterval(interval)
    try {
      // Click "Lấy mã mới" nếu QR hết hạn (thẻ <a class="btn btn--s">)
      const refreshBtn = page.locator("a.btn.btn--s, a.btn--s").filter({ hasText: /Lấy mã mới/i }).first()
      if (await refreshBtn.isVisible({ timeout: 300 })) {
        console.log("[QR] Mã hết hạn, đang lấy mã mới...")
        await refreshBtn.click()
        await page.waitForTimeout(2000)
        return
      }

      // Chụp ảnh QR từ thẻ <img> trong div.qrcode (không phải canvas)
      const qrImg = page.locator("div.qrcode img.img, div.qr-container img").first()
      if (await qrImg.isVisible({ timeout: 300 })) {
        const buf = await qrImg.screenshot()
        if (buf && buf.length > 1024) {
          qrBuffer = buf
          return
        }
      }

      // Fallback: chụp toàn bộ div.qrcode
      const qrBox = page.locator("div.qrcode, div.qr-container").first()
      if (await qrBox.isVisible({ timeout: 300 })) {
        const buf = await qrBox.screenshot()
        if (buf && buf.length > 1024) {
          qrBuffer = buf
        }
      }

    } catch {}
  }, 1000)
}

function waitForLogin() {
  page.waitForURL("https://chat.zalo.me/**", { timeout: 300000 }).then(async () => {
    try {
      const currentUrl = page.url()
      console.log("[Browser] URL hiện tại:", currentUrl)

      // Chờ trang chat load thật sự
      await page.waitForTimeout(6000)
      await closePopupIfAny()

      // Xác nhận đã login bằng cách check search box
      console.log("[Browser] Đang chờ search box...")
      const searchVisible = await page.locator("#contact-search-input").isVisible({ timeout: 40000 }).catch(() => false)
      console.log("[Browser] Search box visible:", searchVisible)

      if (!searchVisible) {
        console.log("[Browser] Chưa thấy search box, URL hiện tại:", page.url())
        loggedIn = false
        startQrLoop()
        waitForLogin()
        return
      }

      loggedIn = true
      qrBuffer = null
      await context.storageState({ path: SESSION_FILE })
      console.log("[Browser] Đăng nhập thành công ✓ Session đã lưu")
      console.log("[Browser] Trang chat sẵn sàng ✓")

    } catch (e) {
      console.error("[Browser] Lỗi sau login:", e.message)
    }
  }).catch(() => {})
}

// ──────────────────────────────────────────────
// Gửi tin nhắn (xử lý trực tiếp, không queue)
// ──────────────────────────────────────────────
async function sendMessage(to, message) {
  const timestamp = new Date().toISOString()

  if (!loggedIn || !page) {
    const entry = { timestamp, to, message, status: "failed", note: "Chưa đăng nhập Zalo" }
    writeLog(entry)
    throw new Error(entry.note)
  }

  if (isSending) {
    const entry = { timestamp, to, message, status: "failed", note: "Bot đang bận gửi tin khác, thử lại sau" }
    writeLog(entry)
    throw new Error(entry.note)
  }

  isSending = true

  try {
    // Kiểm tra trang còn sống
    const alive = await page.locator("#contact-search-input").isVisible({ timeout: 5000 }).catch(() => false)
    if (!alive) {
      console.log("[Send] Trang mất, navigate lại...")
      await page.goto("https://chat.zalo.me", { waitUntil: "domcontentloaded", timeout: 60000 })
      await page.waitForTimeout(5000)
      await closePopupIfAny()
      await page.locator("#contact-search-input").waitFor({ timeout: 30000 })
    }

    // Tìm người dùng
    const searchBox = page.locator("#contact-search-input")
    await searchBox.click()
    await searchBox.fill(to)
    await page.waitForTimeout(2000)

    const user = page.locator(".conv-item").filter({ hasText: to }).first()
    const found = await user.isVisible({ timeout: 8000 }).catch(() => false)
    if (!found) {
      const entry = { timestamp, to, message, status: "failed", note: `Không tìm thấy "${to}"` }
      writeLog(entry)
      throw new Error(entry.note)
    }

    await user.click()

    const chatBox = await page.waitForSelector("#richInput", { timeout: 20000 })
    await chatBox.click()
    await chatBox.fill(message)
    await page.keyboard.press("Enter")
    await page.waitForTimeout(2500)

    // Xác minh
    let verified = false
    let verifyNote = ""
    try {
      const el = page.getByText(message, { exact: false }).last()
      if (await el.isVisible({ timeout: 4000 })) { verified = true; verifyNote = "Tìm thấy tin nhắn trong chat" }
    } catch {}

    if (!verified) {
      try {
        const inputText = await page.locator("#richInput").innerText({ timeout: 2000 })
        if (inputText.trim() === "") { verified = true; verifyNote = "Chatbox đã xóa sau khi gửi" }
      } catch {}
    }

    writeLog({ timestamp, to, message, status: verified ? "success" : "warning", note: verified ? verifyNote : "Đã gửi nhưng không xác minh được" })

  } catch (err) {
    const logs = readLogs()
    if (!logs.length || logs[0].timestamp !== timestamp) {
      writeLog({ timestamp, to, message, status: "failed", note: err.message })
    }
    throw err
  } finally {
    isSending = false
  }
}

// ──────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ──────────────────────────────────────────────
// Express API
// ──────────────────────────────────────────────
const app = express()
app.use(express.json())

app.get("/", (req, res) => {
  const statusColor = loggedIn ? "#22c55e" : "#ef4444"
  const statusText = loggedIn ? "✅ Đã đăng nhập" : "❌ Chưa đăng nhập"
  res.send(`<!DOCTYPE html><html><head>
    <title>Zalo Bot</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;padding:16px}
      .card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.08);margin-bottom:16px}
      h1{font-size:22px;font-weight:700;color:#1a1a1a;display:flex;align-items:center;gap:8px}
      .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:14px;font-weight:600;background:${loggedIn?"#dcfce7":"#fee2e2"};color:${loggedIn?"#166534":"#991b1b"};margin-top:12px}
      .nav-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px}
      .nav-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px 12px;border-radius:12px;text-decoration:none;font-size:13px;font-weight:600;gap:6px;transition:transform .1s,box-shadow .1s}
      .nav-btn:active{transform:scale(0.97)}
      .nav-btn .icon{font-size:24px}
      .nav-btn.green{background:#dcfce7;color:#166534}
      .nav-btn.blue{background:#dbeafe;color:#1e40af}
      .nav-btn.purple{background:#ede9fe;color:#5b21b6}
      .nav-btn.orange{background:#ffedd5;color:#9a3412}
      .nav-btn.gray{background:#f3f4f6;color:#374151}
      .nav-btn.red{background:#fee2e2;color:#991b1b}
      .api-box{background:#1e1e2e;border-radius:12px;padding:16px;margin-top:4px}
      .api-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;font-size:13px}
      .api-row:last-child{margin-bottom:0}
      .method{background:#3b82f6;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
      .method.post{background:#22c55e}
      .api-path{color:#e2e8f0;font-family:monospace}
      .api-desc{color:#94a3b8;font-size:12px;margin-top:2px}
      h2{font-size:15px;font-weight:600;color:#374151;margin-bottom:12px}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>🤖 Zalo Bot</h1>
      <div class="badge">${statusText}</div>
    </div>

    <div class="card">
      <h2>📱 Điều hướng nhanh</h2>
      <div class="nav-grid">
        <a href="/qr" class="nav-btn green">
          <span class="icon">📷</span>Quét QR
        </a>
        <a href="/logs" class="nav-btn blue">
          <span class="icon">📋</span>Xem Logs
        </a>
        <a href="/status" class="nav-btn purple">
          <span class="icon">📊</span>Trạng thái
        </a>
        <a href="/logsjson" class="nav-btn orange" target="_blank">
          <span class="icon">📦</span>Logs JSON
        </a>
        <a href="/logout" class="nav-btn red" onclick="return confirm('Bạn chắc muốn đăng xuất?')">
          <span class="icon">🚪</span>Đăng xuất
        </a>
      </div>
    </div>

    <div class="card">
      <h2>🔌 API Endpoints</h2>
      <div class="api-box">
        <div class="api-row"><span class="method">GET</span><div><div class="api-path">/qr</div><div class="api-desc">QR đăng nhập Zalo</div></div></div>
        <div class="api-row"><span class="method">GET</span><div><div class="api-path">/status</div><div class="api-desc">Trạng thái bot + thống kê</div></div></div>
        <div class="api-row"><span class="method post">POST</span><div><div class="api-path">/send</div><div class="api-desc">{"to":"...","message":"..."}</div></div></div>
        <div class="api-row"><span class="method">GET</span><div><div class="api-path">/logs</div><div class="api-desc">Lịch sử gửi tin</div></div></div>
        <div class="api-row"><span class="method">GET</span><div><div class="api-path">/logsjson</div><div class="api-desc">Logs dạng JSON</div></div></div>
        <div class="api-row"><span class="method">GET</span><div><div class="api-path">/logout</div><div class="api-desc">Đăng xuất + xóa session</div></div></div>
      </div>
    </div>
  </body></html>`)
})

app.get("/qr-image", (req, res) => {
  if (loggedIn) return res.status(200).send("logged_in")
  if (!qrBuffer) return res.status(204).send()
  res.setHeader("Content-Type", "image/png")
  res.setHeader("Cache-Control", "no-store")
  res.send(qrBuffer)
})

app.get("/qr", async (req, res) => {
  await startBrowser()
  if (loggedIn) return res.send("<h3 style='font-family:sans-serif;text-align:center;margin-top:80px'>✅ Đã đăng nhập rồi!</h3>")
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Zalo QR</title>
    <style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;color:#fff}
    #qr-box{background:#fff;padding:16px;border-radius:12px}img{display:block;width:260px;height:260px}
    p{margin-top:16px;color:#aaa;font-size:14px}#status{margin-top:8px;font-size:13px;color:#888}</style>
    </head><body>
    <div id="qr-box"><img id="qr-img" src="/qr-image?t=0"/></div>
    <p>Mở Zalo → Quét mã QR để đăng nhập</p>
    <div id="status">Đang tải mã QR...</div>
    <script>
      let t=0
      function refresh(){
        t++
        fetch('/qr-image?t='+t).then(r=>{
          if(r.status===200&&r.headers.get('content-type')==='image/png'){
            document.getElementById('qr-img').src='/qr-image?t='+t
            document.getElementById('status').textContent='Cập nhật lúc '+new Date().toLocaleTimeString('vi-VN')
          } else if(r.status===200){
            document.body.innerHTML='<h2 style="color:#4ade80;font-family:sans-serif">✅ Đăng nhập thành công!</h2>'
            return
          }
          setTimeout(refresh,1500)
        }).catch(()=>setTimeout(refresh,2000))
      }
      setTimeout(refresh,1500)
    </script></body></html>`)
})

app.get("/status", (req, res) => {
  const logs = readLogs()
  res.json({
    loggedIn, isSending,
    sessionExists: fs.existsSync(SESSION_FILE),
    stats: {
      total: logs.length,
      success: logs.filter(l => l.status === "success").length,
      warning: logs.filter(l => l.status === "warning").length,
      failed: logs.filter(l => l.status === "failed").length,
    }
  })
})

app.post("/send", async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Thiếu "to" hoặc "message"' })
  if (!loggedIn) return res.status(403).json({ error: "Chưa đăng nhập. Vào /qr để quét mã" })
  if (isSending) return res.status(429).json({ error: "Bot đang bận, thử lại sau vài giây" })

  try {
    await sendMessage(to, message)
    const lastLog = readLogs()[0]
    res.json({ status: lastLog.status, note: lastLog.note, to, message })
  } catch (err) {
    res.status(500).json({ status: "failed", error: err.message })
  }
})

app.get("/logs/delete", (req, res) => {
  const { ids } = req.query
  if (!ids) return res.status(400).json({ error: "Thiếu ids" })
  const idList = ids.split(",").map(Number)
  let logs = readLogs()
  logs = logs.filter((_, i) => !idList.includes(i))
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), "utf-8")
  res.json({ ok: true, remaining: logs.length })
})

app.get("/logs", (req, res) => {
  const logs = readLogs()
  const total = logs.length
  const success = logs.filter(l => l.status === "success").length
  const warning = logs.filter(l => l.status === "warning").length
  const failed = logs.filter(l => l.status === "failed").length

  const cards = logs.map((l, i) => {
    const icon = l.status === "success" ? "✅" : l.status === "warning" ? "⚠️" : "❌"
    const border = l.status === "success" ? "#22c55e" : l.status === "warning" ? "#f59e0b" : "#ef4444"
    const bg = l.status === "success" ? "#f0fff4" : l.status === "warning" ? "#fffbeb" : "#fff1f1"
    const time = new Date(l.timestamp).toLocaleString("vi-VN")
    return `<div class="log-card" data-id="${i}" style="border-left:4px solid ${border};background:${bg}">
      <div class="log-header">
        <label class="cb-wrap"><input type="checkbox" class="cb" data-id="${i}"/><span class="cb-box"></span></label>
        <span class="log-status">${icon} ${escHtml(l.status)}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="log-body">
        <div class="log-row"><span class="log-label">Người nhận</span><span class="log-val">${escHtml(l.to)}</span></div>
        <div class="log-row"><span class="log-label">Nội dung</span><span class="log-val">${escHtml(l.message)}</span></div>
        <div class="log-row"><span class="log-label">Ghi chú</span><span class="log-val log-note">${escHtml(l.note||"")}</span></div>
      </div>
    </div>`
  }).join("")

  res.send(`<!DOCTYPE html><html><head>
    <title>Zalo Bot - Logs</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;padding:16px}
      h1{font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:12px}
      .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
      .back{color:#3b82f6;text-decoration:none;font-size:14px;font-weight:600}
      .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
      .stat{background:#fff;border-radius:12px;padding:10px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
      .stat b{font-size:20px;display:block;font-weight:700}
      .stat span{font-size:11px;color:#666}
      .actions{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
      .btn{padding:9px 14px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px}
      .btn-check{background:#dbeafe;color:#1e40af}
      .btn-uncheck{background:#f3f4f6;color:#374151}
      .btn-delete{background:#fee2e2;color:#991b1b}
      .btn:active{opacity:0.75}
      .log-card{background:#fff;border-radius:12px;padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
      .log-card.checked{box-shadow:0 0 0 2px #3b82f6}
      .log-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .log-status{font-size:13px;font-weight:600;flex:1}
      .log-time{font-size:11px;color:#888;white-space:nowrap}
      .log-body{display:flex;flex-direction:column;gap:6px}
      .log-row{display:flex;gap:8px;align-items:flex-start}
      .log-label{font-size:11px;font-weight:700;color:#6b7280;min-width:76px;text-transform:uppercase;padding-top:2px}
      .log-val{font-size:13px;color:#1a1a1a;flex:1;word-break:break-word}
      .log-note{color:#6b7280;font-size:12px}
      .cb-wrap{display:flex;align-items:center;cursor:pointer;flex-shrink:0}
      .cb{display:none}
      .cb-box{width:22px;height:22px;border-radius:6px;border:2px solid #d1d5db;background:#fff;display:flex;align-items:center;justify-content:center}
      .cb:checked+.cb-box{background:#3b82f6;border-color:#3b82f6}
      .cb:checked+.cb-box::after{content:"✓";color:#fff;font-size:14px;font-weight:700}
      .empty{text-align:center;color:#9ca3af;padding:40px 0;font-size:15px}
      .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 22px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:99;white-space:nowrap}
      .toast.show{opacity:1}
    </style>
  </head>
  <body>
    <div class="topbar">
      <a href="/" class="back">← Trang chủ</a>
      <a href="/logsjson" target="_blank" style="color:#f59e0b;text-decoration:none;font-size:13px;font-weight:600">📦 JSON</a>
    </div>

    <h1>📋 Lịch sử gửi tin</h1>

    <div class="stats">
      <div class="stat"><b>${total}</b><span>Tổng</span></div>
      <div class="stat" style="border-top:3px solid #22c55e"><b>${success}</b><span>✅ OK</span></div>
      <div class="stat" style="border-top:3px solid #f59e0b"><b>${warning}</b><span>⚠️ Warn</span></div>
      <div class="stat" style="border-top:3px solid #ef4444"><b>${failed}</b><span>❌ Lỗi</span></div>
    </div>

    <div class="actions">
      <button class="btn btn-check" onclick="checkAll()">☑️ Chọn tất cả</button>
      <button class="btn btn-uncheck" onclick="uncheckAll()">⬜ Bỏ chọn</button>
      <button class="btn btn-delete" onclick="deleteChecked()">🗑️ Xóa đã chọn</button>
    </div>

    <div id="log-list">
      ${logs.length === 0 ? '<div class="empty">Chưa có log nào 🎉</div>' : cards}
    </div>

    <div class="toast" id="toast"></div>

    <script>
      function showToast(msg){
        const t=document.getElementById("toast")
        t.textContent=msg;t.classList.add("show")
        setTimeout(()=>t.classList.remove("show"),2500)
      }
      document.querySelectorAll(".cb").forEach(cb=>{
        cb.addEventListener("change",()=>cb.closest(".log-card").classList.toggle("checked",cb.checked))
      })
      function checkAll(){
        document.querySelectorAll(".cb").forEach(cb=>{cb.checked=true;cb.closest(".log-card").classList.add("checked")})
        showToast("Đã chọn tất cả")
      }
      function uncheckAll(){
        document.querySelectorAll(".cb").forEach(cb=>{cb.checked=false;cb.closest(".log-card").classList.remove("checked")})
        showToast("Đã bỏ chọn")
      }
      function deleteChecked(){
        const checked=[...document.querySelectorAll(".cb:checked")].map(cb=>cb.dataset.id)
        if(!checked.length){showToast("Chưa chọn log nào");return}
        if(!confirm("Xóa "+checked.length+" log đã chọn?"))return
        fetch("/logs/delete?ids="+checked.join(","))
          .then(r=>r.json())
          .then(()=>{
            checked.forEach(id=>{
              const c=document.querySelector('.log-card[data-id="'+id+'"]')
              if(c)c.remove()
            })
            showToast("Đã xóa "+checked.length+" log")
          })
          .catch(()=>showToast("Lỗi khi xóa"))
      }
    </script>
  </body></html>`)
})

app.get("/logsjson", (req, res) => {
  const logs = readLogs()
  res.json({
    total: logs.length,
    stats: {
      success: logs.filter(l => l.status === "success").length,
      warning: logs.filter(l => l.status === "warning").length,
      failed: logs.filter(l => l.status === "failed").length,
    },
    logs,
  })
})

app.get("/logout", async (req, res) => {
  loggedIn = false; qrBuffer = null
  if (browser) await browser.close().catch(() => {})
  browser = null; context = null; page = null
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE)
  res.send("✅ Đã đăng xuất")
})

// ──────────────────────────────────────────────
// Khởi động
// ──────────────────────────────────────────────
async function main() {
  // Khởi động API server trước, không chờ browser
  app.listen(PORT, () => {
    console.log(`\n✅ Zalo Bot đang chạy tại http://localhost:${PORT}`)
    console.log(`   Gửi tin:  POST http://localhost:${PORT}/send`)
    console.log(`   Logs:     GET  http://localhost:${PORT}/logs\n`)
  })

  // Browser khởi động song song không block API
  startBrowser().catch(console.error)
}

main().catch(console.error)
