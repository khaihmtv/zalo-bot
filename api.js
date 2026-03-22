const express = require("express")
const { Queue } = require("bullmq")
const Redis = require("ioredis")

const connection = new Redis({
  maxRetriesPerRequest: null
})

const queue = new Queue("zaloQueue",{ connection })

const app = express()
app.use(express.json())



app.post("/send", async (req,res)=>{

  console.log("JOB:",req.body)

  const {name,message} = req.body

  await queue.add("sendMessage",{name,message})

  res.send({status:"queued"})
})

app.listen(3000,()=>{
  console.log("API running")
})