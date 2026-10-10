/**
 * #/dry-run : URL を1本試し撃ちして robots.txt 判定と <title> を確認する (ADR-0018)。
 *
 * Site/Source を作る前の下見用。DBには何も残らない。
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, field, formatDateTime, renderLoading, renderError } from '../util.js';

const DEFAULT_FETCHER_LABEL = '既定 (Worker 内)';

/** dl に「項目 / 値」を1行足す。value は文字列またはノード */
function addRow(dl, key, value) {
  dl.appendChild(el('dt', { text: key }));
  dl.appendChild(typeof value === 'string' ? el('dd', { text: value }) : el('dd', {}, [value]));
}

function renderRobots(robots) {
  const dl = el('dl');
  addRow(dl, 'robots.txt URL', robots.robots_url);
  addRow(
    dl,
    'robots.txt の取得',
    robots.reachable ? '成功' : '失敗 (5xx / ネットワークエラー)'
  );
  addRow(
    dl,
    '判定',
    robots.verdict === 'allowed' ? '許可 (allowed)' : '禁止 (disallowed)'
  );
  addRow(dl, 'User-Agent グループ', robots.user_agent_group ?? '—');
  addRow(dl, '一致したルール', robots.matched_rule ?? '—');
  addRow(dl, '確認日時', formatDateTime(robots.checked_at));

  const s = section('robots.txt', [dl]);
  if (!robots.reachable) {
    s.appendChild(
      el('p', {
        class: 'error',
        text:
          'robots.txt を取得できませんでした。RFC 9309 では取得不能は禁止扱いになるため、' +
          'この状態が続くと監視は停止します (連続3回で停止)。',
      })
    );
  } else if (robots.verdict === 'disallowed') {
    s.appendChild(
      el('p', {
        class: 'error',
        text:
          'このURLは robots.txt で禁止されています。監視を登録しても実行時に停止します。' +
          '続けるには Site の robots Override (mode=ignore) が必要です。',
      })
    );
  }
  return s;
}

function renderFetch(fetchResult) {
  const dl = el('dl');
  addRow(dl, 'Fetcher', fetchResult.fetcher_id ?? DEFAULT_FETCHER_LABEL);
  if (fetchResult.ok) {
    addRow(dl, 'HTTPステータス', String(fetchResult.status));
    addRow(dl, '最終URL', fetchResult.final_url ?? '—');
    addRow(dl, 'Content-Type', fetchResult.content_type ?? '—');
    addRow(dl, '所要時間', fetchResult.duration_ms === null ? '—' : `${fetchResult.duration_ms} ms`);
  } else {
    addRow(dl, '結果', '取得失敗');
    addRow(dl, '失敗分類', fetchResult.failure_class ?? '—');
    addRow(dl, 'HTTPステータス', fetchResult.status === null ? '—' : String(fetchResult.status));
    addRow(dl, 'エラー', fetchResult.error_message ?? '—');
  }
  return section('ページ取得', [dl]);
}

function renderTitle(result) {
  const children = [];
  if (result.title !== null) {
    children.push(el('p', { class: 'dry-run-title', text: result.title }));
  } else {
    children.push(el('p', { class: 'empty', text: 'タイトルを取得できませんでした。' }));
    if (result.title_skip_reason) {
      children.push(el('p', { class: 'error', text: `理由: ${result.title_skip_reason}` }));
    }
  }
  return section('タイトル', children);
}

async function dryRunView(container) {
  clear(container);
  container.appendChild(el('h2', { text: 'Dry Run' }));
  container.appendChild(
    el('p', {
      text:
        'URLを1本だけ試し撃ちして、robots.txt の判定とページの <title> を確認します。' +
        'DBには何も保存されません。Fetcher を選ぶと、Site の Fetcher Policy を使わずそのFetcher単体で取得します (robots.txt の確認は常に Worker から行います)。robots.txt が禁止でもタイトルの取得は続行し、判定は結果に表示します。',
    })
  );

  const urlInput = el('input', {
    attrs: { type: 'url', required: true, placeholder: 'https://example.com/page' },
  });
  const fetcherSelect = el('select');
  fetcherSelect.appendChild(el('option', { attrs: { value: '' }, text: DEFAULT_FETCHER_LABEL }));
  api
    .get('/fetchers')
    .then((res) => {
      for (const f of res.items) {
        fetcherSelect.appendChild(el('option', { attrs: { value: f.id }, text: f.id }));
      }
    })
    .catch(() => {
      // 一覧が取れなくても既定の取得は使える
    });
  const submitButton = el('button', { attrs: { type: 'submit' }, text: '実行' });
  const formError = el('p', { class: 'error hidden' });
  const resultEl = el('div');

  const form = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        formError.classList.add('hidden');
        const url = urlInput.value.trim();
        if (!url) {
          formError.textContent = 'URLを入力してください。';
          formError.classList.remove('hidden');
          return;
        }

        const fetcherId = fetcherSelect.value;
        submitButton.disabled = true;
        fetcherSelect.disabled = true;
        renderLoading(resultEl);
        if (fetcherId === 'home-http') {
          resultEl.appendChild(
            el('p', {
              text: `${fetcherId} で取得中です。Runner の応答待ちで最大50秒ほどかかります。このままお待ちください。`,
            })
          );
        }
        try {
          const payload = fetcherId ? { url, fetcher_id: fetcherId } : { url };
          const result = await api.post('/dry-run', payload);
          clear(resultEl);
          resultEl.appendChild(renderRobots(result.robots));
          resultEl.appendChild(renderFetch(result.fetch));
          resultEl.appendChild(renderTitle(result));
        } catch (err) {
          clear(resultEl);
          renderError(resultEl, err);
        } finally {
          submitButton.disabled = false;
          fetcherSelect.disabled = false;
        }
      },
    },
  });
  form.appendChild(field('URL', urlInput));
  form.appendChild(field('Fetcher', fetcherSelect));
  form.appendChild(submitButton);
  form.appendChild(formError);

  container.appendChild(section('対象URL', [form]));
  container.appendChild(resultEl);
}

registerRoute('/dry-run', dryRunView);
