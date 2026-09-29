'use strict';

const GROUPS = {
  ready: { key: 'ready', label: 'ГОТОВО — ЖДЁТ ТЕБЯ', icon: 'bell-dot', order: 0, accent: true },
  work: { key: 'work', label: 'В РАБОТЕ',     icon: 'debug-start', order: 1 },
  plan: { key: 'plan', label: 'В ПЛАНЕ',      icon: 'clock',       order: 2 },
  none: { key: 'none', label: 'НЕ РАЗМЕЧЕНО', icon: 'question',    order: 3 },
  done: { key: 'done', label: 'ЗАКРЫТО',      icon: 'pass-filled', order: 4 }
};

const RE_HEAD_ANY = /^##\s+/;
const RE_HEAD     = /^##\s+(.+?)\s+—\s+(.+?)\s*$/;
const RE_FIELD    = /^-\s+\*\*(.+?)\*\*\s*(.*)$/;
const RE_TAG      = /\[\s*(в работе|в плане|закрыт[оа]?|пауза)\s*\]/i;
const RE_URL      = /https?:\/\/[^\s<>()«»"'`]+/g;
// Сигналы «работа сделана / дело за ДМ» — собраны по формулировкам самого PROJECTS.md.
const RE_READY_TAG = /\[\s*(готово|жд[ёе]т дм|гейт)\s*\]/i;
const ATTENTION = [
  { kind: 'gate', re: /гейт/i, why: 'гейт' },
  { kind: 'wait', re: /жд[ёе]т\s+(?:«?да»?|ДМ|ответа|решения|разблокировки|подтверждения)/i, why: 'ждёт ответа' },
  { kind: 'wait', re: /(?:^|[^А-Яа-яЁёA-Za-z])решение ДМ|на согласовании|ДМ проходит|принимает человек|требует одобрени/i, why: 'решение за тобой' },
  { kind: 'done', re: /ВЫПОЛНЕН|ГОТОВО|готово к приёмке|жд[ёе]т приёмки/, why: 'результат готов' }
];

function clean(line) {
  return line.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

// Вырезает фразу вокруг совпадения — иначе сигнал тонет в длинном поле.
function snippet(text, idx) {
  const seps = ['. ', '; ', ': ', '— ', ') '];
  let from = 0;
  for (const sep of seps) {
    const k = text.lastIndexOf(sep, idx);
    if (k > from && k + sep.length <= idx) from = k + sep.length;
  }
  let to = text.length;
  for (const sep of ['. ', '; ']) {
    const k = text.indexOf(sep, idx);
    if (k > -1 && k + 1 < to) to = k + 1;
  }
  const out = text.slice(from, to).trim();
  if (out.length < 40) return text;          // короткая вырезка теряет смысл — отдаём строку целиком
  return (from > 0 ? '…' : '') + out;
}

// Строки блока, требующие внимания ДМ, с причиной.
function attention(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    // цитаты («> ») — пояснения о самих правилах, сигналами не считаются
    if (/^##\s/.test(line) || /^\s*>/.test(line) || !line.trim()) continue;
    for (const a of ATTENTION) {
      const m = a.re.exec(clean(line));
      if (m) {
        const text = snippet(clean(line), m.index);
        if (text && !out.some(o => o.text === text)) out.push({ kind: a.kind, why: a.why, text: text });
        break;
      }
    }
  }
  return out;
}

const RE_DMY      = /(\d{2})\.(\d{2})\.(\d{4})/g;
const RE_YMD      = /(\d{4})-(\d{2})-(\d{2})/g;

// Последняя ДАТА АКТИВНОСТИ. Будущие даты (срок сертификата, оплаты домена) не считаются.
function latestDate(text, now) {
  const cap = (now ? now.getTime() : Date.now()) + 86400000;
  let best = null, m;
  RE_DMY.lastIndex = 0;
  while ((m = RE_DMY.exec(text))) {
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    if (!isNaN(d) && d.getTime() <= cap && (!best || d > best)) best = d;
  }
  RE_YMD.lastIndex = 0;
  while ((m = RE_YMD.exec(text))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (!isNaN(d) && d.getTime() <= cap && (!best || d > best)) best = d;
  }
  return best;
}

function links(text) {
  const out = [];
  let m;
  RE_URL.lastIndex = 0;
  while ((m = RE_URL.exec(text))) {
    const u = m[0].replace(/[.,;:)»"']+$/, '');
    if (u.length > 12 && !out.includes(u)) out.push(u);
  }
  return out;
}

// ВНИМАНИЕ: \b в JS не работает с кириллицей (\w = только ASCII) — границы слов не использовать.
function classify(block, activeDays, now) {
  const tag = RE_TAG.exec(block.raw);
  if (tag) {
    const t = tag[1].toLowerCase();
    if (t.indexOf('закрыт') === 0) return { group: 'done', why: 'явная метка [закрыто]' };
    if (t === 'пауза')             return { group: 'plan', why: 'явная метка [пауза]' };
    if (t === 'в плане')           return { group: 'plan', why: 'явная метка [в плане]' };
    return { group: 'work', why: 'явная метка [в работе]' };
  }

  const s = block.status || '';
  if (s) {
    const closed = /закрыт/i.test(s);
    const goesOn = /(далее|дальше|осталось|остал[аи]сь|next)/i.test(s);
    if (closed && !goesOn) return { group: 'done', why: 'в статусе «закрыт», продолжение не указано' };
    if (closed && goesOn)  return { group: 'work', why: 'этап закрыт, но в статусе есть «далее / осталось»' };
    if (/запланировано|в плане|планируется|не запущен/i.test(s))
      return { group: 'plan', why: 'в статусе «запланировано / в плане»' };
    if (/работает|идёт|идет|в работе|в процессе|опубликован|на согласовании|наполнен|ждёт|ждет|ожида|поставлен|сохранён|сохранен/i.test(s))
      return { group: 'work', why: 'ключевое слово активности в статусе' };
    return { group: 'work', why: 'статус заполнен и это не «закрыт / в плане»' };
  }

  if (block.latest) {
    const days = Math.max(0, Math.floor((now.getTime() - block.latest.getTime()) / 86400000));
    if (days <= activeDays) return { group: 'work', why: 'поля «Статус» нет, но правка ' + days + ' дн. назад' };
    return { group: 'none', why: 'поля «Статус» нет, последняя дата ' + days + ' дн. назад' };
  }
  return { group: 'none', why: 'нет поля «Статус» и нет дат в блоке' };
}

function parse(md, opts) {
  const o = opts || {};
  const activeDays = typeof o.activeDays === 'number' ? o.activeDays : 30;
  const now = o.now || new Date();
  const lines = String(md).split(/\r?\n/);

  const starts = [];
  lines.forEach(function (l, i) { if (RE_HEAD_ANY.test(l)) starts.push(i); });

  const blocks = [];
  for (let n = 0; n < starts.length; n++) {
    const from = starts[n];
    const to = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const head = RE_HEAD.exec(lines[from]);
    if (!head) continue;            // раздел без «КОД — название» (напр. «Соглашение об именах») — не проект
    const bodyLines = lines.slice(from + 1, to);
    const raw = lines.slice(from, to).join('\n');

    const fields = [];
    for (const line of bodyLines) {
      const f = RE_FIELD.exec(line);
      if (f) {
        fields.push({ key: f[1].replace(/:\s*$/, '').trim(), value: f[2].trim() });
      } else if (fields.length && line.trim()) {
        fields[fields.length - 1].value += ' ' + line.trim();   // перенос строки внутри поля
      }
    }

    const fld = re => fields.find(f => re.test(f.key));
    const st = fld(/^Статус/i), sta = fld(/^Начать/i), wht = fld(/^Что/i), whr = fld(/^Где/i);

    const b = {
      code: head[1].trim(),
      title: head[2].trim(),
      line: from + 1,
      raw: raw,
      fields: fields,
      statusKey: st ? st.key : '',
      status: st ? st.value : '',
      start: sta ? sta.value : '',
      what: wht ? wht.value : '',
      where: whr ? whr.value : '',
      links: links(raw),
      latest: latestDate(raw, now),
      attention: attention(raw)
    };
    const c = classify(b, activeDays, now);
    b.group = c.group;
    b.why = c.why;
    // «ждёт тебя» перебивает рабочие группы; закрытые — только по явной метке
    const tagged = RE_READY_TAG.test(raw);
    if (tagged || (b.attention.length && b.group !== 'done')) {
      b.readyWhy = tagged ? 'явная метка в блоке'
        : b.attention.map(a => a.why).filter((v, i, z) => z.indexOf(v) === i).join(', ');
      b.groupBefore = b.group;
      b.group = 'ready';
    }
    blocks.push(b);
  }

  blocks.sort(function (a, b) {
    const ga = GROUPS[a.group].order, gb = GROUPS[b.group].order;
    if (ga !== gb) return ga - gb;
    const ta = a.latest ? a.latest.getTime() : 0, tb = b.latest ? b.latest.getTime() : 0;
    if (ta !== tb) return tb - ta;
    return a.code.localeCompare(b.code, 'ru');
  });

  return blocks;
}

module.exports = { parse, GROUPS };
