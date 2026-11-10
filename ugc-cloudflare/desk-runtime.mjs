import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createDeskApi } from './desk-api.mjs';
import { openStore, dateAt, day } from './store.mjs';
import { createBot, makeTelegram } from './telegram.mjs';

const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' };
const result = (status,value) => Response.json(value,{status,headers});
const validId = id => /^[1-9]\d{0,15}$/.test(id||'');
const validToken = token => /^\d+:[A-Za-z0-9_-]{20,}$/.test(token||'');
const validSetupKey = key => typeof key==='string' && key.length>=24 && key.length<=128;
const digest = x => createHash('sha256').update(x).digest();
const equal = (a,b) => typeof a==='string' && typeof b==='string' && timingSafeEqual(digest(a),digest(b));

export function webhookAuthorized(request,env) {
  return validToken(env.BOT_TOKEN) && equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),webhookSecret(env.BOT_TOKEN));
}
function webhookSecret(token) {
  return createHmac('sha256',token).update('ugc-desk-cloudflare-webhook-v1').digest('hex');
}
async function readObject(request,max) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new Error('Нужен JSON');
  const chunks=[];
  let length=0;
  for await (const chunk of request.body) {
    length+=chunk.byteLength;
    if (length>max) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  const value=JSON.parse(await new Blob(chunks).text());
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Нужен объект');
  return value;
}

export class DeskRuntime {
  constructor(storage,env,fetcher=fetch) {
    this.store=openStore(storage);
    this.env=env;
    this.config={
      token:env.BOT_TOKEN||'', origin:this.store.get('origin',''),
      owner:validId(env.OWNER_TELEGRAM_ID)?env.OWNER_TELEGRAM_ID:'',
      partner:validId(env.PARTNER_TELEGRAM_ID)?env.PARTNER_TELEGRAM_ID:'',
      searchKey:env.BRAVE_SEARCH_KEY||''
    };
    if (this.config.owner===this.config.partner) this.config.owner=this.config.partner='';
    this.telegram=makeTelegram(this.config.token,fetcher);
    this.bot=createBot(this.store,this.config,this.telegram,fetcher);
    this.api=createDeskApi(this.store,this.config);
    this.inFlight=new Set();
    this.schedule=null;
  }

  async connect(request,url) {
    if (request.method!=='POST') return result(405,{error:'Используй кнопку подключения на странице /setup'});
    if (request.headers.get('origin')!==url.origin || url.protocol!=='https:')
      return result(403,{error:'Открой страницу настройки по HTTPS'});
    if (!validToken(this.config.token) || !validSetupKey(this.env.SETUP_KEY))
      return result(503,{error:'Сохрани BOT_TOKEN и SETUP_KEY в секретах Cloudflare'});
    let body;
    try { body=await readObject(request,2048); }
    catch { return result(400,{error:'Некорректный запрос'}); }
    if (!validSetupKey(body.key) || !equal(body.key,this.env.SETUP_KEY))
      return result(403,{error:'Проверь ключ настройки'});
    try {
      const bot=await this.telegram('getMe',{});
      const connected=await this.telegram('setWebhook',{
        url:url.origin+'/telegram/webhook',
        secret_token:webhookSecret(this.config.token),
        max_connections:1,
        allowed_updates:['message','callback_query']
      });
      if (connected!==true) throw new Error('Webhook не подтверждён');
      this.store.put('origin',url.origin);
      this.config.origin=url.origin;
      return result(200,{ok:true,username:bot.username,owner:!!this.config.owner,partner:!!this.config.partner});
    } catch (err) {
      return result(502,{error:'Telegram не подтвердил подключение. Проверь токен и повтори.',
        ...(Number.isInteger(err.code)?{telegramCode:err.code}:{})});
    }
  }

  async update(request,url) {
    if (request.method!=='POST') return result(405,{ok:false});
    if (!webhookAuthorized(request,this.env)) return result(403,{ok:false});
    if (url.origin!==this.config.origin) return result(503,{ok:false});
    let update;
    try { update=await readObject(request,256_000); }
    catch { return result(400,{ok:false}); }
    const id=update.update_id;
    if (!Number.isSafeInteger(id) || id<0) return result(400,{ok:false});
    if (this.store.one('SELECT id FROM telegram_updates WHERE id=?',id)) return result(200,{ok:true});
    if (this.inFlight.has(id)) return result(503,{ok:false});
    this.inFlight.add(id);
    try {
      await this.bot.handle(update);
      this.store.run('INSERT OR IGNORE INTO telegram_updates VALUES (?,?)',id,Date.now());
      return result(200,{ok:true});
    } catch (err) {
      console.error('Telegram update:',err.code||err.name);
      if (Number.isInteger(err.code) && err.code>=400 && err.code<500 && err.code!==429) {
        this.store.run('INSERT OR IGNORE INTO telegram_updates VALUES (?,?)',id,Date.now());
        return result(200,{ok:true});
      }
      return result(503,{ok:false});
    } finally {
      this.inFlight.delete(id);
    }
  }

  fetch(request) {
    const url=new URL(request.url);
    if (url.pathname==='/health' && request.method==='GET') return result(200,{
      ok:true, connected:!!this.config.origin && validToken(this.config.token),
      ownerConfigured:!!this.config.owner, partnerConfigured:!!this.config.partner
    });
    if (url.pathname==='/setup/connect') return this.connect(request,url);
    if (url.pathname==='/telegram/webhook') return this.update(request,url);
    if (url.pathname.startsWith('/api/')) {
      if (url.origin!==this.config.origin || !this.config.owner)
        return result(403,{error:'Подключи Telegram на /setup и укажи ID владельца'});
      return this.api.handle(request);
    }
    return result(404,{error:'Страница не найдена'});
  }

  async runSchedule() {
    if (!validToken(this.config.token) || !this.config.origin || this.schedule) return;
    this.schedule=this.processSchedule();
    try { await this.schedule; }
    finally { this.schedule=null; }
  }

  async processSchedule() {
    await this.bot.tick();
    this.store.run('DELETE FROM telegram_updates WHERE received<?',Date.now()-7*day);
    const settings=this.store.settings();
    const local=dateAt(Date.now(),settings.timezone);
    if (!this.config.searchKey || !(settings.searchDE || settings.searchEN) ||
        local.time<settings.hour || this.store.get('lastSearchDate')===local.date) return;
    this.store.put('lastSearchDate',local.date);
    try { this.store.put('searchStatus',{at:Date.now(),added:await this.api.search()}); }
    catch (err) { this.store.put('searchStatus',{at:Date.now(),error:err.message}); }
  }
}
