/**
 * #/sites/:id : Site詳細
 *  - Sources 一覧 + 監視状態の統合カード表示 (Monitorという別概念をUIから隠し、
 *    「Sourceの監視状態」として見せる。詳細な実行履歴・差分は #/monitors/:id へ)
 *  - Fetcher Policy 表示・編集
 *  - robots Override 管理 (ADR-0009 Override UI)
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import {
  el,
  clear,
  section,
  field,
  fieldRow,
  formatDateTime,
  badge,
  monitorStatusBadge,
  intervalLabel,
  renderLoading,
  renderError,
  appendError,
  navigate,
  truncationNotice,
} from '../util.js';

// src/api/routes/sites.ts の FAILURE_CLASSES と揃える (proceed_on 選択肢)
const FAILURE_CLASSES = [
  'network_error',
  'timeout',
  'http_5xx',
  'http_429',
  'http_403',
  'not_found',
  'auth_required',
  'blocked_by_robots',
  'ssrf_blocked',
  'too_large',
  'captcha_challenge',
  'invalid_content_type',
  'parse_error',
  'internal_error',
];

const SOURCE_TYPES = ['page', 'rss', 'atom', 'sitemap', 'sitemap-index'];

// --- Sources (+ 監視状態の統合表示) -------------------------------------------
//
// 実運用ではMonitor:Source≒1:1のため、UIからMonitorという別概念を隠し、各Sourceカードに
// 「監視状態」として統合表示する (ユーザーフィードバック: 「Site-SourceはいいがMonitorが
// 分かりづらい」への対応)。データ上Source:Monitorが1:Nになるケースも捨象せず、2件目以降は
// カード内の折りたたみに逃がす (renderExtraMonitorsToggle)。

/** 監視あり: 今すぐ実行・一時停止/再開・履歴/差分・監視を削除 */
function renderMonitorActionsRow(monitor, hideError, showError, reload) {
  const runButton = el('button', {
    class: 'button-ghost',
    text: '今すぐ実行',
    on: {
      click: async () => {
        hideError();
        try {
          await api.post(`/monitors/${encodeURIComponent(monitor.id)}/run`);
        } catch (err) {
          showError(`実行できませんでした: ${err.message}`);
          return;
        }
        await reload();
      },
    },
  });

  const isPaused = monitor.status === 'paused';
  const pauseResumeButton = el('button', {
    class: 'button-ghost',
    text: isPaused ? '再開' : '一時停止',
    on: {
      click: async () => {
        hideError();
        const action = isPaused ? 'resume' : 'pause';
        try {
          await api.post(`/monitors/${encodeURIComponent(monitor.id)}/${action}`);
        } catch (err) {
          showError(`${isPaused ? '再開' : '一時停止'}に失敗しました: ${err.message}`);
          return;
        }
        await reload();
      },
    },
  });

  const historyButton = el('button', {
    class: 'button-ghost',
    text: '履歴・差分',
    on: { click: () => navigate(`#/monitors/${encodeURIComponent(monitor.id)}`) },
  });

  const deleteButton = el('button', {
    class: 'button-danger',
    text: '監視を削除',
    on: {
      click: async () => {
        hideError();
        if (!confirm('この監視を削除します。実行履歴・検出済みのChangeも削除されます。よろしいですか?')) return;
        try {
          await api.del(`/monitors/${encodeURIComponent(monitor.id)}`);
        } catch (err) {
          showError(`監視の削除に失敗しました: ${err.message}`);
          return;
        }
        await reload();
      },
    },
  });

  return el('div', { class: 'button-row source-card-actions' }, [runButton, pauseResumeButton, historyButton, deleteButton]);
}

/** 監視状態を1行で: バッジ + 間隔 + 次回実行。blocked_by_robots時は停止理由も短く添える */
function renderMonitorStatusLine(monitor) {
  const frag = document.createDocumentFragment();
  const line = el('p', { class: 'source-monitor-line' }, [
    '監視: ',
    monitorStatusBadge(monitor.status),
    `・${intervalLabel(monitor.interval_seconds)}・次回 ${formatDateTime(monitor.next_run_at)}`,
  ]);
  frag.appendChild(line);

  if (monitor.status === 'blocked_by_robots') {
    const reason = el('p', { class: 'muted source-stop-reason' }, [
      monitor.stop_reason ?? '(停止理由は記録されていません)',
      ' ',
      el('a', { attrs: { href: `#/monitors/${encodeURIComponent(monitor.id)}` }, text: '詳細（判定根拠）' }),
    ]);
    frag.appendChild(reason);
  }
  return frag;
}

/** 同一Sourceに複数Monitorが付く (データ上あり得る) 場合、2件目以降は折りたたみへ逃がす */
function renderExtraMonitorsToggle(extraMonitors) {
  const wrap = el('div', {});
  const listWrap = el('div', { class: 'hidden' });
  const toggle = el('button', {
    class: 'expand-toggle',
    text: `他${extraMonitors.length}件の監視`,
    on: {
      click: (event) => {
        event.preventDefault();
        listWrap.classList.toggle('hidden');
      },
    },
  });

  const table = el('table');
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [el('th', { text: '状態' }), el('th', { text: '間隔' }), el('th', { text: '次回実行' }), el('th', {})]),
    ])
  );
  const tbody = el('tbody');
  for (const monitor of extraMonitors) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', {}, [monitorStatusBadge(monitor.status)]),
        el('td', { text: intervalLabel(monitor.interval_seconds) }),
        el('td', { text: formatDateTime(monitor.next_run_at) }),
        el('td', {}, [
          el('button', {
            class: 'button-ghost',
            text: '詳細',
            on: { click: () => navigate(`#/monitors/${encodeURIComponent(monitor.id)}`) },
          }),
        ]),
      ])
    );
  }
  table.appendChild(tbody);
  listWrap.appendChild(table);
  wrap.appendChild(toggle);
  wrap.appendChild(listWrap);
  return wrap;
}

/** 監視なし: 「監視を開始」インラインフォーム (間隔・分、既定60) */
function renderStartMonitorForm(source, hideError, showError, reload) {
  const intervalInput = el('input', {
    class: 'source-interval-input',
    attrs: { type: 'number', min: 1, step: 1, required: true },
  });
  intervalInput.value = '60';

  const form = el('form', {
    class: 'inline-form',
    on: {
      submit: async (event) => {
        event.preventDefault();
        hideError();
        const minutes = Number(intervalInput.value);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          showError('監視間隔は正の数 (分) で入力してください。');
          return;
        }
        try {
          await api.post('/monitors', { source_id: source.id, interval_seconds: Math.round(minutes * 60) });
        } catch (err) {
          showError(`監視の開始に失敗しました: ${err.message}`);
          return;
        }
        await reload();
      },
    },
  });
  form.appendChild(el('span', { class: 'muted', text: '監視: なし  間隔: ' }));
  form.appendChild(intervalInput);
  form.appendChild(el('span', { class: 'muted', text: ' 分 ' }));
  form.appendChild(el('button', { attrs: { type: 'submit' }, text: '監視を開始' }));
  return form;
}

function renderSourceDeleteButton(source, hideError, showError, reload) {
  return el('button', {
    class: 'button-danger',
    text: 'Sourceを削除',
    on: {
      click: async () => {
        hideError();
        if (!confirm(`Source "${source.url}" を削除します。関連する履歴も削除されます。よろしいですか?`)) return;
        try {
          await api.del(`/sources/${encodeURIComponent(source.id)}`);
        } catch (err) {
          showError(`削除に失敗しました: ${err.message}`);
          return;
        }
        await reload();
      },
    },
  });
}

function renderSourceCard(source, monitorsForSource, monitorsFetchFailed, onSourcesChanged) {
  const card = el('div', { class: 'source-card' });
  const errorEl = el('p', { class: 'error hidden' });
  const hideError = () => errorEl.classList.add('hidden');
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };
  const reload = async () => {
    try {
      await onSourcesChanged();
    } catch (err) {
      showError(`操作は成功しましたが、一覧の更新に失敗しました: ${err.message}`);
    }
  };

  card.appendChild(
    el('div', { class: 'source-card-header' }, [
      el('span', { class: 'badge', text: source.type }),
      el('span', { class: 'source-card-url', text: source.url }),
    ])
  );

  if (monitorsFetchFailed) {
    card.appendChild(
      el('p', { class: 'muted', text: '監視状態の取得に失敗したため表示できません。ページを再読み込みしてください。' })
    );
    card.appendChild(errorEl);
    return card;
  }

  if (monitorsForSource.length === 0) {
    card.appendChild(renderStartMonitorForm(source, hideError, showError, reload));
    card.appendChild(el('div', { class: 'button-row' }, [renderSourceDeleteButton(source, hideError, showError, reload)]));
  } else {
    const [primary, ...rest] = monitorsForSource;
    card.appendChild(renderMonitorStatusLine(primary));
    card.appendChild(renderMonitorActionsRow(primary, hideError, showError, reload));
    if (rest.length > 0) card.appendChild(renderExtraMonitorsToggle(rest));
    card.appendChild(
      el('p', { class: 'muted source-delete-hint', text: '監視を削除するとSourceを削除できるようになります。' })
    );
  }

  card.appendChild(errorEl);
  return card;
}

function renderAddSourceForm(siteId, onSourcesChanged) {
  const wrap = el('div', { class: 'source-add-form' });
  wrap.appendChild(el('h4', { text: 'Sourceを追加' }));

  const typeSelect = el(
    'select',
    {},
    SOURCE_TYPES.map((t) => el('option', { attrs: { value: t }, text: t }))
  );
  const urlInput = el('input', { attrs: { type: 'url', required: true, placeholder: 'https://example.com/feed.xml' } });
  const intervalInput = el('input', {
    attrs: { type: 'number', min: 1, step: 1, placeholder: '空欄なら監視なしで作成' },
  });
  const errorEl = el('p', { class: 'error hidden' });

  const form = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        const url = urlInput.value.trim();
        if (!url) return;
        const minutesRaw = intervalInput.value.trim();

        let source;
        try {
          source = await api.post('/sources', { site_id: siteId, type: typeSelect.value, url });
        } catch (err) {
          errorEl.textContent = `作成に失敗しました: ${err.message}`;
          errorEl.classList.remove('hidden');
          return;
        }

        if (minutesRaw !== '') {
          const minutes = Number(minutesRaw);
          if (!Number.isFinite(minutes) || minutes <= 0) {
            // Sourceの作成自体は既に成功している。監視間隔の指定が不正なだけなので、
            // Source作成の成功と監視未開始であることの両方を明示した上で一覧は更新する。
            errorEl.textContent = 'Sourceは作成済みですが、監視間隔は正の数 (分) で入力してください（監視は開始されていません）。';
            errorEl.classList.remove('hidden');
            try {
              await onSourcesChanged();
            } catch {
              // 一覧再取得の失敗より上記メッセージを優先して表示したままにする。
            }
            return;
          }
          try {
            await api.post('/monitors', { source_id: source.id, interval_seconds: Math.round(minutes * 60) });
          } catch (err) {
            errorEl.textContent = `Sourceは作成済みですが、監視の開始に失敗しました: ${err.message}`;
            errorEl.classList.remove('hidden');
            try {
              await onSourcesChanged();
            } catch {
              // 一覧再取得の失敗より上記メッセージを優先して表示したままにする。
            }
            return;
          }
        }

        urlInput.value = '';
        intervalInput.value = '';
        try {
          await onSourcesChanged();
        } catch (err) {
          errorEl.textContent = `一覧の更新に失敗しました（作成自体は成功しています）: ${err.message}`;
          errorEl.classList.remove('hidden');
        }
      },
    },
  });
  form.appendChild(
    fieldRow([field('種別', typeSelect), field('URL', urlInput), field('監視間隔 (分・空欄なら監視なし)', intervalInput)])
  );
  form.appendChild(el('button', { attrs: { type: 'submit' }, text: 'Sourceを追加' }));
  form.appendChild(errorEl);
  wrap.appendChild(form);
  return wrap;
}

async function renderSourcesSection(container, siteId, onSourcesChanged) {
  const s = section('Sources', []);
  container.appendChild(s);
  renderLoading(s);

  let sourcesData;
  try {
    sourcesData = await api.get(`/sources?site_id=${encodeURIComponent(siteId)}&limit=200`);
  } catch (err) {
    // 取得失敗と0件を区別する: ここで失敗を確定させ、呼び出し元にも「取得失敗」であることを
    // 伝播できるよう { failed: true } を返す (例外は投げない)。
    clear(s);
    s.appendChild(el('h3', { text: 'Sources' }));
    appendError(s, err);
    return { failed: true };
  }

  // Monitor一覧の取得失敗はSources自体の表示は妨げない (各カードの監視状態欄のみ「取得失敗」表示にする)。
  let monitorsData = null;
  let monitorsFetchFailed = false;
  try {
    monitorsData = await api.get(`/monitors?site_id=${encodeURIComponent(siteId)}&limit=200`);
  } catch {
    monitorsFetchFailed = true;
  }

  clear(s);
  s.appendChild(el('h3', { text: 'Sources' }));

  if (monitorsFetchFailed) {
    s.appendChild(
      el('p', { class: 'error', text: '監視状態の取得に失敗したため、各Sourceの監視状態は表示できません。' })
    );
  }

  const monitorsBySource = new Map();
  if (monitorsData) {
    for (const monitor of monitorsData.items) {
      const list = monitorsBySource.get(monitor.source_id) ?? [];
      list.push(monitor);
      monitorsBySource.set(monitor.source_id, list);
    }
  }

  if (sourcesData.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Sourceがまだ登録されていません。' }));
  } else {
    for (const source of sourcesData.items) {
      const monitorsForSource = monitorsBySource.get(source.id) ?? [];
      s.appendChild(renderSourceCard(source, monitorsForSource, monitorsFetchFailed, onSourcesChanged));
    }
    const notice = truncationNotice(sourcesData);
    if (notice) s.appendChild(notice);
  }

  s.appendChild(renderAddSourceForm(siteId, onSourcesChanged));

  return { failed: false };
}

// --- Fetcher Policy ----------------------------------------------------------

function fetcherRowEditor(entry, availableFetchers, onRemove) {
  // fetchers はシード管理のマスタ (GET /api/fetchers)。未登録IDはAPIが400を返すため選択式にする。
  const fetcherIdInput = el('select', { attrs: { required: true } });
  fetcherIdInput.appendChild(el('option', { attrs: { value: '' }, text: '選択してください' }));
  const knownIds = new Set(availableFetchers.map((f) => f.id));
  const ids = availableFetchers.map((f) => f.id);
  const isUnknownExisting = entry.fetcher_id && !knownIds.has(entry.fetcher_id);
  if (isUnknownExisting) ids.unshift(entry.fetcher_id);
  for (const id of ids) {
    // レビュー指摘: マスタに無い既存entryのfetcher_idは、選択肢から静かに消したり
    // 別のIDとして扱ったりせず、「未登録」であることを明示した上でdisabledにする
    // (選び直しは強制するが、保存されている値自体は読み取り時に見える形で残す)。
    const unknown = !knownIds.has(id);
    fetcherIdInput.appendChild(
      el('option', {
        attrs: unknown ? { value: id, disabled: true } : { value: id },
        text: unknown ? `${id} (未登録)` : id,
      })
    );
  }
  fetcherIdInput.value = entry.fetcher_id ?? '';

  const checkboxes = FAILURE_CLASSES.map((cls) => {
    const cb = el('input', { attrs: { type: 'checkbox', value: cls } });
    cb.checked = (entry.proceed_on ?? []).includes(cls);
    const label = el('label', { class: 'checkbox-field' }, [cb, ` ${cls}`]);
    return { cls, cb, label };
  });

  const row = el('div', { class: 'section', attrs: { style: 'margin-bottom:10px;' } });
  row.appendChild(field('Fetcher ID', fetcherIdInput));
  const proceedWrap = el('div', { class: 'field' });
  proceedWrap.appendChild(el('label', { text: '後続へ進んでよい失敗分類 (proceed_on)' }));
  const grid = el('div', { attrs: { style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:4px;' } });
  for (const { label } of checkboxes) grid.appendChild(label);
  proceedWrap.appendChild(grid);
  row.appendChild(proceedWrap);
  row.appendChild(
    el('button', {
      class: 'button-ghost',
      text: 'この行を削除',
      on: { click: (event) => { event.preventDefault(); onRemove(); } },
    })
  );

  return {
    node: row,
    read: () => ({
      fetcher_id: fetcherIdInput.value.trim(),
      proceed_on: checkboxes.filter((c) => c.cb.checked).map((c) => c.cls),
    }),
  };
}

async function renderFetcherPolicySection(container, siteId) {
  const s = section('Fetcher Policy', []);
  container.appendChild(s);
  renderLoading(s);

  let policy = { allow_list: [], order_list: [] };
  let availableFetchers = [];
  // レビュー指摘: fetchers取得 (マスタ一覧) の失敗を「0件」と区別できず、無言で空selectに
  // なってしまっていた。取得失敗フラグを保持し、下で明示的にエラー表示 + 編集不可にする。
  let fetchersFetchFailed = false;
  try {
    const [policyResult, fetchersResult] = await Promise.allSettled([
      api.get(`/sites/${encodeURIComponent(siteId)}/fetcher-policy`),
      api.get('/fetchers'),
    ]);
    if (policyResult.status === 'fulfilled') {
      policy = policyResult.value;
    } else if (policyResult.reason?.status !== 404) {
      throw policyResult.reason;
    }
    if (fetchersResult.status === 'fulfilled') {
      availableFetchers = fetchersResult.value.items ?? [];
    } else {
      fetchersFetchFailed = true;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  clear(s);
  s.appendChild(el('h3', { text: 'Fetcher Policy' }));
  s.appendChild(
    el('p', {
      class: 'muted',
      text: 'AllowListとOrderListは同一の集合として扱う (行の並び順がそのままOrderList)。',
    })
  );

  if (policy.order_list.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Fetcher Policyが未設定です。下のフォームから設定してください。' }));
  } else {
    const table = el('table');
    table.appendChild(
      el('thead', {}, [el('tr', {}, [el('th', { text: '順序' }), el('th', { text: 'Fetcher ID' }), el('th', { text: 'proceed_on' })])])
    );
    const tbody = el('tbody');
    policy.order_list.forEach((entry, idx) => {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: String(idx + 1) }),
          el('td', { text: entry.fetcher_id }),
          el('td', { text: (entry.proceed_on ?? []).join(', ') || '(既定値)' }),
        ])
      );
    });
    table.appendChild(tbody);
    s.appendChild(table);
  }

  const editorWrap = el('div', { class: 'hidden' });
  const rows = [];
  const rowsContainer = el('div');

  function addRow(entry = { fetcher_id: '', proceed_on: [] }) {
    const rowEditor = fetcherRowEditor(entry, availableFetchers, () => {
      const idx = rows.indexOf(rowEditor);
      if (idx >= 0) rows.splice(idx, 1);
      rowEditor.node.remove();
    });
    rows.push(rowEditor);
    rowsContainer.appendChild(rowEditor.node);
  }

  const knownFetcherIds = new Set(availableFetchers.map((f) => f.id));
  const errorEl = el('p', { class: 'error hidden' });
  const editForm = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        const entries = rows.map((r) => r.read()).filter((e) => e.fetcher_id !== '');

        // レビュー指摘: マスタに無い (未登録) fetcher_idが行に残ったまま保存しようとした場合、
        // サーバー側の unknown_fetcher 400 に頼らず、クライアント側でも事前に検出して
        // 送信自体をブロックする (どの行が未登録かをここで明示する)。
        const unknownIds = entries.filter((e) => !knownFetcherIds.has(e.fetcher_id)).map((e) => e.fetcher_id);
        if (unknownIds.length > 0) {
          errorEl.textContent = `未登録のFetcher IDが含まれています: ${unknownIds.join(', ')}。該当行を選び直すか削除してください。`;
          errorEl.classList.remove('hidden');
          return;
        }

        const body = {
          allow_list: entries.map((e) => e.fetcher_id),
          order_list: entries.map((e) => ({ fetcher_id: e.fetcher_id, proceed_on: e.proceed_on.length ? e.proceed_on : undefined })),
        };
        try {
          await api.put(`/sites/${encodeURIComponent(siteId)}/fetcher-policy`, body);
        } catch (err) {
          errorEl.textContent = `保存に失敗しました: ${err.message}`;
          errorEl.classList.remove('hidden');
          return;
        }
        await renderFetcherPolicySectionReload();
      },
    },
  });
  editForm.appendChild(rowsContainer);
  const addRowButton = el('button', {
    class: 'button-ghost',
    text: '行を追加',
    on: { click: (event) => { event.preventDefault(); addRow(); } },
  });
  editForm.appendChild(addRowButton);
  editForm.appendChild(el('div', { class: 'button-row', attrs: { style: 'margin-top:10px;' } }, [
    el('button', { attrs: { type: 'submit' }, text: '保存' }),
  ]));
  editForm.appendChild(errorEl);
  editorWrap.appendChild(editForm);

  for (const entry of policy.order_list) addRow(entry);
  if (policy.order_list.length === 0) addRow();

  if (fetchersFetchFailed) {
    // レビュー指摘: Fetcherマスタの取得に失敗した状態で編集を許可すると、選択肢が
    // 実質空 (プレースホルダのみ) のまま保存されてしまう恐れがあるため、失敗を明示した上で
    // 編集自体を不可にする (トグルボタンを無効化)。
    s.appendChild(
      el('p', {
        class: 'error',
        text: 'Fetcherマスタ一覧 (GET /api/fetchers) の取得に失敗しました。編集内容が正しく検証できないため、Fetcher Policyの編集は無効化されています。ページを再読み込みしてください。',
      })
    );
  }

  const toggleButton = el('button', {
    class: 'button-ghost',
    text: 'Fetcher Policyを編集',
    attrs: fetchersFetchFailed ? { disabled: true } : {},
    on: {
      click: () => {
        if (fetchersFetchFailed) return;
        editorWrap.classList.toggle('hidden');
        toggleButton.textContent = editorWrap.classList.contains('hidden') ? 'Fetcher Policyを編集' : '編集を閉じる';
      },
    },
  });
  s.appendChild(toggleButton);
  s.appendChild(editorWrap);

  async function renderFetcherPolicySectionReload() {
    container.removeChild(s);
    try {
      await renderFetcherPolicySection(container, siteId);
    } catch (err) {
      // 保存自体は成功しているため、再描画失敗は別メッセージで通知する。
      // sを既に取り除いているため、代わりのセクションを挿入してエラーを表示する
      // (何も挿入しないとセクション自体が消えたままになってしまう)。
      const fallback = section('Fetcher Policy', []);
      container.appendChild(fallback);
      fallback.appendChild(el('p', { class: 'error', text: `保存は成功しましたが、表示の更新に失敗しました: ${err.message}` }));
    }
  }
}

// --- Robots Overrides (ADR-0009 Override UI) --------------------------------

async function findRobotsEvaluationForOrigin(siteId, origin) {
  // API契約上、origin単位のrobots評価を直接取得するエンドポイントは存在しない。
  // Monitor詳細(GET /api/monitors/:id)にのみ robots_evaluation が同梱されるため、
  // このSiteのMonitorのうち、対象originに紐づくSourceを持つものを探し、その最新評価を代表値として表示する。
  // (判断点: report参照)
  const monitorsData = await api.get(`/monitors?site_id=${encodeURIComponent(siteId)}&limit=200`);

  // Source取得とorigin判定を並列化する。個々のSource取得/URL解析の失敗は従来どおり
  // そのMonitorをスキップする (継続) 扱いとし、エラーを外へ伝播させない。
  const originMatches = await Promise.all(
    monitorsData.items.map(async (m) => {
      let source;
      try {
        source = await api.get(`/sources/${encodeURIComponent(m.source_id)}`);
      } catch {
        return null;
      }
      let sourceOrigin;
      try {
        sourceOrigin = new URL(source.url).origin;
      } catch {
        return null;
      }
      return sourceOrigin === origin ? m : null;
    })
  );
  const matchedMonitors = originMatches.filter((m) => m !== null);

  // 一致したMonitorのrobots評価取得も並列化する。ここは従来どおりエラーを
  // そのまま伝播させる (呼び出し元 refreshJudgment() が捕捉して表示する)。
  const evaluations = await Promise.all(
    matchedMonitors.map(async (m) => {
      const detail = await api.get(`/monitors/${encodeURIComponent(m.id)}`);
      return detail.robots_evaluation ?? null;
    })
  );
  return evaluations.find((e) => e) ?? null;
}

async function renderRobotsOverridesSection(container, site) {
  const siteId = site.id;
  const s = section('robots.txt Override', []);
  container.appendChild(s);
  renderLoading(s);

  const data = await api.get(`/sites/${encodeURIComponent(siteId)}/robots-overrides`);
  clear(s);
  s.appendChild(el('h3', { text: 'robots.txt Override' }));

  if (data.has_active_override) {
    s.appendChild(
      el('div', {
        class: 'banner banner-warning',
        text:
          'このSiteには有効な robots.txt Override (ignore) があります。robots.txt が禁止している対象への取得を継続しています。',
      })
    );
  }

  if (data.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Override設定はまだありません。' }));
  } else {
    const table = el('table');
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Origin' }),
          el('th', { text: 'モード' }),
          el('th', { text: '理由' }),
          el('th', { text: '更新者' }),
          el('th', { text: '更新日時' }),
          el('th', {}),
        ]),
      ])
    );
    const tbody = el('tbody');
    for (const policy of data.items) {
      const disableButton = el('button', {
        class: 'button-danger',
        text: '無効化 (enforceへ戻す)',
        attrs: policy.mode !== 'ignore' ? { disabled: true } : {},
        on: {
          click: async () => {
            if (!confirm(`origin "${policy.canonical_origin}" のOverrideを解除しますか?`)) return;
            try {
              await api.del(
                `/sites/${encodeURIComponent(siteId)}/robots-overrides?canonical_origin=${encodeURIComponent(policy.canonical_origin)}`
              );
              await reload();
            } catch (err) {
              alert(`解除に失敗しました: ${err.message}`);
            }
          },
        },
      });
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: policy.canonical_origin }),
          el('td', {}, [badge(policy.mode === 'ignore' ? 'blocked_by_robots' : 'active'), document.createTextNode(` ${policy.mode}`)]),
          el('td', { text: policy.reason ?? '—' }),
          el('td', { text: policy.updated_by ?? '—' }),
          el('td', { text: formatDateTime(policy.updated_at) }),
          el('td', {}, [disableButton]),
        ])
      );
    }
    table.appendChild(tbody);
    s.appendChild(table);
  }

  // --- 有効化フォーム ---
  const enableSection = el('div', { class: 'section', attrs: { style: 'margin-top:16px;' } });
  enableSection.appendChild(el('h3', { text: 'Overrideを有効化する' }));
  enableSection.appendChild(
    el('p', { class: 'muted', text: '対象originのrobots.txtによる禁止を理解した上で、監視の続行を明示的に許可します。' })
  );

  const originInput = el('input', { attrs: { type: 'url', required: true } });
  originInput.value = site.primary_origin ?? '';
  const judgmentEl = el('div', {});
  judgmentEl.appendChild(el('p', { class: 'muted', text: 'originを指定すると現在のrobots判定を表示します。' }));

  async function refreshJudgment() {
    const origin = originInput.value.trim();
    clear(judgmentEl);
    if (!origin) {
      judgmentEl.appendChild(el('p', { class: 'muted', text: 'originを入力してください。' }));
      return;
    }
    judgmentEl.appendChild(el('p', { class: 'loading', text: 'robots判定を確認中...' }));
    let evaluation = null;
    try {
      evaluation = await findRobotsEvaluationForOrigin(siteId, origin);
    } catch (err) {
      clear(judgmentEl);
      judgmentEl.appendChild(el('p', { class: 'error', text: `robots判定の取得に失敗しました: ${err.message}` }));
      return;
    }
    clear(judgmentEl);
    if (!evaluation) {
      judgmentEl.appendChild(
        el('p', {
          class: 'muted',
          text: 'このoriginに対する robots評価はまだ記録されていません (監視の実行後に確認できます)。',
        })
      );
      return;
    }
    const dl = el('dl', { class: 'kv' });
    const rows = [
      ['判定 (verdict)', evaluation.verdict],
      ['robots.txt URL', evaluation.robots_url],
      ['matched rule', evaluation.matched_rule ?? '—'],
      ['User-Agent group', evaluation.user_agent_group ?? '—'],
      ['確認日時', formatDateTime(evaluation.checked_at)],
      ['robots_would_block', evaluation.robots_would_block ? 'true (本来は禁止)' : 'false'],
    ];
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    judgmentEl.appendChild(dl);
  }
  originInput.addEventListener('change', refreshJudgment);

  const reasonInput = el('textarea', { attrs: { rows: 3, required: true, placeholder: '例: 自分が管理するSiteであり、robots.txtの設定を修正するまで監視を継続したい' } });
  const confirmCheckbox = el('input', { attrs: { type: 'checkbox', required: true } });
  const enableError = el('p', { class: 'error hidden' });

  const enableForm = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        enableError.classList.add('hidden');
        const origin = originInput.value.trim();
        const reason = reasonInput.value.trim();
        if (!origin || !reason) {
          enableError.textContent = 'originと理由は必須です。';
          enableError.classList.remove('hidden');
          return;
        }
        if (!confirmCheckbox.checked) {
          enableError.textContent = '確認チェックボックスにチェックしてください。';
          enableError.classList.remove('hidden');
          return;
        }
        try {
          await api.put(`/sites/${encodeURIComponent(siteId)}/robots-overrides`, {
            canonical_origin: origin,
            mode: 'ignore',
            reason,
            confirm: true,
          });
        } catch (err) {
          enableError.textContent = `有効化に失敗しました: ${err.message}`;
          enableError.classList.remove('hidden');
          return;
        }
        reasonInput.value = '';
        confirmCheckbox.checked = false;
        await reload();
      },
    },
  });
  enableForm.appendChild(field('対象Origin', originInput));
  enableForm.appendChild(el('div', { class: 'field' }, [el('label', { text: '現在のrobots判定' }), judgmentEl]));
  enableForm.appendChild(field('理由 (必須)', reasonInput));
  enableForm.appendChild(
    el('div', { class: 'checkbox-field field' }, [confirmCheckbox, el('label', { text: '禁止を理解した上で監視を続行する' })])
  );
  enableForm.appendChild(el('button', { attrs: { type: 'submit' }, text: 'Overrideを有効化' }));
  enableForm.appendChild(enableError);
  enableSection.appendChild(enableForm);
  s.appendChild(enableSection);

  refreshJudgment();

  async function reload() {
    container.removeChild(s);
    try {
      await renderRobotsOverridesSection(container, site);
    } catch (err) {
      // 有効化/解除自体は成功しているため、再描画失敗は別メッセージで通知する。
      const fallback = section('robots.txt Override', []);
      container.appendChild(fallback);
      fallback.appendChild(el('p', { class: 'error', text: `更新は成功しましたが、表示の更新に失敗しました: ${err.message}` }));
    }
  }
}

// --- top-level view -----------------------------------------------------------

async function siteDetailView(container, params) {
  const siteId = params.id;
  clear(container);
  container.appendChild(el('p', { class: 'breadcrumbs' }, [el('a', { attrs: { href: '#/sites' }, text: '← Sites一覧' })]));

  let site;
  try {
    site = await api.get(`/sites/${encodeURIComponent(siteId)}`);
  } catch (err) {
    renderError(container, err);
    return;
  }

  container.appendChild(el('h2', { text: `Site: ${site.name}` }));
  const kv = el('dl', { class: 'kv' });
  kv.appendChild(el('dt', { text: 'Primary Origin' }));
  kv.appendChild(el('dd', { text: site.primary_origin ?? '—' }));
  kv.appendChild(el('dt', { text: '作成日時' }));
  kv.appendChild(el('dd', { text: formatDateTime(site.created_at) }));
  container.appendChild(section(null, [kv]));

  async function reloadAll() {
    // Source作成後・監視の開始/削除後はSites詳細ページ全体を再レンダリングし、
    // カード内の監視状態や他セクションにも反映させる。
    await siteDetailView(container, params);
  }

  // Sources (監視状態統合表示) / Fetcher Policy / robots Override の取得・描画は互いに独立
  // しているため並列実行する。各セクション自身が自分の描画領域へエラーを出すため、
  // ここでの失敗処理は従来どおり維持する。
  const [sourcesResult, fetcherResult, robotsResult] = await Promise.allSettled([
    renderSourcesSection(container, siteId, reloadAll),
    renderFetcherPolicySection(container, siteId),
    renderRobotsOverridesSection(container, site),
  ]);

  if (sourcesResult.status === 'rejected') {
    appendError(container, sourcesResult.reason);
  }
  if (fetcherResult.status === 'rejected') {
    appendError(container, fetcherResult.reason);
  }
  if (robotsResult.status === 'rejected') {
    appendError(container, robotsResult.reason);
  }

  renderSiteDangerZone(container, site);
}

// --- 危険操作 (Site削除) -------------------------------------------------------

function renderSiteDangerZone(container, site) {
  const s = section('危険操作', []);
  const errorEl = el('p', { class: 'error hidden' });
  const deleteButton = el('button', {
    class: 'button-danger',
    text: 'このSiteを削除',
    on: {
      click: async () => {
        errorEl.classList.add('hidden');
        if (!confirm(`Site "${site.name}" を削除します。関連する履歴も削除されます。よろしいですか?`)) return;
        try {
          await api.del(`/sites/${encodeURIComponent(site.id)}`);
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.classList.remove('hidden');
          return;
        }
        navigate('#/sites');
      },
    },
  });
  s.appendChild(el('p', { class: 'muted', text: '配下にSourceが残っている場合は削除できません (先にSourceを削除してください)。' }));
  s.appendChild(deleteButton);
  s.appendChild(errorEl);
  container.appendChild(s);
}

registerRoute('/sites/:id', siteDetailView);
