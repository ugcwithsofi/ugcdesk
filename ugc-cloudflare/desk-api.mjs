import { clean, labels, pitch } from './store.mjs';
import { discover } from './telegram.mjs';

const cookie = 'ugc_session';
const security = {
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY'
};
function respond(status,data,headers={}) {
  return Response.json(data,{status,headers:{...security,...headers}});
}
function sid(req) {
  const value = req.headers.get('cookie')?.match(/(?:^|;\s*)ugc_session=([0-9a-f]{64})(?:;|$)/)?.[1];
  return value || '';
}
async function json(req) {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new Error('Нужен JSON');
  const chunks = [];
  let total = 0;
  for await (const chunk of req.body) {
    total += chunk.length;
    if (total > 128_000) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  const result = JSON.parse(await new Blob(chunks).text());
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Проверь поля запроса');
  return result;
}

export function createDeskApi(store, config) {
  const secure = '; Secure';
  const setCookie = (value,maxAge) => `${cookie}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  let failures = 0, resetAt = 0;
  let searchBusy = false;
  async function search() {
    if (searchBusy) throw new Error('Поиск уже выполняется');
    searchBusy = true;
    try { return await discover(store,config.searchKey); }
    finally { searchBusy = false; }
  }
  async function handle(req) {
    let path;
    try { path = new URL(req.url).pathname; }
    catch { return respond(400,{error:'Некорректный адрес'}); }
    if (req.method === 'GET' && path === '/health') return respond(200,{ok:true});
    if (!path.startsWith('/api/')) return respond(404,{error:'Страница не найдена'});
    if (!['GET','POST'].includes(req.method)) return respond(405,{error:'Метод недоступен'});
    if (req.method === 'POST' && req.headers.get('origin') !== config.origin) return respond(403,{error:'Открой кабинет по адресу Worker, который использовал при подключении Telegram'});
    try {
      if (req.method === 'POST' && path === '/api/login') {
        const { code } = await json(req);
        const now = Date.now();
        if (now > resetAt) { failures=0; resetAt=now+60_000; }
        if (failures >= 20) return respond(429,{error:'Подожди минуту и попробуй ещё раз'});
        const value = clean(code,40).toLowerCase();
        const session = /^[a-f0-9]{16}$/.test(value) && store.login(value,config.owner);
        if (!session) { failures++; return respond(401,{error:'Код устарел или уже использован. Получи новый через /login.'}); }
        return respond(200,{ok:true},{'Set-Cookie':setCookie(session,604800)});
      }
      const session = sid(req);
      if (!store.session(session,config.owner)) return respond(401,{error:'Войди через Telegram'});
      if (req.method === 'GET') {
        if (path === '/api/desk') {
          const settings = store.settings();
          const brands = store.brands();
          const chats = store.all('SELECT actor FROM chats').map(row=>row.actor);
          return respond(200,{brands,labels,settings,searchEnabled:!!config.searchKey,roles:{
            owner:chats.includes(config.owner),partner:chats.includes(config.partner)
          },searchStatus:store.get('searchStatus'),activity:store.all(`SELECT events.actor,events.at,events.description,events.brand_id,
            json_extract(brands.data,'$.name') AS brand FROM events JOIN brands ON brands.id=events.brand_id ORDER BY events.id DESC LIMIT 12`),
          discoveries:store.all('SELECT data,found FROM discoveries WHERE found>0 ORDER BY found DESC LIMIT 100').map(r=>({...JSON.parse(r.data),found:r.found}))});
        }
        if (path === '/api/export') return respond(200,store.backup(),{'Content-Disposition':'attachment; filename="ugc-desk-export.json"'});
        const match = path.match(/^\/api\/brands\/(\d+)$/);
        if (match) {
          const b = store.brand(Number(match[1]));
          if (!b) return respond(404,{error:'Карточка не найдена'});
          return respond(200,{brand:b,events:store.events(b.id),pitch:pitch(b,store.settings())});
        }
        return respond(404,{error:'Маршрут не найден'});
      }
      const body = await json(req);
      if (path === '/api/logout') {
        store.logout(session);
        return respond(200,{ok:true},{'Set-Cookie':setCookie('',0)});
      }
      if (path === '/api/brands') {
        const b = store.create(body,'owner');
        return respond(201,b);
      }
      const match = path.match(/^\/api\/brands\/(\d+)\/(edit|move|undo)$/);
      if (match) {
        const id = Number(match[1]), version = Number(body.version);
        const actions = {
          edit:()=>store.edit(id,version,'owner',body),
          move:()=>store.move(id,version,'owner',body.status,body.when),
          undo:()=>store.undo(id,version,'owner')
        };
        return respond(200,actions[match[2]]());
      }
      if (path === '/api/settings') return respond(200,store.replaceSettings(body));
      if (path === '/api/discover') {
        const added = await search();
        store.put('searchStatus',{at:Date.now(),added});
        return respond(200,{added});
      }
      if (path === '/api/discover/dismiss') {
        store.run("UPDATE discoveries SET found=0 WHERE url=?",clean(body.url,700));
        return respond(200,{ok:true});
      }
      return respond(404,{error:'Маршрут не найден'});
    } catch (err) {

      if (err.code?.startsWith?.('ERR_SQLITE')) {
        console.error('SQLite:',err.code);
        return respond(500,{error:'Ошибка базы. Проверь журнал сервера.'});
      }
      return respond(400,{error:err.message || 'Не удалось выполнить действие'});
    }
  }
  return {handle,search};
}


