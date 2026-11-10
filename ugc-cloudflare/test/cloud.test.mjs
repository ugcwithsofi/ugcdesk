import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DeskRuntime } from '../desk-runtime.mjs';
import { readOutreachCsv, applyOutreachCsv } from '../csv-import.mjs';

const origin='https://desk.example.test';
const env={BOT_TOKEN:'12345:synthetic-token-for-local-tests',SETUP_KEY:'synthetic-setup-key-for-local-tests',
  OWNER_TELEGRAM_ID:'101',PARTNER_TELEGRAM_ID:'202'};

function sqlHarness() {
  const db=new DatabaseSync(':memory:');
  return {db,storage:{
    sql:{exec(query,...args){
      if (query.trim().startsWith('CREATE TABLE') && query.includes('telegram_updates')) {
        db.exec(query);
        return {toArray:()=>[],rowsWritten:0};
      }
      const statement=db.prepare(query);
      if (statement.columns().length) return {toArray:()=>statement.all(...args),rowsWritten:0};
      const {changes}=statement.run(...args);
      return {toArray:()=>[],rowsWritten:changes};
    }},
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {const value=fn();db.exec('COMMIT');return value;}
      catch (err) {db.exec('ROLLBACK');throw err;}
    }
  }};
}
function telegram() {
  const calls=[];
  const fetcher=async (url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1);
    if (url.includes('/file/bot')) return new Response('brand,email,sent_at,assignee\nFrom file,hi@example.net,2026-01-01,partner');
    calls.push({method,...JSON.parse(options.body)});
    const value={getMe:{username:'UGCExampleBot'},setWebhook:true,getFile:{file_path:'documents/file_1.csv'},
      sendMessage:{message_id:calls.length}}[method]??true;
    return Response.json({ok:true,result:value});
  };
  return {calls,fetcher};
}
const post=(path,body,headers={})=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
const message=(updateId,user,text)=>({update_id:updateId,message:{from:{id:user},chat:{id:user,type:'private'},text}});
const callback=(updateId,user,data)=>({update_id:updateId,callback_query:{id:'q'+updateId,data,from:{id:user},
  message:{message_id:10,chat:{id:user,type:'private'}}}});

test('bootstrap, secret webhook, owner-only login and repeat update',async()=>{
  const {db,storage}=sqlHarness();
  const {calls,fetcher}=telegram();
  try {
    const initial=new DeskRuntime(storage,{...env,OWNER_TELEGRAM_ID:'',PARTNER_TELEGRAM_ID:''},fetcher);
    assert.equal((await initial.fetch(post('/setup/connect',{key:'x'.repeat(24)},{origin}))).status,403);
    const connected=await initial.fetch(post('/setup/connect',{key:env.SETUP_KEY},{origin}));
    assert.equal(connected.status,200);
    assert.equal((await connected.json()).username,'UGCExampleBot');
    const registered=calls.find(c=>c.method==='setWebhook');
    assert.equal(registered.url,origin+'/telegram/webhook');
    assert.equal((await initial.fetch(post('/telegram/webhook',message(1,101,'/id')))).status,403);
    const tg={'X-Telegram-Bot-Api-Secret-Token':registered.secret_token};
    await initial.fetch(post('/telegram/webhook',message(1,101,'/id'),tg));
    assert.match(calls.at(-1).text,/Telegram ID: 101/);
    const desk=new DeskRuntime(storage,env,fetcher);
    const send=body=>desk.fetch(post('/telegram/webhook',body,tg));
    await send(message(2,202,'/login'));
    assert.match(calls.at(-1).text,/владельцу/);
    await send(message(3,101,'/login'));
    const code=calls.at(-1).text.match(/\b[a-f0-9]{16}\b/)[0];
    const before=calls.length;
    assert.equal((await send(message(3,101,'/login'))).status,200);
    assert.equal(calls.length,before);
    const login=await desk.fetch(post('/api/login',{code},{origin}));
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'),/HttpOnly.*SameSite=Strict.*Secure/);
    assert.equal((await desk.fetch(post('/api/login',{code},{origin}))).status,401);
    assert.equal((await desk.fetch(new Request(origin+'/api/desk'))).status,401);
    assert.equal((await desk.fetch(new Request(origin+'/api/desk',{headers:{cookie}}))).status,200);
  } finally {db.close();}
});

test('CSV preview survives restarting the object, email lookup, reply and scheduled reminders',async()=>{
  const {db,storage}=sqlHarness();
  const {calls,fetcher}=telegram();
  try {
    let desk=new DeskRuntime(storage,env,fetcher);
    await desk.fetch(post('/setup/connect',{key:env.SETUP_KEY},{origin}));
    const tg={'X-Telegram-Bot-Api-Secret-Token':calls.find(c=>c.method==='setWebhook').secret_token};
    const send=body=>desk.fetch(post('/telegram/webhook',body,tg));
    const file=message(11,101,'');
    file.message.document={file_id:'file',file_name:'brands.csv',file_size:200};
    assert.equal((await send(file)).status,200);
    const confirm=calls.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(desk.store.brands().length,0);
    desk=new DeskRuntime(storage,env,fetcher);
    await send(callback(12,101,confirm));
    assert.equal(desk.store.brands().length,1);
    const csv='brand,email,sent_at,assignee\n'+Array.from({length:500},(_,i)=>`Brand ${i},lead${i}@example.net,2026-01-01,partner`).join('\n');
    assert.equal(applyOutreachCsv(desk.store,readOutreachCsv(csv)).sent,500);
    await send(message(13,202,'From: Contact <lead249@example.net>'));
    assert.match(calls.at(-1).text,/Brand 249/);
    const brand=desk.store.brands().find(b=>b.name==='Brand 249');
    await send(callback(14,202,`a:${brand.id}:${brand.version}:interest`));
    assert.equal(desk.store.brand(brand.id).status,'interest');
    await desk.runSchedule();
    await desk.runSchedule();
    assert.equal(calls.filter(c=>c.text?.includes('Пора проверить 500 обращений')).length,1);
  } finally {db.close();}
});

test('Telegram creates a brand, assigns it once, counts the first email and guides the follow-up',async()=>{
  const {db,storage}=sqlHarness();
  const {calls,fetcher}=telegram();
  try {
    const desk=new DeskRuntime(storage,env,fetcher);
    await desk.fetch(post('/setup/connect',{key:env.SETUP_KEY},{origin}));
    const tg={'X-Telegram-Bot-Api-Secret-Token':calls.find(c=>c.method==='setWebhook').secret_token};
    let updateId=100;
    const send=(user,text)=>desk.fetch(post('/telegram/webhook',message(++updateId,user,text),tg));
    const press=(user,data)=>desk.fetch(post('/telegram/webhook',callback(++updateId,user,data),tg));
    const action=(b,name)=>`a:${b.id}:${b.version}:${name}`;
    await send(202,'/start');
    assert.equal(calls.find(c=>c.reply_markup?.keyboard).reply_markup.keyboard[0][0],'☀ Сегодня');
    await press(202,'add');
    await send(202,'hello@new-brand.example');
    await send(202,'New Brand');
    const save=calls.at(-1).reply_markup.inline_keyboard[0][1].callback_data;
    await press(202,save);
    assert.equal(desk.store.brands().length,1);
    const csv='brand,email\nCSV Brand,hello@csv-brand.example';
    applyOutreachCsv(desk.store,readOutreachCsv(csv));
    await press(202,'next:0');
    let b=desk.store.brands().find(b=>b.name==='New Brand');
    assert.equal(b.assignee,'partner');
    assert.match(calls.at(-1).text,/hello@new-brand.example/);
    await press(101,'next:0');
    assert.match(calls.at(-1).text,/CSV Brand/);
    await press(202,action(b,'sent'));
    b=desk.store.brand(b.id);
    const originalSent=b.sent;
    assert.ok(b.due>b.sent);
    await send(202,'☀ Сегодня');
    assert.match(calls.at(-1).text,/Написать брендам: 1 из 10/);
    await press(202,action(b,'no-reply'));
    assert.equal(desk.store.brand(b.id).checkStage,'initial');
    const expire=()=>desk.store.run("UPDATE brands SET data=json_set(data,'$.due',?) WHERE id=?",Date.now()-1,b.id);
    expire();
    await press(202,action(b,'no-reply'));
    b=desk.store.brand(b.id);
    assert.equal(b.checkStage,'recheck');
    expire();
    await press(202,action(b,'no-reply'));
    b=desk.store.brand(b.id);
    assert.equal(b.checkStage,'followup');
    await press(202,action(b,'followup-draft'));
    assert.match(calls.at(-1).text,/follow up/);
    await press(202,action(b,'followup-sent'));
    b=desk.store.brand(b.id);
    assert.equal(b.checkStage,'final');
    assert.equal(b.sent,originalSent);
    expire();
    await press(202,action(b,'no-reply'));
    assert.equal(desk.store.brand(b.id).status,'closed');
  } finally {db.close();}
});
