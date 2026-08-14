/**
 * #/dry-run : URL を1本試し撃ちして robots.txt 判定と <title> を確認する (ADR-0018)。
 *
 * Site/Source を作る前の下見用。DBには何も残らない。
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, field, formatDateTime, renderLoading, renderError } from '../util.js';

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
        'DBには何も保存されません。robots.txt が禁止でもタイトルの取得は続行し、判定は結果に表示します。',
    })
  );

  const urlInput = el('input', {
    attrs: { type: 'url', required: true, placeholder: 'https://example.com/page' },
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

        submitButton.disabled = true;
        clear(resultEl);
        renderLoading(resultEl);
        try {
          const result = await api.post('/dry-run', { url });
          clear(resultEl);
          resultEl.appendChild(renderRobots(result.robots));
          resultEl.appendChild(renderFetch(result.fetch));
          resultEl.appendChild(renderTitle(result));
        } catch (err) {
          clear(resultEl);
          renderError(resultEl, err);
        } finally {
          submitButton.disabled = false;
        }
      },
    },
  });
  form.appendChild(field('URL', urlInput));
  form.appendChild(submitButton);
  form.appendChild(formError);

  container.appendChild(section('対象URL', [form]));
  container.appendChild(resultEl);
}

registerRoute('/dry-run', dryRunView);
