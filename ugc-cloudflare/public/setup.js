const form=document.querySelector('#setup');
const output=document.querySelector('#result');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const field=form.elements.key;
  const submit=form.querySelector('button');
  const key=field.value;
  field.value='';
  submit.disabled=true;
  output.textContent='Подключаю Telegram…';
  try {
    const response=await fetch('/setup/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    const data=await response.json();
    if (!response.ok) {
      output.textContent=(data.error||'Не удалось подключить')+(data.telegramCode?' Код Telegram '+data.telegramCode+'.':'');
      return;
    }
    output.textContent='Подключено: @'+data.username+'. Открой бота в Telegram и отправь '+(data.owner?'/start.':'/id.');
  } catch {
    output.textContent='Не удалось связаться с Worker. Проверь адрес и попробуй ещё раз.';
  } finally {submit.disabled=false;}
});
