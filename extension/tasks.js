'use strict';

// Правая боковая панель «Задачи»: открытые вкладки Claude этого окна в порядке постановки.
// Источник — сами вкладки редактора (vscode.window.tabGroups), поэтому новая задача появляется
// сразу, как открылась вкладка, а закрытие из панели закрывает именно вкладку.
// Статус «работает/ждёт» и sessionId подтягиваются из реестра сессий по совпадению названия.

const vscode = require('vscode');
const { readSessions, Titles } = require('./sessions');

const isClaude = t => t.input instanceof vscode.TabInputWebview && /claudeVSCodePanel$/.test(t.input.viewType);
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const norm = s => String(s || '').replace(/[…\s]+$/g, '').trim().toLowerCase();

class TasksProvider {
  constructor(state) {
    this.state = state;                 // workspaceState: порядок появления вкладок
    this.titles = new Titles();
    this.checked = new Set();           // ключи отмеченных вкладок
    this.order = new Map(state.get('vpTaskOrder', []));
    this.items = [];
    this._e = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._e.event;
  }

  key(tab) { return tab.group.viewColumn + '|' + tab.label; }

  collect() {
    const tabs = [];
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (isClaude(t)) tabs.push(t);

    let sessions = [];
    try { sessions = readSessions().filter(s => s.entrypoint === 'claude-vscode'); } catch (_) { /* реестра нет */ }
    const byTitle = new Map();
    for (const s of sessions) {
      const title = this.titles.get(s) || s.name;
      if (title) byTitle.set(norm(title), s);
    }
    const match = label => {
      const l = norm(label);
      if (byTitle.has(l)) return byTitle.get(l);
      for (const [t, s] of byTitle) if (l && (t.startsWith(l) || l.startsWith(t))) return s;
      return null;
    };

    let seq = Math.max(0, ...this.order.values());
    const alive = new Set();
    this.items = tabs.map(tab => {
      const k = this.key(tab);
      alive.add(k);
      if (!this.order.has(k)) this.order.set(k, ++seq);
      return { tab, key: k, session: match(tab.label), n: this.order.get(k) };
    }).sort((a, b) => a.n - b.n);

    for (const k of [...this.order.keys()]) if (!alive.has(k)) this.order.delete(k);
    for (const k of [...this.checked]) if (!alive.has(k)) this.checked.delete(k);
    this.state.update('vpTaskOrder', [...this.order]);
    return this.items;
  }

  reload() { this.collect(); this._e.fire(); return this.items; }
  getTreeItem(el) { return el; }
  getParent() { return undefined; }

  getChildren(el) {
    if (!el) {
      const n = this.items.length;
      const root = new vscode.TreeItem(n ? 'Открытые задачи' : 'Нет открытых задач',
        n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      root.id = 'vpTasksRoot';
      root.description = n ? n + (this.checked.size ? ' · отмечено ' + this.checked.size : '') : '';
      root.iconPath = new vscode.ThemeIcon(n ? 'checklist' : 'circle-slash');
      root.contextValue = n ? 'vpTasksRoot' : '';
      root.vpRoot = true;
      if (n) {
        const all = this.items.every(x => this.checked.has(x.key));
        root.checkboxState = all ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        root.tooltip = 'Галочка здесь — отметить все. Закрыть отмеченные — кнопка в шапке.';
      } else {
        root.tooltip = 'Новая задача — кнопка «+» в шапке';
        root.command = { command: 'ventpromProjects.newTask', title: '' };
      }
      return [root];
    }
    if (!el.vpRoot) return [];
    return this.items.map((x, i) => {
      const s = x.session;
      const busy = s && s.status === 'busy';
      const it = new vscode.TreeItem((i + 1) + '. ' + cut(x.tab.label, 60));
      it.id = 't:' + x.key;
      it.description = (busy ? 'работает' : s ? 'ждёт' : '') +
        (vscode.window.tabGroups.all.length > 1 ? (s ? ' · ' : '') + 'группа ' + x.tab.group.viewColumn : '');
      it.iconPath = busy
        ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'))
        : x.tab.isActive && x.tab.group.isActive
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
          : new vscode.ThemeIcon('circle-outline');
      it.checkboxState = this.checked.has(x.key)
        ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      it.contextValue = 'vpTask';
      it.vpTask = x;
      it.vpSession = s;
      it.command = { command: 'ventpromProjects.focusTask', title: 'Перейти', arguments: [it] };
      it.tooltip = x.tab.label + (s ? '\nСтатус: ' + (busy ? 'работает' : 'ждёт ответа') : '') +
        '\nКлик — перейти, ✕ — закрыть, галочка — отметить для закрытия пачкой';
      return it;
    });
  }
}

async function focusTab(x) {
  if (x.session) {
    try { await vscode.commands.executeCommand('claude-vscode.editor.open', x.session.sessionId); return; }
    catch (_) { /* упадём на поиск по индексу */ }
  }
  const g = x.tab.group;
  const idx = g.tabs.indexOf(x.tab);
  const ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'][g.viewColumn - 1];
  if (ord) await vscode.commands.executeCommand('workbench.action.focus' + ord + 'EditorGroup');
  if (idx >= 0) await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', idx);
}

function register(ctx) {
  const provider = new TasksProvider(ctx.workspaceState);
  // Один список — два места: справа (ЗАДАЧИ) и слева в разделе «Сессии Claude».
  const views = ['ventpromTasks.list', 'ventpromProjects.sessions'].map(id =>
    vscode.window.createTreeView(id, { treeDataProvider: provider, manageCheckboxStateManually: true }));
  ctx.subscriptions.push(...views);

  const paint = () => {
    const list = provider.reload();
    const busy = list.filter(x => x.session && x.session.status === 'busy').length;
    const tail = list.length ? ': ' + list.length + (busy ? ' · работают ' + busy : '') : '';
    views[0].title = 'Задачи' + tail;
    views[0].badge = list.length ? { value: list.length, tooltip: list.length + ' открытых задач' } : undefined;
    views[1].title = 'Сессии' + tail;
    vscode.commands.executeCommand('setContext', 'ventpromTasks.anyChecked', provider.checked.size > 0);
  };
  let pending = null;
  const soon = () => { clearTimeout(pending); pending = setTimeout(paint, 150); };

  const close = async (list) => {
    const tabs = list.map(x => x.tab).filter(t => vscode.window.tabGroups.all.some(g => g.tabs.includes(t)));
    if (!tabs.length) return;
    await vscode.window.tabGroups.close(tabs);
    for (const x of list) provider.checked.delete(x.key);
    soon();
  };

  ctx.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(soon),
    vscode.window.tabGroups.onDidChangeTabGroups(soon),

    ...views.map(view => view.onDidChangeCheckboxState(e => {
      for (const [item, st] of e.items) {
        const on = st === vscode.TreeItemCheckboxState.Checked;
        const keys = item.vpRoot ? provider.items.map(x => x.key) : [item.vpTask.key];
        for (const k of keys) on ? provider.checked.add(k) : provider.checked.delete(k);
      }
      paint();
    })),

    vscode.commands.registerCommand('ventpromProjects.focusTask', it => it && it.vpTask && focusTab(it.vpTask)),
    vscode.commands.registerCommand('ventpromProjects.closeTask', it => it && it.vpTask && close([it.vpTask])),

    vscode.commands.registerCommand('ventpromProjects.closeChecked', async () => {
      const list = provider.items.filter(x => provider.checked.has(x.key));
      if (!list.length) { vscode.window.showInformationMessage('Ничего не отмечено — поставь галочки у задач.'); return; }
      await close(list);
    }),

    // «Выпадающий список» с галочками: отметил нужные — Enter закрывает их.
    vscode.commands.registerCommand('ventpromProjects.pickClose', async () => {
      provider.collect();
      if (!provider.items.length) { vscode.window.showInformationMessage('Открытых задач нет.'); return; }
      const picks = provider.items.map((x, i) => ({
        label: (i + 1) + '. ' + x.tab.label,
        description: x.session ? (x.session.status === 'busy' ? 'работает' : 'ждёт') : '',
        picked: provider.checked.has(x.key),
        x
      }));
      const sel = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        title: 'Закрыть задачи',
        placeHolder: 'Отметь галочками, что закрыть, и нажми Enter'
      });
      if (sel && sel.length) await close(sel.map(p => p.x));
    }),

    vscode.commands.registerCommand('ventpromProjects.toggleAllTasks', () => {
      const all = provider.items.length && provider.items.every(x => provider.checked.has(x.key));
      provider.checked.clear();
      if (!all) for (const x of provider.items) provider.checked.add(x.key);
      paint();
    }),

    vscode.commands.registerCommand('ventpromProjects.refreshSessions', paint),
    vscode.commands.registerCommand('ventpromProjects.openSession', it => it && it.vpTask && focusTab(it.vpTask)),
    vscode.commands.registerCommand('ventpromProjects.copySessionName', async (it) => {
      const s = it && it.vpSession;
      if (!s) { vscode.window.showInformationMessage('У этой вкладки нет запущенной сессии — открой её, и имя появится.'); return; }
      await vscode.env.clipboard.writeText(s.name || s.sessionId);
      vscode.window.showInformationMessage('Скопировано: ' + (s.name || s.sessionId));
    }),

    vscode.commands.registerCommand('ventpromProjects.newTask', () =>
      vscode.commands.executeCommand('claude-vscode.editor.open')),

    { dispose: () => clearTimeout(pending) }
  );

  // статус «работает/ждёт» меняется внутри файлов реестра — подкрашиваем раз в 10 с
  const timer = setInterval(paint, 10000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  paint();
}

module.exports = { register };
