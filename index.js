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

  console.log("[Browser] Đang khởi động..  .")

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
  res.send(`<html><head><title>Zalo Bot</title><meta charset="utf-8"/></head>
    <body style="font-family:sans-serif;max-width:640px;margin:40px auto">
      <h2>🤖 Zalo Bot</h2><hr/>
      <p>Đăng nhập: <b>${loggedIn ? "✅ Đã đăng nhập" : "❌ Chưa đăng nhập"}</b></p>
      ${!loggedIn ? '<p><a href="/qr">👉 Quét QR để đăng nhập</a></p>' : ""}
      <ul>
        <li><code>GET  /qr</code> — QR đăng nhập</li>
        <li><code>GET  /status</code> — Trạng thái</li>
        <li><code>POST /send</code> — Gửi tin <code>{"to":"...","message":"..."}</code></li>
        <li><code>GET  /logs</code> — Log HTML</li>
        <li><code>GET  /logsjson</code> — Log JSON</li>
        <li><code>GET  /logout</code> — Đăng xuất</li>
      </ul>
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

app.get("/logs", (req, res) => {
  const logs = readLogs()
  const total = logs.length
  const success = logs.filter(l => l.status === "success").length
  const warning = logs.filter(l => l.status === "warning").length
  const failed = logs.filter(l => l.status === "failed").length

  const rows = logs.map(l => {
    const icon = l.status === "success" ? "✅" : l.status === "warning" ? "⚠️" : "❌"
    const bg = l.status === "success" ? "#f0fff4" : l.status === "warning" ? "#fffbeb" : "#fff1f1"
    return `<tr style="background:${bg}">
      <td>${icon} ${escHtml(l.status)}</td>
      <td>${escHtml(l.to)}</td>
      <td>${escHtml(l.message)}</td>
      <td style="color:#555;font-size:13px">${escHtml(l.note||"")}</td>
      <td style="color:#888;font-size:13px;white-space:nowrap">${new Date(l.timestamp).toLocaleString("vi-VN")}</td>
    </tr>`
  }).join("")

  res.send(`<html><head><title>Logs</title><meta charset="utf-8"/>
    <style>body{font-family:sans-serif;margin:32px;background:#f5f5f5}
    .stats{display:flex;gap:12px;margin:16px 0 24px}.stat{background:#fff;border-radius:8px;padding:12px 20px;box-shadow:0 1px 4px #0001}
    .stat b{font-size:24px;display:block}.stat span{font-size:13px;color:#666}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px #0001}
    th{background:#222;color:#fff;padding:10px 12px;text-align:left;font-size:13px}td{padding:9px 12px;border-bottom:1px solid #f0f0f0}
    a{color:#0066cc;text-decoration:none;margin-right:12px}</style></head>
    <body><h2>📋 Zalo Bot — Logs</h2>
    <div><a href="/">← Trang chủ</a><a href="/logsjson" target="_blank">📦 JSON</a></div>
    <div class="stats">
      <div class="stat"><b>${total}</b><span>Tổng</span></div>
      <div class="stat" style="border-top:3px solid #22c55e"><b>${success}</b><span>✅ Thành công</span></div>
      <div class="stat" style="border-top:3px solid #f59e0b"><b>${warning}</b><span>⚠️ Warning</span></div>
      <div class="stat" style="border-top:3px solid #ef4444"><b>${failed}</b><span>❌ Thất bại</span></div>
    </div>
    ${logs.length === 0 ? "<p style='color:#999'>Chưa có log nào.</p>" :
      `<table><thead><tr><th>Trạng thái</th><th>Người nhận</th><th>Nội dung</th><th>Ghi chú</th><th>Thời gian</th></tr></thead>
      <tbody>${rows}</tbody></table>`}
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
