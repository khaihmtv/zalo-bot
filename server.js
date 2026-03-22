const express = require("express")
const { chromium } = require("playwright")

const app = express()
let browser
let page

let qrBase64 = null

async function startBrowser() {

  browser = await chromium.launch({
    headless: true
  })

  page = await browser.newPage()

  await page.goto("https://id.zalo.me/account?continue=https://chat.zalo.me")

  console.log("Waiting for QR...")

  setInterval(async () => {

    try {

      const qr = page.locator("img").first()

      if (await qr.isVisible()) {

        const buffer = await qr.screenshot()

        qrBase64 = buffer.toString("base64")

      }

    } catch(e) {}

  }, 1000)

}

startBrowser()

app.get("/qr-stream", (req,res)=>{

  res.setHeader("Content-Type","text/event-stream")
  res.setHeader("Cache-Control","no-cache")
  res.setHeader("Connection","keep-alive")

  const timer = setInterval(()=>{

    if(qrBase64){
      res.write(`data: ${qrBase64}\n\n`)
    }

  },1000)

  req.on("close",()=>clearInterval(timer))

})
app.get("/session", async (req, res) => {

  try {

    await page.context().storageState({
      path: "session.json"
    })

    res.send("session.json saved")

  } catch (e) {

    console.log(e)
    res.send("save failed")

  }

})
app.get("/",(req,res)=>{

res.send(`
<html>
<body>

<h2>Zalo QR Login</h2>

<img id="qr" width="300"/>

<a href="/session">Save Session</a>

<script>

const evt = new EventSource("/qr-stream")

evt.onmessage = (e)=>{

document.getElementById("qr").src =
"data:image/png;base64," + e.data

}

</script>

</body>
</html>
`)

})

app.listen(3000,()=>{
console.log("Server running http://localhost:3000")
})