const { Queue } = require("bullmq")
const Redis = require("ioredis")

const connection = new Redis({
  maxRetriesPerRequest:null
})

const queue = new Queue("zaloQueue",{connection})

queue.add("sendMessage",{
 name:"My Documents",
 message:"1xs Mar 11 19:22:00"
})