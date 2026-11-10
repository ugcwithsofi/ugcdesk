import { clean, dateAt, day, httpUrl, labels, pitch } from './store.mjs';
import { emailAddresses, findBrands } from './public/brand-search.mjs';
import { applyOutreachCsv, readOutreachCsv } from './csv-import.mjs';

const button = (text, callback_data) => ({ text, callback_data });
const menu = { keyboard:[['🔎 Найти','▦ Мои бренды'],['☀ Подборка','◷ Напоминания']], resize_keyboard:true };
const channels = { brief:'Открытый бриф', invite:'Приглашение бренда', thread:'Текущий диалог', unknown:'Нужно проверить' };
class TelegramError extends Error {
  constructor(code, retry) { super('Telegram API: ' + code); this.code = code; this.retry = retry; }
}

export function makeTelegram(token, fetcher = fetch) {
  return async function api(method, data, signal) {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(40_000)]) : AbortSignal.timeout(15_000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const error = new TelegramError(result.error_code || response.status,result.parameters?.retry_after);
      error.unchanged = result.description?.includes('message is not modified');
      throw error;
    }
    return result.result;
  };
}

export function createBot(store, config, api = makeTelegram(config.token), fetcher = fetch) {
  const { owner, partner } = config;
  const actor = id => id === owner ? 'owner' : id === partner ? 'partner' : '';
  const send = (chat,text,markup) => api('sendMessage',{ chat_id:chat,text,link_preview_options:{is_disabled:true},reply_markup:markup });
  const inline = (chat,text,rows) => send(chat,text,{inline_keyboard:rows});
  function screen(chat,messageId) {
    if (!messageId) return (text,rows) => inline(chat,text,rows);
    return async (text,rows) => {
      try {
        return await api('editMessageText',{chat_id:chat,message_id:messageId,text,
          link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:rows}});
      } catch (err) {
        if (err.unchanged) return;
        if (err.code !== 400) throw err;
        return inline(chat,text,rows);
      }
    };
  }
  const canSee = (b,who) => who === 'owner' ||
    (b.assignee !== 'owner' && (b.assignee === 'partner' || b.status === 'ready') && b.status !== 'lead');
  function cards(render, list, title, {empty='Пока пусто.',offset=0,route='',back='mine',size=8}={}) {
    offset = Math.min(Math.max(0,offset),Math.max(0,Math.floor((list.length-1)/size)*size));
    const items = list.slice(offset,offset+size);
    const rows = items.map(b => [button(b.name.slice(0,34)+' · '+labels[b.status],'b:'+b.id)]);
    const arrows = [];
    if (route && offset) arrows.push(button('← Назад',route+':'+Math.max(0,offset-size)));
    if (route && list.length > offset+size) arrows.push(button('Дальше →',route+':'+(offset+size)));
    if (arrows.length) rows.push(arrows);
    const nav = [button('🔎 Поиск','search')];
    if (back) nav.push(button('Мои бренды',back));
    rows.push(nav);
    const count = list.length ? '\n'+(offset+1)+'–'+(offset+items.length)+' из '+list.length : '\n\n'+empty;
    return render(title+count,rows);
  }
  const listFor = who => store.brands().filter(b=>canSee(b,who));
  const recents = who => (store.get('recent:'+who,[]) || []).map(store.brand).filter(b=>b&&canSee(b,who));
  const favoriteIds = who => store.get('favorites:'+who,[]);
  const favorites = who => favoriteIds(who).map(store.brand).filter(b=>b&&canSee(b,who));
  function remember(b,who) {
    const current = store.get('recent:'+who,[]);
    store.put('recent:'+who,[b.id,...current.filter(id=>id!==b.id)].slice(0,12));
  }
  function myBrands(render,who) {
    const list = listFor(who);
    const count = states=>list.filter(b=>states.includes(b.status)).length;
    const recent = recents(who).slice(0,4);
    const pinned = favorites(who);
    const rows = [[button('🔎 Найти бренд','search')]];
    if (pinned.length) rows.push([button('★ Избранное · '+pinned.length,'fav:0')]);
    for (const b of recent) rows.push([button('↶ '+b.name.slice(0,34)+' · '+labels[b.status],'b:'+b.id)]);
    rows.push([button('Ждём ответ · '+count(['sent']),'list:sent:0'),button('Позже · '+count(['later']),'list:later:0')],
      [button('Есть ответ · '+count(['interest','details']),'list:replies:0'),button('Проекты · '+count(['brief','quote','contract','production','review','invoice','paid']),'list:projects:0')],
      [button('Готовы к питчу · '+count(['ready']),'list:ready:0'),button('Закрыто · '+count(['closed']),'list:closed:0')]);
    if (who==='owner') rows.push([button('На проверке · '+count(['lead']),'list:lead:0')],
      [button('🔑 Код для кабинета','login')]);
    return render('▦ Мои бренды\n\n'+(recent.length?'Недавно открытые карточки сверху. Ниже — разделы по этапам.':
      'Выбери этап или введи часть названия, продукта либо @ник.'),rows);
  }
  function searchPrompt(render) {
    return render('🔎 Найти бренд\n\n' +
      'Для ответа из почты вставь email отправителя или строку From. Также можно искать по части названия, продукту, домену или @нику.\n\n' +
      'Например: «morg», «mrogen», «ьщкпут» или «термокружка».',
      [[button('← Мои бренды','mine')]]);
  }
  function search(render,who,query) {
    const matches = findBrands(listFor(who),query,10);
    const addresses=emailAddresses(query);
    if (addresses.length && matches.length===1) return showCard(render,matches[0],who,'Найдена карточка по email.');
    const title=addresses.length ? addresses.join(', ').slice(0,120) : query.slice(0,80);
    return cards(render,matches,'🔎 Поиск: '+title,{
      empty:addresses.length?'Точного адреса в базе нет. Попробуй название или домен.':
        'Совпадений нет. Попробуй одно характерное слово, начало названия или домен.',size:10
    });
  }
  const dateLabel = ms => new Intl.DateTimeFormat('ru',{dateStyle:'medium',timeStyle:'short',
    timeZone:store.settings().timezone}).format(ms);
  async function showCard(render,b,who,notice='') {
    if (!b || !canSee(b,who)) return render('Карточка недоступна.',[[button('← Мои бренды','mine')]]);
    remember(b,who);
    const key = (text,action) => button(text,`a:${b.id}:${b.version}:${action}`);
    const rows = [];
    const editable = who==='owner' || b.assignee!=='owner';
    const firstContact = b.status==='ready' || b.status==='later'&&!b.sent;
    if (editable && firstContact) {
      rows.push([key('✎ Черновик','pitch')],[key(who==='partner'?'✓ Написала':'✓ Написал','sent')],
        [key('◷ Отложить','dates'),key('Не подходит','skip')]);
    }
    if (['sent','interest','details','later'].includes(b.status)) {
      if (editable && b.sent) {
        const replies = [['Есть интерес','interest'],['Нужны подробности','details']].filter(([,state])=>state!==b.status);
        if (replies.length) rows.push(replies.map(([title,state])=>key(title,state)));
        if (b.status === 'sent') rows.push([key('Ответа нет · перенести','snooze')]);
        rows.push([key('Вернуться позже','dates'),key('Отказали','reject')]);
      }
      if (b.assignee===who || who==='owner') rows.push([key('✎ Добавить заметку','note')]);
    }
    const links = b.url ? [{text:'Сайт ↗',url:b.url}] : [];
    if (b.source && b.source!==b.url) links.push({text:'Источник / бриф ↗',url:b.source});
    if (links.length) rows.push(links);
    const pinned = favoriteIds(who).includes(b.id);
    rows.push([button(pinned?'★ Убрать из избранного':'☆ В избранное','pin:'+b.id+':'+(pinned?'off':'on'))]);
    const last = store.events(b.id)[0];
    if (last?.actor === who && last.description !== 'Действие отменено' && last.description !== 'Бренд добавлен')
      rows.push([key('↶ Отменить действие','undo')]);
    rows.push([button('☀ К подборке','today'),button('▦ Мои бренды','mine')]);
    const due = b.due ? '\nНапомню: '+dateLabel(b.due) : '';
    const next = {ready:'Открой черновик. После отправки нажми кнопку ниже.',
      sent:'Проверь ответ в том канале, где было обращение.',interest:'Запиши, о чём договорились.',
      details:'Сохрани вопросы бренда в заметке.',later:'Вернись к карточке по напоминанию.',
      closed:'Карточка сохранена в разделе «Закрыто».'}[b.status];
    return render([notice,b.name+' · '+b.lang,labels[b.status]+due,b.product && 'Продукт: '+b.product,
      firstContact && b.idea && 'Идея: '+b.idea,b.email && 'Email: '+b.email,b.contact && channels[b.channel]+': '+b.contact,
      !firstContact && b.note && 'Последняя часть заметок: '+b.note.slice(-300),next].filter(Boolean).join('\n\n'),rows);
  }
  function today(render,who,offset=0) {
    const s = store.settings();
    const list = store.picks(dateAt(Date.now(),s.timezone).date).filter(b=>canSee(b,who));
    return cards(render,list,'☀ Подборка на сегодня',{
      empty:'На сегодня новых карточек нет. Открытые обращения и прошлые подборки доступны в «Мои бренды».',offset,route:'today'
    });
  }
  function reminders(render,who,upcoming=false,offset=0) {
    const list = listFor(who).filter(b => b.due && (upcoming ? b.due>Date.now() : b.due<=Date.now())).sort((a,b)=>a.due-b.due);
    return cards((text,rows)=>render(text,[[button(upcoming?'Пора проверить':'Запланировано',upcoming?'rem:0':'upcoming:0')],...rows]),
      list,upcoming?'◷ Запланированные проверки':'◷ Пора проверить', {
        empty:upcoming?'Запланированных проверок нет.':'Сейчас проверять нечего.',offset,route:upcoming?'upcoming':'rem'
      });
  }
  async function home(chat,who) {
    const msg = 'UGC Desk\n\n☀ Подборка — кому написать сегодня.\n🔎 Найти — быстро открыть карточку.\n' +
      '▦ Мои бренды — недавние карточки и этапы.\n◷ Напоминания — что пора проверить.';
    await send(chat,msg,menu);
    if (who === 'owner') await inline(chat,'Управление базой',[[button('📄 Импорт CSV','import')],
      [button('🔑 Код для кабинета','login')]]);
  }
  function importHelp(render) {
    return render('📄 Отправь CSV файлом в этот чат.\n\nОбязательные колонки: brand, email. '+
      'Если письмо уже отправлено, добавь sent_at. В assignee можно указать owner или partner. '+
      'До подтверждения бот только проверит файл.',[[button('← Мои бренды','mine')]]);
  }
  async function receiveCsv(chat,doc) {
    const max=1_500_000;
    if (!/\.csv$/i.test(doc.file_name||'') || !doc.file_size || doc.file_size>max)
      return send(chat,'Нужен CSV до 1,5 МБ. Сохрани его в UTF-8 и отправь как файл.',menu);
    store.put('pendingImport',null);
    try {
      const file=await api('getFile',{file_id:doc.file_id});
      if (!/^documents\/[A-Za-z0-9_.-]+$/.test(file?.file_path||'')) throw new Error('Telegram не вернул путь к документу');
      const response=await fetcher('https://api.telegram.org/file/bot'+config.token+'/'+file.file_path,
        {signal:AbortSignal.timeout(15_000)});
      if (!response.ok) throw new Error('Не удалось скачать документ');
      const data=await response.arrayBuffer();
      if (data.byteLength>max) throw new Error('Файл слишком большой');
      let text;
      try {text=new TextDecoder('utf-8',{fatal:true}).decode(data);}
      catch {throw new Error('Сохрани CSV в кодировке UTF-8');}
      const rows=readOutreachCsv(text);
      const valid=rows.filter(r=>!r.error);
      const ref=String(Date.now());
      store.put('pendingImport',{rows,ref,until:Date.now()+15*60_000});
      const errors=rows.filter(r=>r.error).slice(0,4).map(r=>'Строка '+r.line+' · '+r.error);
      return inline(chat,'CSV проверен\n\nСтрок: '+rows.length+'\nГотовы к импорту: '+valid.length+
        '\nИз них уже отправлены: '+valid.filter(r=>r.outreach).length+
        (errors.length?'\n\n'+errors.join('\n'):'')+'\n\nДубли будут пропущены.',[
          ...(valid.length?[[button('Импортировать','import-ok:'+ref)]]:[]),[button('Отмена','import-no:'+ref)]
        ]);
    } catch (err) {
      const message = err instanceof TypeError ? 'Не удалось получить CSV. Проверь файл и попробуй ещё раз.' : err.message;
      return send(chat,message,menu);
    }
  }
  async function login(chat,who,id) {
    if (who !== 'owner') return send(chat,'Кабинет доступен владельцу.',menu);
    const code = store.code(id);
    const {origin}=config;
    const text = 'Одноразовый код, действует 5 минут:\n\n'+code+'\n\nСкопируй код и вставь его в поле входа.';
    if (origin.startsWith('https:')) await inline(chat,text,[[{text:'Открыть кабинет ↗',url:origin}]]);
    else await send(chat,text+'\nАдрес на компьютере: '+origin);
  }
  async function handle(update) {
    const q = update.callback_query;
    const msg = q?.message || update.message;
    if (!msg || msg.chat.type !== 'private') return;
    const id = String((q?.from || msg.from)?.id);
    const chat = String(msg.chat.id);
    const who = actor(id);
    const text = clean(msg.text,4096).replace(/^(\/\w+)@\w+/,'$1');
    if (!q && text === '/id') return send(chat,'Твой Telegram ID: '+id);
    if (!who) {
      if (q) return api('answerCallbackQuery',{callback_query_id:q.id,text:'Доступ закрыт'});
      if (text.startsWith('/start')) return send(chat,'Это закрытый бот. Для настройки доступа отправь /id и передай число владельцу.');
      return;
    }
    store.run('INSERT OR REPLACE INTO chats VALUES (?,?)',id,chat);
    const render = screen(chat,q && msg.message_id);
    if (!q) {
      if (msg.document && who==='owner') return receiveCsv(chat,msg.document);
      if (text==='/import' && who==='owner') return importHelp(render);
      if (['☀ Подборка','/today'].includes(text)) return today(render,who);
      if (['▦ Мои бренды','/brands'].includes(text)) return myBrands(render,who);
      if (['◷ Напоминания','/reminders'].includes(text)) return reminders(render,who);
      if (['🔎 Найти','/search'].includes(text)) return searchPrompt(render);
      if (text === '/login') return login(chat,who,id);
      const pending = store.get('note:'+id);
      if (text === '/cancel') {
        store.put('note:'+id,null);
        return send(chat,pending?'Заметка отменена.':'Сейчас нет открытой заметки.',menu);
      }
      if (pending && msg.reply_to_message?.message_id === pending.messageId) {
        const b = store.brand(pending.id);
        if (pending.until<Date.now() || !b || !canSee(b,who) || b.version!==pending.version) {
          store.put('note:'+id,null);
          return showCard(render,b,who,'Карточка обновилась или срок ввода истёк. Открой заметку заново.');
        }
        let saved;
        try { saved=store.addNote(b.id,b.version,who,text); }
        catch (err) { return send(chat,err.message+' Ответь ещё раз на запрос заметки.'); }
        store.put('note:'+id,null);
        return showCard(render,saved,who,'✓ Заметка сохранена. Она видна в кабинете.');
      }
      if (text && !text.startsWith('/') && text!=='⌂ Меню') return search(render,who,text);
      return home(chat,who);
    }
    await api('answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
    if (q.data === 'login') return login(chat,who,id);
    const [kind, key, ver, action] = String(q.data).split(':');
    if (kind === 'search') return searchPrompt(render);
    if (kind === 'import' && who==='owner') return importHelp(render);
    if (['import-ok','import-no'].includes(kind) && who==='owner') {
      const pendingImport=store.get('pendingImport');
      if (pendingImport?.ref!==key || pendingImport.until<Date.now())
        return render('Этот запрос устарел. Отправь CSV заново.',[[button('Импорт CSV','import')]]);
      const rows=pendingImport.rows;
      if (kind==='import-no') {
        store.put('pendingImport',null);
        return render('Импорт отменён.',[[button('← Мои бренды','mine')]]);
      }
      const {added,sent,skipped,errors}=applyOutreachCsv(store,rows);
      store.put('pendingImport',null);
      return render('✓ Импорт завершён\n\nДобавлено: '+added+'\nИз них ждут ответа: '+sent+
        '\nПропущено: '+skipped+(errors.length?'\n\n'+errors.join('\n'):''),
        [[button('🔎 Найти бренд','search'),button('▦ Мои бренды','mine')]]);
    }
    if (kind === 'mine') return myBrands(render,who);
    if (kind === 'fav') return cards(render,favorites(who),'★ Избранное',{
      empty:'Открой нужную карточку и нажми «В избранное».',offset:Number(key)||0,route:'fav'
    });
    if (kind === 'today') return today(render,who,Number(key)||0);
    if (kind === 'rem' || kind === 'upcoming') return reminders(render,who,kind==='upcoming',Number(key)||0);
    if (kind === 'list') {
      const filters = {
        sent:['Ждём ответ','sent'],later:['Отложены','later'],replies:['Есть ответ','interest','details'],
        projects:['Проекты','brief','quote','contract','production','review','invoice','paid'],
        ready:['Готовы к питчу','ready'],closed:['Закрыто','closed'],lead:['На проверке','lead']
      };
      if (!Object.hasOwn(filters,key)) return myBrands(render,who);
      const [title,...states] = filters[key];
      const list = listFor(who).filter(b=>states.includes(b.status)).sort((a,b)=>b.updated-a.updated);
      return cards(render,list,title,{offset:Number(ver)||0,route:'list:'+key});
    }
    if (kind === 'b') return showCard(render,store.brand(Number(key)),who);
    if (kind === 'pin') {
      const b=store.brand(Number(key));
      if (!b || !canSee(b,who)) return showCard(render,b,who);
      const ids=favoriteIds(who);
      const remove=ver==='off';
      if (ids.includes(b.id)===!remove) return showCard(render,b,who);
      if (!remove && ids.length>=30) return showCard(render,b,who,'В избранном 30 карточек. Убери одну, чтобы добавить эту.');
      store.put('favorites:'+who,remove?ids.filter(id=>id!==b.id):[b.id,...ids]);
      return showCard(render,b,who,remove?'Карточка убрана из избранного.':'★ Сохранено в избранном.');
    }
    if (kind !== 'a') return;
    const b = store.brand(Number(key));
    if (!b || !canSee(b,who)) return showCard(render,b,who);
    if (b.version !== Number(ver)) return showCard(render,b,who,'Карточка уже обновилась. Вот её текущий статус.');
    const keyFor = (title,value) => button(title,`a:${b.id}:${b.version}:${value}`);
    const back = [button('← Карточка','b:'+b.id)];
    if (action === 'pitch') {
      const draft = pitch(b,store.settings());
      const copy = draft.length<=256 ? [[{text:'Копировать текст',copy_text:{text:draft}}]] : [];
      return render(draft,[...copy,[keyFor(who==='partner'?'✓ Написала':'✓ Написал','sent')],back]);
    }
    if (action === 'note') {
      if (who==='partner' && (b.assignee!==who || !['sent','interest','details','later'].includes(b.status)))
        return showCard(render,b,who,'Заметки доступны для твоих активных обращений.');
      const prompt = await send(chat,'Ответь на это сообщение заметкой для «'+b.name+'» (до 800 символов). Отмена: /cancel.',
        {force_reply:true,input_field_placeholder:'Что ответил бренд?'});
      if (prompt?.message_id) store.put('note:'+id,{id:b.id,version:b.version,messageId:prompt.message_id,until:Date.now()+15*60_000});
      return;
    }
    if (['dates','snooze'].includes(action)) {
      const route = action==='dates'?'later':'check';
      return render('Когда напомнить про '+b.name+'?\nВыбери день. Напоминание придёт в 09:00 по часовому поясу команды.',[
        [1,3,7].map(days=>keyFor(days===1?'Завтра':days+' дн.',route+'-'+days)),back]);
    }
    if (['skip','reject'].includes(action)) {
      return render((action==='skip'?'Убрать из подборки':'Отметить отказ')+' · '+b.name+'?\nКарточка останется в разделе «Закрыто».',
        [[keyFor('Да, закрыть','closed')],back]);
    }
    let next;
    let confirmation;
    try {
      if (action === 'undo') {
        next = store.undo(b.id,b.version,who);
        confirmation = '↶ Предыдущее состояние восстановлено.';
      } else if (/^(later|check)-[137]$/.test(action)) {
        const [mode,days] = action.split('-');
        if (mode==='check' && b.status!=='sent') return showCard(render,b,who);
        const timezone = store.settings().timezone;
        const today = dateAt(Date.now(),timezone).date;
        const target = new Date(Date.parse(today+'T00:00:00Z')+Number(days)*day).toISOString().slice(0,10);
        next = store.move(b.id,b.version,who,mode==='check'?'sent':'later',target);
        confirmation = '✓ Напоминание перенесено.';
      } else if (['sent','interest','details','closed'].includes(action)) {
        next = store.move(b.id,b.version,who,action);
        confirmation = action==='sent' ? '✓ Отправка отмечена. Я напомню проверить ответ.' : '✓ Статус сохранён.';
      }
      else return;
    } catch (err) { return showCard(render,store.brand(b.id),who,err.message); }
    return showCard(render,next,who,confirmation);
  }
  async function notify(key,fn,budget) {
    if (budget.left<=0) return;
    const now = Date.now();
    store.run("INSERT OR IGNORE INTO notices VALUES (?,'pending',?,0)",key,now);
    const claim = store.run("UPDATE notices SET due=?,attempts=attempts+1 WHERE key=? AND status='pending' AND due<=?",now+120_000,key,now);
    if (!claim.changes) return;
    budget.left--;
    try {
      await fn();
      store.run("UPDATE notices SET status='sent',due=? WHERE key=?",now,key);
    } catch (err) {
      if ([400,403].includes(err.code)) store.run("UPDATE notices SET status='failed',due=? WHERE key=?",now,key);
      else {
        const n = store.one('SELECT attempts FROM notices WHERE key=?',key).attempts;
        store.run('UPDATE notices SET due=? WHERE key=?',now+Math.max((err.retry||0)*1000,Math.min(n*60_000,3_600_000)),key);
      }
      console.error('Telegram: доставка',err.code||err.name);
    }
  }
  async function tick() {
    const budget={left:20};
    const s = store.settings(), now = Date.now(), local = dateAt(now,s.timezone);
    const chats = store.all('SELECT * FROM chats').filter(row=>actor(row.actor));
    if (local.time >= s.hour) {
      for (const row of chats) await notify('pick:'+local.date+':'+row.actor,()=>today(screen(row.chat),actor(row.actor)),budget);
    }
    const brands = store.brands();
    const ownerChat = chats.find(c=>c.actor===owner);
    const reminderKey = (b,id) => `reply:${b.id}:${b.due}:${id}`;
    const digested = new Set();
    for (const row of chats) {
      const due = brands.filter(b=>b.due && b.due<=now && (b.assignee==='partner'?partner:owner)===row.actor);
      if (due.length<=5) continue;
      digested.add(row.actor);
      const pending = due.filter(b=>!store.one("SELECT 1 FROM notices WHERE key=? AND status IN ('sent','failed')",reminderKey(b,row.actor)));
      if (!pending.length) continue;
      await notify('reply-digest:'+local.date+':'+row.actor,async()=>{
        await inline(row.chat,'◷ Пора проверить '+due.length+' обращений.\nОткрой очередь или найди ответивший бренд по email.',
          [[button('Открыть очередь','rem:0'),button('🔎 Поиск','search')]]);
        store.atomic(()=>{
          for (const b of pending)
            store.run("INSERT OR REPLACE INTO notices(key,status,due) VALUES (?,'sent',?)",reminderKey(b,row.actor),now);
        });
      },budget);
    }
    for (const b of brands) {
      const assigned = b.assignee === 'partner' ? partner : owner;
      const row = chats.find(c=>c.actor===assigned);
      if (row && !digested.has(row.actor) && b.due && b.due <= now) {
        const buttons = [[button('Открыть карточку','b:'+b.id)]];
        if (b.status==='sent') buttons.unshift([
          button('Есть интерес',`a:${b.id}:${b.version}:interest`),
          button('Ответа нет',`a:${b.id}:${b.version}:snooze`)
        ]);
        await notify(reminderKey(b,assigned),()=>inline(row.chat,
          b.sent ? 'Есть ответ от '+b.name+'?' : 'Пора вернуться к карточке '+b.name+'.',buttons),budget);
      }
      if (!ownerChat) continue;
      const alerts = [['deadline','Срок сдачи',day],['invoiceDue','Проверить оплату',0],['rightsEnd','Проверить продление прав',7*day]];
      for (const [field,title,lead] of alerts) {
        const date = b[field];
        if (!date || b.status === 'closed' || field !== 'rightsEnd' && b.status === 'paid') continue;
        if (Date.parse(date+'T00:00:00Z') - lead > Date.parse(local.date+'T00:00:00Z')) continue;
        await notify(`${field}:${b.id}:${date}`,()=>send(ownerChat.chat,`${title} · ${b.name}\nДата: ${date}`,menu),budget);
      }
    }
    store.run('DELETE FROM auth WHERE until<?',now);
    if (store.get('pendingImport')?.until<now) store.put('pendingImport',null);
    store.run("DELETE FROM notices WHERE status<>'pending' AND due<?",now-400*day);
  }
  return { handle, tick, actor };
}

export async function discover(store, key, fetcher = fetch) {
  if (!key) throw new Error('Добавь BRAVE_SEARCH_KEY в .env');
  const settings = store.settings();
  let added = 0;
  let queries = 0;
  for (const lang of ['DE','EN']) {
    const query = settings['search'+lang];
    if (!query) continue;
    queries++;
    const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
    endpoint.search = new URLSearchParams({q:query,count:'10',country:lang==='DE'?'DE':'GB',search_lang:lang.toLowerCase()});
    const r = await fetcher(endpoint,{headers:{Accept:'application/json','X-Subscription-Token':key},signal:AbortSignal.timeout(15_000)});
    if (!r.ok) throw new Error('Brave Search вернул '+r.status);
    const result = await r.json();
    for (const match of result.web?.results || []) {
      let url;
      try { url = httpUrl(match.url); } catch { continue; }
      url.hash='';
      url.search='';
      const entry = {url:url.href,title:clean(match.title?.replace(/<[^>]*>/g,''),150),lang,domain:url.hostname,query};
      if (store.one('INSERT OR IGNORE INTO discoveries VALUES (?,?,?) RETURNING url',url.href,JSON.stringify(entry),Date.now())) added++;
    }
  }
  if (!queries) throw new Error('В настройках нужен хотя бы один поисковый запрос');
  return added;
}
