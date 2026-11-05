// Вопросы менеджеру по сделке из уведомления о заявке сайта.
const F = { cameras: 425887, object: 407575, address: 321119, legal: 425889, url: 425891, recalc: 425893 };
const questions = [
  ['name', 'Как зовут клиента?'],
  ['city', 'Какой город? Ответьте «+», если Самара.'],
  ['address', 'Какой адрес объекта? Если пока неизвестен, ответьте «−».'],
  ['object', 'Какой тип объекта?'],
  ['cameras', 'Сколько камер?'],
  ['legal', 'Кто заказчик?'],
  ['inn', 'Какой ИНН? Его можно указать позже.'],
];
const field = (lead, id) => lead.custom_fields_values?.find(f => f.field_id === id)?.values?.[0]?.value;
const dealPath = id => '/api/v4/leads/' + id;

function handler({ env, max, amo, getJson, putJson, say, btn, answer }) {
  const allowed = (user, chat) => Boolean(env('MAX_ESTIMATE_USER_ID')) &&
    String(user) === env('MAX_ESTIMATE_USER_ID') && String(chat) === env('MAX_ESTIMATE_CHAT_ID');
  const sayEstimate = (text, opts) => say(text, {...opts, chat:env('MAX_ESTIMATE_CHAT_ID')});
  const sendText = text => max('/messages?chat_id='+encodeURIComponent(env('MAX_ESTIMATE_CHAT_ID'))+'&disable_link_preview=true', { text });

  async function sendResult(state, wait = false) {
    let url;
    for (const delay of wait ? [0, 1500, 2500] : [0]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const lead = await amo(dealPath(state.lead));
      url = field(lead, F.url);
      if (field(lead, F.recalc) || !/^https:\/\/(?:smeta\.xn--d1agelkcbq\.xn--p1ai|smeta\.мойдозор\.рф)\/[a-z0-9-]+$/i.test(url || '')) url = null;
      if (url) break;
    }
    if (!url) {
      await sayEstimate('Данные сохранены. Смета ещё готовится.', {buttons:[[btn('Проверить готовность', 'estimate:result:'+state.lead)]]});
      return;
    }
    const {name} = state.values;
    await sendText(
      `📋 ${name}, вот ваша смета на видеонаблюдение\n${url}\n\n`+
      'Выберите камеры и посмотрите видео с наших объектов. Меняйте количество и метраж — итог сразу обновится. Смета учтёт и кабель, и его протяжку.\n\n'+
      '💡 Под итогом есть «Можно дешевле». Отметьте подходящие акции, чтобы увидеть экономию. Условия — под значком «?».' +
      (state.values.legal ? '' : '\nЕсли доступна вкладка «Рассрочка», в ней можно посмотреть платёж в месяц.')
    );
  }

  async function save(state) {
    const lead = await amo(dealPath(state.lead)+'?with=contacts,companies');
    const contacts = lead._embedded?.contacts || [];
    const contact = contacts.find(c => c.is_main) || contacts[0];
    if (!contact) throw new Error('missing contact');
    const v = state.values;
    const fields = [
      [F.cameras, v.cameras], [F.address, [v.city, v.address].filter(Boolean).join(', ')],
      [F.object, v.object], [F.legal, v.legal],
    ];
    if (field(lead, F.url) && Number(field(lead, F.cameras)) !== v.cameras) fields.push([F.recalc, true]);
    let companyMissing = false;
    if (v.inn && !lead._embedded?.companies?.length) {
      const result = await amo('/api/v4/companies?query='+encodeURIComponent(v.inn));
      const matches = (result._embedded?.companies || []).filter(company =>
        company.custom_fields_values?.some(f => f.field_code === 'N_DADATA_INN' &&
          f.values?.some(x => String(x.value).trim() === v.inn))
      );
      companyMissing = matches.length !== 1 || Boolean(result._links?.next);
      if (!companyMissing) {
        await amo(dealPath(state.lead)+'/link', [{to_entity_id:matches[0].id,to_entity_type:'companies'}]);
      }
    }
    await amo('/api/v4/contacts/'+contact.id, {name:v.name}, 'PATCH');
    await amo(dealPath(state.lead), {custom_fields_values:fields.map(([field_id,value]) => ({field_id,values:[{value}]}))}, 'PATCH');
    return companyMissing;
  }

  async function prompt(state, key) {
    const [step, text] = questions[state.step];
    let choices = [];
    if (step === 'legal') choices = [['Физлицо','0'],['Юрлицо','1']];
    if (step === 'inn') choices = [['Укажу позже','-']];
    if (step === 'city') choices = [['Самара','+']];
    if (step === 'object') choices = state.types.map((t,i) => [t,String(i)]);
    const rows = [];
    for (let i=0;i<choices.length;i+=2) rows.push(choices.slice(i,i+2).map(([label,val]) => btn(label,`estimate:pick:${state.lead}:${state.step}:${val}`)));
    const mid = await sayEstimate(`Смета №${state.lead} · ${text}` + (choices.length ? '' : '\nОтветьте на это сообщение.'), {buttons:rows.length ? rows : undefined});
    await putJson(key, {...state, mid});
  }

  async function advance(state, raw, key, fromButton) {
    const step = questions[state.step][0];
    let value = raw.trim();
    if (step === 'city' && value === '+') value = 'Самара';
    if (step === 'address' && ['-','−'].includes(value)) value = '';
    if (step === 'object' && fromButton) value = state.types[Number(value)];
    if (step === 'cameras') value = /^\d+$/.test(value) && Number(value);
    if (step === 'inn' && ['-','−'].includes(value)) value = '';
    const invalid = value == null || (typeof value === 'string' && value.length > (step==='address'?175:75)) ||
      (step === 'object' && !state.types.includes(value)) ||
      (step === 'cameras' && (!value || value > 500)) ||
      (step === 'legal' && !['0','1'].includes(value)) ||
      (step === 'inn' && value && !/^(\d{10}|\d{12})$/.test(value));
    if (invalid) {
      await sayEstimate('Проверьте ответ и повторите его под вопросом.');
      return;
    }
    state.values[step] = step === 'legal' ? value === '1' : value;
    state.step++;
    if (step === 'legal' && !state.values.legal) state.step++;
    if (state.step < questions.length) return prompt(state, key);

    await putJson(key, {...state, mid:null, pending:true});
    await finish(state, key);
  }

  async function finish(state, key) {
    let companyMissing;
    try {
      companyMissing = await save(state);
      await putJson(key, {...state, mid:null, pending:false});
    } catch {
      await sayEstimate('Не удалось сохранить данные в amoCRM. Ответы сохранены, можно повторить.', {buttons:[[btn('Повторить сохранение','estimate:save:'+state.lead)]]});
      return;
    }
    if (companyMissing) await sayEstimate("Компания по ИНН не найдена однозначно. Смета будет готова, а компанию можно привязать в amoCRM.");
    await sendResult(state, true);
  }

  return async function onEstimateUpdate(update) {
    const msg = update.message;
    const cb = update.callback;
    const payload = String(cb?.payload || '');
    const chat = msg?.recipient?.chat_id;
    const user = update.update_type === 'message_callback' ? cb?.user?.user_id : msg?.sender?.user_id;
    const isEstimateButton = update.update_type === 'message_callback' && payload.startsWith('estimate:');
    if (!allowed(user, chat)) {
      if (isEstimateButton) await answer(cb,msg,'Доступ только у менеджера');
      return isEstimateButton;
    }
    if (!isEstimateButton && (update.update_type !== 'message_created' || msg?.sender?.is_bot || msg?.link?.type !== 'reply')) return false;
    const key = `estimate-bot/${chat}/${user}.json`;
    const state = await getJson(key);
    if (!isEstimateButton) {
      if (!state?.mid || state.mid !== msg.link.message?.mid) return false;
      if (Date.now() < state.expires && msg.body?.text?.trim()) await advance(state, msg.body.text, key, false);
      else await sayEstimate('Откройте заявку и нажмите «Создать смету» ещё раз.');
      return true;
    }
    const [,action,id,step,value] = payload.split(':');
    const leadId = Number(id);
    if (!Number.isSafeInteger(leadId) || leadId <= 0) return true;
    if (action === 'start') {
      await answer(cb,msg,'Открываю смету');
      const defs = await amo('/api/v4/leads/custom_fields/'+F.object);
      const types = (defs.enums || []).map(x => x.value);
      if (!types.length) { await sayEstimate('Не удалось загрузить типы объектов из amoCRM.'); return true; }
      await prompt({lead:leadId, step:0, types, values:{}, expires:Date.now()+3600000}, key);
    } else if (state?.lead !== leadId || Date.now() >= state.expires) {
      await answer(cb,msg,'Откройте заявку и начните расчёт заново');
    } else {
      await answer(cb,msg,'Принято');
      if (action === 'pick' && Number(step) === state.step && value != null && state.mid === msg?.body?.mid) await advance(state,value,key,true);
      if (action === 'save' && state.pending) await finish(state,key);
      if (action === 'result' && state.step === questions.length && !state.pending) await sendResult(state);
    }
    return true;
  };
}

module.exports = { handler };
