/**
 * #/monitors/:id : 監視詳細
 *  - Site詳細のSourceカードから「履歴・差分」で遷移してくる詳細ページ
 *    (どのSourceの監視かが一目で分かるよう、ヘッダにSource種別・URLを表示する)
 *  - DOステータス (status API 由来)
 *  - 手動実行・pause/resume
 *  - Policy Stop表示 (SPEC §9.1-7): status='blocked_by_robots' のときの停止理由・判定根拠
 *  - Jobs履歴 -> 展開でAttempts (取得経路の再現)
 *  - Changes一覧
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import {
  el,
  clear,
  section,
  formatDateTime,
  monitorStatusBadge,
  monitorStatusLabel,
  intervalLabel,
  renderLoading,
  renderError,
  appendError,
  navigate,
} from '../util.js';

function renderPolicyStopBanner(container, monitor) {
  if (monitor.status !== 'blocked_by_robots') return;
  const ev = monitor.robots_evaluation;
  const banner = el('div', { class: 'banner banner-danger' });
  banner.appendChild(el('strong', { text: 'Policy Stop: robots.txt により監視を停止しています' }));
  banner.appendChild(el('p', { text: monitor.stop_reason ?? '(停止理由は記録されていません)' }));
  if (ev) {
    const dl = el('dl', { class: 'kv' });
    const rows = [
      ['robots.txt URL', ev.robots_url ?? '—'],
      ['matched rule', ev.matched_rule ?? '—'],
      ['User-Agent group', ev.user_agent_group ?? '—'],
      ['確認日時', formatDateTime(ev.checked_at)],
      ['robots_would_block', ev.robots_would_block ? 'true' : 'false'],
    ];
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    banner.appendChild(dl);
  } else {
    banner.appendChild(el('p', { class: 'muted', text: '判定根拠 (robots_evaluation) が記録されていません。' }));
  }
  container.appendChild(banner);
}

async function renderStatusSection(container, monitorId, monitor, onChanged) {
  const s = section('状態', []);
  container.appendChild(s);
  renderLoading(s);

  let doStatus = null;
  let statusError = null;
  try {
    doStatus = await api.get(`/monitors/${encodeURIComponent(monitorId)}/status`);
  } catch (err) {
    statusError = err;
  }

  clear(s);
  s.appendChild(el('h3', { text: '状態' }));

  const dl = el('dl', { class: 'kv' });
  const rows = [
    ['ステータス (DB)', monitorStatusLabel(monitor.status)],
    ['実行間隔', intervalLabel(monitor.interval_seconds)],
    ['最終確認日時', formatDateTime(monitor.last_checked_at)],
  ];
  if (doStatus) {
    rows.push(
      ['次回実行 (DO)', formatDateTime(doStatus.next_run_at)],
      ['実行中 (DO)', doStatus.running ? 'true' : 'false'],
      ['一時停止中 (DO)', doStatus.paused ? 'true' : 'false'],
      ['直近結果 (DO)', doStatus.last_result ? `${doStatus.last_result.status} (${formatDateTime(doStatus.last_result.at)})` : '—']
    );
  }
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v }));
  }
  s.appendChild(dl);
  if (statusError) {
    s.appendChild(el('p', { class: 'error', text: `DOステータスの取得に失敗しました: ${statusError.message}` }));
  }

  const actionError = el('p', { class: 'error hidden' });
  const runButton = el('button', {
    text: '今すぐ実行',
    on: {
      click: async () => {
        actionError.classList.add('hidden');
        try {
          await api.post(`/monitors/${encodeURIComponent(monitorId)}/run`);
          await onChanged();
        } catch (err) {
          actionError.textContent = `実行できませんでした: ${err.message}`;
          actionError.classList.remove('hidden');
        }
      },
    },
  });
  const pauseButton = el('button', {
    class: 'button-ghost',
    text: '一時停止',
    on: {
      click: async () => {
        actionError.classList.add('hidden');
        try {
          await api.post(`/monitors/${encodeURIComponent(monitorId)}/pause`);
          await onChanged();
        } catch (err) {
          actionError.textContent = `一時停止に失敗しました: ${err.message}`;
          actionError.classList.remove('hidden');
        }
      },
    },
  });
  const resumeButton = el('button', {
    class: 'button-ghost',
    text: '再開',
    on: {
      click: async () => {
        actionError.classList.add('hidden');
        try {
          await api.post(`/monitors/${encodeURIComponent(monitorId)}/resume`);
          await onChanged();
        } catch (err) {
          actionError.textContent = `再開に失敗しました: ${err.message}`;
          actionError.classList.remove('hidden');
        }
      },
    },
  });
  s.appendChild(el('div', { class: 'button-row', attrs: { style: 'margin-top:10px;' } }, [runButton, pauseButton, resumeButton]));
  s.appendChild(actionError);
}

async function renderAttemptsFor(container, jobId) {
  renderLoading(container);
  const data = await api.get(`/jobs/${encodeURIComponent(jobId)}/attempts?limit=100`);
  clear(container);
  if (data.items.length === 0) {
    container.appendChild(el('p', { class: 'empty', text: 'Attemptがありません。' }));
    return;
  }
  const table = el('table');
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: 'Fetcher' }),
        el('th', { text: '結果' }),
        el('th', { text: '失敗分類' }),
        el('th', { text: 'HTTP' }),
        el('th', { text: '所要時間(ms)' }),
        el('th', { text: 'エラー' }),
      ]),
    ])
  );
  const tbody = el('tbody');
  for (const attempt of data.items) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: String(attempt.attempt_index) }),
        el('td', { text: attempt.fetcher_id }),
        el('td', { text: attempt.outcome }),
        el('td', { text: attempt.failure_class ?? '—' }),
        el('td', { text: attempt.status_code !== null ? String(attempt.status_code) : '—' }),
        el('td', { text: attempt.duration_ms !== null ? String(attempt.duration_ms) : '—' }),
        el('td', { text: attempt.error_message ?? '—' }),
      ])
    );
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

async function renderJobsSection(container, monitorId) {
  const s = section('Jobs履歴', []);
  container.appendChild(s);
  renderLoading(s);

  const data = await api.get(`/monitors/${encodeURIComponent(monitorId)}/jobs?limit=100`);
  clear(s);
  s.appendChild(el('h3', { text: 'Jobs履歴' }));

  if (data.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Jobがまだありません。' }));
    return;
  }

  for (const job of data.items) {
    const attemptsContainer = el('div', { class: 'hidden' });
    const toggle = el('button', {
      class: 'expand-toggle',
      text: `展開 (${job.status})`,
      on: {
        click: async () => {
          const willShow = attemptsContainer.classList.contains('hidden');
          attemptsContainer.classList.toggle('hidden');
          if (willShow && attemptsContainer.childNodes.length === 0) {
            try {
              await renderAttemptsFor(attemptsContainer, job.id);
            } catch (err) {
              renderError(attemptsContainer, err);
            }
          }
        },
      },
    });
    const row = el('div', { class: 'list-item' });
    const dl = el('dl', { class: 'kv' });
    const rows = [
      ['Job ID', job.id],
      ['ステータス', job.status],
      ['トリガー', job.trigger],
      ['予定時刻', formatDateTime(job.scheduled_for)],
      ['開始', formatDateTime(job.started_at)],
      ['終了', formatDateTime(job.finished_at)],
    ];
    for (const [k, v] of rows) {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v }));
    }
    row.appendChild(dl);
    row.appendChild(toggle);
    row.appendChild(attemptsContainer);
    s.appendChild(row);
  }
}

async function renderChangesSection(container, monitorId) {
  const s = section('Changes一覧', []);
  container.appendChild(s);
  renderLoading(s);

  const data = await api.get(`/changes?monitor_id=${encodeURIComponent(monitorId)}&limit=100`);
  clear(s);
  s.appendChild(el('h3', { text: 'Changes一覧' }));

  if (data.items.length === 0) {
    s.appendChild(el('p', { class: 'empty', text: 'Changeはまだ検出されていません。' }));
    return;
  }

  const table = el('table');
  table.appendChild(
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '種別' }),
        el('th', { text: 'タイトル' }),
        el('th', { text: '検出日時' }),
        el('th', { text: 'プレビュー' }),
        el('th', {}),
      ]),
    ])
  );
  const tbody = el('tbody');
  for (const change of data.items) {
    tbody.appendChild(
      el('tr', {}, [
        el('td', { text: change.kind }),
        el('td', { text: change.title ?? '—' }),
        el('td', { text: formatDateTime(change.detected_at) }),
        el('td', { text: change.diff_preview ?? '—' }),
        el('td', {}, [
          el('button', {
            class: 'button-ghost',
            text: '差分を見る',
            on: { click: () => navigate(`#/changes/${encodeURIComponent(change.id)}`) },
          }),
        ]),
      ])
    );
  }
  table.appendChild(tbody);
  s.appendChild(table);
}

async function monitorDetailView(container, params) {
  const monitorId = params.id;
  clear(container);
  container.appendChild(el('p', { class: 'breadcrumbs' }, [el('a', { attrs: { href: '#/sites' }, text: '← Sites一覧' })]));

  let monitor;
  try {
    monitor = await api.get(`/monitors/${encodeURIComponent(monitorId)}`);
  } catch (err) {
    renderError(container, err);
    return;
  }

  // どのSourceの監視かをヘッダで一目で分かるようにする (Site詳細のカードから来た際の文脈維持)。
  // Source取得に失敗しても監視詳細自体は表示を続行する (取得失敗時はURL等を省略する)。
  let source = null;
  try {
    source = await api.get(`/sources/${encodeURIComponent(monitor.source_id)}`);
  } catch {
    source = null;
  }

  container.appendChild(el('h2', {}, ['監視詳細', ' ', monitorStatusBadge(monitor.status)]));
  container.appendChild(
    el('p', { class: 'breadcrumbs' }, [el('a', { attrs: { href: `#/sites/${encodeURIComponent(monitor.site_id)}` }, text: '← Site詳細へ' })])
  );

  if (source) {
    container.appendChild(
      el('p', { class: 'source-card-header' }, [
        el('span', { class: 'badge', text: source.type }),
        el('span', { class: 'source-card-url', text: source.url }),
      ])
    );
  } else {
    container.appendChild(
      el('p', { class: 'muted', text: `Source情報を取得できませんでした (Source ID: ${monitor.source_id})` })
    );
  }

  renderPolicyStopBanner(container, monitor);

  async function reload() {
    await monitorDetailView(container, params);
  }

  try {
    await renderStatusSection(container, monitorId, monitor, reload);
  } catch (err) {
    appendError(container, err);
  }

  try {
    await renderJobsSection(container, monitorId);
  } catch (err) {
    appendError(container, err);
  }

  try {
    await renderChangesSection(container, monitorId);
  } catch (err) {
    appendError(container, err);
  }

  renderMonitorDangerZone(container, monitor);
}

// --- 危険操作 (監視の削除) -------------------------------------------------------

function renderMonitorDangerZone(container, monitor) {
  const s = section('危険操作', []);
  const errorEl = el('p', { class: 'error hidden' });
  const deleteButton = el('button', {
    class: 'button-danger',
    text: 'この監視を削除',
    on: {
      click: async () => {
        errorEl.classList.add('hidden');
        if (!confirm(`この監視 (ID: ${monitor.id}) を削除します。関連する履歴も削除されます。よろしいですか?`)) return;
        try {
          await api.del(`/monitors/${encodeURIComponent(monitor.id)}`);
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.classList.remove('hidden');
          return;
        }
        navigate(`#/sites/${encodeURIComponent(monitor.site_id)}`);
      },
    },
  });
  s.appendChild(deleteButton);
  s.appendChild(errorEl);
  container.appendChild(s);
}

registerRoute('/monitors/:id', monitorDetailView);
