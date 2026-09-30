const express = require("express")
const app = express()

app.use(express.json())
app.use(express.static("public"))

let parking = {}
let command = null

const PRICE_PER_HOUR = 20
const FREE_MINUTES = 3


// ===== รับ QR Scan =====
app.post("/scan",(req,res)=>{

    const id = req.body.id
    const now = Date.now()

    if(!parking[id]){

        parking[id] = { enter: now }

        console.log("รถเข้า",id)

        command = {
            action:"open",
            car:id
        }

        return res.json({
            status:"enter"
        })
    }

    const enter = parking[id].enter

    let minutes = (now-enter)/60000
    let billMinutes = minutes - FREE_MINUTES

    if(billMinutes < 0) billMinutes = 0

    let hours = Math.ceil(billMinutes/60)
    let price = hours * PRICE_PER_HOUR

    delete parking[id]

    console.log("รถออก",id,"ราคา",price)

    command = {
        action:"open",
        car:id
    }

    res.json({
        status:"exit",
        price:price
    })

})


// ===== Arduino ขอคำสั่ง =====
app.get("/command",(req,res)=>{

    if(command){

        res.json(command)
        command = null

    }else{

        res.json({
            action:"none"
        })

    }

})


// ===== Arduino บอกว่าทำเสร็จ =====
app.post("/done",(req,res)=>{

    console.log("Gate finished")

    res.json({
        status:"ok"
    })

})


app.listen(3000,"0.0.0.0",()=>{
    console.log("Server running http://localhost:3000")
})