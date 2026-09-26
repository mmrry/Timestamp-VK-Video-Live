// ==UserScript==
// @name         VK Video Live — точное время VOD и Моментов
// @namespace    vkvideo-vod-exact-time
// @version      1.2.0
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

    // Сколько запросов к API выполнять одновременно
    const MAX_CONCURRENT = 3;
    // Пауза всей очереди после ответа 429 (мс)
    const RATE_LIMIT_PAUSE_MS = 5000;
    // Таймаут одного запроса (мс)
    const REQUEST_TIMEOUT_MS = 10000;
    // ===============================================

    const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
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
    // Рекурсивно обходим JSON и собираем:
    //  - записи VOD: id (UUID) + startTime/createdAt
    //  - клипы (Моменты): id (UUID) + createdAt, без startTime
    function harvest(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(harvest); return; }

        if (typeof obj.id === 'string' && UUID_RE.test(obj.id) &&
            (typeof obj.startTime === 'number' || typeof obj.createdAt === 'number')) {
            timesById.set(obj.id.toLowerCase(), {
                startTime: obj.startTime,
                createdAt: obj.createdAt,
                kind: (typeof obj.startTime === 'number') ? 'record' : 'clip'
            });
            scheduleDecorate();
        }
        for (const k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) harvest(obj[k]);
        }
    }

    // ---------- Запросы к API с очередью ----------
    // requestedIds: ключи, которые уже в очереди, в работе или успешно получены.
    // При временной ошибке ключ удаляется, и следующий проход декоратора
    // поставит элемент в очередь заново.
    const requestedIds = new Set();
    const queue = [];
    let active = 0;
    let pausedUntil = 0;
    let pumpTimer = null;

    function pump() {
        while (active < MAX_CONCURRENT && queue.length) {
            const wait = pausedUntil - Date.now();
            if (wait > 0) {
                if (!pumpTimer) {
                    pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
                }
                return;
            }
            const job = queue.shift();
            active++;
            runJob(job);
        }
    }

    function runJob(job) {
        let finished = false;
        const done = (retry) => {
            if (finished) return;
            finished = true;
            if (retry) requestedIds.delete(job.key);
            active--;
            pump();
        };

        GM_xmlhttpRequest({
            method: 'GET',
            url: job.url,
            timeout: REQUEST_TIMEOUT_MS,
            onload: (r) => {
                if (r.status === 429) {
                    pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
                    done(true);
                    return;
                }
                if (r.status >= 500) { done(true); return; }   // временная ошибка — повторим
                if (r.status !== 200) { done(false); return; } // 404/403 — не долбим повторно
                try { harvest(JSON.parse(r.responseText)); } catch (e) { /* ignore */ }
                done(false);
            },
            onerror: () => done(true),
            ontimeout: () => done(true),
            onabort: () => done(true)
        });
    }

    function fetchItem(blog, kind, itemId) {
        const key = kind + '/' + blog + '/' + itemId;
        if (requestedIds.has(key)) return;
        requestedIds.add(key);
        const url = (kind === 'clip')
            ? 'https://api.live.vkvideo.ru/v1/channel/' + encodeURIComponent(blog) + '/clip/' + itemId
            : 'https://api.live.vkvideo.ru/v1/blog/' + encodeURIComponent(blog) +
              '/public_video_stream/record/' + itemId;
        queue.push({ key, url });
        pump();
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
    // Карточка записи: a[href="/<blog>/record/<uuid>"]
    // Карточка момента: a[href="/<blog>/clip/<uuid>"]
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
                fetchItem(blog, kind, uuid);
                return;
            }

            const text = fmt(ts);
            const tip = getTooltip(info);

            // 1) Основной путь: заменяем текст элемента с относительной датой
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

            // 2) Fallback: бейдж поверх превью
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

        // 1) Пробуем заменить относительную дату
        if (REPLACE_RELATIVE_DATE) {
            // 1а) По классу, вне карточек списка
            const passedAll = document.querySelectorAll(
                '[class*="VideoInfo_passed"], [class*="VideoClipCard_passed"], [class*="_passed_"]'
            );
            for (const passed of passedAll) {
                if (passed.closest('a[href*="/record/"], a[href*="/clip/"]')) continue;
                if (passed.textContent !== text) {
                    passed.textContent = text;
                    passed.title = tip;
                }
                return;
            }
            // 1б) Эвристика по тексту
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

        // SPA-навигация (pushState/replaceState/back)
        const origPush = history.pushState;
        history.pushState = function (...a) { const r = origPush.apply(this, a); scheduleDecorate(); return r; };
        const origReplace = history.replaceState;
        history.replaceState = function (...a) { const r = origReplace.apply(this, a); scheduleDecorate(); return r; };
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
