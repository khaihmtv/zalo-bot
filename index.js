/**
 * Zalo Bot - Unified Server
 *
 * API:
 *   GET  /         → Trang chủ
 *   GET  /qr       → QR đăng nhập
 *   GET  /status   → Trạng thái bot
 *   POST /send     → Gửi tin nhắn { "to": "...", "message": "..." }
 *   GET  /logs     → Xem log dạng HTML
 *   GET  /logsjson → Xem log dạng JSON
 *   GET  /logout   → Đăng xuất
 */

const express = require("express")
const { Queue, Worker } = require("bullmq")
const Redis = require("ioredis")
const { chromium } = require("playwright")
const fs = require("fs")
const path = require("path")

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000
const SESSION_FILE = path.resolve(__dirname, "session.json")
const LOG_FILE = path.resolve(__dirname, "logs.json")
const QUEUE_NAME = "zaloQueue"

// ──────────────────────────────────────────────
// Redis + Queue
// ──────────────────────────────────────────────
const redis = new Redis({ host: process.env.REDIS_HOST || "127.0.0.1", port: 6379, maxRetriesPerRequest: null })
const queue = new Queue(QUEUE_NAME, { connection: redis })

// ──────────────────────────────────────────────
// Trạng thái toàn cục
// ──────────────────────────────────────────────
let browser = null
let context = null
let page = null
let qrBuffer = null
let loggedIn = false

// ──────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────
function readLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"))
  } catch {
    return []
  }
}

function writeLog(entry) {
  const logs = readLogs()
  logs.unshift(entry) // mới nhất lên đầu
  if (logs.length > 500) logs.splice(500)
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), "utf-8")
  const icon = entry.status === "success" ? "✓" : entry.status === "warning" ? "⚠" : "✗"
  console.log(`[Log] ${icon} to="${entry.to}" | ${entry.status} | ${entry.note || ""}`)
}

// ──────────────────────────────────────────────
// Khởi động browser
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
    console.log("[Browser] Bị ngắt, đang khởi động lại...")
    browser = null
    context = null
    page = null
    loggedIn = false
    await startBrowser()
  })

  // Chỉ load session nếu file tồn tại VÀ không rỗng
  let contextOptions = {}
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, "utf-8").trim()
      if (raw && raw !== "null" && raw.startsWith("{")) {
        contextOptions = { storageState: SESSION_FILE }
        console.log("[Browser] Tìm thấy session cũ, đang load...")
      }
    }
  } catch {}

  context = await browser.newContext(contextOptions)
  page = await context.newPage()

  await page.goto("https://chat.zalo.me", { waitUntil: "domcontentloaded", timeout: 60000 })
  await page.waitForTimeout(5000)

  const isLoggedIn = await page.locator("#contact-search-input").isVisible({ timeout: 20000 }).catch(() => false)

  if (isLoggedIn) {
    loggedIn = true
    console.log("[Browser] Đã đăng nhập từ session cũ ✓")
    await closePopupIfAny()
  } else {
    console.log("[Browser] Chưa đăng nhập, đang chờ quét QR...")
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
      // Tự động click "Lấy mã mới" nếu QR hết hạn
      const refreshBtn = page.getByText(/Lấy mã mới/i).first()
      if (await refreshBtn.isVisible({ timeout: 300 })) {
        console.log("[QR] Mã hết hạn, đang click Lấy mã mới...")
        await refreshBtn.click()
        await page.waitForTimeout(2000)
        return
      }

      // Debug: log text của tất cả button trên trang (chỉ log 1 lần/30s)
      const now = Date.now()
      if (!global._lastBtnLog || now - global._lastBtnLog > 30000) {
        global._lastBtnLog = now
        try {
          const btns = await page.locator("button").allInnerTexts()
          console.log("[QR Debug] Buttons trên trang:", btns)
          const pageText = await page.locator("body").innerText({ timeout: 1000 })
          if (pageText.includes("mã")) console.log("[QR Debug] Body có chứa 'mã':", pageText.substring(0, 200))
        } catch {}
      }

      // Chụp canvas QR
      const canvas = page.locator("canvas").first()
      if (await canvas.isVisible({ timeout: 500 })) {
        const buf = await canvas.screenshot()
        if (buf && buf.length > 1024) {
          qrBuffer = buf
        }
        return
      }

      // Fallback: thử img
      const img = page.locator("img[alt*='QR'], img[alt*='qr']").first()
      if (await img.isVisible({ timeout: 500 })) {
        qrBuffer = await img.screenshot()
      }
    } catch {}
  }, 1000)
}

function waitForLogin() {
  page.waitForURL("https://chat.zalo.me/**", { timeout: 300000 }).then(async () => {
    try {
      loggedIn = true
      qrBuffer = null

      // Lưu session
      await context.storageState({ path: SESSION_FILE })
      console.log("[Browser] Đăng nhập thành công ✓ Session đã lưu")

      // Chờ trang chat load hoàn toàn
      await page.waitForTimeout(3000)
      await closePopupIfAny()

      // Đảm bảo đang ở đúng trang chat
      const currentUrl = page.url()
      if (!currentUrl.includes("chat.zalo.me")) {
        console.log("[Browser] Đang navigate về trang chat...")
        await page.goto("https://chat.zalo.me", { waitUntil: "domcontentloaded", timeout: 60000 })
        await page.waitForTimeout(4000)
      }

      // Chờ search box xuất hiện để xác nhận trang đã sẵn sàng
      await page.locator("#contact-search-input").waitFor({ timeout: 30000 })
      console.log("[Browser] Trang chat sẵn sàng ✓")

    } catch (e) {
      console.error("[Browser] Lỗi sau login:", e.message)
    }
  }).catch(() => {})
}

// ──────────────────────────────────────────────
// Gửi tin nhắn + Xác minh
// ──────────────────────────────────────────────
async function sendMessage(to, message) {
  const timestamp = new Date().toISOString()

  if (!loggedIn || !page) {
    const entry = { timestamp, to, message, status: "failed", note: "Chưa đăng nhập Zalo" }
    writeLog(entry)
    throw new Error(entry.note)
  }

  try {
    // Đảm bảo trang Zalo vẫn còn sống
    const stillAlive = await page.locator("#contact-search-input").isVisible({ timeout: 5000 }).catch(() => false)
    if (!stillAlive) {
      console.log("[Send] Trang Zalo bị mất, navigate lại...")
      await page.goto("https://chat.zalo.me", { waitUntil: "domcontentloaded", timeout: 60000 })
      await page.waitForTimeout(5000)
      await closePopupIfAny()
      // Chờ search box xuất hiện
      await page.locator("#contact-search-input").waitFor({ timeout: 30000 })
    }

    // Bước 1: Tìm kiếm người dùng
    const searchBox = page.locator("#contact-search-input")
    await searchBox.waitFor({ timeout: 30000 })
    await searchBox.click()
    await searchBox.fill(to)
    await page.waitForTimeout(2000)

    // Bước 2: Kiểm tra có tìm thấy không
    const user = page.locator(".conv-item").filter({ hasText: to }).first()
    const userFound = await user.isVisible({ timeout: 8000 }).catch(() => false)

    if (!userFound) {
      const entry = { timestamp, to, message, status: "failed", note: `Không tìm thấy người dùng "${to}" trong danh sách` }
      writeLog(entry)
      throw new Error(entry.note)
    }

    await user.click()

    // Bước 3: Gõ và gửi
    const chatBox = await page.waitForSelector("#richInput", { timeout: 20000 })
    await chatBox.click()
    await chatBox.fill(message)
    await page.keyboard.press("Enter")

    // Bước 4: Xác minh tin nhắn đã gửi
    await page.waitForTimeout(2500)

    let verified = false
    let verifyNote = ""

    // Cách 1: Tìm nội dung tin nhắn xuất hiện bất kỳ đâu trong DOM (đáng tin nhất)
    try {
      const el = page.getByText(message, { exact: false }).last()
      const visible = await el.isVisible({ timeout: 4000 })
      if (visible) {
        verified = true
        verifyNote = "Tìm thấy nội dung tin nhắn trong chat"
      }
    } catch {}

    // Cách 2: Selector tin nhắn đã gửi (outgoing) phổ biến của Zalo
    if (!verified) {
      const selectors = [
        "[class*='message-out']",
        "[class*='msg-out']",
        "[class*='sent']",
        "[class*='outgoing']",
        "[class*='mine']",
        "[class*='owner']",
      ]
      for (const sel of selectors) {
        try {
          const count = await page.locator(sel).count()
          if (count > 0) {
            const lastText = await page.locator(sel).last().innerText().catch(() => "")
            if (lastText.includes(message)) {
              verified = true
              verifyNote = `Tìm thấy trong selector ${sel}`
              break
            }
          }
        } catch {}
      }
    }

    // Cách 3: Chatbox đã xóa sạch sau khi Enter (xác minh gián tiếp)
    if (!verified) {
      try {
        await page.waitForTimeout(500)
        const inputText = await page.locator("#richInput").innerText({ timeout: 2000 })
        if (inputText.trim() === "") {
          verified = true
          verifyNote = "Chatbox đã xóa sạch sau khi gửi (xác minh gián tiếp)"
        }
      } catch {}
    }

    if (verified) {
      writeLog({ timestamp, to, message, status: "success", note: verifyNote })
    } else {
      writeLog({ timestamp, to, message, status: "warning", note: "Đã gửi nhưng không xác minh được — kiểm tra thủ công" })
    }

  } catch (err) {
    // Tránh ghi log 2 lần nếu đã ghi ở trên
    const logs = readLogs()
    const alreadyLogged = logs.length > 0 && logs[0].timestamp === timestamp
    if (!alreadyLogged) {
      writeLog({ timestamp, to, message, status: "failed", note: err.message })
    }
    throw err
  }
}

// ──────────────────────────────────────────────
// Worker
// ──────────────────────────────────────────────
function startWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[Worker] Nhận job #${job.id}:`, job.data)
      const { to, message } = job.data
      await sendMessage(to, message)
    },
    { connection: redis }
  )

  worker.on("completed", (job) => console.log(`[Worker] Job #${job.id} hoàn thành ✓`))
  worker.on("failed", (job, err) => console.error(`[Worker] Job #${job.id} thất bại:`, err.message))

  console.log("[Worker] Đang chạy, chờ job từ queue...")
}

// ──────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ──────────────────────────────────────────────
// Express API
// ──────────────────────────────────────────────
const app = express()
app.use(express.json())

// Trang chủ
app.get("/", (req, res) => {
  res.send(`
    <html><head><title>Zalo Bot</title><meta charset="utf-8"/></head>
    <body style="font-family:sans-serif;max-width:640px;margin:40px auto">
      <h2>🤖 Zalo Bot API</h2>
      <hr/>
      <p>Đăng nhập: <b>${loggedIn ? "✅ Đã đăng nhập" : "❌ Chưa đăng nhập"}</b></p>
      ${!loggedIn ? '<p><a href="/qr">👉 Quét QR để đăng nhập</a></p>' : ""}
      <hr/>
      <h3>Endpoints</h3>
      <ul>
        <li><code>GET  /qr</code> — Mã QR đăng nhập</li>
        <li><code>GET  /status</code> — Trạng thái bot</li>
        <li><code>POST /send</code> — Gửi tin nhắn <code>{"to":"...","message":"..."}</code></li>
        <li><code>GET  /logs</code> — Xem log dạng HTML</li>
        <li><code>GET  /logsjson</code> — Xem log dạng JSON</li>
        <li><code>GET  /logout</code> — Đăng xuất</li>
      </ul>
    </body></html>
  `)
})

// QR image (raw PNG, cập nhật mỗi lần gọi)
app.get("/qr-image", async (req, res) => {
  if (loggedIn) return res.status(200).send("logged_in")
  if (!qrBuffer) return res.status(204).send()
  res.setHeader("Content-Type", "image/png")
  res.setHeader("Cache-Control", "no-store")
  res.send(qrBuffer)
})

// QR page - tự động refresh ảnh mỗi 2 giây
app.get("/qr", async (req, res) => {
  await startBrowser()

  if (loggedIn) {
    return res.send("<h3 style=\"font-family:sans-serif;text-align:center;margin-top:80px\">✅ Đã đăng nhập rồi!</h3>")
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8"/>
      <title>Zalo QR Login</title>
      <style>
        body { background: #111; display: flex; flex-direction: column; align-items: center;
               justify-content: center; height: 100vh; margin: 0; font-family: sans-serif; color: #fff; }
        #qr-box { background: #fff; padding: 16px; border-radius: 12px; }
        img { display: block; width: 260px; height: 260px; }
        p { margin-top: 16px; color: #aaa; font-size: 14px; text-align: center; }
        #status { margin-top: 8px; font-size: 13px; color: #666; }
      </style>
    </head>
    <body>
      <div id="qr-box">
        <img id="qr-img" src="/qr-image?t=0" alt="QR"/>
      </div>
      <p>Mở Zalo → Quét mã QR để đăng nhập</p>
      <div id="status">Đang cập nhật mã QR...</div>
      <script>
        let t = 0
        function refresh() {
          t++
          const img = document.getElementById('qr-img')
          const status = document.getElementById('status')

          fetch('/qr-image?t=' + t)
            .then(r => {
              if (r.status === 200 && r.headers.get('content-type') === 'image/png') {
                img.src = '/qr-image?t=' + t
                status.textContent = 'QR cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN')
              } else if (r.status === 200) {
                // logged_in
                document.body.innerHTML = '<h2 style="color:#4ade80;font-family:sans-serif">✅ Đăng nhập thành công!</h2>'
                return
              }
            })
            .catch(() => {})
          setTimeout(refresh, 2000)
        }
        setTimeout(refresh, 2000)
      </script>
    </body>
    </html>
  `)
})

// Status
app.get("/status", (req, res) => {
  const logs = readLogs()
  res.json({
    loggedIn,
    sessionExists: fs.existsSync(SESSION_FILE),
    queueReady: !!redis,
    stats: {
      total: logs.length,
      success: logs.filter(l => l.status === "success").length,
      warning: logs.filter(l => l.status === "warning").length,
      failed: logs.filter(l => l.status === "failed").length,
    }
  })
})

// Gửi tin
app.post("/send", async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Thiếu "to" hoặc "message"' })
  if (!loggedIn) return res.status(403).json({ error: "Chưa đăng nhập Zalo. Vào /qr để quét mã" })

  const job = await queue.add("sendMessage", { to, message })
  console.log(`[API] Job #${job.id} đã thêm vào queue: to="${to}"`)
  res.json({ status: "queued", jobId: job.id, to, message })
})

// Logs - HTML
app.get("/logs", (req, res) => {
  const logs = readLogs()
  const total = logs.length
  const success = logs.filter(l => l.status === "success").length
  const warning = logs.filter(l => l.status === "warning").length
  const failed = logs.filter(l => l.status === "failed").length

  const rows = logs.map(l => {
    const icon = l.status === "success" ? "✅" : l.status === "warning" ? "⚠️" : "❌"
    const bg = l.status === "success" ? "#f0fff4" : l.status === "warning" ? "#fffbeb" : "#fff1f1"
    const time = new Date(l.timestamp).toLocaleString("vi-VN")
    return `<tr style="background:${bg}">
      <td>${icon} ${escHtml(l.status)}</td>
      <td>${escHtml(l.to)}</td>
      <td>${escHtml(l.message)}</td>
      <td style="color:#555;font-size:13px">${escHtml(l.note || "")}</td>
      <td style="color:#888;font-size:13px;white-space:nowrap">${time}</td>
    </tr>`
  }).join("")

  res.send(`
    <html><head><title>Zalo Bot - Logs</title><meta charset="utf-8"/>
    <style>
      body{font-family:sans-serif;margin:32px;background:#f5f5f5}
      h2{margin-bottom:8px}
      .stats{display:flex;gap:12px;margin:16px 0 24px}
      .stat{background:#fff;border-radius:8px;padding:12px 20px;box-shadow:0 1px 4px #0001;min-width:80px}
      .stat b{font-size:24px;display:block}
      .stat span{font-size:13px;color:#666}
      table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px #0001}
      th{background:#222;color:#fff;padding:10px 12px;text-align:left;font-size:13px}
      td{padding:9px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top}
      tr:hover{filter:brightness(0.97)}
      a{color:#0066cc;text-decoration:none;margin-right:12px}
    </style>
    </head>
    <body>
      <h2>📋 Zalo Bot — Lịch sử gửi tin nhắn</h2>
      <div><a href="/">← Trang chủ</a><a href="/logsjson" target="_blank">📦 JSON</a></div>
      <div class="stats">
        <div class="stat"><b>${total}</b><span>Tổng</span></div>
        <div class="stat" style="border-top:3px solid #22c55e"><b>${success}</b><span>✅ Thành công</span></div>
        <div class="stat" style="border-top:3px solid #f59e0b"><b>${warning}</b><span>⚠️ Warning</span></div>
        <div class="stat" style="border-top:3px solid #ef4444"><b>${failed}</b><span>❌ Thất bại</span></div>
      </div>
      ${logs.length === 0
        ? "<p style='color:#999'>Chưa có log nào.</p>"
        : `<table>
            <thead><tr>
              <th>Trạng thái</th><th>Người nhận</th><th>Nội dung</th><th>Ghi chú</th><th>Thời gian</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`
      }
    </body></html>
  `)
})

// Logs - JSON
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

// Logout
app.get("/logout", async (req, res) => {
  loggedIn = false
  qrBuffer = null
  if (browser) await browser.close().catch(() => {})
  browser = null; context = null; page = null
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE)
  res.send("✅ Đã đăng xuất và xóa session")
})

// ──────────────────────────────────────────────
// Khởi động
// ──────────────────────────────────────────────
async function main() {
  await startBrowser()
  startWorker()
  app.listen(PORT, () => {
    console.log(`\n✅ Zalo Bot đang chạy tại http://localhost:${PORT}`)
    console.log(`   Gửi tin:  POST http://localhost:${PORT}/send`)
    console.log(`   Logs:     GET  http://localhost:${PORT}/logs`)
    console.log(`   LogsJSON: GET  http://localhost:${PORT}/logsjson\n`)
  })
}

main().catch(console.error)
