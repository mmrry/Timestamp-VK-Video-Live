// ==UserScript==
// @name         VK Video Live — точное время VOD и Моментов
// @namespace    vkvideo-vod-exact-time
// @version      1.2.0
// @description  Показывает точную дату и время (ДД.ММ.ГГГГ ЧЧ:ММ:СС) начала стрима для VOD и создания Моментов (клипов) на live.vkvideo.ru
// @author       Aaa
// @match        https://live.vkvideo.ru/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.live.vkvideo.ru
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ================== НАСТРОЙКИ ==================
    // Какое поле использовать как "время начала":
    //   'startTime' — фактическое начало стрима (рекомендуется)
    //   'createdAt' — время создания записи VOD
    const TIME_FIELD = 'startTime';

    // Пытаться ли на странице записи заменить относительную дату
    // ("вчера", "2 дня назад" и т.п.) на точное время.
    // Если false — точное время просто добавляется отдельной строкой.
    const REPLACE_RELATIVE_DATE = true;
    // ===============================================

    // Окно страницы (а не песочницы Tampermonkey) — иначе перехват fetch/XHR не видит запросы сайта
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    // Firefox: функции из песочницы нужно явно пробрасывать в контекст страницы
    const expose = (fn) => (typeof exportFunction === 'function') ? exportFunction(fn, W) : fn;

    const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const ITEM_PATH_RE = /^\/([^\/]+)\/(record|clip)\/([0-9a-f-]{36})/i;
    const PASSED_SEL = '[class*="VideoInfo_passed"], [class*="VideoClipCard_passed"], [class*="_passed_"]';
    const CARD_LINK_SEL = 'a[href*="/record/"], a[href*="/clip/"]';

    // id -> { startTime, createdAt, kind }
    const timesById = new Map();
    let decorateScheduled = false;

    // ---------- Форматирование ----------
    function pad(n) { return String(n).padStart(2, '0'); }

    function fmt(unixTs) {
        const d = new Date(unixTs * 1000);
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function getTs(info) {
        if (!info) return null;
        if (info.kind === 'clip') return info.createdAt || null; // Момент: время создания
        return info[TIME_FIELD] || info.startTime || info.createdAt || null;
    }

    function getTooltip(info) {
        return (info && info.kind === 'clip')
            ? 'Точное время создания момента'
            : 'Точное время начала стрима';
    }

    // ---------- Сбор данных из JSON-ответов API ----------
    // Рекурсивно обходим любой JSON и собираем:
    //  - записи VOD: id (UUID) + startTime/createdAt
    //  - клипы (Моменты): id (UUID) + createdAt, без startTime
    // Данные сливаются: короткая форма объекта не затирает уже известный startTime.
    function harvest(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(harvest); return; }

        if (typeof obj.id === 'string' && UUID_RE.test(obj.id) &&
            (typeof obj.startTime === 'number' || typeof obj.createdAt === 'number')) {
            const id = obj.id.toLowerCase();
            const prev = timesById.get(id) || {};
            const startTime = (typeof obj.startTime === 'number') ? obj.startTime : prev.startTime;
            const createdAt = (typeof obj.createdAt === 'number') ? obj.createdAt : prev.createdAt;
            const kind = (typeof startTime === 'number') ? 'record' : 'clip';
            if (prev.startTime !== startTime || prev.createdAt !== createdAt || prev.kind !== kind) {
                timesById.set(id, { startTime, createdAt, kind });
                scheduleDecorate();
            }
        }
        for (const k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) harvest(obj[k]);
        }
    }

    // ---------- Перехват fetch (в контексте страницы) ----------
    try {
        const origFetch = W.fetch;
        W.fetch = expose(function (...args) {
            const p = origFetch.apply(this, args);
            try {
                const a0 = args[0];
                const url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0 || '');
                if (url.includes('api.live.vkvideo.ru')) {
                    p.then(resp => {
                        resp.clone().json().then(harvest).catch(() => {});
                    }).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            return p;
        });
    } catch (e) { /* остаётся fallback через fetchItem */ }

    // ---------- Перехват XMLHttpRequest (в контексте страницы) ----------
    try {
        const XHRProto = W.XMLHttpRequest.prototype;
        const origOpen = XHRProto.open;
        const origSend = XHRProto.send;
        XHRProto.open = expose(function (method, url, ...rest) {
            this.__vkvod_url = String(url);
            return origOpen.call(this, method, url, ...rest);
        });
        XHRProto.send = expose(function (...args) {
            if (this.__vkvod_url && this.__vkvod_url.includes('api.live.vkvideo.ru')) {
                this.addEventListener('load', () => {
                    try { harvest(JSON.parse(this.responseText)); } catch (e) { /* not JSON */ }
                });
            }
            return origSend.apply(this, args);
        });
    } catch (e) { /* ignore */ }

    // ---------- Прямой запрос к API (fallback, если данные пришли через SSR) ----------
    const requestedIds = new Set();
    function fetchItem(blog, kind, itemId) {
        const key = kind + '/' + blog + '/' + itemId;
        if (requestedIds.has(key)) return;
        requestedIds.add(key);
        const apiUrl = (kind === 'clip')
            ? 'https://api.live.vkvideo.ru/v1/channel/' + encodeURIComponent(blog) + '/clip/' + itemId
            : 'https://api.live.vkvideo.ru/v1/blog/' + encodeURIComponent(blog) +
              '/public_video_stream/record/' + itemId;
        GM_xmlhttpRequest({
            method: 'GET',
            url: apiUrl,
            onload: (r) => {
                try { harvest(JSON.parse(r.responseText)); } catch (e) { /* ignore */ }
            }
        });
    }

    // ---------- Стили ----------
    function injectStyles() {
        if (document.getElementById('vkvod-exact-time-css')) return;
        const st = document.createElement('style');
        st.id = 'vkvod-exact-time-css';
        st.textContent = `
            .vkvod-badge {
                position: absolute;
                left: 6px;
                bottom: 6px;
                z-index: 5;
                padding: 2px 6px;
                border-radius: 4px;
                background: rgba(0, 0, 0, 0.78);
                color: #fff;
                font-size: 11px;
                line-height: 1.3;
                font-family: inherit;
                pointer-events: none;
                white-space: nowrap;
            }
            .vkvod-page-time {
                display: inline-block;
                margin: 6px 0;
                padding: 3px 8px;
                border-radius: 6px;
                background: rgba(125, 125, 125, 0.15);
                font-size: 13px;
                font-weight: 500;
            }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    // ---------- Фильтры: левая панель и «настоящие» карточки ----------
    // Левая панель (каналы, рекомендации, история просмотра).
    // Класс засчитываем только у узкого предка — чтобы обёртка всей страницы
    // с классом вида "Layout_withSidebar" не отключила все карточки.
    const SIDEBAR_CLASS_RE = /sidebar|side_bar|history|leftmenu|navigation/i;
    const SIDEBAR_MAX_WIDTH = 420;

    function isInSidebar(el) {
        if (el.closest('aside, nav')) return true;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const c = (typeof n.className === 'string') ? n.className : '';
            if (c && SIDEBAR_CLASS_RE.test(c) && n.getBoundingClientRect().width < SIDEBAR_MAX_WIDTH) {
                return true;
            }
        }
        return false;
    }

    // Карточка VOD/Момента: RecordCard-атрибут или крупное превью (не аватарка).
    // Кнопки «Показать все», «Записи» и элементы истории сюда не проходят.
    function isPreviewCard(a) {
        if (isInSidebar(a)) return false;
        if (a.dataset.vkvodCard === '1') return true;
        let ok = a.matches('[data-test-id="RecordCard:root"], [data-test-id*="ClipCard"]');
        if (!ok) {
            const media = a.querySelectorAll('img, picture, video, [class*="Preview"], [class*="preview"], [class*="Thumbnail"]');
            for (const m of media) {
                const r = m.getBoundingClientRect();
                if (r.width >= 120 && r.height >= 60) { ok = true; break; } // аватарки ~32–48px не пройдут
            }
        }
        if (ok) a.dataset.vkvodCard = '1'; // кэшируем только положительный результат (превью может догрузиться позже)
        return ok;
    }

    // ---------- Точное время на карточках VOD и Моментов ----------
    // Карточка записи: a[data-test-id="RecordCard:root"][href="/<blog>/record/<uuid>"]
    // Карточка момента: a[href="/<blog>/clip/<uuid>"]
    // Относительная дата: <div class="VideoInfo_passed_XXXXX">7 ч. назад</div>
    // Хэш-суффиксы классов меняются между сборками, поэтому матчим по префиксу.
    function decoratePreviews() {
        // Убираем бейджи, оказавшиеся не на карточках (после SPA-перерисовки)
        document.querySelectorAll('.vkvod-badge').forEach(b => {
            const a = b.closest('a');
            if (!a || !isPreviewCard(a)) b.remove();
        });

        document.querySelectorAll(CARD_LINK_SEL).forEach(a => {
            const href = a.getAttribute('href') || '';
            const hm = href.match(/\/([^\/?#]+)\/(record|clip)\/([0-9a-f-]{36})/i);
            if (!hm) return;
            if (!isPreviewCard(a)) return;

            const blog = hm[1];
            const kind = hm[2].toLowerCase();
            const uuid = hm[3].toLowerCase();

            const info = timesById.get(uuid);
            const ts = getTs(info);
            if (!ts) {
                fetchItem(blog, kind, uuid);
                return;
            }

            const text = fmt(ts);
            const tip = getTooltip(info);

            // 1) Заменяем относительную дату в карточке
            const passed = a.querySelector(PASSED_SEL);
            if (passed) {
                if (passed.textContent !== text) {
                    passed.textContent = text;
                    passed.title = tip;
                }
                return;
            }

            // 2) Fallback-бейдж поверх превью
            let badge = a.querySelector(':scope .vkvod-badge');
            if (badge) {
                if (badge.textContent !== text) badge.textContent = text;
                return;
            }
            if (getComputedStyle(a).position === 'static') a.style.position = 'relative';

            badge = document.createElement('div');
            badge.className = 'vkvod-badge';
            badge.textContent = text;
            badge.title = tip;
            a.appendChild(badge);
        });
    }

    // ---------- Точное время на странице записи / момента ----------
    const RELATIVE_DATE_RE = /^(сегодня|вчера|только что|\d+\s*(секунд|минут|час|дн|недел|месяц|год|лет)[а-яё]*\.?\s*назад|\d{1,2}\s+[а-яё]+(\s+\d{4})?( г\.)?)$/i;

    function decorateItemPage() {
        const pm = location.pathname.match(ITEM_PATH_RE);
        if (!pm) {
            // Ушли со страницы записи — убираем свою строку, если она осталась
            const stale = document.querySelector('.vkvod-page-time');
            if (stale) stale.remove();
            return;
        }
        const blog = pm[1];
        const kind = pm[2].toLowerCase();
        const itemId = pm[3].toLowerCase();

        const info = timesById.get(itemId);
        if (!info) {
            fetchItem(blog, kind, itemId);
            return;
        }
        const ts = getTs(info);
        if (!ts) return;
        const text = fmt(ts);
        const tip = getTooltip(info);
        const label = (kind === 'clip' || info.kind === 'clip') ? 'Создан: ' : 'Начало стрима: ';

        // Элемент не из карточек списка и не из левой панели
        const isForeign = (el) => !!el.closest(CARD_LINK_SEL) || isInSidebar(el);

        if (REPLACE_RELATIVE_DATE) {
            // 1а) По классу
            for (const passed of document.querySelectorAll(PASSED_SEL)) {
                if (isForeign(passed)) continue;
                if (passed.textContent !== text) {
                    passed.textContent = text;
                    passed.title = tip;
                }
                return;
            }
            // 1б) Эвристика по тексту
            for (const el of document.querySelectorAll('span, div, time, p')) {
                if (el.childElementCount !== 0) continue;
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 40) continue;
                if (el.dataset.vkvodDone === '1') {
                    if (el.textContent !== text) el.textContent = text;
                    return;
                }
                if (!RELATIVE_DATE_RE.test(t)) continue;
                if (isForeign(el)) continue;
                el.textContent = text;
                el.title = tip;
                el.dataset.vkvodDone = '1';
                return;
            }
        }

        // 2) Fallback: отдельная строка под заголовком
        const want = label + text;
        const ex = document.querySelector('.vkvod-page-time');
        if (ex) {
            if (ex.textContent !== want) ex.textContent = want;
            return;
        }
        const h1 = document.querySelector('h1');
        if (h1) {
            const el = document.createElement('div');
            el.className = 'vkvod-page-time';
            el.textContent = want;
            el.title = tip;
            h1.insertAdjacentElement('afterend', el);
        }
    }

    // ---------- Планировщик и наблюдение за DOM (SPA) ----------
    function decorateAll() {
        injectStyles();
        decoratePreviews();
        decorateItemPage();
    }

    function scheduleDecorate() {
        if (decorateScheduled) return;
        decorateScheduled = true;
        setTimeout(() => {
            decorateScheduled = false;
            decorateAll();
        }, 200);
    }

    function start() {
        const mo = new MutationObserver(scheduleDecorate);
        mo.observe(document.documentElement, { childList: true, subtree: true });

        // SPA-навигация — патчим history страницы, а не песочницы
        try {
            const H = W.history;
            const origPush = H.pushState;
            const origReplace = H.replaceState;
            H.pushState = expose(function (...a) { const r = origPush.apply(this, a); scheduleDecorate(); return r; });
            H.replaceState = expose(function (...a) { const r = origReplace.apply(this, a); scheduleDecorate(); return r; });
        } catch (e) { /* MutationObserver и интервал всё равно подхватят */ }
        window.addEventListener('popstate', scheduleDecorate);

        // Подстраховка: периодический проход раз в 3 сек
        setInterval(scheduleDecorate, 3000);

        scheduleDecorate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
