/**
 * #/sites : Site一覧・作成 (SPEC §13 sites)
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, field, formatDateTime, renderLoading, renderError, navigate, truncationNotice } from '../util.js';

function renderCreateForm(container, onCreated) {
  const nameInput = el('input', { attrs: { type: 'text', required: true, placeholder: '例: 自宅サーバー監視' } });
  const originInput = el('input', { attrs: { type: 'url', placeholder: 'https://example.com' } });
  const errorEl = el('p', { class: 'error hidden' });

  const form = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        const name = nameInput.value.trim();
        if (!name) return;
        const body = { name };
        const origin = originInput.value.trim();
        if (origin) body.canonical_origins = [origin];
        try {
          await api.post('/sites', body);
        } catch (err) {
          errorEl.textContent = `作成に失敗しました: ${err.message}`;
          errorEl.classList.remove('hidden');
          return;
        }
        nameInput.value = '';
        originInput.value = '';
        try {
          await onCreated();
        } catch (err) {
          errorEl.textContent = `一覧の更新に失敗しました（作成自体は成功しています）: ${err.message}`;
          errorEl.classList.remove('hidden');
        }
      },
    },
  });
  form.appendChild(field('名前', nameInput));
  form.appendChild(field('Canonical Origin (任意)', originInput));
  form.appendChild(el('button', { attrs: { type: 'submit' }, text: '作成' }));
  form.appendChild(errorEl);
  container.appendChild(section('新規Site作成', [form]));
}

async function renderList(container) {
  const listSection = section('Site一覧', []);
  container.appendChild(listSection);
  renderLoading(listSection);

  const data = await api.get('/sites?limit=200');
  clear(listSection);
  listSection.appendChild(el('h3', { text: 'Site一覧' }));

  if (data.items.length === 0) {
    listSection.appendChild(el('p', { class: 'empty', text: 'Siteがまだ登録されていません。' }));
    return;
  }

  const table = el('table');
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', { text: '名前' }),
      el('th', { text: 'Primary Origin' }),
      el('th', { text: '作成日時' }),
      el('th', {}),
    ]),
  ]);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const site of data.items) {
    const link = el('a', { attrs: { href: `#/sites/${encodeURIComponent(site.id)}` }, text: site.name });
    const row = el('tr', {}, [
      el('td', {}, [link]),
      el('td', { text: site.primary_origin ?? '—' }),
      el('td', { text: formatDateTime(site.created_at) }),
      el('td', {}, [
        el('button', {
          class: 'button-ghost',
          text: '詳細',
          on: { click: () => navigate(`#/sites/${encodeURIComponent(site.id)}`) },
        }),
      ]),
    ]);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  listSection.appendChild(table);
  const notice = truncationNotice(data);
  if (notice) listSection.appendChild(notice);
}

async function sitesView(container) {
  clear(container);
  container.appendChild(el('h2', { text: 'Sites' }));

  renderCreateForm(container, () => renderList(listContainer));
  const listContainer = el('div');
  container.appendChild(listContainer);

  try {
    await renderList(listContainer);
  } catch (err) {
    renderError(listContainer, err);
  }
}

registerRoute('/sites', sitesView);
