/**
 * #/destinations : Destinations一覧/作成、Subscriptions管理 (SPEC §14)
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, field, fieldRow, formatDateTime, renderLoading, renderError, truncationNotice } from '../util.js';

const KIND_OPTIONS = ['', 'new', 'updated', 'removed'];

async function renderSubscriptionsFor(container, destinationId, sites) {
  renderLoading(container);
  const data = await api.get(`/subscriptions?destination_id=${encodeURIComponent(destinationId)}&limit=200`);
  clear(container);

  if (data.items.length > 0) {
    const table = el('table');
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Site' }),
          el('th', { text: '監視' }),
          el('th', { text: 'Tag' }),
          el('th', { text: 'Kind' }),
          el('th', {}),
        ]),
      ])
    );
    const tbody = el('tbody');
    for (const sub of data.items) {
      const delButton = el('button', {
        class: 'button-danger',
        text: '削除',
        on: {
          click: async () => {
            if (!confirm('この購読を削除しますか?')) return;
            try {
              await api.del(`/subscriptions/${encodeURIComponent(sub.id)}`);
              await renderSubscriptionsFor(container, destinationId, sites);
            } catch (err) {
              alert(`削除に失敗しました: ${err.message}`);
            }
          },
        },
      });
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: sub.site_id ?? '(全Site)' }),
          el('td', { text: sub.monitor_id ?? '(全監視)' }),
          el('td', { text: sub.tag ?? '—' }),
          el('td', { text: sub.kind ?? '(全種別)' }),
          el('td', {}, [delButton]),
        ])
      );
    }
    table.appendChild(tbody);
    container.appendChild(table);
    const notice = truncationNotice(data);
    if (notice) container.appendChild(notice);
  } else {
    container.appendChild(el('p', { class: 'empty', text: '購読はまだありません。' }));
  }

  const siteSelect = el('select', {}, [
    el('option', { attrs: { value: '' }, text: '(全Site)' }),
    ...sites.map((site) => el('option', { attrs: { value: site.id }, text: site.name })),
  ]);
  const monitorIdInput = el('input', { attrs: { type: 'text', placeholder: '(任意) 監視ID (monitor_id)' } });
  const tagInput = el('input', { attrs: { type: 'text', placeholder: '(任意) tag' } });
  const kindSelect = el(
    'select',
    {},
    KIND_OPTIONS.map((k) => el('option', { attrs: { value: k }, text: k === '' ? '(全種別)' : k }))
  );
  const errorEl = el('p', { class: 'error hidden' });

  const form = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        errorEl.classList.add('hidden');
        try {
          await api.post('/subscriptions', {
            destination_id: destinationId,
            site_id: siteSelect.value || null,
            monitor_id: monitorIdInput.value.trim() || null,
            tag: tagInput.value.trim() || null,
            kind: kindSelect.value || null,
          });
        } catch (err) {
          errorEl.textContent = `作成に失敗しました: ${err.message}`;
          errorEl.classList.remove('hidden');
          return;
        }
        monitorIdInput.value = '';
        tagInput.value = '';
        try {
          await renderSubscriptionsFor(container, destinationId, sites);
        } catch (reloadErr) {
          // 作成自体は成功しているため、一覧再取得の失敗は別扱いで表示する
          // (renderSubscriptionsForは失敗時にcontainerをloading表示のまま残すため、
          // ここで明示的にエラー表示へ差し替える)
          clear(container);
          container.appendChild(
            el('p', { class: 'error', text: `一覧の更新に失敗しました（作成自体は成功しています）: ${reloadErr.message}` })
          );
        }
      },
    },
  });
  form.appendChild(fieldRow([field('Site', siteSelect), field('監視ID', monitorIdInput), field('Tag', tagInput), field('Kind', kindSelect)]));
  form.appendChild(el('button', { attrs: { type: 'submit' }, text: '購読を作成' }));
  form.appendChild(errorEl);
  container.appendChild(form);
}

async function renderDestinationsList(container, sites) {
  renderLoading(container);
  const data = await api.get('/destinations?limit=200');
  clear(container);

  if (data.items.length === 0) {
    container.appendChild(el('p', { class: 'empty', text: 'Destinationがまだ登録されていません。' }));
    return;
  }

  for (const destination of data.items) {
    const box = el('div', { class: 'section' });
    const header = el('div', { class: 'section-header' });
    header.appendChild(
      el('div', {}, [
        el('strong', { text: destination.name }),
        el('span', { class: 'muted', text: ` ${destination.webhook_url_masked}` }),
        el('span', { class: 'muted', text: destination.enabled ? ' [有効]' : ' [無効]' }),
      ])
    );
    const deleteButton = el('button', {
      class: 'button-danger',
      text: 'Destinationを削除',
      on: {
        click: async () => {
          if (!confirm(`Destination "${destination.name}" を削除しますか?`)) return;
          try {
            await api.del(`/destinations/${encodeURIComponent(destination.id)}`);
            await renderDestinationsList(container, sites);
          } catch (err) {
            alert(`削除に失敗しました: ${err.message} (配送履歴が残っている場合は削除できません)`);
          }
        },
      },
    });
    header.appendChild(deleteButton);
    box.appendChild(header);
    box.appendChild(el('p', { class: 'muted', text: `作成日時: ${formatDateTime(destination.created_at)}` }));

    const subsContainer = el('div');
    box.appendChild(el('h3', { text: 'Subscriptions' }));
    box.appendChild(subsContainer);
    container.appendChild(box);

    try {
      await renderSubscriptionsFor(subsContainer, destination.id, sites);
    } catch (err) {
      renderError(subsContainer, err);
    }
  }

  const notice = truncationNotice(data);
  if (notice) container.appendChild(notice);
}

async function destinationsView(container) {
  clear(container);
  container.appendChild(el('h2', { text: 'Destinations / Subscriptions' }));

  const nameInput = el('input', { attrs: { type: 'text', required: true, placeholder: '例: メインDiscordチャンネル' } });
  const webhookInput = el('input', { attrs: { type: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/...' } });
  const createError = el('p', { class: 'error hidden' });

  const listContainer = el('div');

  const createForm = el('form', {
    on: {
      submit: async (event) => {
        event.preventDefault();
        createError.classList.add('hidden');
        try {
          await api.post('/destinations', { name: nameInput.value.trim(), webhook_url: webhookInput.value.trim() });
        } catch (err) {
          createError.textContent = `作成に失敗しました: ${err.message}`;
          createError.classList.remove('hidden');
          return;
        }
        nameInput.value = '';
        webhookInput.value = '';
        try {
          await renderDestinationsList(listContainer, sites);
        } catch (err) {
          createError.textContent = `一覧の更新に失敗しました（作成自体は成功しています）: ${err.message}`;
          createError.classList.remove('hidden');
        }
      },
    },
  });
  createForm.appendChild(fieldRow([field('名前', nameInput), field('Discord Webhook URL', webhookInput)]));
  createForm.appendChild(el('button', { attrs: { type: 'submit' }, text: 'Destination作成' }));
  createForm.appendChild(createError);
  container.appendChild(section('新規Destination作成', [createForm]));
  container.appendChild(listContainer);

  let sites = [];
  try {
    const sitesData = await api.get('/sites?limit=200');
    sites = sitesData.items;
  } catch (err) {
    renderError(listContainer, err);
    return;
  }

  async function reload() {
    try {
      await renderDestinationsList(listContainer, sites);
    } catch (err) {
      renderError(listContainer, err);
    }
  }
  await reload();
}

registerRoute('/destinations', destinationsView);
