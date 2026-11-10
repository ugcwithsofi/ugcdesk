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
