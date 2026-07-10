/**
 * #/sites/:id : Site詳細
 *  - Sources 一覧/作成
 *  - Fetcher Policy 表示・編集
 *  - robots Override 管理 (ADR-0009 Override UI)
 *  - Monitor 一覧/作成 (詳細は #/monitors/:id へ)
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

// --- Sources ---------------------------------------------------------------

async function renderSourcesSection(container, siteId, onSourcesChanged) {
  const s = section('Sources', []);
  container.appendChild(s);
  renderLoading(s);

  let data;
  try {
    data = await api.get(`/sources?site_id=${encodeURIComponent(siteId)}&limit=200`);
  } catch (err) {
    // 取得失敗と0件を区別する: ここで失敗を確定させ、呼び出し元 (Monitorsセクション) にも
    // 「取得失敗」であることを伝播できるよう { failed: true } を返す (例外は投げない)。
    clear(s);
    s.appendChild(el('h3', { text: 'Sources' }));
    appendError(s, err);
    return { sources: [], failed: true };
  }
  clear(s);
  s.appendChild(el('h3', { text: 'Sources' }));

  const typeSelect = el(
    'select',
    {},
    SOURCE_TYPES.map((t) => el('option', { attrs: { value: t }, text: t }))
  );
  const urlInput = el('input', { attrs: { type: 'url', required: true, placeholder: 'https://example.com/feed.xml' } });
  const errorEl = el('p', { class: 'error hidden' });
  const form = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        const url = urlInput.value.trim();
        if (!url) return;
        try {
          await api.post('/sources', { site_id: siteId, type: typeSelect.value, url });
        } catch (err) {
          errorEl.textContent = `作成に失敗しました: ${err.message}`;
          errorEl.classList.remove('hidden');
          return;
        }
        urlInput.value = '';
        try {
          await onSourcesChanged();
        } catch (err) {
          errorEl.textContent = `一覧の更新に失敗しました（作成自体は成功しています）: ${err.message}`;
          errorEl.classList.remove('hidden');
        }
      },
    },
  });
  form.appendChild(fieldRow([field('種別', typeSelect), field('URL', urlInput)]));
  form.appendChild(el('button', { attrs: { type: 'submit' }, text: 'Source作成' }));
  form.appendChild(errorEl);
  s.appendChild(form);

  if (data.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Sourceがまだ登録されていません。' }));
    return { sources: [], failed: false };
  }

  const table = el('table');
  table.appendChild(
    el('thead', {}, [el('tr', {}, [el('th', { text: '種別' }), el('th', { text: 'URL' }), el('th', { text: '作成日時' })])])
  );
  const tbody = el('tbody');
  for (const source of data.items) {
    tbody.appendChild(
      el('tr', {}, [el('td', { text: source.type }), el('td', { text: source.url }), el('td', { text: formatDateTime(source.created_at) })])
    );
  }
  table.appendChild(tbody);
  s.appendChild(table);
  const notice = truncationNotice(data);
  if (notice) s.appendChild(notice);
  return { sources: data.items, failed: false };
}

// --- Fetcher Policy ----------------------------------------------------------

function fetcherRowEditor(entry, availableFetchers, onRemove) {
  // fetchers はシード管理のマスタ (GET /api/fetchers)。未登録IDはAPIが400を返すため選択式にする。
  const fetcherIdInput = el('select', { attrs: { required: true } });
  fetcherIdInput.appendChild(el('option', { attrs: { value: '' }, text: '選択してください' }));
  const ids = availableFetchers.map((f) => f.id);
  if (entry.fetcher_id && !ids.includes(entry.fetcher_id)) ids.unshift(entry.fetcher_id);
  for (const id of ids) {
    fetcherIdInput.appendChild(el('option', { attrs: { value: id }, text: id }));
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

  const errorEl = el('p', { class: 'error hidden' });
  const editForm = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        const entries = rows.map((r) => r.read()).filter((e) => e.fetcher_id !== '');
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

  const toggleButton = el('button', {
    class: 'button-ghost',
    text: 'Fetcher Policyを編集',
    on: {
      click: () => {
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
          text: 'このoriginに対する robots評価はまだ記録されていません (Monitor実行後に確認できます)。',
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

// --- Monitors ----------------------------------------------------------------

async function renderMonitorsSection(container, siteId, sources, sourcesFetchFailed = false) {
  const s = section('Monitors', []);
  container.appendChild(s);
  renderLoading(s);

  const data = await api.get(`/monitors?site_id=${encodeURIComponent(siteId)}&limit=200`);
  clear(s);
  s.appendChild(el('h3', { text: 'Monitors' }));

  const sourceSelect = el(
    'select',
    {},
    sources.map((src) => el('option', { attrs: { value: src.id }, text: `${src.type}: ${src.url}` }))
  );
  const intervalInput = el('input', { attrs: { type: 'number', min: 60, step: 1, required: true } });
  intervalInput.value = '3600';
  const errorEl = el('p', { class: 'error hidden' });

  if (sourcesFetchFailed) {
    // Sources取得の失敗と「Sourceが0件」を区別する: 前者はMonitor作成不可の理由が
    // 取得失敗であることを明示し、後者 (0件) と異なる文言で案内する。
    s.appendChild(
      el('p', { class: 'error', text: 'Source一覧の取得に失敗しているため、Monitorを作成できません。ページを再読み込みしてください。' })
    );
  } else if (sources.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Monitorを作成するには先にSourceを登録してください。' }));
  } else {
    const form = el('form', {
      on: {
        submit: async (event) => {
          event.preventDefault();
          errorEl.classList.add('hidden');
          try {
            await api.post('/monitors', {
              source_id: sourceSelect.value,
              interval_seconds: Number(intervalInput.value),
            });
          } catch (err) {
            errorEl.textContent = `作成に失敗しました: ${err.message}`;
            errorEl.classList.remove('hidden');
            return;
          }
          container.removeChild(s);
          try {
            await renderMonitorsSection(container, siteId, sources, sourcesFetchFailed);
          } catch (err) {
            // 作成自体は成功しているため、再描画失敗は別メッセージで通知する。
            const fallback = section('Monitors', []);
            container.appendChild(fallback);
            fallback.appendChild(el('p', { class: 'error', text: `作成は成功しましたが、一覧の更新に失敗しました: ${err.message}` }));
          }
        },
      },
    });
    form.appendChild(fieldRow([field('Source', sourceSelect), field('実行間隔 (秒)', intervalInput)]));
    form.appendChild(el('button', { attrs: { type: 'submit' }, text: 'Monitor作成' }));
    form.appendChild(errorEl);
    s.appendChild(form);
  }

  if (data.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Monitorがまだ登録されていません。' }));
    return;
  }

  const table = el('table');
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '状態' }),
        el('th', { text: 'Source ID' }),
        el('th', { text: '実行間隔(秒)' }),
        el('th', { text: '次回実行' }),
        el('th', {}),
      ]),
    ])
  );
  const tbody = el('tbody');
  for (const monitor of data.items) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', {}, [badge(monitor.status)]),
        el('td', { text: monitor.source_id }),
        el('td', { text: String(monitor.interval_seconds) }),
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
  s.appendChild(table);
  const notice = truncationNotice(data);
  if (notice) s.appendChild(notice);
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
    // Source作成後はSites詳細ページ全体を再レンダリングし、Monitor作成フォームの
    // Source候補一覧などにも反映させる。
    await siteDetailView(container, params);
  }

  // Sources / Fetcher Policy / robots Override の取得は互いに独立しているため並列実行する
  // (Monitorsのみ、Sources取得結果 (sources一覧・取得失敗フラグ) に依存するため後段で実行する)。
  // 各セクション自身が自分の描画領域へエラーを出すため、ここでの失敗処理は従来どおり維持する。
  const [sourcesResult, fetcherResult, robotsResult] = await Promise.allSettled([
    renderSourcesSection(container, siteId, reloadAll),
    renderFetcherPolicySection(container, siteId),
    renderRobotsOverridesSection(container, site),
  ]);

  let sources = [];
  let sourcesFetchFailed = false;
  if (sourcesResult.status === 'fulfilled') {
    sources = sourcesResult.value.sources;
    sourcesFetchFailed = sourcesResult.value.failed;
  } else {
    appendError(container, sourcesResult.reason);
    sourcesFetchFailed = true;
  }
  if (fetcherResult.status === 'rejected') {
    appendError(container, fetcherResult.reason);
  }
  if (robotsResult.status === 'rejected') {
    appendError(container, robotsResult.reason);
  }

  try {
    await renderMonitorsSection(container, siteId, sources, sourcesFetchFailed);
  } catch (err) {
    appendError(container, err);
  }
}

registerRoute('/sites/:id', siteDetailView);
