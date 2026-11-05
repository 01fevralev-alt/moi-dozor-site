const {createHash, timingSafeEqual} = require('node:crypto');

function calls({env, say, btn, getJson, putJson, amo}) {
  const phone = value => {
    const digits = String(value || '').replace(/\D/g, '');
    return /^(?:7|8)?\d{10}$/.test(digits) ? '+7'+digits.slice(-10) : '';
  };
  async function receive(query, body) {
    const expected = Buffer.from(env('SIPUNI_HOOK_SECRET'));
    const provided = Buffer.from(query.key || '');
    const reply = (statusCode, success) => ({
      statusCode, headers:{'Content-Type':'application/json'}, body:JSON.stringify({success})
    });
    if (!expected.length || expected.length !== provided.length || !timingSafeEqual(expected, provided)) return reply(403,false);
    const form = {...query, ...Object.fromEntries(new URLSearchParams(body))};
    if (form.event !== '2' || form.src_type !== '1') return reply(200,true);
    const number = phone(form.src_num);
    if (!number || !form.call_id || !form.status) return reply(200,true);
    const id = createHash('sha256').update(form.call_id).digest('hex').slice(0,24);
    const key = 'sipuni-calls/'+id+'.json';
    const previous = await getJson(key);
    if (previous?.notified) return reply(200,true);
    const date = new Date(Number(form.timestamp)*1000);
    const time = Number.isFinite(date.getTime()) ? date.toLocaleTimeString('ru-RU',{timeZone:'Europe/Samara',hour:'2-digit',minute:'2-digit'}) : '';
    const title = form.status === 'ANSWER' ? 'Входящий звонок принят' : 'Пропущенный входящий звонок';
    await putJson(key,{number, created:Date.now()});
    await say('📞 <b>'+title+'</b>\n'+number+(time?' · '+time:''),{
      chat:env('MAX_ESTIMATE_CHAT_ID'),buttons:[[btn('Создать смету','estimate:call:'+id)]]
    });
    await putJson(key,{number, created:Date.now(), notified:true});
    return reply(200,true);
  }
  async function leads(id) {
    if (!/^[a-f0-9]{24}$/.test(id)) return [];
    const call = await getJson('sipuni-calls/'+id+'.json');
    if (!call || Date.now()-call.created > 7*86400000) return [];
    const result = await amo('/api/v4/contacts?with=leads&query='+encodeURIComponent(call.number.slice(-10)));
    const contacts = (result._embedded?.contacts || []).filter(c => c.custom_fields_values?.some(f =>
      f.field_code==='PHONE' && f.values?.some(v => phone(v.value)===call.number)));
    const ids = [...new Set(contacts.flatMap(c => (c._embedded?.leads || []).map(l=>l.id)))];
    if (!ids.length) return [];
    const query = new URLSearchParams();
    ids.forEach(id => query.append('filter[id][]',String(id)));
    const data = await amo('/api/v4/leads?'+query);
    return (data._embedded?.leads || []).filter(l => ids.includes(l.id) && !l.closed_at && ![142,143].includes(l.status_id));
  }
  return {receive, leads};
}
module.exports = {calls};
