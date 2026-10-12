/* ==========================================================
   MAISON | ALEJO v1.2 — script.js
   Funciona con index.html v1.2 y styles.css v1.2.
   Fuente única del catálogo: las tarjetas .product-card del HTML
   (data-product-id, data-name, data-price, data-category, data-new,
   y opcionales data-description, data-available).
   ========================================================== */
(() => {
  'use strict';

  /* ---------- CONFIGURACIÓN ---------- */
  const CONFIG = {
    // Solo dígitos con código de país, p. ej. "573001234567". Vacío = sin canal configurado.
    whatsappNumber: '573106360200',
    whatsappMessage: 'Hola, quiero asesoría sobre MAISON | ALEJO.',
    storageKey: 'maisonalejo:v1',
    schemaVersion: 1,
    maxQty: 99, // límite técnico, no es inventario
    currency: 'COP'
  };
  const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='5'%3E%3Crect width='4' height='5' fill='%23222'/%3E%3C/svg%3E";

  /* ---------- UTILIDADES ---------- */
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollOpts = { behavior: reduceMotion ? 'auto' : 'smooth' };
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const fmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: CONFIG.currency, maximumFractionDigits: 0 });
  const money = (n) => (Number.isFinite(n) ? fmt.format(n) : 'Precio por definir');
  const clampQty = (v) => Math.min(CONFIG.maxQty, Math.max(1, Math.floor(Number(v)) || 1));
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[MAISON | ALEJO] ${name}:`, e); } };

  const state = {
    ready: false,
    catalog: new Map(),      // id -> producto
    cart: [],                // [{ id, size, color, qty }]
    favorites: new Set(),
    filter: { q: '', category: 'todas', sort: 'relevancia', favoritesOnly: false },
    renderedSort: null,      // evita reordenar el DOM si el orden no cambió
    focusBack: { cart: null, detail: null },
    toastTimer: null,
    pendingOrder: null,      // solo en memoria; nunca se guarda
    confirming: false
  };

  /* ---------- PERSISTENCIA (solo carrito y favoritos) ---------- */
  const memoryStore = {};
  const storage = {
    read() { try { return window.localStorage.getItem(CONFIG.storageKey); } catch { return memoryStore.data || null; } },
    write(text) { try { window.localStorage.setItem(CONFIG.storageKey, text); } catch { memoryStore.data = text; } }
  };
  const save = () => storage.write(JSON.stringify({ v: CONFIG.schemaVersion, cart: state.cart, favorites: [...state.favorites] }));

  function loadSaved() {
    try {
      const data = JSON.parse(storage.read() || 'null');
      if (!data || data.v !== CONFIG.schemaVersion) return;
      (Array.isArray(data.cart) ? data.cart : []).forEach((l) => {
        if (l && state.catalog.has(l.id) && typeof l.size === 'string' && typeof l.color === 'string'
          && l.size.length <= 30 && l.color.length <= 30 && Number.isInteger(l.qty) && l.qty >= 1
          && !state.cart.some((x) => lineKey(x) === lineKey(l))) {
          state.cart.push({ id: l.id, size: l.size, color: l.color, qty: clampQty(l.qty) });
        }
      });
      (Array.isArray(data.favorites) ? data.favorites : []).forEach((id) => { if (state.catalog.has(id)) state.favorites.add(id); });
    } catch { console.warn('[MAISON | ALEJO] Datos guardados inválidos; se ignoran.'); }
  }

  /* ---------- IMÁGENES ---------- */
  // Aplica data-src solo cuando ya es una ruta real; si una imagen falla, vuelve al marcador.
  function initImages() {
    $$('img[data-src]').forEach((img) => {
      if (!/^REEMPLAZAR/i.test(img.dataset.src)) img.src = img.dataset.src;
    });
    document.addEventListener('error', (e) => {
      const img = e.target;
      if (img instanceof HTMLImageElement && img.dataset.failed !== '1') { img.dataset.failed = '1'; img.src = PLACEHOLDER; }
    }, true);
  }

  /* ---------- CATÁLOGO (lectura del HTML) ---------- */
  function readCatalog() {
    $$('.product-card[data-product-id]').forEach((card, index) => {
      const id = card.dataset.productId;
      if (!/^[\w-]+$/.test(id) || state.catalog.has(id)) return;
      const price = Number(card.dataset.price);
      const img = card.querySelector('.product-card__image');
      state.catalog.set(id, {
        id, index, card,
        name: card.dataset.name || id,
        price: Number.isFinite(price) && price > 0 ? price : null, // 0 o inválido = por definir
        category: card.dataset.category || '',
        isNew: card.dataset.new === 'true',
        demo: card.dataset.demo === 'true',
        images: img ? [{ src: img.currentSrc || img.src, alt: img.alt }] : [],
        sizes: $$('[data-size]', card).map((b) => b.dataset.size),
        colors: $$('[data-color]', card).map((b) => b.textContent.trim()),
        description: card.dataset.description || '',
        available: card.dataset.available || '' // vacío = desconocido
      });
    });
  }

  /* ---------- BÚSQUEDA, FILTROS Y ORDEN ---------- */
  const sorters = {
    'precio-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.index - b.index,
    'precio-desc': (a, b) => (b.price ?? -1) - (a.price ?? -1) || a.index - b.index,
    novedad: (a, b) => Number(b.isNew) - Number(a.isNew) || a.index - b.index,
    nombre: (a, b) => a.name.localeCompare(b.name, 'es'),
    relevancia: (a, b) => a.index - b.index
  };

  function applyFilters() {
    const grid = $('product-grid');
    if (!grid) return;
    const { q, category, sort, favoritesOnly } = state.filter;
    const query = norm(q);
    let shown = 0, allDemo = true;
    state.catalog.forEach((p) => {
      const ok = (category === 'todas' || p.category === category)
        && (!query || norm(`${p.name} ${p.category}`).includes(query))
        && (!favoritesOnly || state.favorites.has(p.id));
      p.card.hidden = !ok;
      if (ok) { shown += 1; allDemo = allDemo && p.demo; }
    });
    if (state.renderedSort !== sort) { // solo reordena cuando cambia el criterio
      [...state.catalog.values()].sort(sorters[sort] || sorters.relevancia).forEach((p) => grid.appendChild(p.card));
      state.renderedSort = sort;
    }
    grid.hidden = shown === 0;
    const empty = $('catalog-empty');
    if (empty) {
      empty.hidden = shown > 0;
      const title = empty.querySelector('.catalog__empty-title');
      if (title) {
        if (!title.dataset.default) title.dataset.default = title.textContent;
        title.textContent = !query && !favoritesOnly && category !== 'todas'
          ? 'Todavía no hay productos en esta categoría.' : favoritesOnly && !query ? 'Aún no tienes favoritos en esta vista.' : title.dataset.default;
      }
    }
    const count = $('catalog-count');
    if (count) count.textContent = `Mostrando ${shown} ${shown === 1 ? 'producto' : 'productos'}${shown && allDemo ? ' de demostración' : ''}`;
    // Categorías (enlaces de la fila horizontal): el CSS usa aria-current="true"
    $$('[data-filter-category]').forEach((el) => {
      if (el.dataset.filterCategory === category && !favoritesOnly) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    });
    moveIndicator();
    const favBtn = $('btn-favorites');
    if (favBtn) favBtn.setAttribute('aria-pressed', String(favoritesOnly));
  }

  /* Línea indicadora de la categoría activa: una sola barra que se desliza.
     El aspecto (3 px, dorado) vive en el CSS; aquí solo se calcula posición y ancho,
     replicando la barra que cada tarjeta dibuja bajo su nombre. */
  function moveIndicator() {
    const track = document.querySelector('.categories__track');
    if (!track) return;
    const link = track.querySelector('.category-card__link[aria-current="true"]');
    const name = link && link.querySelector('.category-card__name');
    if (!name) { track.style.setProperty('--ind-o', '0'); return; }
    const cs = getComputedStyle(name), t = track.getBoundingClientRect(), n = name.getBoundingClientRect();
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const contentW = n.width - padL - padR;
    const isAll = false; // "Todo" ahora es una tarjeta con foto, igual que las demás
    const w = isAll ? Math.min(contentW, 2 * parseFloat(getComputedStyle(document.documentElement).fontSize)) : contentW; // "Todo" = 2rem centrada
    // El navegador alinea la barra de cada tarjeta al píxel: se hace igual, tomando como origen el borde ya alineado de la fila
    const dpr = window.devicePixelRatio || 1, snap = (v) => Math.round(v * dpr) / dpr;
    const left = n.left + padL + (contentW - w) / 2;
    const x = snap(left) - snap(t.left) + track.scrollLeft; // coordenadas del contenido: sigue el scroll horizontal
    const y = snap(n.bottom - padB - 3) - snap(t.top) + track.scrollTop;
    const wSnap = snap(left + w) - snap(left);
    track.style.setProperty('--ind-x', `${x}px`);
    track.style.setProperty('--ind-y', `${y}px`);
    track.style.setProperty('--ind-w', `${wSnap}px`);
    track.style.setProperty('--ind-o', '1');
    if (!track.classList.contains('is-indicator-ready')) { // la primera posición se fija sin animar
      requestAnimationFrame(() => track.classList.add('is-indicator-ready'));
    }
  }

  function resetFilters() {
    state.filter = { q: '', category: 'todas', sort: 'relevancia', favoritesOnly: false };
    const s = $('catalog-search'), o = $('catalog-sort');
    if (s) s.value = ''; if (o) o.value = 'relevancia';
    applyFilters();
  }

  /* ---------- OPCIONES (talla, color) ---------- */
  function selectOption(btn) {
    const list = btn.closest('.option-group__list');
    if (list) $$('.option-button', list).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  }
  const selected = (root, attr) => {
    const b = root.querySelector(`.option-button[aria-pressed="true"][${attr}]`);
    return b ? (attr === 'data-size' ? b.dataset.size : b.textContent.trim()) : '';
  };

  /* ---------- DETALLE DEL PRODUCTO ---------- */
  function fillOptions(container, values, attr, emptyText) {
    container.replaceChildren();
    if (!values.length) { const p = document.createElement('p'); p.className = 'section-text'; p.textContent = emptyText; container.appendChild(p); return; }
    values.forEach((v) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'option-button'; b.textContent = v;
      b.setAttribute(attr, v); b.setAttribute('aria-pressed', 'false');
      container.appendChild(b);
    });
  }

  function openDetail(id, trigger) {
    const p = state.catalog.get(id), section = $('product-detail');
    if (!p || !section) return;
    state.focusBack.detail = trigger || document.activeElement;
    section.dataset.productId = id;
    $('detail-title').textContent = p.name;
    $('detail-price').textContent = money(p.price);
    $('detail-description').textContent = p.description || 'Descripción pendiente de configurar.';
    const av = $('detail-availability');
    if (av) { av.hidden = !p.available; if (p.available) av.textContent = `Disponibilidad: ${p.available}`; }

    const main = $('detail-main-image'), thumbs = $('detail-thumbs');
    thumbs.replaceChildren();
    if (p.images.length) {
      main.src = p.images[0].src; main.alt = p.images[0].alt || p.name;
      if (p.images.length > 1) { // con una sola imagen no hace falta galería
        p.images.forEach((im, i) => {
          const li = document.createElement('li'), b = document.createElement('button'), t = document.createElement('img');
          b.type = 'button'; b.className = 'icon-button'; b.setAttribute('aria-label', `Ver imagen ${i + 1} de ${p.name}`);
          t.src = im.src; t.alt = ''; t.width = 64; t.height = 80;
          b.appendChild(t);
          b.addEventListener('click', () => { main.src = im.src; main.alt = im.alt || p.name; $$('img', thumbs).forEach((x) => x.classList.toggle('is-active', x === t)); });
          li.appendChild(b); thumbs.appendChild(li);
        });
      }
    }
    fillOptions($('detail-sizes'), p.sizes, 'data-size', 'Este producto no tiene tallas.');
    fillOptions($('detail-colors'), p.colors, 'data-color', 'Este producto no tiene colores.');
    $('detail-quantity').value = 1;
    const guide = $('size-guide'), gbtn = $('detail-size-guide-btn');
    if (guide) guide.hidden = true;
    if (gbtn) gbtn.setAttribute('aria-expanded', 'false');
    section.hidden = false;
    section.scrollIntoView({ ...scrollOpts, block: 'start' });
    $('detail-title').setAttribute('tabindex', '-1');
    $('detail-title').focus({ preventScroll: true });
  }

  function closeDetail() {
    const section = $('product-detail');
    if (!section || section.hidden) return;
    section.hidden = true; section.dataset.productId = '';
    const back = $('catalogo'); if (back) back.scrollIntoView(scrollOpts);
    const f = state.focusBack.detail;
    if (f && document.contains(f)) f.focus({ preventScroll: true });
  }

  /* ---------- FAVORITOS ---------- */
  function renderFavorites() {
    state.catalog.forEach((p) => {
      const on = state.favorites.has(p.id);
      $$('[data-action="toggle-favorite"]', p.card).forEach((b) => {
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', `${on ? 'Quitar' : 'Añadir'} ${p.name} ${on ? 'de' : 'a'} favoritos`);
      });
    });
    const n = state.favorites.size, c = $('favorites-count'), btn = $('btn-favorites');
    if (c) c.textContent = String(n);
    if (btn) btn.setAttribute('aria-label', `Ver favoritos, ${n} ${n === 1 ? 'producto' : 'productos'}`);
  }

  function toggleFavorite(el) {
    const card = el.closest('.product-card'), id = card && card.dataset.productId;
    if (!id || !state.catalog.has(id)) return;
    state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
    save(); renderFavorites();
    if (state.filter.favoritesOnly) applyFilters();
  }

  function showFavorites() {
    state.filter.favoritesOnly = !state.filter.favoritesOnly;
    applyFilters();
    if (!state.filter.favoritesOnly) return;
    if (state.favorites.size === 0) toast('Aún no tienes favoritos. Toca el corazón de una prenda para guardarla.');
    const t = $('catalogo'); if (t) t.scrollIntoView(scrollOpts);
  }

  /* ---------- CARRITO ---------- */
  const lineKey = (l) => `${l.id}|${l.size}|${l.color}`;

  function addToCart(id, size, color, qty, root) {
    const p = state.catalog.get(id);
    if (!p) return;
    const missing = [];
    if (p.sizes.length && !size) missing.push('talla');
    if (p.colors.length && !color) missing.push('color');
    if (missing.length) {
      toast(`Elige ${missing.join(' y ')} antes de añadir "${p.name}" al carrito.`);
      const first = root && root.querySelector('.option-button'); if (first) first.focus();
      return;
    }
    const line = { id, size: size || '', color: color || '', qty: clampQty(qty) };
    const same = state.cart.find((l) => lineKey(l) === lineKey(line));
    if (same) same.qty = clampQty(same.qty + line.qty); else state.cart.push(line);
    save(); renderCart(true);
    toast(`"${p.name}" se añadió al carrito.`);
  }

  function changeQty(key, delta) {
    const line = state.cart.find((l) => lineKey(l) === key);
    if (!line) return;
    line.qty += delta;
    if (line.qty < 1) state.cart = state.cart.filter((l) => l !== line); else line.qty = clampQty(line.qty);
    save(); renderCart(true);
  }

  function cartTotals() {
    let units = 0, subtotal = 0, pending = false;
    state.cart.forEach((l) => {
      const p = state.catalog.get(l.id); if (!p) return;
      units += l.qty;
      if (p.price === null) pending = true; else subtotal += p.price * l.qty; // el precio sale siempre del catálogo
    });
    return { units, subtotal, pending };
  }

  function renderCart(bump = false) {
    const list = $('cart-list'), tpl = $('cart-item-template');
    if (!list || !tpl) return;
    const frag = document.createDocumentFragment();
    state.cart.forEach((l) => {
      const p = state.catalog.get(l.id); if (!p) return;
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.productId = l.id; li.dataset.size = l.size; li.dataset.color = l.color;
      const img = li.querySelector('.cart-item__image');
      if (p.images[0]) { img.src = p.images[0].src; img.alt = p.images[0].alt || p.name; }
      li.querySelector('.cart-item__name').textContent = p.name;
      li.querySelector('.cart-item__size').textContent = l.size ? `Talla ${l.size}` : '';
      li.querySelector('.cart-item__color').textContent = l.color ? `Color ${l.color}` : '';
      li.querySelector('.cart-item__price').textContent = p.price === null ? 'Precio por definir' : money(p.price * l.qty);
      li.querySelector('.cart-item__qty').textContent = String(l.qty);
      frag.appendChild(li);
    });
    list.replaceChildren(frag);
    const { units, subtotal, pending } = cartTotals();
    const empty = $('cart-empty'); if (empty) empty.hidden = units > 0;
    const sub = $('cart-subtotal'); if (sub) sub.textContent = units === 0 ? '—' : pending ? 'Por definir' : money(subtotal);
    const count = $('cart-count');
    if (count) {
      count.textContent = String(units);
      if (bump && !reduceMotion) { count.classList.remove('is-bump'); void count.offsetWidth; count.classList.add('is-bump'); }
    }
    const btn = $('btn-cart');
    if (btn) btn.setAttribute('aria-label', `Abrir carrito, ${units} ${units === 1 ? 'unidad' : 'unidades'}`);
  }

  // Mientras el carrito está abierto, el resto de la página no recibe foco ni teclado.
  const setInert = (on) => ['site-header', 'contenido-principal', 'site-footer'].forEach((id) => { const el = $(id); if (el) el.inert = on; });

  function setCartOpen(open, restoreFocus = true) {
    const panel = $('cart-panel'), overlay = $('overlay'), btn = $('btn-cart');
    if (!panel || !overlay || open === (panel.dataset.open === 'true')) return;
    if (open) {
      state.focusBack.cart = document.activeElement;
      overlay.hidden = false; void overlay.offsetWidth; overlay.classList.add('is-visible');
      panel.dataset.open = 'true'; panel.setAttribute('aria-hidden', 'false');
      document.body.classList.add('cart-open');
      setInert(true);
      panel.focus({ preventScroll: true });
    } else {
      overlay.classList.remove('is-visible');
      panel.dataset.open = 'false'; panel.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('cart-open');
      setInert(false);
      setTimeout(() => { if (panel.dataset.open !== 'true') overlay.hidden = true; }, reduceMotion ? 0 : 160);
      const f = state.focusBack.cart;
      if (restoreFocus && f && document.contains(f)) f.focus({ preventScroll: true });
    }
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  function cartLineAction(el, act) {
    const li = el.closest('.cart-item'); if (!li) return;
    const key = `${li.dataset.productId}|${li.dataset.size}|${li.dataset.color}`;
    const line = state.cart.find((l) => lineKey(l) === key); if (!line) return;
    changeQty(key, act === 'increase-qty' ? 1 : act === 'decrease-qty' ? -1 : -line.qty);
  }

  /* ---------- MENSAJES ---------- */
  function toast(message) {
    const el = $('toast'); if (!el) return;
    clearTimeout(state.toastTimer);
    el.textContent = message; el.hidden = false; void el.offsetWidth; el.classList.add('is-visible');
    const ms = Math.min(8000, 2500 + message.length * 45); // tiempo proporcional al texto
    state.toastTimer = setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => { if (!el.classList.contains('is-visible')) el.hidden = true; }, reduceMotion ? 0 : 160);
    }, ms);
  }

  /* ---------- MENÚ MÓVIL ---------- */
  function setMenu(open) {
    const nav = $('main-nav'), btn = $('btn-menu'); if (!nav || !btn) return;
    nav.dataset.open = String(open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
    const use = btn.querySelector('use'); if (use) use.setAttribute('href', open ? '#icon-close' : '#icon-menu');
  }
  const menuOpen = () => { const n = $('main-nav'); return !!n && n.dataset.open === 'true'; };

  function initActiveLink() { // un solo observador, sin animaciones
    if (!('IntersectionObserver' in window)) return;
    const links = $$('.main-nav__link');
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((a) => {
        const on = a.getAttribute('href') === `#${en.target.id}`;
        a.classList.toggle('is-active', on);
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
    }), { rootMargin: '-45% 0px -50% 0px' });
    links.forEach((a) => { const s = $(a.getAttribute('href').slice(1)); if (s) io.observe(s); });
  }

  /* ---------- ASESORÍA ---------- */
  const whatsappUrl = (text) => (/^\d{8,15}$/.test(CONFIG.whatsappNumber) ? `https://wa.me/${CONFIG.whatsappNumber}?text=${encodeURIComponent(text)}` : null);

  function initAdvisor() {
    const link = $('advisor-whatsapp'); if (!link) return;
    const url = whatsappUrl(CONFIG.whatsappMessage);
    if (url) {
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', 'Hablar con un asesor por WhatsApp (se abre en una pestaña nueva)');
    } else {
      link.addEventListener('click', (e) => { e.preventDefault(); toast('La asesoría por WhatsApp aún no está disponible.'); });
    }
  }

  /* ---------- FORMULARIO DE PEDIDO ---------- */
  const validators = {
    'order-name': (v) => (/^[\p{L}][\p{L}\s.'-]{2,79}$/u.test(v) ? '' : 'Escribe tu nombre completo (mínimo 3 letras).'),
    'order-phone': (v) => (/^\d{7,15}$/.test(v.replace(/[\s()+-]/g, '')) ? '' : 'Escribe un número de contacto válido (7 a 15 dígitos).'),
    'order-address': (v) => (!v || v.length >= 6 ? '' : 'Escribe una dirección completa o deja el campo vacío si no aplica.')
  };

  function setFieldError(id, msg) {
    const input = $(id), err = $(`${id}-error`); if (!input) return;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (err) { if (msg) err.textContent = msg; err.hidden = !msg; }
  }

  function setStatus(msg, kind) {
    const s = $('order-status'); if (!s) return;
    s.textContent = msg; s.classList.remove('is-success', 'is-error');
    if (kind) s.classList.add(`is-${kind}`);
  }

  function clearSummary() { const old = $('order-summary'); if (old) old.remove(); state.pendingOrder = null; state.confirming = false; }

  function buildOrder(values) {
    const { subtotal, pending } = cartTotals();
    const lines = state.cart.map((l) => {
      const p = state.catalog.get(l.id);
      return `${l.qty} × ${p.name}${l.size ? `, talla ${l.size}` : ''}${l.color ? `, color ${l.color}` : ''}`;
    });
    const hasDemo = state.cart.some((l) => (state.catalog.get(l.id) || {}).demo);
    return { ...values, lines, hasDemo, subtotalText: pending ? 'por definir (hay precios sin configurar)' : money(subtotal) };
  }

  function showSummary(order) {
    clearSummary();
    const form = $('order-form'); if (!form) return;
    const box = document.createElement('div');
    box.id = 'order-summary'; box.className = 'benefit-card order-summary';
    const h = document.createElement('h3'); h.className = 'benefit-card__title'; h.textContent = 'Revisa tu pedido';
    const ul = document.createElement('ul');
    order.lines.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    const sub = document.createElement('p'); sub.className = 'benefit-card__text'; sub.textContent = `Subtotal: ${order.subtotalText}`;
    const who = document.createElement('p'); who.className = 'benefit-card__text';
    who.textContent = `Contacto: ${order.name}, ${order.phone}${order.address ? `. Entrega: ${order.address}` : ''}`;
    const row = document.createElement('div'); row.className = 'product-detail__actions';
    [['confirm-order', 'CONFIRMAR RESUMEN', 'button--primary'], ['edit-order', 'EDITAR', 'button--ghost']].forEach(([act, label, cls]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = `button ${cls}`; b.dataset.action = act; b.textContent = label; row.appendChild(b);
    });
    box.append(h, ul, sub, who, row);
    form.insertBefore(box, $('order-status'));
    state.pendingOrder = order;
    box.setAttribute('tabindex', '-1'); box.focus();
  }

  function submitOrder(e) {
    e.preventDefault();
    setStatus('');
    let firstBad = null;
    Object.keys(validators).forEach((id) => {
      const input = $(id); if (!input) return;
      const msg = validators[id](input.value.trim());
      setFieldError(id, msg);
      if (msg && !firstBad) firstBad = input;
    });
    if (firstBad) { firstBad.focus(); setStatus('Revisa los campos marcados.', 'error'); return; }
    if (state.cart.length === 0) { setStatus('Tu carrito está vacío. Añade al menos una prenda para continuar.', 'error'); return; }
    showSummary(buildOrder({ name: $('order-name').value.trim(), phone: $('order-phone').value.trim(), address: $('order-address').value.trim(), notes: $('order-notes').value.trim() }));
  }

  function confirmOrder() {
    const o = state.pendingOrder;
    if (!o || state.confirming) return; // evita envíos duplicados por clics repetidos
    const text = ['Pedido MAISON | ALEJO', ...o.lines, `Subtotal: ${o.subtotalText}`, `Nombre: ${o.name}`, `Contacto: ${o.phone}`,
      o.address ? `Entrega: ${o.address}` : '', o.notes ? `Notas: ${o.notes}` : ''].filter(Boolean).join('\n');
    const url = whatsappUrl(text);
    if (!url) {
      setStatus('El pedido está listo, pero todavía no puede enviarse: aún no hay un canal de recepción configurado. No se guardó ningún dato personal.', 'error');
      return;
    }
    if (o.hasDemo) {
      setStatus('Tu carrito tiene productos de demostración y no se pueden pedir. Quítalos para continuar.', 'error');
      return;
    }
    state.confirming = true;
    window.open(url, '_blank', 'noopener,noreferrer');
    setStatus('Se abrió WhatsApp con el resumen. El pedido solo se envía cuando pulses enviar allí.', 'success');
    clearSummary();
  }

  /* ---------- EVENTOS (un solo manejador de clic y uno de teclado) ---------- */
  const actions = {
    'toggle-menu': () => setMenu(!menuOpen()),
    'reset-filters': resetFilters,
    'view-product': (el) => openDetail(el.dataset.productId, el),
    'close-product': closeDetail,
    'add-to-cart-detail': () => {
      const s = $('product-detail'), id = s && s.dataset.productId;
      if (id) addToCart(id, selected(s, 'data-size'), selected(s, 'data-color'), $('detail-quantity').value, s);
    },
    'open-size-guide': (el) => { const g = $('size-guide'); g.hidden = !g.hidden; el.setAttribute('aria-expanded', String(!g.hidden)); },
    'toggle-favorite': toggleFavorite,
    'open-favorites': showFavorites,
    'add-to-cart': (el) => { const card = el.closest('.product-card'); if (card) addToCart(el.dataset.productId, selected(card, 'data-size'), selected(card, 'data-color'), 1, card); },
    'toggle-cart': () => setCartOpen($('cart-panel').dataset.open !== 'true'),
    'close-cart': () => setCartOpen(false),
    'close-panels': () => setCartOpen(false),
    'increase-qty': (el) => cartLineAction(el, 'increase-qty'),
    'decrease-qty': (el) => cartLineAction(el, 'decrease-qty'),
    'remove-item': (el) => cartLineAction(el, 'remove-item'),
    'confirm-order': confirmOrder,
    'edit-order': () => { clearSummary(); const f = $('order-name'); if (f) f.focus(); }
  };

  function onClick(e) {
    const opt = e.target.closest('.option-button');
    if (opt) selectOption(opt);
    const chip = e.target.closest('[data-filter-category]');
    if (chip) { state.filter.category = chip.dataset.filterCategory; state.filter.favoritesOnly = false; applyFilters(); }
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) safe(el.dataset.action, () => actions[el.dataset.action](el, e));
    const sp = searchPanel();
    if (sp && sp.open && !sp.contains(e.target)) sp.open = false;
    // Menú: se cierra al elegir un enlace o al tocar fuera
    if (menuOpen()) {
      const nav = $('main-nav'), btn = $('btn-menu');
      if (e.target.closest('#main-nav a') || (!nav.contains(e.target) && !btn.contains(e.target))) setMenu(false);
    }
  }

  const searchPanel = () => $('search-panel');

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    const panel = $('cart-panel'), sp = searchPanel();
    if (panel && panel.dataset.open === 'true') setCartOpen(false);
    else if (sp && sp.open) { sp.open = false; const s = sp.querySelector('summary'); if (s) s.focus(); }
    else if (menuOpen()) { setMenu(false); const b = $('btn-menu'); if (b) b.focus(); }
    else closeDetail();
  }

  /* ---------- INICIALIZACIÓN ---------- */
  function init() {
    if (state.ready) return;
    state.ready = true;
    safe('imágenes', initImages);
    safe('catálogo', readCatalog);
    safe('datos guardados', loadSaved);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    const search = $('catalog-search'), sort = $('catalog-sort'), form = $('order-form'), qty = $('detail-quantity');
    if (search) search.addEventListener('input', () => { state.filter.q = search.value; if (search.value.trim()) { state.filter.category = 'todas'; state.filter.favoritesOnly = false; } applyFilters(); });
    const searchForm = $('search-form');
    if (searchForm) searchForm.addEventListener('submit', (e) => { // BUSCAR / Enter: aplica, cierra el panel y lleva al catálogo
      e.preventDefault();
      if (search) { state.filter.q = search.value; if (search.value.trim()) { state.filter.category = 'todas'; state.filter.favoritesOnly = false; } }
      if (sort) state.filter.sort = sort.value;
      applyFilters();
      const panel = searchPanel(); if (panel) panel.open = false;
      const t = $('catalogo'); if (t) t.scrollIntoView(scrollOpts);
    });
    if (sort) sort.addEventListener('change', () => { state.filter.sort = sort.value; applyFilters(); });
    if (qty) qty.addEventListener('change', () => { qty.value = clampQty(qty.value); });
    if (form) {
      form.addEventListener('submit', submitOrder);
      Object.keys(validators).forEach((id) => {
        const input = $(id);
        if (input) input.addEventListener('input', () => { if (input.getAttribute('aria-invalid') === 'true') setFieldError(id, validators[id](input.value.trim())); });
      });
    }
    const sp = searchPanel(), pedido = $('pedido');
    if (sp) sp.addEventListener('toggle', () => { if (sp.open && search) search.focus(); });
    if (pedido) pedido.addEventListener('toggle', () => {
      if (!pedido.open) return;
      setStatus(state.cart.length === 0 ? 'Tu carrito está vacío. Añade una prenda para continuar.' : '', state.cart.length === 0 ? 'error' : '');
    });
    const catTrack = document.querySelector('.categories__track');
    if (catTrack && 'ResizeObserver' in window) new ResizeObserver(() => moveIndicator()).observe(catTrack); // cambios de ancho/alto
    safe('filtros', applyFilters);
    safe('favoritos', renderFavorites);
    safe('carrito', () => renderCart());
    safe('enlace activo', initActiveLink);
    safe('asesoría', initAdvisor);
    const year = $('footer-year'); if (year) year.textContent = String(new Date().getFullYear());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
