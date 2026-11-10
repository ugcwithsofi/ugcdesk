const alphabet = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',
  о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',
  э:'e',ю:'yu',я:'ya'
};
const ruKeys = 'йцукенгшщзхъфывапролджэячсмитьбю';
const enKeys = 'qwertyuiop[]asdfghjkl;\'zxcvbnm,.';
export function emailAddresses(text) {
  const value=String(text||'').slice(0,6000);
  const from=value.match(/^(?:from|von|от|отправитель):[^\r\n]*/im);
  return [...new Set((from?.[0]||value).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)||[])];
}
const words = value => String(value || '').toLowerCase().replace(/ß/g,'ss').normalize('NFKD')
  .replace(/\p{Mark}/gu,'').match(/[\p{Letter}\p{Number}]+/gu) || [];
const latin = value => value.replace(/[а-яё]/g,ch=>alphabet[ch] ?? ch);
const layout = (value,from,to) => value.replace(/./g,ch=>to[from.indexOf(ch)] ?? ch);
function variants(query) {
  const raw = query.toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'')
    .replace(/^(instagram|tiktok|linkedin|facebook)\.com\//,'').split(/[?#]/)[0];
  return [raw,latin(raw),layout(raw,ruKeys,enKeys),layout(raw,enKeys,ruKeys)].map(words).filter(x=>x.length);
}

function editDistance(a,b) {
  let before, row = Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) {
    const next = [i];
    for (let j=1;j<=b.length;j++) {
      next[j] = Math.min(row[j]+1,next[j-1]+1,row[j-1]+Number(a[i-1]!==b[j-1]));
      if (i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) next[j]=Math.min(next[j],before[j-2]+1);
    }
    before=row;
    row=next;
  }
  return row[b.length];
}
function scoreWord(query, candidate, fuzzy) {
  if (query===candidate) return 12;
  if (candidate.startsWith(query)) return query.length>1?9:6;
  if (query.length>=3 && candidate.includes(query)) return 7;
  const tolerance = query.length>=7?2:1;
  if (!fuzzy || query.length<4 || Math.abs(query.length-candidate.length)>tolerance) return 0;
  const distance=editDistance(query,candidate);
  return distance<=tolerance ? 5-distance : 0;
}

export function findBrands(brands, query, limit=10) {
  const addresses=emailAddresses(query);
  if (addresses.length) {
    return brands.filter(b=>emailAddresses([b.email,b.contact].filter(Boolean).join(' ')).some(email=>addresses.includes(email)))
      .sort((a,b)=>(b.sent||0)-(a.sent||0)||b.updated-a.updated).slice(0,limit);
  }
  const queries=variants(query.slice(0,100));
  if (!queries.length) return [];
  const results=[];
  for (const brand of brands) {
    const primary=words(brand.name);
    const aliases=words(brand.url).filter(x=>!['https','http','www','com','net','instagram','tiktok','linkedin','facebook'].includes(x));
    const secondary=words([brand.product,brand.category,brand.contact,brand.email,brand.lang].filter(Boolean).join(' '));
    const tokens=[...primary.map(word=>[word,4]),...aliases.map(word=>[word,3]),...secondary.map(word=>[word,1])];
    if (primary.length>1) tokens.push([primary.join(''),3]);
    const spellings=tokens.flatMap(([word,weight])=>word===latin(word)?[[word,weight]]:[[word,weight],[latin(word),weight]]);
    let best=0;
    for (const [i,parts] of queries.entries()) {
      const scores=parts.map(part=>Math.max(0,...spellings.map(([word,weight])=>scoreWord(part,word,weight>=3)*weight)));
      if (scores.some(x=>!x)) continue;
      const name = primary.join(' ');
      const phrase = parts.join(' ');
      const bonus = phrase===name || phrase===latin(name) ? 55 : name.startsWith(phrase)?22:0;
      best=Math.max(best,bonus+scores.reduce((a,b)=>a+b,0)/parts.length-i);
    }
    if (best) results.push({brand,score:best});
  }
  return results.sort((a,b)=>b.score-a.score || b.brand.updated-a.brand.updated || b.brand.id-a.brand.id)
    .slice(0,limit).map(x=>x.brand);
}
