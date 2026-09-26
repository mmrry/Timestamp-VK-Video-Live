// ==UserScript==
// @name         VK Video Live — точное время VOD и Моментов
// @namespace    vkvideo-vod-exact-time
// @version      1.1.2
// @description  Показывает точную дату и время (ДД.ММ.ГГГГ ЧЧ:ММ:СС) начала стрима для VOD и создания Моментов (клипов) на live.vkvideo.ru
// @author       Aaa
// @match        https://live.vkvideo.ru/*
// @grant        GM_xmlhttpRequest
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

    const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    // id -> { startTime, createdAt }
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
    //  - клипы (Моменты): id (UUID) + createdAt (+ recordId/videoCreatedAt), без startTime
    function harvest(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(harvest); return; }

        if (typeof obj.id === 'string' && UUID_RE.test(obj.id) &&
            (typeof obj.startTime === 'number' || typeof obj.createdAt === 'number')) {
            const isClip = typeof obj.startTime !== 'number' &&
                (typeof obj.recordId === 'string' || typeof obj.videoCreatedAt === 'number' ||
                 typeof obj.createdAt === 'number');
            timesById.set(obj.id.toLowerCase(), {
                startTime: obj.startTime,
                createdAt: obj.createdAt,
                kind: (typeof obj.startTime === 'number') ? 'record' : (isClip ? 'clip' : 'record')
            });
            scheduleDecorate();
        }
        for (const k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) harvest(obj[k]);
        }
    }

    // ---------- Перехват fetch ----------
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (url.includes('api.live.vkvideo.ru')) {
                p.then(resp => {
                    resp.clone().json().then(harvest).catch(() => {});
                    return resp;
                }).catch(() => {});
            }
        } catch (e) { /* ignore */ }
        return p;
    };

    // ---------- Перехват XMLHttpRequest ----------
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__vkvod_url = url;
        return origOpen.call(this, method, url, ...rest);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
        if (this.__vkvod_url && String(this.__vkvod_url).includes('api.live.vkvideo.ru')) {
            this.addEventListener('load', () => {
                try { harvest(JSON.parse(this.responseText)); } catch (e) { /* not JSON */ }
            });
        }
        return origSend.apply(this, args);
    };

    // ---------- Прямой запрос к API (fallback для страницы записи/клипа) ----------
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
                      if (r.status !== 200) { requestedIds.delete(key); return; }
                      try { harvest(JSON.parse(r.responseText)); } catch (e) { /* ignore */ }
                  },
                  onerror: () => requestedIds.delete(key),
                  ontimeout: () => requestedIds.delete(key),
                  timeout: 10000
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

    // ---------- Точное время на карточках VOD и Моментов ----------
    // Карточка записи: a[data-test-id="RecordCard:root"][href="/<blog>/record/<uuid>"]
    // Карточка момента: a[href="/<blog>/clip/<uuid>"] (та же компонента VideoInfo)
    // Относительная дата лежит в <div class="VideoInfo_passed_XXXXX">7 ч. назад</div>
    // Хэш-суффиксы классов меняются между сборками, поэтому матчим по префиксу.
    function decoratePreviews() {
        document.querySelectorAll('a[href*="/record/"], a[href*="/clip/"]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const hm = href.match(/\/([^\/]+)\/(record|clip)\/([0-9a-f-]{36})/i);
            if (!hm) return;
            const blog = hm[1];
            const kind = hm[2].toLowerCase();
            const uuid = hm[3].toLowerCase();

            const info = timesById.get(uuid);
            const ts = getTs(info);
            if (!ts) {
                // Список пришёл через SSR и API-запроса не было — тянем данные сами.
                fetchItem(blog, kind, uuid);
                return;
            }

            const text = fmt(ts);
            const tip = getTooltip(info);

            // 1) Основной путь: заменяем текст элемента с относительной датой
            // Записи: VideoInfo_passed_XXXXX; Моменты: VideoClipCard_passed_XXXXX
            const passed = a.querySelector(
                '[class*="VideoInfo_passed"], [class*="VideoClipCard_passed"], [class*="_passed_"]'
            );
            if (passed) {
                if (passed.textContent !== text) {
                    passed.textContent = text;
                    passed.title = tip;
                }
                return;
            }

            // 2) Fallback: если разметка изменилась — бейдж поверх превью
            let badge = a.querySelector(':scope .vkvod-badge');
            if (badge) {
                if (badge.textContent !== text) badge.textContent = text;
                return;
            }
            const cs = getComputedStyle(a);
            if (cs.position === 'static') a.style.position = 'relative';

            badge = document.createElement('div');
            badge.className = 'vkvod-badge';
            badge.textContent = text;
            badge.title = tip;
            a.appendChild(badge);
        });
    }

    // ---------- Точное время на странице записи / момента ----------
    const RELATIVE_DATE_RE = /^(сегодня|вчера|только что|\d+\s*(секунд|минут|час|дн|недел|месяц|год|лет)[а-яё]*\s*назад|\d{1,2}\s+[а-яё]+(\s+\d{4})?( г\.)?)$/i;

    function decorateItemPage() {
        const pm = location.pathname.match(/^\/([^\/]+)\/(record|clip)\/([0-9a-f-]{36})/i);
        if (!pm) return;
        const blog = pm[1];
        const kind = pm[2].toLowerCase();
        const itemId = pm[3].toLowerCase();

        let info = timesById.get(itemId);
        if (!info) {
            // Данных ещё нет (SSR / прямой заход) — тянем из API сами
            fetchItem(blog, kind, itemId);
            return;
        }
        const ts = getTs(info);
        if (!ts) return;
        const text = fmt(ts);
        const tip = getTooltip(info);
        const label = (kind === 'clip' || info.kind === 'clip') ? 'Создан: ' : 'Начало стрима: ';

        // 1) Пробуем заменить относительную дату
        if (REPLACE_RELATIVE_DATE) {
            // 1а) По классу (та же компонента, что и на карточках).
            // Важно: берём элемент вне карточек списка, чтобы не задеть превью других видео.
            const passedAll = document.querySelectorAll(
                '[class*="VideoInfo_passed"], [class*="VideoClipCard_passed"], [class*="_passed_"]'
            );
            for (const passed of passedAll) {
                if (passed.closest('a[href*="/record/"], a[href*="/clip/"]')) continue; // это карточка списка
                if (passed.textContent !== text) {
                    passed.textContent = text;
                    passed.title = tip;
                }
                return;
            }
            // 1б) Эвристика по тексту, если класс не нашёлся
            const candidates = document.querySelectorAll('span, div, time, p');
            for (const el of candidates) {
                if (el.childElementCount !== 0) continue;
                if (el.closest('a[href*="/record/"], a[href*="/clip/"]')) continue;
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 40) continue;
                if (el.dataset.vkvodDone === '1') {
                    if (el.textContent !== text) el.textContent = text;
                    return;
                }
                if (RELATIVE_DATE_RE.test(t)) {
                    el.textContent = text;
                    el.title = tip;
                    el.dataset.vkvodDone = '1';
                    return;
                }
            }
        }

        // 2) Fallback: добавляем отдельную строку под заголовком
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

        // SPA-навигация (pushState/replaceState/back)
        const origPush = history.pushState;
        history.pushState = function (...a) { const r = origPush.apply(this, a); scheduleDecorate(); return r; };
        const origReplace = history.replaceState;
        history.replaceState = function (...a) { const r = origReplace.apply(this, a); scheduleDecorate(); return r; };
        window.addEventListener('popstate', scheduleDecorate);

        // Подстраховка: периодический проход (лениво, раз в 3 сек)
        setInterval(scheduleDecorate, 3000);

        scheduleDecorate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
