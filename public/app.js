import { findBrands } from '/brand-search.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
const pages = [
  ['today','◫','Сегодня'], ['brands','◎','Бренды'], ['projects','↗','Проекты'],
  ['radar','✦','Радар'], ['guide','◇','Шпаргалка'], ['settings','⚙','Настройки']
];
const channels = [['unknown','Нужно проверить'],['brief','Открытый бриф'],['invite','Приглашение бренда'],['thread','Текущий диалог']];
const actors = {owner:'Ты',partner:'Партнёрша'};
const workStatuses = new Set(['interest','details','brief','quote','contract','production','review','invoice','paid']);
let data, page = 'today', searchText = '', filter = '', toastTimer;
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format = (ms, opts={dateStyle:'medium'}) => new Intl.DateTimeFormat('ru',{...opts,timeZone:data?.settings.timezone||'Europe/Berlin'}).format(ms);
const euros = cents => new Intl.NumberFormat('ru',{style:'currency',currency:'EUR'}).format(cents/100);
const button = (label,action,value='',style='secondary') => `<button type="button" class="btn ${style}" data-action="${action}" data-value="${esc(value)}">${label}</button>`;
const link = (url, label) => {
  try {
    if (['http:','https:'].includes(new URL(url).protocol))
      return `<a class="btn secondary" target="_blank" rel="noopener noreferrer" href="${esc(url)}">${label} ↗</a>`;
  } catch {}
  return '';
};
const badge = b => `<span class="tag ${b.status}">${esc(data.labels[b.status])}</span>`;
const logo = '<div class="mark"><img src="/icon.svg" alt="">UGC desk</div>';
const empty = text => '<p class="empty">'+text+'</p>';
const heading = (eyebrow,title,caption,actions='') => `<div class="title"><div><div class="eyebrow muted">${eyebrow}</div><h1>${title}</h1><p class="muted">${caption}</p></div><div class="actions">${actions}</div></div>`;
const panel = (title,body,action='') => `<section class="panel"><header class="panel-head"><h2>${title}</h2>${action}</header>${body}</section>`;
const add = () => button('+ Добавить бренд','new','','primary');

function notice(message) {
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toast.textContent='',3800);
}
async function api(path,body) {
  const response = await fetch('/api/'+path,body===undefined?undefined:{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') { if(dialog.open)dialog.close(); loginView(); }
    throw new Error(result.error || 'Запрос не выполнен');
  }
  return result;
}
function loginView(message='') {
  data = null;
  app.innerHTML = `<main id="main" class="login">
    <section class="login-aside">${logo}<div class="eyebrow">Твой UGC-кабинет</div>
      <h1>От первого питча<br>до оплаты.</h1><p>Подборки, история переписки и проекты в одном месте. Партнёрша ведёт обращения кнопками в Telegram.</p>
    </section><section class="login-box"><form class="form panel login-form" data-form="login">
      <div class="eyebrow muted">Доступ владельца</div><h2>Войти в кабинет</h2>
      <p>Открой свой UGC-бот в Telegram и отправь <strong>/login</strong>. Вставь полученный код ниже.</p>
      <label class="field">Одноразовый код<input name="code" maxlength="16" autocomplete="one-time-code" spellcheck="false" required></label>
      <button class="btn">Войти →</button><p class="error" role="alert">${esc(message)}</p>
    </form></section></main>`;
}
async function refresh(renderPage=true) {
  data = await api('desk');
  if (renderPage) render();
}
function render() {
  const view = {today,brands:()=>brandList(false),projects:()=>brandList(true),radar,guide,settings}[page];
  app.innerHTML = `<div class="layout"><aside class="rail">${logo}
    <nav class="nav" aria-label="Разделы">${pages.map(([id,icon,text])=>`<button data-action="nav" data-value="${id}" ${id===page?'aria-current="page"':''}><span class="glyph" aria-hidden="true">${icon}</span>${text}</button>`).join('')}</nav>
    <div class="rail-footer"><strong>Рабочее пространство для двоих</strong>Твой доступ · владелец<br>Партнёрша · Telegram</div>
    </aside><div><header class="top"><span class="eyebrow muted">Рабочее пространство UGC</span><div class="actions">
    ${button('↻ Обновить','refresh','','subtle')}${button('Выйти','logout','','subtle')}</div></header>
    <main class="main" id="main">${view()}</main></div></div>`;
}
function row(b) {
  const detail = [b.category,b.lang,actors[b.assignee],b.due&&'проверка '+format(b.due)].filter(Boolean).join(' · ');
  return `<button type="button" class="row" data-action="card" data-value="${b.id}">
    <span class="monogram" aria-hidden="true">${esc(b.name.slice(0,2).toUpperCase())}</span>
    <span><strong>${esc(b.name)}</strong><small>${esc(detail)}</small></span>${badge(b)}</button>`;
}
function today() {
  const now = Date.now(), {brands,activity} = data;
  const ready = brands.filter(b=>b.status==='ready');
  const waiting = brands.filter(b=>b.status==='sent');
  const projects = brands.filter(b=>workStatuses.has(b.status)&&b.status!=='paid');
  const due = brands.filter(b=>b.due && b.due<=now).sort((a,b)=>a.due-b.due);
  const upcoming = brands.filter(b=>!['closed','paid'].includes(b.status)&&b.deadline).sort((a,b)=>a.deadline.localeCompare(b.deadline)).slice(0,5);
  return `<section class="hero"><div><div class="eyebrow">${esc(format(now,{weekday:'long',day:'numeric',month:'long'}))}</div>
    <h1>У каждого бренда<br>есть следующий шаг.</h1><p>Подготовь подборку, разбери ответы и проверь, что пора сдавать.</p>
    <div class="actions">${button('+ Добавить бренд','new','','lime')}${button('Открыть радар','nav','radar')}</div></div>
    <div class="hero-art" aria-hidden="true"><svg viewBox="0 0 180 160" fill="none"><rect x="32" y="21" width="115" height="119" rx="17" transform="rotate(-9 32 21)" fill="#9ab77e"/><rect x="44" y="21" width="115" height="119" rx="17" transform="rotate(9 44 21)" fill="#eae6fa"/><rect x="37" y="21" width="115" height="119" rx="17" fill="#def48f"/><path d="M62 64l11 11 22-24m-33 57 11 11 22-24m10-27h23m-23 44h23" stroke="#193b2d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="151" cy="33" r="15" fill="#fffefa"/><path d="M151 27v12m-6-6h12" stroke="#193b2d" stroke-width="2" stroke-linecap="round"/></svg></div>
    </section>
    <div class="stats">${[['Готовы к питчу',ready.length],['Ждём ответ',waiting.length],['В работе',projects.length],['Пора проверить',due.length]].map(([name,n])=>`<div class="stat"><small>${name}</small><strong>${n}</strong></div>`).join('')}</div>
    <div class="columns"><div>
    ${panel('Напоминания',due.length?due.map(row).join(''):empty('На сегодня проверок нет. Отметь обращение в карточке, чтобы поставить напоминание.'))}
    ${panel('Готовы к подборке',ready.length?ready.slice(0,7).map(row).join(''):empty('Проверь первый бренд и переведи его в «Готов к питчу».'),
      button('Все бренды →','nav','brands','subtle'))}
    </div><div>
    ${panel('Лента команды',activity.length?`<div class="activity">${activity.slice(0,7).map(e=>`<div><i></i><p><strong>${esc(e.brand)}</strong><br>${actors[e.actor]||'Система'} · ${esc(e.description)}<br><small>${format(e.at,{dateStyle:'short',timeStyle:'short'})}</small></p></div>`).join('')}</div>`:empty('Здесь появится история действий из кабинета и бота.'))}
    ${panel('Сроки сдачи',upcoming.length?`<div class="panel-body">${upcoming.map(b=>`<p><strong>${esc(b.deadline)}</strong> · ${esc(b.name)}</p>`).join('')}</div>`:empty('Добавь дату сдачи в карточке проекта.'))}
    </div></div>`;
}
function brandList(projects) {
  const title = projects ? 'Проекты' : 'База брендов';
  const sub = projects ? 'Бриф, смета, права, производство и оплата.' : 'Общая очередь, история и ответственный за контакт.';
  return heading('Твой кабинет',title,sub,add()) + panel(title,
    `<div class="filters"><input id="search" type="search" aria-label="Поиск брендов" placeholder="Часть названия, продукт, домен или @ник" value="${esc(searchText)}">
    <select id="filter" aria-label="Этап">${options([['','Все этапы'],...Object.entries(data.labels).filter(([s])=>!projects||workStatuses.has(s))],filter)}</select></div>
    <div id="list">${filtered(projects)}</div>`);
}
function filtered(projects) {
  const query = searchText.trim();
  const candidates = data.brands.filter(b=>(!projects||workStatuses.has(b.status))&&(!filter||b.status===filter));
  const list = query ? findBrands(candidates,query,30) : candidates;
  return list.length?list.map(row).join(''):empty('Нет подходящих карточек.');
}
function radar() {
  const results = data.discoveries;
  const status = data.searchStatus;
  const lead = data.searchEnabled?'Проверяй найденные страницы перед переносом в базу.':'Подключи ключ Brave Search по инструкции или добавляй бренды вручную.';
  return heading('Поиск и проверка','Радар брендов',lead,add())+panel('На проверку',`
    <div class="panel-body"><p class="info">Открой источник. Сверь бренд, продукт, язык команды и условия обращения. Затем сохрани карточку.</p>
    ${status?`<p class="muted">Последний запуск ${format(status.at,{dateStyle:'short',timeStyle:'short'})} · ${esc(status.error||'новых результатов: '+status.added)}</p>`:''}</div>
    ${results.length?results.map(x=>`<article class="discovery"><div><small>${esc(x.lang)} · ${esc(x.domain)}</small><p><strong>${esc(x.title||x.domain)}</strong></p></div>
    <div class="actions">${link(x.url,'Источник')}${button('В базу','import',x.url,'primary')}${button('Скрыть','dismiss',x.url,'subtle')}</div></article>`).join(''):empty('Результаты поиска появятся здесь.')}`,
    data.searchEnabled?button('Искать сейчас','discover'):button('Настройки →','nav','settings','subtle'));
}
function guide() {
  const steps = [
    ['01 · Найти','Сохрани ссылку на бренд и на конкретный бриф или продукт. Проверь историю, чтобы вы не написали одной команде дважды.'],
    ['02 · Подготовить питч','Назови зрителя, его вопрос и кадр, который даст ответ. Выбери язык брифа и отправь подходящую версию портфолио.'],
    ['03 · Разобрать ответ','При интересе уточни цель, площадку, сроки, объём и права. Если бренд попросил вернуться позже, поставь дату проверки.'],
    ['04 · Согласовать смету','Раздели производство, права на использование и дополнительные услуги. Укажи срок, площадки, правки и исходники.'],
    ['05 · Снять и сдать','Согласуй бриф и договор, сними хук и демонстрацию, проверь безопасные зоны кадра, звук и субтитры. Зафиксируй правки и ссылку на сдачу.'],
    ['06 · Закрыть проект','Проверь оплату, сохрани итог и поставь дату проверки прав. Продление и повторный заказ обсуждай с брендом отдельно.']
  ];
  return heading('По материалам проекта UGC','Шпаргалка','Рабочие проверки от поиска до продления прав.')+
    steps.map(([title,copy])=>panel(title,'<p class="panel-body">'+copy+'</p>')).join('');
}
const options = (list,value) => list.map(([k,text])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(text)}</option>`).join('');
function field(label,name,value='',type='text',attrs='',hint='') {
  const element = type==='textarea'
    ? `<textarea name="${name}" ${attrs}>${esc(value)}</textarea>`
    : `<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
  return `<label class="field ${type==='textarea'?'full':''}">${label}${element}${hint?`<small>${hint}</small>`:''}</label>`;
}
const select = (label,name,list,value) => `<label class="field">${label}<select name="${name}">${options(list,value)}</select></label>`;
function settings() {
  const s=data.settings;
  const chat = yes=>yes?'Чат подключён':'Открой бот и нажми Start';
  return heading('Только владелец','Настройки','Расписание, портфолио и подключение команды.',
    '<a class="btn secondary" href="/api/export" download>Экспорт JSON ↓</a>')+
    panel('Подборки, напоминания и поиск',`<form class="panel-body form" data-form="settings">
      <div class="fields">
      ${field('Брендов за день','count',s.count,'number','min="1" max="10" required')}
      ${field('Время подборки','hour',s.hour,'time','required')}
      ${field('Часовой пояс','timezone',s.timezone,'text','required','Например, Europe/Berlin')}
      ${field('Проверить ответ через, дней','delay',s.delay,'number','min="1" max="30" required')}
      ${field('Имя для черновика','creator',s.creator)}
      ${field('Портфолио DE','portfolioDE',s.portfolioDE,'url')}
      ${field('Портфолио EN','portfolioEN',s.portfolioEN,'url')}
      </div><h3>Запросы радара</h3><p class="muted">Каждый заполненный запрос запускается раз в день при подключённом ключе. Оставь поле пустым, чтобы отключить запрос.</p>
      <div class="fields">${field('Поиск DE','searchDE',s.searchDE,'text','maxlength="300" placeholder="D2C Hautpflege Creator Kooperation"')}
      ${field('Поиск EN','searchEN',s.searchEN,'text','maxlength="300" placeholder="homeware brands creator collaboration UK"')}</div>
      <div class="actions"><button class="btn">Сохранить настройки</button></div></form>`)+
    panel('Доступ для двоих',`<div class="panel-body"><p><strong>Ты</strong> · кабинет и Telegram · ${chat(data.roles.owner)}</p>
    <p><strong>Партнёрша</strong> · только Telegram · ${chat(data.roles.partner)}</p>
    <p class="muted">Telegram ID задаются в конфигурации сервера.</p></div>`);
}

function openDialog(title,content) {
  dialog.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${button('Закрыть ×','close','','subtle')}</header>
    <div class="dialog-body">${content}<p id="dialog-status" role="alert"></p></div>`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop=0;
}
function brandForm(b={},discovery='') {
  const money = (label,name) => field(label,name,(b[name]??0)/100,'number','min="0" max="1000000" step="0.01"');
  openDialog(b.id?'Редактировать карточку':'Добавить бренд',`<form class="form" data-form="brand">
    <input type="hidden" name="id" value="${b.id||''}"><input type="hidden" name="version" value="${b.version||''}">
    <input type="hidden" name="discovery" value="${esc(discovery)}">
    <div class="fields">
    ${field('Название','name',b.name,'text','required maxlength="90"')}
    ${field('Сайт или профиль бренда','url',b.url,'url','maxlength="700"')}
    ${field('Email контакта','email',b.email,'email','maxlength="254"')}
    ${field('Категория','category',b.category)}
    ${select('Язык обращения','lang',[['DE','Deutsch'],['EN','English']],b.lang||'DE')}
    ${field('Продукт','product',b.product)}
    ${field('Кому нужен продукт','audience',b.audience)}
    ${field('Какой вопрос решает ролик','question',b.question)}
    ${field('Ссылка на бриф или источник','source',b.source,'url')}
    ${select('Канал и основание','channel',channels,b.channel||'unknown')}
    ${field('Куда написать','contact',b.contact,'text','','Почта, профиль или форма из брифа')}
    ${field('Что подтверждает основание','evidence',b.evidence,'text','','Например, бренд приглашает откликнуться в опубликованном брифе')}
    ${b.id?select('Ответственный','assignee',[['','Свободно'],['owner','Ты'],['partner','Партнёрша']],b.assignee):''}
    ${field('Идея и первый кадр','idea',b.idea,'textarea','maxlength="500"','Напиши на языке обращения, чтобы вставить в черновик.')}
    ${field('Заметки и фактическая переписка','note',b.note,'textarea','maxlength="2500"')}
    </div>
    ${b.id?`<h3>Проект</h3><div class="fields">
    ${field('Бриф: цель, площадки, объём, сроки','brief',b.brief,'textarea')}
    ${money('Производство, €','productionFee')}${money('Права, €','rightsFee')}${money('Дополнительно, €','extrasFee')}
    ${field('Срок сдачи','deadline',b.deadline,'date')}${field('Окончание прав','rightsEnd',b.rightsEnd,'date')}${field('Проверить оплату','invoiceDue',b.invoiceDue,'date')}
    ${field('Условия: площадки, права, правки, исходники','terms',b.terms,'textarea')}
    ${field('Следующее действие / ссылка на сдачу','followup',b.followup,'textarea')}
    </div>`:''}
    <div class="actions"><button class="btn">Сохранить карточку</button>${button('Отмена','close')}</div>
  </form>`);
}
async function showCard(id) {
  const {brand:b,events,pitch} = await api('brands/'+id);
  const total = b.productionFee+b.rightsFee+b.extrasFee;
  const when = b.due?format(b.due,{dateStyle:'medium',timeStyle:'short'}):'—';
  openDialog(b.name,`<div class="actions">${badge(b)}<span class="tag">${b.lang}</span><span class="muted">${actors[b.assignee]||'Без ответственного'}</span></div>
    <div class="actions">${link(b.url,'Сайт бренда')}${link(b.source,'Бриф / источник')}${button('Редактировать','edit',b.id)}</div>
    <p><strong>Продукт</strong> · ${esc(b.product||'—')}<br><strong>Идея</strong> · ${esc(b.idea||'—')}<br>
    <strong>Канал</strong> · ${esc(Object.fromEntries(channels)[b.channel])} ${esc(b.contact)}<br><strong>Проверка ответа</strong> · ${when}</p>
    ${b.evidence?`<p class="info">${esc(b.evidence)}</p>`:''}
    <form class="form" data-form="move"><input type="hidden" name="id" value="${b.id}"><input type="hidden" name="version" value="${b.version}">
    <div class="fields">${select('Этап','status',Object.entries(data.labels),b.status)}${field('Дата проверки для «Ждём ответ» / «Позже»','when','','date')}</div>
    <div class="actions"><button class="btn">Обновить этап</button>${events[0]?.actor==='owner'&&events[0]?.description!=='Действие отменено'&&events.length>1?button('↶ Отменить','undo',b.id+':'+b.version):''}</div></form>
    <h3>Черновик обращения</h3><pre id="pitch">${esc(pitch)}</pre><div class="actions">${button('Копировать черновик','copy')}</div>
    <h3>Бриф и условия</h3><p>${esc(b.brief||'Бриф ещё не заполнен.')}</p>
    <p>Производство ${euros(b.productionFee)} · права ${euros(b.rightsFee)} · дополнения ${euros(b.extrasFee)}<br><strong>Итого ${euros(total)}</strong></p>
    ${b.terms?`<p>${esc(b.terms)}</p>`:''}
    <p class="muted">Сдача ${esc(b.deadline||'—')} · оплата ${esc(b.invoiceDue||'—')} · окончание прав ${esc(b.rightsEnd||'—')}</p>
    ${b.followup?`<p class="info">${esc(b.followup)}</p>`:''}
    ${b.note?`<h3>Заметки</h3><pre>${esc(b.note)}</pre>`:''}
    <h3>История действий</h3><div class="history">${events.map(e=>`<div><span>${actors[e.actor]||'Система'} · ${esc(e.description)}</span><small>${format(e.at,{dateStyle:'short',timeStyle:'short'})}</small></div>`).join('')}</div>`);
}

function report(err) {
  const target = dialog.open ? dialog.querySelector('#dialog-status') : null;
  if (target) target.textContent=err.message; else notice(err.message);
}
document.addEventListener('click',async e=>{
  const target=e.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const {action,value}=target.dataset;
  target.disabled=true;
  try {
    if (action==='nav') {page=value;searchText='';filter='';render();document.querySelector('#main').scrollIntoView();}
    if (action==='refresh') {await refresh();notice('Кабинет обновлён');}
    if (action==='logout') {await api('logout',{});loginView();}
    if (action==='close') dialog.close();
    if (action==='new') brandForm();
    if (action==='card') await showCard(value);
    if (action==='edit') {const {brand}=await api('brands/'+value);brandForm(brand);}
    if (action==='copy') {await navigator.clipboard.writeText(dialog.querySelector('#pitch').textContent);notice('Черновик скопирован');}
    if (action==='undo') {const [id,version]=value.split(':');await api('brands/'+id+'/undo',{version});await refresh();await showCard(id);}
    if (action==='discover') {const {added}=await api('discover',{});await refresh();notice('Новых страниц: '+added);}
    if (action==='dismiss') {await api('discover/dismiss',{url:value});await refresh();}
    if (action==='import') {
      const hit=data.discoveries.find(x=>x.url===value);
      if(hit)brandForm({lang:hit.lang,url:new URL(hit.url).origin,source:hit.url},hit.url);
    }
  } catch(err) {report(err);}
  finally {target.disabled=false;}
});
document.addEventListener('input',e=>{
  if(e.target.id==='search'){searchText=e.target.value;document.querySelector('#list').innerHTML=filtered(page==='projects');}
});
document.addEventListener('change',e=>{
  if(e.target.id==='filter'){filter=e.target.value;document.querySelector('#list').innerHTML=filtered(page==='projects');}
});
document.addEventListener('submit',async e=>{
  const form=e.target;
  if(!form.dataset.form)return;
  e.preventDefault();
  const submit=form.querySelector('button[type="submit"],button:not([type])');
  if(submit.disabled)return;
  submit.disabled=true;
  const values=Object.fromEntries(new FormData(form));
  try {
    if(form.dataset.form==='login'){await api('login',values);await refresh();}
    if(form.dataset.form==='settings'){await api('settings',values);await refresh();notice('Настройки сохранены');}
    if(form.dataset.form==='brand'){
      const b=await api(values.id?'brands/'+values.id+'/edit':'brands',values);
      await refresh();await showCard(b.id);notice('Карточка сохранена');
    }
    if(form.dataset.form==='move'){
      await api('brands/'+values.id+'/move',values);await refresh();await showCard(values.id);notice('Этап обновлён');
    }
  } catch(err) {
    if(form.dataset.form==='login')form.querySelector('.error').textContent=err.message;
    else report(err);
  } finally {submit.disabled=false;}
});
refresh().catch(err=>loginView(err.message==='Войди через Telegram'?'':err.message));

setInterval(async ()=>{
  if (!data || document.hidden || dialog.open || !['today','brands','projects'].includes(page) ||
      document.activeElement?.matches('input, select')) return;
  const previous = data;
  const currentPage = page;
  try {
    const next = await api('desk');
    if (data !== previous || page !== currentPage || dialog.open) return;
    data = next;
    if (JSON.stringify(previous.brands) !== JSON.stringify(next.brands)) render();
  } catch {}
},12_000);
