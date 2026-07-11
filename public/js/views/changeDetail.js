/**
 * #/changes/:id : Change詳細 (SPEC §17 受け入れ条件10)
 *  - unified diffの +/- 色分け表示
 *  - 変更前後の本文表示 (snapshots API、<pre>にtextContentで)
 *
 * XSS対策: diff描画のみ escapeHtml 済みの値を innerHTML で組み立てる。
 * それ以外 (本文、メタデータ) は全て textContent 経由。
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, escapeHtml, formatDateTime, renderLoading, renderError, appendError } from '../util.js';

function diffLineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-header';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-remove';
  return null;
}

function renderDiffPre(rawText) {
  const pre = el('pre', { class: 'code-block' });
  const lines = rawText.split('\n');
  // このコンポーネントに限り、行ごとに escapeHtml() を通した文字列を innerHTML で組み立てる
  // (色分けのため <span class="..."> を挿入する必要があるため textContent では表現できない)。
  const html = lines
    .map((line) => {
      const cls = diffLineClass(line);
      const className = cls ? `diff-line ${cls}` : 'diff-line';
      const safe = escapeHtml(line);
      return `<span class="${className}">${safe.length ? safe : ' '}</span>`;
    })
    .join('\n');
  pre.innerHTML = html;
  return pre;
}

async function renderDiffSection(container, changeId, change) {
  const s = section('差分 (unified diff)', []);
  container.appendChild(s);

  if (!change.has_diff) {
    s.appendChild(el('p', { class: 'empty', text: '保存された差分本文がありません。' }));
    return;
  }

  renderLoading(s);
  try {
    const diffText = await api.getText(`/changes/${encodeURIComponent(changeId)}/diff`);
    clear(s);
    s.appendChild(el('h3', { text: '差分 (unified diff)' }));
    s.appendChild(renderDiffPre(diffText));
  } catch (err) {
    clear(s);
    s.appendChild(el('h3', { text: '差分 (unified diff)' }));
    renderError(s, err);
  }
}

async function renderSnapshotBody(container, snapshotId, labelText) {
  const box = el('div', { class: 'section' });
  box.appendChild(el('h3', { text: labelText }));
  container.appendChild(box);

  if (!snapshotId) {
    box.appendChild(el('p', { class: 'empty', text: '対象のSnapshotがありません。' }));
    return;
  }

  const metaHolder = el('dl', { class: 'kv' });
  box.appendChild(metaHolder);
  const bodyHolder = el('div', { class: 'loading', text: '読み込み中...' });
  box.appendChild(bodyHolder);

  try {
    const meta = await api.get(`/snapshots/${encodeURIComponent(snapshotId)}`);
    clear(metaHolder);
    const rows = [
      ['取得日時', formatDateTime(meta.fetched_at)],
      ['HTTP status', meta.http_status !== null ? String(meta.http_status) : '—'],
      ['Content-Type', meta.content_type ?? '—'],
    ];
    for (const [k, v] of rows) {
      metaHolder.appendChild(el('dt', { text: k }));
      metaHolder.appendChild(el('dd', { text: v }));
    }
  } catch (err) {
    clear(metaHolder);
    metaHolder.appendChild(el('p', { class: 'error', text: `メタデータの取得に失敗しました: ${err.message}` }));
  }

  try {
    const bodyText = await api.getText(`/snapshots/${encodeURIComponent(snapshotId)}/body`);
    clear(bodyHolder);
    // 本文は監視対象サイトが返した信頼できない文字列。<pre> に textContent で描画し、
    // HTMLとして解釈させない (src/api/routes/snapshots.ts のコメント参照)。
    const pre = el('pre', { class: 'code-block', text: bodyText });
    bodyHolder.replaceWith(pre);
  } catch (err) {
    clear(bodyHolder);
    bodyHolder.className = 'empty';
    bodyHolder.textContent = `本文は利用できません (${err.message})`;
  }
}

async function changeDetailView(container, params) {
  const changeId = params.id;
  clear(container);

  let change;
  try {
    change = await api.get(`/changes/${encodeURIComponent(changeId)}`);
  } catch (err) {
    renderError(container, err);
    return;
  }

  container.appendChild(
    el('p', { class: 'breadcrumbs' }, [
      el('a', { attrs: { href: `#/monitors/${encodeURIComponent(change.monitor_id)}` }, text: '← 監視詳細へ' }),
    ])
  );
  container.appendChild(el('h2', { text: `Change: ${change.kind}` }));

  const kv = el('dl', { class: 'kv' });
  const rows = [
    ['対象URL', change.target_url ?? '—'],
    ['タイトル', change.title ?? '—'],
    ['検出日時', formatDateTime(change.detected_at)],
    ['diffレベル', change.diff_level],
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', { text: k }));
    kv.appendChild(el('dd', { text: v }));
  }
  container.appendChild(section(null, [kv]));

  try {
    await renderDiffSection(container, changeId, change);
  } catch (err) {
    appendError(container, err);
  }

  const pairSection = section('変更前後の本文', []);
  container.appendChild(pairSection);
  const pairGrid = el('div', { class: 'snapshot-pair' });
  pairSection.appendChild(pairGrid);

  const beforeBox = el('div');
  const afterBox = el('div');
  pairGrid.appendChild(beforeBox);
  pairGrid.appendChild(afterBox);

  await Promise.all([
    renderSnapshotBody(beforeBox, change.previous_snapshot_id, '変更前 (previous snapshot)'),
    renderSnapshotBody(afterBox, change.snapshot_id, '変更後 (current snapshot)'),
  ]);
}

registerRoute('/changes/:id', changeDetailView);
