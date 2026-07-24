/**
 * ============================================================================
 *  VENDOR DASHBOARD LOGIC
 *  - Polls the Apps Script API every APP_CONFIG.POLL_INTERVAL_MS
 *  - Renders/updates order cards without a full page reload
 *  - Supports search, status filter, sorting
 *  - Sends status updates back to the API with duplicate-click protection
 * ============================================================================
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------
  const state = {
    orders: [],           // full unfiltered list from the last successful fetch
    filterStatus: 'All',
    searchTerm: '',
    sortBy: 'newest',
    isFetching: false,
    pendingUpdates: new Set() // queueIds currently mid-update (button lock)
  };

  // ---------------------------------------------------------------------
  // DOM REFERENCES
  // ---------------------------------------------------------------------
  const el = {
    grid: document.getElementById('orderGrid'),
    emptyState: document.getElementById('emptyState'),
    template: document.getElementById('orderCardTemplate'),
    searchInput: document.getElementById('searchInput'),
    filterStatus: document.getElementById('filterStatus'),
    sortBy: document.getElementById('sortBy'),
    refreshBtn: document.getElementById('refreshBtn'),
    statTotalValue: document.getElementById('statTotalValue'),
    statCurrentValue: document.getElementById('statCurrentValue'),
    connectionDot: document.getElementById('connectionDot'),
    connectionText: document.getElementById('connectionText')
  };

  // Tracks rendered card elements by queueId so we can patch instead of
  // rebuilding the whole grid every poll (performance requirement).
  const renderedCards = new Map();

  // Thai labels shown on the status badge. The underlying order.status
  // value (Pending/Cooking/Ready/Completed) must stay in English -
  // it's sent to the API, matched against CSS classes, and read by
  // the ESP32, so only the DISPLAYED text is translated here.
  const STATUS_LABELS_TH = {
    Pending: 'รอดำเนินการ',
    Cooking: 'กำลังปรุง',
    Ready: 'พร้อมรับ',
    Completed: 'เสร็จสิ้น'
  };

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------
  function init() {
    el.searchInput.addEventListener('input', debounce(onSearchChange, 200));
    el.filterStatus.addEventListener('change', onFilterChange);
    el.sortBy.addEventListener('change', onSortChange);
    el.refreshBtn.addEventListener('click', () => fetchOrders(true));

    fetchOrders(true);
    fetchSystemStats();

    setInterval(() => {
      fetchOrders(false);
      fetchSystemStats();
    }, APP_CONFIG.POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------
  // DATA FETCHING
  // ---------------------------------------------------------------------

  async function fetchOrders(showLoadingState) {
    if (state.isFetching) return; // avoid overlapping requests
    state.isFetching = true;
    if (showLoadingState) setConnectionStatus('connecting');

    try {
      const url = `${APP_CONFIG.API_BASE_URL}?action=orders&limit=${APP_CONFIG.ORDERS_LIMIT}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Unknown API error');

      state.orders = data.orders || [];
      setConnectionStatus('online');
      renderGrid();
    } catch (err) {
      console.error('fetchOrders failed:', err);
      setConnectionStatus('offline');
    } finally {
      state.isFetching = false;
    }
  }

  async function fetchSystemStats() {
    try {
      const url = `${APP_CONFIG.API_BASE_URL}?action=getQueue`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        el.statCurrentValue.textContent = data.currentQueue || '—';
      }
    } catch (err) {
      console.error('fetchSystemStats failed:', err);
    }

    // Total orders is derived from the orders list itself to avoid an
    // extra API call every poll cycle.
    el.statTotalValue.textContent = state.orders.length ? String(state.orders.length) : '0';
  }

  function setConnectionStatus(status) {
    el.connectionDot.classList.remove('online', 'offline');
    if (status === 'online') {
      el.connectionDot.classList.add('online');
      el.connectionText.textContent = 'เชื่อมต่อแล้ว';
    } else if (status === 'offline') {
      el.connectionDot.classList.add('offline');
      el.connectionText.textContent = 'การเชื่อมต่อขาดหาย';
    } else {
      el.connectionText.textContent = 'กำลังเชื่อมต่อ…';
    }
  }

  // ---------------------------------------------------------------------
  // FILTER / SEARCH / SORT
  // ---------------------------------------------------------------------

  function getVisibleOrders() {
    let list = state.orders.slice();

    if (state.filterStatus !== 'All') {
      list = list.filter(o => o.status === state.filterStatus);
    }

    if (state.searchTerm) {
      const term = state.searchTerm.toLowerCase();
      list = list.filter(o =>
        o.studentName.toLowerCase().includes(term) ||
        o.classroom.toLowerCase().includes(term) ||
        o.foodStall.toLowerCase().includes(term)
      );
    }

    switch (state.sortBy) {
      case 'oldest':
        list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        break;
      case 'pickupTime':
        list.sort((a, b) => a.pickupTime.localeCompare(b.pickupTime));
        break;
      case 'queueId':
        list.sort((a, b) => a.queueId.localeCompare(b.queueId));
        break;
      case 'newest':
      default:
        list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        break;
    }

    return list;
  }

  function onSearchChange(e) {
    state.searchTerm = e.target.value.trim();
    renderGrid();
  }

  function onFilterChange(e) {
    state.filterStatus = e.target.value;
    renderGrid();
  }

  function onSortChange(e) {
    state.sortBy = e.target.value;
    renderGrid();
  }

  // ---------------------------------------------------------------------
  // RENDERING (DOM-diff: patch existing cards, add new, remove stale)
  // ---------------------------------------------------------------------

  function renderGrid() {
    const visible = getVisibleOrders();
    const visibleIds = new Set(visible.map(o => o.queueId));

    // Remove cards that are no longer visible (filtered out or gone)
    for (const [queueId, cardEl] of renderedCards.entries()) {
      if (!visibleIds.has(queueId)) {
        cardEl.remove();
        renderedCards.delete(queueId);
      }
    }

    // Add/update cards in the correct sorted order
    visible.forEach((order, index) => {
      let card = renderedCards.get(order.queueId);
      if (!card) {
        card = buildCard(order);
        renderedCards.set(order.queueId, card);
      } else {
        patchCard(card, order);
      }

      // Ensure DOM order matches sorted order
      const currentNode = el.grid.children[index];
      if (currentNode !== card) {
        el.grid.insertBefore(card, currentNode || null);
      }
    });

    el.emptyState.classList.toggle('hidden', visible.length !== 0);
  }

  function buildCard(order) {
    const fragment = el.template.content.cloneNode(true);
    const card = fragment.querySelector('.order-card');

    card.dataset.queueId = order.queueId;

    card.querySelectorAll('.btn-status').forEach(btn => {
      btn.addEventListener('click', () => onStatusButtonClick(order.queueId, btn.dataset.status, btn));
    });

    patchCard(card, order);
    el.grid.appendChild(card);
    return card;
  }

  /**
   * Updates only the text/attributes that changed, rather than
   * re-rendering the whole card - keeps the DOM diff minimal.
   */
  function patchCard(card, order) {
    setTextIfChanged(card.querySelector('.queue-number'), order.queueId);
    setTextIfChanged(card.querySelector('.student-name'), order.studentName);
    setTextIfChanged(card.querySelector('.classroom'), order.classroom);
    setTextIfChanged(card.querySelector('.food-stall'), order.foodStall);
    setTextIfChanged(card.querySelector('.food-description'), order.foodDescription);
    setTextIfChanged(card.querySelector('.quantity'), `จำนวน: ${order.quantity}`);
    setTextIfChanged(card.querySelector('.pickup-time'), `รับที่: ${order.pickupTime}`);

    const noteField = card.querySelector('.note-field');
    if (order.note) {
      noteField.classList.remove('hidden');
      setTextIfChanged(noteField.querySelector('.note'), order.note);
    } else {
      noteField.classList.add('hidden');
    }

    const badge = card.querySelector('.status-badge');
    setTextIfChanged(badge, STATUS_LABELS_TH[order.status] || order.status);
    badge.className = 'status-badge status-' + order.status.toLowerCase();

    card.dataset.status = order.status;

    // Reflect pending-update lock on buttons
    const locked = state.pendingUpdates.has(order.queueId);
    card.querySelectorAll('.btn-status').forEach(btn => {
      btn.disabled = locked;
    });
  }

  function setTextIfChanged(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  // ---------------------------------------------------------------------
  // STATUS UPDATES (write action, protected against duplicate clicks)
  // ---------------------------------------------------------------------

  async function onStatusButtonClick(queueId, newStatus, buttonEl) {
    if (state.pendingUpdates.has(queueId)) return; // already mid-update

    state.pendingUpdates.add(queueId);
    const card = renderedCards.get(queueId);
    if (card) card.querySelectorAll('.btn-status').forEach(b => (b.disabled = true));

    try {
      const res = await fetch(APP_CONFIG.API_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
        body: JSON.stringify({
          action: 'updateStatus',
          apiKey: APP_CONFIG.API_KEY,
          queueId: queueId,
          status: newStatus
        })
      });
      const data = await res.json();

      if (!data.success) {
        console.error('updateStatus failed:', data.error);
        alert('ไม่สามารถอัปเดตออเดอร์ได้: ' + data.error);
        return;
      }

      // Optimistically patch local state so the UI feels instant,
      // then let the next poll reconcile with the sheet.
      const localOrder = state.orders.find(o => o.queueId === queueId);
      if (localOrder) localOrder.status = newStatus;
      renderGrid();
    } catch (err) {
      console.error('Network error updating status:', err);
      alert('เกิดข้อผิดพลาดเครือข่าย กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง');
    } finally {
      state.pendingUpdates.delete(queueId);
      if (card) card.querySelectorAll('.btn-status').forEach(b => (b.disabled = false));
    }
  }

  // ---------------------------------------------------------------------
  // UTILITIES
  // ---------------------------------------------------------------------

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  document.addEventListener('DOMContentLoaded', init);
})();
