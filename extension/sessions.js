'use strict';

// Раздел «Сессии Claude»: живые сессии Claude Code на этом ПК, сверху вниз по времени старта.
// Источник — реестр самого Claude Code: ~/.claude/sessions/<pid>.json (пишет каждый процесс,
// поле status = busy/idle обновляется на лету). Название вкладки — запись ai-title/custom-title
// в истории сессии ~/.claude/projects/<папка>/<sessionId>.jsonl.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = path.join(os.homedir(), '.claude');
const REG = path.join(HOME, 'sessions');
const PROJ = path.join(HOME, 'projects');
const TAIL = 512 * 1024;

const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function age(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + ' мин';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' ч';
  return Math.round(h / 24) + ' д';
}

// Папка истории: cwd, где всё кроме латиницы и цифр заменено на «-» (так её называет Claude Code).
function transcriptPath(s) {
  const guess = path.join(PROJ, String(s.cwd || '').replace(/[^A-Za-z0-9]/g, '-'), s.sessionId + '.jsonl');
  if (fs.existsSync(guess)) return guess;
  try {
    for (const d of fs.readdirSync(PROJ)) {
      const p = path.join(PROJ, d, s.sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* нет папки */ }
  return null;
}

function lastTitle(text) {
  let custom = null, ai = null;
  const re = /"type":"(custom-title|ai-title)","(customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    let t;
    try { t = JSON.parse('"' + m[3] + '"'); } catch (_) { t = m[3]; }
    if (m[1] === 'custom-title') custom = t; else ai = t;
  }
  return custom || ai;
}

class Titles {
  constructor() { this.cache = new Map(); }   // sessionId -> {size, title}
  get(s) {
    const p = transcriptPath(s);
    if (!p) return null;
    let size;
    try { size = fs.statSync(p).size; } catch (_) { return null; }
    const c = this.cache.get(s.sessionId);
    if (c && c.size === size) return c.title;
    let title = null;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const from = Math.max(0, size - TAIL);
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        title = lastTitle(buf.toString('utf8'));
        if (!title && from > 0) title = lastTitle(fs.readFileSync(p, 'utf8'));
      } finally { fs.closeSync(fd); }
    } catch (_) { /* файл занят — возьмём прошлое */ }
    title = title || (c && c.title) || null;
    this.cache.set(s.sessionId, { size, title });
    return title;
  }
}

function readSessions() {
  let files = [];
  try { files = fs.readdirSync(REG).filter(f => /^\d+\.json$/.test(f)); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8'));
      if (!s.pid || !s.sessionId || !alive(s.pid)) continue;
      out.push(s);
    } catch (_) { /* файл пишется прямо сейчас — подхватим следующим проходом */ }
  }
  return out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

class SessionsProvider {
  constructor() {
    this.titles = new Titles();
    this.list = [];
    this._e = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._e.event;
  }
  reload() { this.list = readSessions(); this._e.fire(); return this.list; }
  getTreeItem(el) { return el; }

  getChildren(el) {
    if (el) return [];
    if (!this.list.length) {
      const i = new vscode.TreeItem('Нет открытых сессий');
      i.iconPath = new vscode.ThemeIcon('circle-slash');
      return [i];
    }
    const now = Date.now();
    return this.list.map((s, n) => {
      const title = this.titles.get(s) || s.name || s.sessionId.slice(0, 8);
      const busy = s.status === 'busy';
      const i = new vscode.TreeItem((n + 1) + '. ' + cut(title, 60));
      i.description = (busy ? 'работает' : 'ждёт') + ' · ' + age(now - (s.statusUpdatedAt || s.updatedAt || s.startedAt));
      i.iconPath = busy
        ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('circle-outline');
      i.id = 's:' + s.sessionId;
      i.contextValue = 'vpSession';
      i.vpSession = s;
      const fromVscode = s.entrypoint === 'claude-vscode';
      if (fromVscode) {
        i.command = { command: 'ventpromProjects.openSession', title: 'Открыть', arguments: [s] };
      }
      const t = new vscode.MarkdownString();
      t.appendMarkdown('### ' + title + '\n\n');
      t.appendMarkdown('**Статус:** ' + (busy ? 'работает' : 'ждёт ответа') + '  \n');
      t.appendMarkdown('**Запущена:** ' + new Date(s.startedAt).toLocaleString('ru-RU') + ' (' + age(now - s.startedAt) + ' назад)  \n');
      t.appendMarkdown('**Имя для связи:** `' + (s.name || '—') + '`  \n');
      t.appendMarkdown('**Откуда:** ' + (fromVscode ? 'VS Code — клик открывает вкладку' : (s.entrypoint || 'терминал')) + '  \n');
      t.appendMarkdown('**Папка:** ' + (s.cwd || '') + '  \n');
      t.appendMarkdown('**ID:** `' + s.sessionId + '`');
      i.tooltip = t;
      return i;
    });
  }
}

function register(ctx) {
  const provider = new SessionsProvider();
  const view = vscode.window.createTreeView('ventpromProjects.sessions', { treeDataProvider: provider });
  ctx.subscriptions.push(view);

  const paint = () => {
    const list = provider.reload();
    const busy = list.filter(s => s.status === 'busy').length;
    view.title = list.length ? 'Сессии: ' + list.length + ' · работают ' + busy : 'Сессии';
  };

  let pending = null;
  const soon = () => { clearTimeout(pending); pending = setTimeout(paint, 400); };

  try {
    const w = fs.watch(REG, soon);
    ctx.subscriptions.push({ dispose: () => w.close() });
  } catch (_) { /* папки ещё нет — спасёт таймер */ }
  const timer = setInterval(paint, 15000);   // статус и названия меняются внутри файлов, плюс упавшие процессы
  ctx.subscriptions.push({ dispose: () => { clearInterval(timer); clearTimeout(pending); } });

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ventpromProjects.refreshSessions', paint),
    vscode.commands.registerCommand('ventpromProjects.openSession', async (s) => {
      s = s && s.vpSession ? s.vpSession : s;
      if (!s || !s.sessionId) return;
      try { await vscode.commands.executeCommand('claude-vscode.editor.open', s.sessionId); }
      catch (e) { vscode.window.showWarningMessage('Не удалось открыть сессию: ' + e.message); }
    }),
    vscode.commands.registerCommand('ventpromProjects.copySessionName', async (item) => {
      const s = item && item.vpSession;
      if (!s) return;
      await vscode.env.clipboard.writeText(s.name || s.sessionId);
      vscode.window.showInformationMessage('Скопировано: ' + (s.name || s.sessionId));
    })
  );
  paint();
}

module.exports = { register, readSessions, lastTitle, Titles };
