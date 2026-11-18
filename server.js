require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const db = new Database(process.env.DB_FILE || "game.sqlite");
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || "";

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, username TEXT, first_name TEXT, coins INTEGER NOT NULL DEFAULT 500,
  xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
  chapter INTEGER NOT NULL DEFAULT 1, energy INTEGER NOT NULL DEFAULT 20,
  referred_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS referrals (
  inviter_id TEXT NOT NULL, invitee_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  payload TEXT PRIMARY KEY, user_id TEXT NOT NULL, stars INTEGER NOT NULL,
  coins INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  charge_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS actions (
  user_id TEXT NOT NULL, action_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, action_key)
);
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const a = Buffer.from(calculated, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now()/1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}

function auth(req, res, next) {
  const user = verifyInitData(req.get("x-telegram-init-data") || "");
  if (!user?.id) return res.status(401).json({error:"Открой игру через Telegram"});
  req.tgUser = user;
  next();
}
function getPlayer(user) {
  let p = db.prepare("SELECT * FROM players WHERE id=?").get(String(user.id));
  if (!p) {
    db.prepare("INSERT INTO players(id,username,first_name) VALUES(?,?,?)")
      .run(String(user.id), user.username || "", user.first_name || "Игрок");
    p = db.prepare("SELECT * FROM players WHERE id=?").get(String(user.id));
  } else {
    db.prepare("UPDATE players SET username=?, first_name=? WHERE id=?")
      .run(user.username || "", user.first_name || "Игрок", String(user.id));
  }
  return p;
}
function publicPlayer(p) {
  return {id:p.id, name:p.first_name || "Игрок", coins:p.coins, xp:p.xp, level:p.level,
    chapter:p.chapter, energy:p.energy};
}
async function telegram(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

app.get("/api/me", auth, (req,res) => {
  const p = getPlayer(req.tgUser);
  const referrals = db.prepare("SELECT COUNT(*) n FROM referrals WHERE inviter_id=?").get(p.id).n;
  res.json({player:publicPlayer(p), referrals, referralLink:`https://t.me/${process.env.BOT_USERNAME || "YOUR_BOT"}?startapp=ref_${p.id}`});
});

app.post("/api/action", auth, (req,res) => {
  const p = getPlayer(req.tgUser);
  const key = String(req.body.action || "");
  const missions = {
    "street-job": {coins:120, xp:15, energy:2, text:"Ты выполнил поручение и получил оплату."},
    "negotiate": {coins:220, xp:25, energy:3, text:"Переговоры прошли успешно. Влияние растёт."},
    "explore": {coins:80, xp:10, energy:1, text:"Ты нашёл полезные связи в новом районе."}
  };
  const m = missions[key];
  if (!m) return res.status(400).json({error:"Неизвестное задание"});
  if (p.energy < m.energy) return res.status(400).json({error:"Недостаточно энергии. Попробуй позже."});
  const done = db.prepare("SELECT 1 FROM actions WHERE user_id=? AND action_key=?").get(p.id, key + ":" + new Date().toISOString().slice(0,10));
  if (done) return res.status(409).json({error:"Это задание уже выполнено сегодня"});
  const xp = p.xp + m.xp, level = Math.floor(xp/100)+1;
  db.transaction(() => {
    db.prepare("INSERT INTO actions(user_id,action_key) VALUES(?,?)").run(p.id,key + ":" + new Date().toISOString().slice(0,10));
    db.prepare("UPDATE players SET coins=coins+?, xp=?, level=?, energy=energy-? WHERE id=?")
      .run(m.coins,xp,level,m.energy,p.id);
  })();
  res.json({message:m.text, player:publicPlayer(db.prepare("SELECT * FROM players WHERE id=?").get(p.id))});
});

const PACKS = {
  starter:{stars:25, coins:2500, title:"Стартовый запас"},
  silver:{stars:75, coins:8500, title:"Серебряный запас"},
  gold:{stars:150, coins:19000, title:"Золотой запас"},
  premium:{stars:300, coins:42000, title:"Премиум запас"},
  emperor:{stars:750, coins:120000, title:"Императорский запас"}
};
app.post("/api/invoice", auth, async (req,res) => {
  if (!BOT_TOKEN) return res.status(503).json({error:"Сначала настрой BOT_TOKEN на сервере"});
  const p = getPlayer(req.tgUser), pack = PACKS[req.body.pack];
  if (!pack) return res.status(400).json({error:"Неизвестный пакет"});
  const payload = `coins:${p.id}:${crypto.randomUUID()}`;
  db.prepare("INSERT INTO payments(payload,user_id,stars,coins) VALUES(?,?,?,?)")
    .run(payload,p.id,pack.stars,pack.coins);
  try {
    const link = await telegram("createInvoiceLink", {
      title:pack.title, description:`${pack.coins.toLocaleString("ru-RU")} игровых монет для Теневой Империи`,
      payload, currency:"XTR", prices:[{label:pack.title,amount:pack.stars}]
    });
    res.json({url:link});
  } catch(e) {
    db.prepare("DELETE FROM payments WHERE payload=?").run(payload);
    res.status(502).json({error:"Не удалось создать счёт Telegram: "+e.message});
  }
});

app.post("/telegram/webhook", (req,res) => {
  if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET)
    return res.sendStatus(403);
  res.sendStatus(200);
  const update = req.body;
  (async () => {
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      const order = db.prepare("SELECT * FROM payments WHERE payload=? AND status='pending'").get(q.invoice_payload);
      await telegram("answerPreCheckoutQuery", {pre_checkout_query_id:q.id, ok:!!order,
        ...(order ? {} : {error_message:"Счёт не найден или уже использован"})});
    }
    const msg = update.message;
    if (msg?.successful_payment) {
      const sp = msg.successful_payment;
      const order = db.prepare("SELECT * FROM payments WHERE payload=? AND status='pending'").get(sp.invoice_payload);
      if (order && order.user_id === String(msg.from.id) && sp.currency === "XTR" && sp.total_amount === order.stars) {
        db.transaction(() => {
          db.prepare("UPDATE players SET coins=coins+? WHERE id=?").run(order.coins,order.user_id);
          db.prepare("UPDATE payments SET status='paid',charge_id=? WHERE payload=?")
            .run(sp.telegram_payment_charge_id,order.payload);
        })();
        await telegram("sendMessage",{chat_id:msg.chat.id,text:`⭐ Оплата получена! На баланс зачислено ${order.coins.toLocaleString("ru-RU")} монет.`});
      }
    }
    if (msg?.text?.startsWith("/start")) {
      const parts = msg.text.trim().split(/\s+/);
      const u = msg.from;
      getPlayer(u);
      const ref = (parts[1] || "").match(/^ref_(\d+)$/);
      if (ref && ref[1] !== String(u.id)) {
        const inviter = db.prepare("SELECT id FROM players WHERE id=?").get(ref[1]);
        const existing = db.prepare("SELECT 1 FROM referrals WHERE invitee_id=?").get(String(u.id));
        if (inviter && !existing) {
          db.transaction(() => {
            db.prepare("INSERT INTO referrals(inviter_id,invitee_id) VALUES(?,?)").run(ref[1],String(u.id));
            db.prepare("UPDATE players SET coins=coins+500 WHERE id=?").run(ref[1]);
            db.prepare("UPDATE players SET coins=coins+200 WHERE id=?").run(String(u.id));
          })();
        }
      }
      if (APP_URL) await telegram("sendMessage",{chat_id:msg.chat.id,text:"Добро пожаловать в Теневую Империю. Твоя история начинается сейчас.",reply_markup:{inline_keyboard:[[{text:"🎮 Открыть игру",web_app:{url:APP_URL}}]]}});
    }
  })().catch(err => console.error("Webhook processing:",err));
});

app.get("/health",(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Теневая Империя запущена на порту ${PORT}`));
