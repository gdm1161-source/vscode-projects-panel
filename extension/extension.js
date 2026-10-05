'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const { parse, GROUPS } = require('./parser');
const sessions = require('./sessions');

const CFG = 'ventpromProjects';
const cfg = () => vscode.workspace.getConfiguration(CFG);
const fmt = d => d
  ? String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear()
  : '';
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

// Путь для удалённой оболочки: в кавычках «~» не раскрывается, поэтому «~/…» → "$HOME"/'…'.
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function remoteArg(p) {
  p = String(p || '~/PROJECTS.md').trim();
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return '"$HOME"/' + sq(p.slice(2));
  return sq(p);
}

// Кириллица через base64: stdout ssh под Windows иначе ломается кодировкой.
function fetchRemote() {
  return new Promise((resolve, reject) => {
    const c = cfg();
    const host = String(c.get('host') || '').trim();
    if (!host) return reject(new Error('не задан ventpromProjects.host'));
    const secs = Math.max(3, Number(c.get('timeoutSeconds')) || 10);
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=' + secs,
      '-o', 'StrictHostKeyChecking=accept-new',
      host,
      'base64 -w0 ' + remoteArg(c.get('remotePath'))
    ];
    cp.execFile(c.get('sshExe'), args,
      { encoding: 'ascii', timeout: secs * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || '').trim().split('\n').pop()));
        const b64 = String(stdout).replace(/\s+/g, '');
        if (!b64) return reject(new Error('сервер вернул пустой ответ'));
        try { resolve(Buffer.from(b64, 'base64').toString('utf8')); }
        catch (e) { reject(new Error('не удалось раскодировать ответ: ' + e.message)); }
      });
  });
}

class Store {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = ctx.globalStorageUri;
    this.md = '';
    this.fetchedAt = null;
    this.stale = false;
    this.error = '';
  }
  fileUri(name) { return vscode.Uri.joinPath(this.dir, name); }

  async init() {
    await vscode.workspace.fs.createDirectory(this.dir);
    try {
      const buf = await vscode.workspace.fs.readFile(this.fileUri('PROJECTS.md'));
      this.md = Buffer.from(buf).toString('utf8');
      const at = this.ctx.globalState.get('fetchedAt');
      this.fetchedAt = at ? new Date(at) : null;
      this.stale = true;
    } catch (_) { /* кэша ещё нет */ }
  }

  async refresh() {
    try {
      const md = await fetchRemote();
      this.md = md;
      this.fetchedAt = new Date();
      this.stale = false;
      this.error = '';
      await vscode.workspace.fs.writeFile(this.fileUri('PROJECTS.md'), Buffer.from(md, 'utf8'));
      await this.ctx.globalState.update('fetchedAt', this.fetchedAt.toISOString());
      return true;
    } catch (e) {
      this.stale = true;
      this.error = e.message;
      return false;
    }
  }

  blocks() {
    if (!this.md) return [];
    return parse(this.md, { activeDays: Number(cfg().get('activeDays')) || 30, now: new Date() });
  }
}

class Provider {
  constructor(store) {
    this.store = store;
    this._e = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._e.event;
  }
  refresh() { this._e.fire(); }
  getTreeItem(el) { return el; }

  getChildren(el) {
    if (!el) return this.roots();
    if (el.vpKind === 'group') return this.projects(el.vpGroup);
    if (el.vpKind === 'project') return this.details(el.vpBlock);
    return [];
  }

  roots() {
    if (!String(cfg().get('host') || '').trim()) {
      const i = new vscode.TreeItem('Укажи сервер в настройках');
      i.description = 'ventpromProjects.host';
      i.iconPath = new vscode.ThemeIcon('gear');
      i.tooltip = new vscode.MarkdownString('Панель не знает, где лежит PROJECTS.md. Задай `ventpromProjects.host` (например `user@server`) и `ventpromProjects.remotePath`.');
      i.command = { command: 'workbench.action.openSettings', title: '', arguments: ['ventpromProjects'] };
      return [i];
    }
    if (!this.store.md) {
      const i = new vscode.TreeItem('Реестр не загружен — нажми «Обновить»');
      i.iconPath = new vscode.ThemeIcon('cloud-download');
      i.command = { command: 'ventpromProjects.refresh', title: '' };
      return [i];
    }

    const blocks = this.store.blocks();
    const out = [];

    if (this.store.stale) {
      const at = this.store.fetchedAt;
      const when = at ? fmt(at) + ' ' + at.toTimeString().slice(0, 5) : 'неизвестно когда';
      const i = new vscode.TreeItem('Копия от ' + when);
      i.description = cut(this.store.error || 'сервер не ответил', 60);
      i.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      i.tooltip = new vscode.MarkdownString('**Сервер не ответил**\n\n' + (this.store.error || '') +
        '\n\nПроверь VPN (Happ глушит локалку) и доступность `' + cfg().get('host') + '`.');
      i.command = { command: 'ventpromProjects.refresh', title: '' };
      out.push(i);
    }

    const filter = String(cfg().get('filter') || 'all');
    for (const g of ['ready', 'work', 'plan', 'none', 'done']) {
      if (filter === 'ready' && g !== 'ready') continue;
      if (filter === 'work' && g !== 'ready' && g !== 'work') continue;
      const list = blocks.filter(b => b.group === g);
      if (!list.length) continue;
      const meta = GROUPS[g];
      const i = new vscode.TreeItem(meta.label, (g === 'ready' || g === 'work')
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed);
      i.description = String(list.length);
      i.iconPath = new vscode.ThemeIcon(meta.icon,
        meta.accent ? new vscode.ThemeColor('charts.blue') : undefined);
      i.vpKind = 'group';
      i.vpGroup = g;
      i.id = 'g:' + g;
      out.push(i);
    }
    return out;
  }

  projects(group) {
    return this.store.blocks().filter(b => b.group === group).map(b => {
      const i = new vscode.TreeItem(b.code, vscode.TreeItemCollapsibleState.Collapsed);
      i.description = (b.group === 'ready' ? '← ' + b.readyWhy + '  ·  ' : '') +
        cut(b.title, b.group === 'ready' ? 30 : 46) + (b.latest ? '  · ' + fmt(b.latest) : '');
      i.iconPath = b.group === 'ready'
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
        : new vscode.ThemeIcon(b.group === 'work' ? 'circle-filled' : 'circle-outline');
      i.contextValue = 'vpProject';
      i.vpKind = 'project';
      i.vpBlock = b;
      i.id = 'p:' + b.code;
      i.command = { command: 'ventpromProjects.openBlock', title: 'Открыть блок', arguments: [b] };

      const t = new vscode.MarkdownString();
      t.appendMarkdown('### ' + b.code + ' — ' + b.title + '\n\n');
      t.appendMarkdown('**Группа:** ' + GROUPS[b.group].label + '  \n');
      t.appendMarkdown('**Почему тут:** ' + (b.group === 'ready' ? b.readyWhy : b.why) + '  \n');
      if (b.attention && b.attention.length) {
        t.appendMarkdown('\n**Ждёт тебя:**\n');
        for (const a of b.attention) t.appendMarkdown('- ' + a.text + '\n');
      }
      if (b.latest) t.appendMarkdown('**Последняя дата в блоке:** ' + fmt(b.latest) + '  \n');
      if (b.status) t.appendMarkdown('\n**' + (b.statusKey || 'Статус') + ':** ' + b.status + '\n');
      if (b.start) t.appendMarkdown('\n**Начать:** ' + b.start + '\n');
      i.tooltip = t;
      return i;
    });
  }

  details(b) {
    const out = [];
    for (const a of (b.attention || [])) {
      const i = new vscode.TreeItem(cut(a.text, 150));
      i.iconPath = new vscode.ThemeIcon(
        a.kind === 'done' ? 'pass-filled' : a.kind === 'gate' ? 'shield' : 'bell-dot',
        new vscode.ThemeColor('charts.blue'));
      i.tooltip = new vscode.MarkdownString('**' + a.why + '**\n\n' + a.text);
      i.command = { command: 'ventpromProjects.openBlock', title: '', arguments: [b] };
      out.push(i);
    }
    for (const f of b.fields) {
      const i = new vscode.TreeItem(f.key);
      i.description = cut(f.value.replace(/`/g, ''), 140);
      i.iconPath = new vscode.ThemeIcon(/^Статус/i.test(f.key) ? 'pulse'
        : /^Начать/i.test(f.key) ? 'terminal'
        : /^Где/i.test(f.key) ? 'folder'
        : /^Память/i.test(f.key) ? 'database' : 'dash');
      const t = new vscode.MarkdownString();
      t.appendMarkdown('**' + f.key + '**\n\n' + f.value);
      i.tooltip = t;
      i.command = { command: 'ventpromProjects.openBlock', title: '', arguments: [b] };
      out.push(i);
    }
    for (const u of b.links) {
      const i = new vscode.TreeItem(u.replace(/^https?:\/\//, ''));
      i.iconPath = new vscode.ThemeIcon('link-external');
      i.tooltip = u;
      i.command = { command: 'vscode.open', title: 'Открыть', arguments: [vscode.Uri.parse(u)] };
      out.push(i);
    }
    return out;
  }
}

async function activate(ctx) {
  sessions.register(ctx);

  const store = new Store(ctx);
  await store.init();

  const provider = new Provider(store);
  const view = vscode.window.createTreeView('ventpromProjects.tree', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  ctx.subscriptions.push(view);

  const paint = () => {
    const blocks = store.blocks();
    const ready = blocks.filter(b => b.group === 'ready').length;
    const work = blocks.filter(b => b.group === 'work').length;
    view.badge = ready ? { value: ready, tooltip: ready + ' задач ждут тебя' }
      : work ? { value: work, tooltip: work + ' проектов в работе' } : undefined;
    view.title = blocks.length
      ? 'Ждёт тебя ' + ready + ' · в работе ' + work
      : 'Проекты';
    provider.refresh();
  };
  paint();

  const doRefresh = (loud) => vscode.window.withProgress(
    { location: { viewId: 'ventpromProjects.tree' } },
    async () => {
      const ok = await store.refresh();
      paint();
      if (!ok && loud) {
        vscode.window.showWarningMessage('ПРОЕКТЫ: сервер не ответил — показана копия. ' + store.error);
      }
    });

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ventpromProjects.refresh', () => doRefresh(true)),

    vscode.commands.registerCommand('ventpromProjects.openFull', async () => {
      if (!store.md) { await doRefresh(true); if (!store.md) return; }
      const doc = await vscode.workspace.openTextDocument(store.fileUri('PROJECTS.md'));
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('ventpromProjects.openBlock', async (b) => {
      if (!b || !b.raw) return;
      const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'blocks');
      await vscode.workspace.fs.createDirectory(dir);
      const uri = vscode.Uri.joinPath(dir, b.code.replace(/[^0-9A-Za-zА-Яа-яЁё._-]+/g, '_') + '.md');
      const head = '<!-- ' + GROUPS[b.group].label + ' · ' + b.why +
        ' · PROJECTS.md строка ' + b.line + ' · копия, правь на сервере -->\n\n';
      await vscode.workspace.fs.writeFile(uri, Buffer.from(head + b.raw + '\n', 'utf8'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ventpromProjects.copyStart', async (item) => {
      const b = item && item.vpBlock;
      if (!b) return;
      const text = String(b.start || '').replace(/`/g, '').trim();
      if (!text) { vscode.window.showInformationMessage('У «' + b.code + '» нет поля «Начать».'); return; }
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Скопировано: ' + cut(text, 80));
    }),

    vscode.commands.registerCommand('ventpromProjects.cycleFilter', async () => {
      const order = ['all', 'ready', 'work'];
      const cur = String(cfg().get('filter') || 'all');
      const next = order[(order.indexOf(cur) + 1) % order.length];
      await cfg().update('filter', next, vscode.ConfigurationTarget.Global);
      paint();
    }),

    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CFG)) paint(); })
  );

  let timer = null;
  const arm = () => {
    if (timer) { clearInterval(timer); timer = null; }
    const min = Number(cfg().get('refreshMinutes'));
    if (min > 0) timer = setInterval(() => doRefresh(false), min * 60000);
  };
  arm();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CFG + '.refreshMinutes')) arm();
    }),
    { dispose: () => { if (timer) clearInterval(timer); } }
  );

  doRefresh(false);
}

function deactivate() {}

module.exports = { activate, deactivate };
