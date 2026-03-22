const { Worker } = require("bullmq")
const Redis = require("ioredis")
const { chromium } = require("playwright")

const connection = new Redis({
  maxRetriesPerRequest: null
})

let browser
let context
let page

async function initBrowser() {

    browser = await chromium.launch({
        headless:true,
        slowMo:500
    })

    browser.on("disconnected", async () => {
        console.log("Browser crashed, restarting...")
        await initBrowser()
    })

  context = await browser.newContext({
    storageState: "session.json"
  })

  page = await context.newPage()

    await page.goto("https://chat.zalo.me")
    await page.waitForLoadState("networkidle")

// đóng popup nếu có
        const closeBtn = page.locator('text=Đóng')
        if (await closeBtn.isVisible()) {
        await closeBtn.click()
        }
    //await page.pause()
  console.log("Zalo ready")
}

async function sendMessage(name, message) {

  console.log("Step1 search")

  const searchBox = page.locator('#contact-search-input')

  await searchBox.click()
  await searchBox.fill(name)

  await page.waitForTimeout(2000)

  console.log("Step2 find user")

  const user = page.locator('.conv-item').filter({ hasText: name }).first()

  await user.waitFor()
  await user.click()

  console.log("Step3 type message")
  const chatBox = await page.waitForSelector("#richInput", { timeout: 10000 })
  await chatBox.click()
  await chatBox.fill(message)

  await page.keyboard.press("Enter")

  console.log("Step4 done")

    await page.waitForTimeout(2000 + Math.random()*2000)

}

async function startWorker() {

  await initBrowser()

  const worker = new Worker(
    "zaloQueue",
    async job => {

        console.log("JOB RECEIVED:",job.data)

        const { name, message } = job.data

        await sendMessage(name,message)

    },
    { connection }
    )

}

startWorker()