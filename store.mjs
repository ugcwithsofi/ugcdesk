import { randomBytes, createHash } from 'node:crypto';
import { emailAddresses } from './public/brand-search.mjs';

export const day = 86_400_000;
export const labels = {
  lead: 'Проверить', ready: 'Готов к питчу', sent: 'Ждём ответ', interest: 'Есть интерес',
  details: 'Готовим бриф', later: 'Вернуться позже', brief: 'Бриф', quote: 'Смета',
  contract: 'Договор', production: 'Съёмка', review: 'Правки', invoice: 'Счёт',
  paid: 'Оплачено', closed: 'Закрыто'
};
export const projectSteps = {
  interest:{next:'brief',button:'Перейти к брифу',task:'Уточни задачу, формат, сроки и где будут использовать ролик.'},
  details:{next:'brief',button:'Перейти к брифу',task:'Ответь на вопросы бренда и уточни детали задания.'},
  brief:{next:'quote',button:'Перейти к смете',task:'Зафиксируй объём работы и подготовь стоимость.'},
  quote:{next:'contract',button:'Смета согласована',task:'Согласуй стоимость, сроки, права и правки.'},
  contract:{next:'production',button:'Договор согласован',task:'Подтверди условия до начала съёмки.'},
  production:{next:'review',button:'Материал отправлен на проверку',task:'Сними ролик, проверь его и отправь бренду на согласование.'},
  review:{next:'invoice',button:'Материал принят, счёт выставлен',task:'Закрой правки, передай финал и выставь счёт.'},
  invoice:{next:'paid',button:'Оплата получена',task:'Проверь поступление оплаты.'}
};
export const defaults = { count: 5, dailyGoal: 10, hour: '09:00', delay: 2, timezone: 'Europe/Berlin',
  portfolioDE: '', portfolioEN: '', creator: '', searchDE: '', searchEN: '' };
export const clean = (v, n = 250) => typeof v === 'string' ? v.trim().slice(0, n) : '';
export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Нужна ссылка http или https');
  return url;
}
function brandKey(url) {
  const domain = url.hostname.replace(/^www\./, '');
  if (['instagram.com', 'tiktok.com', 'linkedin.com', 'facebook.com'].includes(domain)) {
    const path = url.pathname.split('/').filter(Boolean).slice(0, domain === 'linkedin.com' ? 2 : 1).join('/');
    if (!path || /^(p|reel|stories|explore|share)$/i.test(path)) throw new Error('Укажи ссылку на профиль бренда или его сайт');
    return domain + '/' + path.toLowerCase();
  }
  return domain;
}
function keyFor(b) {
  if (!b.url) return 'email:'+b.email+':'+b.name.toLowerCase();
  const url=new URL(b.url);
  if (!b.email && b.channel==='brief' && url.pathname!=='/')
    return 'brief:'+url.hostname.replace(/^www\./,'')+url.pathname.replace(/\/$/,'');
  return brandKey(url);
}
export function dateAt(ms, timezone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts=Object.fromEntries(f.formatToParts(ms).map(({type,value})=>[type,value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};
}
export function dueDate(date, tz) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Выбери дату');
  const guess = Date.parse(date + 'T09:00:00Z');
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0,10) !== date) throw new Error('Некорректная дата');
  const { date: local, time } = dateAt(guess, tz);
  return guess + (guess - Date.parse(local + 'T' + time + ':00Z'));
}
export function afterDays(ms,days,tz) {
  const date=dateAt(ms,tz).date;
  const target=new Date(Date.parse(date+'T00:00:00Z')+days*day).toISOString().slice(0,10);
  return dueDate(target,tz);
}
const groupName = name => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const hash = x => createHash('sha256').update(x).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('hex');

export function openStore(storage) {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
      name_key TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS brands_email ON brands(lower(json_extract(data,'$.email')));
    CREATE INDEX IF NOT EXISTS brands_group ON brands(json_extract(data,'$.groupKey'));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, brand_id INTEGER NOT NULL REFERENCES brands(id),
      actor TEXT NOT NULL, at INTEGER NOT NULL, description TEXT NOT NULL, before TEXT, version INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS events_brand ON events(brand_id,id);
    CREATE TABLE IF NOT EXISTS auth (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (actor TEXT PRIMARY KEY, chat TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (key TEXT PRIMARY KEY, status TEXT NOT NULL, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS picks (date TEXT PRIMARY KEY, ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS discoveries (url TEXT PRIMARY KEY, data TEXT NOT NULL, found INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, received INTEGER NOT NULL);
  `);
  const all = (statement, ...params) => sql.exec(statement,...params).toArray();
  const one = (statement, ...params) => all(statement,...params)[0];
  const run = (statement, ...params) => {
    const result=sql.exec(statement,...params);
    result.toArray();
    return {changes:result.rowsWritten};
  };
  const atomic = fn => storage.transactionSync(fn);
  const get = (key, fallback = null) => JSON.parse(one('SELECT value FROM config WHERE key=?', key)?.value ?? JSON.stringify(fallback));
  const put = (key, value) => run('INSERT OR REPLACE INTO config VALUES (?,?)', key, JSON.stringify(value));
  const settings = () => ({ ...defaults, ...get('settings', {}) });
  const unpack = row => row && ({ ...JSON.parse(row.data), id: row.id, version: row.version });
  const brand = id => unpack(one('SELECT * FROM brands WHERE id=?', id));
  const brands = () => all(`SELECT brands.*, (SELECT at FROM events WHERE brand_id=brands.id ORDER BY id LIMIT 1) AS created_at
    FROM brands ORDER BY id DESC`).map(row=>{
      const b=unpack(row);
      return {...b,createdAt:b.createdAt||row.created_at};
    });
  function duplicates(name,email,exclude=0) {
    const normalized=email?.toLowerCase();
    const address=normalized && (unpack(one("SELECT * FROM brands WHERE lower(json_extract(data,'$.email'))=? AND id<>? LIMIT 1",normalized,exclude))
      || all("SELECT * FROM brands WHERE instr(lower(json_extract(data,'$.contact')),?)>0 AND id<>?",normalized,exclude)
        .map(unpack).find(b=>emailAddresses(b.contact).includes(normalized)));
    const key=groupName(name);
    const same=key&&(unpack(one("SELECT * FROM brands WHERE (json_extract(data,'$.groupKey')=? OR name_key=?) AND id<>? LIMIT 1",
      key,name.toLowerCase(),exclude)) || all("SELECT * FROM brands WHERE json_extract(data,'$.groupKey') IS NULL AND id<>?",exclude)
      .map(unpack).find(b=>groupName(b.brandGroup||b.name)===key));
    return {address,same};
  }
  function event(b, actor, description, before = null) {
    run('INSERT INTO events(brand_id,actor,at,description,before,version) VALUES (?,?,?,?,?,?)',
      b.id, actor, Date.now(), description, before ? JSON.stringify(before) : null, b.version);
  }
  function validate(data) {
    const rawUrl = clean(data.url,700);
    const url = rawUrl ? httpUrl(rawUrl).href : '';
    const name = clean(data.name, 90);
    if (!name) throw new Error('Введи название бренда');
    const email = clean(data.email,254).toLowerCase();
    if (email && emailAddresses(email)[0]!==email) throw new Error('Проверь email контакта');
    if (!url && !email) throw new Error('Нужен сайт, профиль или email бренда');
    const fields = {};
    for (const [k, max] of Object.entries({ category:80, product:140, audience:160, question:180, idea:500,
      evidence:280, contact:250, note:2500, brief:2000, terms:1400, followup:1200 })) fields[k] = clean(data[k],max);
    const channel = ['brief','invite','thread','unknown'].includes(data.channel) ? data.channel : 'unknown';
    const source = clean(data.source, 700);
    if (source) httpUrl(source);
    const amounts = {};
    for (const k of ['productionFee','rightsFee','extrasFee']) {
      const amount = Number(data[k] ?? 0);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error('Проверь суммы сметы');
      amounts[k] = Math.round(amount * 100);
    }
    const dates = {};
    for (const k of ['deadline','rightsEnd','invoiceDue']) {
      dates[k] = clean(data[k],10);
      if (dates[k]) dueDate(dates[k],settings().timezone);
    }
    return { ...fields, ...amounts, ...dates, url, email, source, name, channel, lang: data.lang === 'EN' ? 'EN' : 'DE' };
  }
  function create(input, actor, outreach, alternateOf) {
    const data = validate(input);
    const key = keyFor(data);
    return atomic(() => {
      const existing=duplicates(data.name,data.email);
      if (existing.address) throw new Error('Этот email уже есть в карточке «'+existing.address.name+'»');
      let brandGroup;
      if (alternateOf) {
        const original=brand(alternateOf);
        if (!original || groupName(original.brandGroup||original.name)!==groupName(data.name) || !data.email)
          throw new Error('Открой исходную карточку и проверь email');
        brandGroup=original.brandGroup||original.name;
        const suffix=data.email.split('@')[0].slice(0,28);
        const label=brandGroup.slice(0,58)+' · '+suffix;
        data.name=one('SELECT 1 FROM brands WHERE name_key=?',label.toLowerCase()) ? label+' '+String(Date.now()).slice(-6) : label;
      } else if (existing.same) throw new Error('Бренд уже добавлен: «'+existing.same.name+'». Проверь почту команды перед добавлением нового контакта.');
      const nameKey=data.name.toLowerCase();
      if (one('SELECT id FROM brands WHERE key=? OR name_key=?',key,nameKey))
        throw new Error('Бренд уже в базе. Открой его карточку.');
      const now=Date.now();
      const deadline=clean(input.applicationDeadline,10);
      if (deadline) dueDate(deadline,settings().timezone);
      const item = { ...data, ...(brandGroup?{brandGroup}:{}), groupKey:groupName(brandGroup||data.name), contactReview:input.contactReview===true,
        applicationDeadline:deadline, createdAt:now, addedBy:actor, status:outreach?'sent':'lead', assignee:outreach?.assignee||'',
        due:outreach ? afterDays(outreach.sent,settings().delay,settings().timezone) : 0, sent:outreach?.sent||0, updated:now };
      const {id} = one('INSERT INTO brands(key,name_key,version,data) VALUES (?,?,1,?) RETURNING id',key,nameKey,JSON.stringify(item));
      const b = brand(id);
      event(b,actor,outreach?'Обращение импортировано из CSV':'Бренд добавлен');
      if (input.discovery) run('UPDATE discoveries SET found=0 WHERE url=?',clean(input.discovery,700));
      return b;
    });
  }
  function write(before, data, actor, description) {
    const version = before.version + 1;
    const { id, version: ignored, ...fields } = data;
    const key = keyFor(fields);
    const nameKey=fields.name.toLowerCase();
    if (fields.email && fields.email!==before.email && duplicates('',fields.email,id).address)
      throw new Error('Этот email уже есть в общей базе');
    if (!fields.brandGroup && fields.name!==before.name && duplicates(fields.name,'',id).same)
      throw new Error('Бренд уже есть в общей базе');
    fields.groupKey=groupName(fields.brandGroup||fields.name);
    if (one('SELECT id FROM brands WHERE (key=? OR name_key=?) AND id<>?',key,nameKey,id))
      throw new Error('Этот бренд уже есть в базе');
    run('UPDATE brands SET key=?,name_key=?,version=?,data=? WHERE id=?',key,nameKey,version,JSON.stringify({ ...fields, updated:Date.now() }),id);
    const after = brand(id);
    event(after,actor,description,before);
    return after;
  }
  function change(id, version, actor, fn) {
    return atomic(() => {
      const before = brand(id);
      if (!before || before.version !== version) throw new Error('Карточка обновилась. Открой её заново.');
      const [data, description] = fn(before);
      return write(before,data,actor,description);
    });
  }
  function edit(id, version, actor, input) {
    const data = validate(input);
    return change(id,version,actor,b => {
      const assignee = ['owner','partner',''].includes(input.assignee) ? input.assignee : b.assignee;
      return [{ ...b, ...data, assignee, status: b.status === 'ready' && !isReady(data) ? 'lead' : b.status },'Карточка обновлена'];
    });
  }
  function isReady(b) {
    return b.channel !== 'unknown' && (b.contact || b.email) && b.evidence && b.product && b.idea && b.audience && b.question;
  }
  function move(id, version, actor, next, when) {
    return change(id,version,actor,b => {
      if (!Object.hasOwn(labels,next)) throw new Error('Неизвестный этап');
      if (actor === 'partner' && (b.assignee && b.assignee !== actor ||
          !['lead','ready','sent','interest','details','later'].includes(b.status) ||
          !['sent','interest','details','later','closed'].includes(next))) throw new Error('Этот этап меняется в кабинете');
      if (next === 'ready' && !isReady(b)) throw new Error('Нужны продукт, зритель, вопрос, идея, канал, контакт и основание для обращения');
      const contactReady=!b.contactReview && (b.email || b.source && b.channel!=='unknown');
      if (next==='sent' && !b.sent && (b.contactReview ||
          (b.applicationDeadline && b.applicationDeadline<dateAt(Date.now(),settings().timezone).date)))
        throw new Error('Контакт на проверке или срок подачи уже прошёл');
      if (next === 'sent' && !b.sent && !contactReady && !isReady(b)) throw new Error('Проверь канал для обращения');
      if (actor==='partner' && b.status==='lead' && !contactReady) throw new Error('Карточка ещё на проверке');
      if (next === b.status && !['sent','later'].includes(next)) throw new Error('Этот статус уже установлен');
      const now = Date.now();
      let due = 0;
      if (['later','sent'].includes(next)) {
        const days = Number(when || settings().delay);
        due = typeof when === 'string' ? dueDate(when,settings().timezone) :
          next==='sent'?afterDays(now,days,settings().timezone):now + days * day;
        if (!Number.isFinite(due) || due <= now || due > now + day * 366) throw new Error('Дата напоминания должна быть в пределах года');
      }
      const firstSent = next==='sent' && !b.sent;
      const sent = firstSent ? now : b.sent;
      if (actor === 'partner' && ['interest','details'].includes(next) && !sent) throw new Error('Сначала отметь отправку обращения');
      return [{ ...b, status: next, due, sent, ...(firstSent?{sentBy:actor,checkStage:'initial'}:{}),
        assignee: b.assignee || (['sent','later','closed'].includes(next) ? actor : '') },
        next === 'sent' && b.status === 'sent' ? 'Проверка ответа перенесена' : labels[next]];
    });
  }
  function reserveForOutreach(id,version,actor) {
    return change(id,version,actor,b=>{
      const expired=b.applicationDeadline && b.applicationDeadline<dateAt(Date.now(),settings().timezone).date;
      if (b.sent || !['lead','ready','later'].includes(b.status) ||
          expired || b.contactReview || !(b.email || b.source&&b.channel!=='unknown') || b.assignee)
        throw new Error('Этот бренд уже занят или изменился');
      return [{...b,assignee:actor,outreachReserved:true},'Бренд взят в работу'];
    });
  }
  function approveContact(id,version,actor) {
    return change(id,version,actor,b=>{
      if (!b.contactReview || !b.email || (actor==='partner' && b.addedBy!==actor && b.assignee!==actor))
        throw new Error('Сначала внеси проверенный рабочий email');
      return [{...b,contactReview:false},'Контакт проверен вручную'];
    });
  }
  function releaseOutreach(id,version,actor) {
    return change(id,version,actor,b=>{
      if (b.sent || !b.outreachReserved || b.assignee!==actor || !['lead','ready'].includes(b.status))
        throw new Error('Эту карточку нельзя вернуть в очередь');
      return [{...b,assignee:'',outreachReserved:false},'Бренд возвращён в очередь'];
    });
  }
  function followupStep(id,version,actor,action) {
    return change(id,version,actor,b=>{
      if (b.status!=='sent' || !b.sent || (b.assignee && b.assignee!==actor && actor!=='owner'))
        throw new Error('Открой своё обращение со статусом «Ждём ответ»');
      const now=Date.now();
      const stage=b.checkStage||'initial';
      if (action==='followup-sent' && stage==='followup')
        return [{...b,checkStage:'final',followupSent:now,due:afterDays(now,3,settings().timezone)},'Follow-up отправлен'];
      if (action!=='no-reply') throw new Error('Follow-up пока не запланирован');
      if (b.due>now) throw new Error('Проверка ещё впереди. Дата указана в карточке.');
      if (stage==='initial' || stage==='recheck')
        return [{...b,checkStage:'followup',due:now},'Пора отправить follow-up'];
      if (stage==='final')
        return [{...b,status:'closed',due:0},'Закрыто без ответа после follow-up'];
      throw new Error('Открой черновик follow-up и отметь отправку');
    });
  }
  function projectAction(id,version,actor,action) {
    return change(id,version,actor,b=>{
      const step=projectSteps[b.status];
      if (!step || (actor==='partner' && b.assignee!==actor))
        throw new Error('Действие доступно для твоих активных проектов');
      if (action==='advance') return [{...b,status:step.next,due:0},step.button];
      if (action==='cancel') return [{...b,status:'closed',due:0},'Проект закрыт'];
      const days=Number(action);
      if (![1,3,7].includes(days)) throw new Error('Выбери срок напоминания');
      return [{...b,due:Date.now()+days*day},'Следующий шаг запланирован'];
    });
  }
  function editContact(id,version,actor,input) {
    return change(id,version,actor,b=>{
      if (actor==='partner' && b.assignee!==actor) throw new Error('Сначала возьми бренд в работу');
      const name=clean(input.name,90), email=clean(input.email,254).toLowerCase();
      if (!name || emailAddresses(email)[0]!==email) throw new Error('Проверь название и email');
      if (!['DE','EN'].includes(input.lang)) throw new Error('Выбери язык');
      const existing=duplicates(name,email,id);
      if (existing.address || (existing.same && groupName(name)!==groupName(b.brandGroup||b.name)))
        throw new Error('Бренд или email уже есть в общей базе');
      return [{...b,name,email,lang:input.lang},'Контакты обновлены'];
    });
  }
  function undo(id, version, actor) {
    return change(id,version,actor,b => {
      const last = one('SELECT * FROM events WHERE brand_id=? ORDER BY id DESC LIMIT 1', id);
      if (last?.actor !== actor || last?.version !== b.version || !last?.before || last.description === 'Действие отменено')
        throw new Error('Отменить можно своё последнее изменение карточки');
      return [JSON.parse(last.before),'Действие отменено'];
    });
  }
  function addNote(id, version, actor, text) {
    return change(id,version,actor,b => {
      if (actor === 'partner' && (b.assignee !== actor || !(['sent','later'].includes(b.status) || Object.hasOwn(projectSteps,b.status))))
        throw new Error('Заметки доступны для твоих активных обращений');
      const note = clean(text,801);
      if (!note || note.length > 800) throw new Error('Напиши заметку до 800 символов');
      const combined = [b.note,(actor === 'partner' ? 'Партнёрша: ' : 'Владелец: ') + note].filter(Boolean).join('\n\n');
      if (combined.length > 2500) throw new Error('В карточке закончилось место для заметок. Владелец может освободить его в кабинете.');
      return [{...b,note:combined},'Добавлена заметка'];
    });
  }
  function code(actor) {
    const value = token(8);
    run('DELETE FROM auth WHERE kind=? AND actor=?','login',actor);
    run('INSERT INTO auth VALUES (?,?,?,?)',hash(value),'login',actor,Date.now() + 300_000);
    return value;
  }
  function login(value, owner) {
    return atomic(() => {
      const row = one('SELECT * FROM auth WHERE hash=? AND kind=? AND actor=? AND until>?',hash(value),'login',owner,Date.now());
      if (!row) return null;
      run('DELETE FROM auth WHERE hash=?',row.hash);
      const sid = token();
      run('INSERT INTO auth VALUES (?,?,?,?)',hash(sid),'session',owner,Date.now() + 7 * day);
      return sid;
    });
  }
  const session = (sid, owner) => !!sid && !!one('SELECT 1 FROM auth WHERE hash=? AND kind=? AND actor=? AND until>?',hash(sid),'session',owner,Date.now());
  const logout = sid => run('DELETE FROM auth WHERE hash=?',hash(sid));
  function picks(date) {
    return atomic(() => {
      const existing = one('SELECT ids FROM picks WHERE date=?',date);
      if (existing) return JSON.parse(existing.ids).map(brand).filter(b => b?.status === 'ready' && b.assignee !== 'owner');
      const previous = new Set(all('SELECT ids FROM picks').flatMap(row => JSON.parse(row.ids)));
      const ready = brands().filter(b => b.status === 'ready' && b.assignee !== 'owner').sort((a,b) => a.id - b.id);
      const newIds = ready.filter(b => !previous.has(b.id)).slice(0,settings().count);
      if (newIds.length) run('INSERT INTO picks VALUES (?,?)',date,JSON.stringify(newIds.map(b => b.id)));
      return newIds;
    });
  }
  function replaceSettings(input) {
    const timezone = clean(input.timezone,80);
    try { dateAt(Date.now(),timezone); } catch { throw new Error('Некорректный часовой пояс, например Europe/Berlin'); }
    const hour = clean(input.hour,5);
    const count = Number(input.count ?? settings().count);
    const delay = Number(input.delay);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hour) || !Number.isInteger(count) || count < 1 || count > 10 ||
        !Number.isInteger(delay) || delay < 1 || delay > 30) throw new Error('Проверь время, объём подборки и интервал');
    const dailyGoal = Number(input.dailyGoal ?? settings().dailyGoal);
    if (!Number.isInteger(dailyGoal) || dailyGoal<1 || dailyGoal>50) throw new Error('Укажи дневную цель от 1 до 50');
    const next = { timezone, hour, count, delay, dailyGoal };
    for (const k of ['portfolioDE','portfolioEN']) {
      next[k] = clean(input[k],700);
      if (next[k]) httpUrl(next[k]);
    }
    for (const k of ['creator','searchDE','searchEN']) next[k] = clean(input[k],300);
    put('settings',next);
    return next;
  }
  function backup() {
    return { format:1, exported:new Date().toISOString(), settings:settings(), brands:brands(),
      events:all('SELECT brand_id,actor,at,description FROM events ORDER BY id'), discoveries:all('SELECT data FROM discoveries').map(r=>JSON.parse(r.data)) };
  }
  return { one, all, run, atomic, get, put, settings, brand, brands, create, duplicates, edit, move, reserveForOutreach, approveContact, releaseOutreach, followupStep, projectAction, editContact, undo, addNote, code, login, session, logout, picks,
    replaceSettings, backup, events:id => all('SELECT actor,at,description FROM events WHERE brand_id=? ORDER BY id DESC LIMIT 60',id) };
}

export function pitch(b, config) {
  const creator = config.creator || (b.lang === 'DE' ? '[Name]' : '[your name]');
  const de = b.lang === 'DE';
  const portfolio = de ? config.portfolioDE : config.portfolioEN;
  return de
    ? `Hallo liebes ${b.name}-Team,\n\nich bin ${creator} und erstelle UGC. Für ${b.product || '[Produkt]'} habe ich eine Videoidee:\n${b.idea || '[Idee auf Deutsch]'}\n\n${portfolio ? 'Hier ist eine Arbeitsprobe: ' + portfolio + '\n' : ''}Passt diese Richtung zu eurer Kampagne?\n\nViele Grüße\n${creator}`
    : `Hi ${b.name} team,\n\nI'm ${creator}, a UGC creator. I have a video idea for ${b.product || '[product]'}:\n${b.idea || '[idea in English]'}\n\n${portfolio ? 'Here is a work sample: ' + portfolio + '\n' : ''}Would this direction fit your campaign?\n\nBest,\n${creator}`;
}
