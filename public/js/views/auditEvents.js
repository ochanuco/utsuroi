/**
 * #/audit-events : Audit events一覧 (ADR-0009 監査ログ参照)
 */
import { api } from '../api.js';
import { registerRoute } from '../router.js';
import { el, clear, section, formatDateTime, renderLoading, renderError } from '../util.js';

async function auditEventsView(container) {
  clear(container);
  container.appendChild(el('h2', { text: 'Audit Events' }));

  const s = section('監査ログ', []);
  container.appendChild(s);
  renderLoading(s);

  try {
    const data = await api.get('/audit-events?limit=200');
    clear(s);
    s.appendChild(el('h3', { text: '監査ログ' }));

    if (data.items.length === 0) {
      s.appendChild(el('p', { class: 'empty', text: '監査ログはまだありません。' }));
      return;
    }

    const table = el('table');
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '日時' }),
          el('th', { text: 'actor' }),
          el('th', { text: 'action' }),
          el('th', { text: 'subject' }),
          el('th', { text: '理由' }),
        ]),
      ])
    );
    const tbody = el('tbody');
    for (const event of data.items) {
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: formatDateTime(event.created_at) }),
          el('td', { text: event.actor }),
          el('td', { text: event.action }),
          el('td', { text: event.subject ?? '—' }),
          el('td', { text: event.reason ?? '—' }),
        ])
      );
    }
    table.appendChild(tbody);
    s.appendChild(table);
  } catch (err) {
    clear(s);
    renderError(s, err);
  }
}

registerRoute('/audit-events', auditEventsView);
