const express = require("express")
const { chromium } = require("playwright")
const fs = require("fs")

const app = express()

let browser = null
let context = null
let page = null
let qrBuffer = null
let loggedIn = false

async function startBrowser() {

  if (browser) return

  console.log("Launching browser...")

  browser = await chromium.launch({
    headless: false
  })

  context = await browser.newContext()
  page = await context.newPage()

  await page.goto("https://chat.zalo.me")

  // loop cập nhật QR
  setInterval(async () => {

    try {

      const qr = page.locator("canvas").first()

      if (await qr.isVisible()) {
        qrBuffer = await qr.screenshot()
      }

    } catch {}

  }, 2000)

  // detect login
  page.waitForURL("https://chat.zalo.me/**").then(async () => {

    try {

      loggedIn = true

      await context.storageState({
        path: "session.json"
      })

      console.log("Login success")

    } catch {}

  })

}

app.get("/qr", async (req, res) => {

  await startBrowser()

  if (!qrBuffer) {
    return res.send("QR đang tạo...")
  }

  res.setHeader("Content-Type", "image/png")
  res.send(qrBuffer)

})

app.get("/status", (req, res) => {

  res.json({
    loggedIn
  })

})

app.get("/session", (req, res) => {

  if (!fs.existsSync("session.json")) {
    return res.send("No session")
  }

  res.download("session.json")

})

app.get("/logout", async (req, res) => {

  loggedIn = false
  qrBuffer = null

  if (browser) {
    await browser.close()
  }

  browser = null
  context = null
  page = null

  if (fs.existsSync("session.json")) {
    fs.unlinkSync("session.json")
  }

  res.send("Logged out")

})

app.listen(3000, () => {

  console.log("Login server running")
  console.log("QR: http://localhost:3000/qr")
  console.log("Status: http://localhost:3000/status")

})