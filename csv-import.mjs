import { emailAddresses } from './public/brand-search.mjs';

export function readOutreachCsv(input, now=Date.now()) {
  const text=input.replace(/^\uFEFF/,'');
  const delimiter=text.split(/\r?\n/,1)[0].includes(';')?';':',';
  const table=[];
  let row=[], field='', quoted=false, closed=false;
  function endField() { row.push(field.trim()); field=''; closed=false; }
  function endRow() {
    endField();
    if (row.some(Boolean)) table.push(row);
    row=[];
  }
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch==='"' && text[i+1]==='"') {field+='"';i++;}
      else if (ch==='"') {quoted=false;closed=true;}
      else field+=ch;
    } else if (ch===delimiter) endField();
    else if (ch==='\n'||ch==='\r') {
      endRow();
      if(ch==='\r'&&text[i+1]==='\n')i++;
    } else if (ch==='"'&&!field.trim()&&!closed) {field='';quoted=true;}
    else if (closed&&!/\s/.test(ch) || ch==='"') throw new Error('Проверь кавычки в CSV');
    else field+=ch;
  }
  if (quoted) throw new Error('В CSV есть незакрытые кавычки');
  endRow();
  const header=table.shift()?.map(v=>v.toLowerCase())||[];
  if (!['brand','email'].every(key=>header.includes(key)) || new Set(header).size!==header.length)
    throw new Error('Первая строка должна содержать колонки brand и email без повторов');
  if (!table.length || table.length>2000) throw new Error('В одном файле должно быть от 1 до 2000 строк');
  return table.map((cells,i)=>{
    const line=i+2;
    if (cells.length!==header.length) return {line,error:'количество столбцов не совпадает с заголовком'};
    const v=Object.fromEntries(header.map((key,j)=>[key,cells[j]]));
    const email=v.email?.toLowerCase();
    if (!v.brand || (email && emailAddresses(email)[0]!==email) || (!email && !v.url && !v.source))
      return {line,error:'нужно название и email или ссылка'};
    if (v.assignee && !['owner','partner'].includes(v.assignee)) return {line,error:'assignee должен быть owner или partner'};
    if (v.lang && !['DE','EN'].includes(v.lang.toUpperCase())) return {line,error:'lang должен быть DE или EN'};
    const sent=Date.parse(v.sent_at);
    if (v.sent_at && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v.sent_at) ||
      !Number.isFinite(sent) || sent<=0 || sent>now || new Date(v.sent_at.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==v.sent_at.slice(0,10)))
      return {line,error:'sent_at должен быть фактической датой в формате ГГГГ-ММ-ДД или ISO со смещением'};
    return {line,input:{name:v.brand,email,url:v.url||(!email?v.source:''),source:v.source,channel:v.channel,
      applicationDeadline:v.application_deadline,contactReview:v.review==='yes',note:v.note,
      lang:v.lang?.toUpperCase(),product:v.product,category:v.category},
      outreach:v.sent_at?{sent,assignee:v.assignee||'owner'}:undefined};
  });
}

export function applyOutreachCsv(store, rows) {
  const result={added:0,sent:0,skipped:0,errors:[]};
  for (const row of rows) {
    try {
      if (row.error) throw new Error(row.error);
      store.create(row.input,'owner',row.outreach);
      result.added++;
      if (row.outreach) result.sent++;
    } catch (err) {
      result.skipped++;
      if (result.errors.length<5) result.errors.push('Строка '+row.line+' · '+err.message);
    }
  }
  return result;
}
