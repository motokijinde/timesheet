/**
 * 勤務報告アプリ - フロントエンド (PWA)
 *
 * 役割:
 *   - GAS (code.gas) と通信して勤怠データを取得・更新する。
 *   - オフライン耐性のために localStorage にキャッシュとキューを保持する。
 *   - 楽観的 UI で即時反映し、バックグラウンドで GAS と同期する。
 *
 * 主要な状態:
 *   - currentData: { 'YYYY-MM-DD': entry } 形式の勤怠データ。 サーバ取得 + 楽観的更新の集合。
 *   - syncQueue:   未送信 / 失敗中の編集キュー。 owner (作成時のユーザー) を保持する。
 *
 * 詳細な設計は README.md を参照。
 */

// =============================================================================
// 設定 / 定数
// =============================================================================

/** GAS ウェブアプリの公開 URL。 デプロイのたびに変わらない (バージョン更新は同 URL)。 */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbypSu0uWZPSRtAAyctCQE_X7LBPYKv4Bh2Szd7YG4PjAJzPuHevIGpViBkPdPr7hCAfOg/exec';



// --- ネットワーク / リトライ ---
const LOAD_TIMEOUT_MS = 15_000;     // GET タイムアウト (GAS コールドスタート + 祝日 API を考慮)
const SYNC_TIMEOUT_MS = 10_000;     // POST タイムアウト (シート書き込みのみ)
const MAX_RETRY_ATTEMPTS = 5;       // 失敗キューを自動再送する最大回数 (これを超えたら手動)
const RETRY_BASE_DELAY_MS = 2_000;  // 指数バックオフの初期間隔: 2s, 4s, 8s, 16s, 32s

// --- 打刻ルール (業務側で決まっている値) ---
const WORK_START_HOUR = 9;          // これより前に打刻しても 9:00 に丸める
const TIME_ROUND_MINUTES = 10;      // 開始は切り上げ、終了は切り捨てで 10 分単位

/**
 * 休暇種別。 GAS (code.gas) と完全一致させること。
 * 文字列を変えるなら両ファイルを同時に更新する。
 */
const VACATION_TYPES = {
    // 全日扱いの休暇 (E 列にこのいずれかが入っていれば isAbsent=true)
    ABSENT: ['有給休暇', '特別休暇', '病気休暇', '慶弔休暇', 'その他休暇', '欠勤'],
    // 半休扱い (2 種類のみ)
    HALF_MORNING: '午前半休',
    HALF_AFTERNOON: '午後半休',
};

/**
 * localStorage キー。 ログアウト時に Object.values でまとめて削除する。
 * キー追加時はここを更新するだけで cleanup の対象になる。
 */
const STORAGE_KEYS = {
    USER_NAME: 'work_user_name',
    USER_PASS: 'work_user_pass',
    DATA_CACHE: 'cached_work_data',           // サーバ応答 + 楽観的更新の最新スナップショット
    HOLIDAYS_CACHE: 'cached_holidays',        // 祝日マップ ('YYYY-MM-DD' → 名称) の累積キャッシュ
    SYNC_QUEUE: 'work_sync_queue',            // 未送信 / 失敗キュー
    LAST_VIEWED_MONTH: 'work_last_viewed_month', // 最後に閲覧した月 ('YYYY-MM')
};


// =============================================================================
// 状態
// =============================================================================

let currentData = {};                                    // 'YYYY-MM-DD' → entry
let viewDate = new Date();                               // 表示中の月 (月初の 1 日にそろえて保持)
let editingKey = null;                                   // 編集中の日付 (モーダル開いている間)
let currentUser = localStorage.getItem(STORAGE_KEYS.USER_NAME);
let currentPass = localStorage.getItem(STORAGE_KEYS.USER_PASS);
let syncQueue = loadSyncQueueFromStorage_();
let isQueueProcessing = false;                           // processQueue の排他制御
let isOnline = navigator.onLine;


// =============================================================================
// 起動シーケンス
// =============================================================================

window.addEventListener('load', () => {
    // ログイン画面に保存済み認証情報を反映 (UX のため)
    if (currentUser) document.getElementById('userNameInput').value = currentUser;
    if (currentPass) document.getElementById('passwordInput').value = currentPass;

    // 両方そろっていれば自動ログイン
    if (currentUser && currentPass) showApp();
});


// =============================================================================
// 認証 (ログイン / ログアウト)
// =============================================================================

function login() {
    const name = document.getElementById('userNameInput').value.trim();
    const pass = document.getElementById('passwordInput').value.trim();
    if (!name || !pass) {
        alert('ユーザー名とパスワードを入力してください');
        return;
    }
    currentUser = name;
    currentPass = pass;
    localStorage.setItem(STORAGE_KEYS.USER_NAME, name);
    localStorage.setItem(STORAGE_KEYS.USER_PASS, pass);
    showApp();
}

/**
 * ログアウト: 認証情報だけでなくキャッシュ・キューも一括で消す。
 * 共用デバイスで別ユーザーがログインしたときに、前ユーザーのデータが
 * 一瞬でも見えたり、未送信編集が誤送信される事故を防ぐため。
 */
function logout(confirmLogout = true) {
    if (confirmLogout && !confirm('ログアウトしますか？')) return;
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
    location.reload();
}

function showApp() {
    document.getElementById('loginArea').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    document.getElementById('displayUserName').textContent = currentUser;

    // 最後に閲覧した月を復元 (なければ今月)
    const savedMonth = localStorage.getItem(STORAGE_KEYS.LAST_VIEWED_MONTH);
    if (savedMonth && /^\d{4}-\d{2}$/.test(savedMonth)) {
        const [yy, mm] = savedMonth.split('-').map(Number);
        viewDate = new Date(yy, mm - 1, 1);
    } else {
        const now = new Date();
        viewDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    // キャッシュを即時描画して空白の時間をなくす
    currentData = loadFromCacheWithQueueOverlay_();
    initCalendar();

    // 続けて非同期でサーバーから最新を取得
    loadData();
}


// =============================================================================
// データ取得 / キャッシュ
// =============================================================================

/**
 * サーバーから最新データを取得して currentData に反映する。
 * 失敗時はキャッシュにフォールバックし、ユーザー向けにアラート or トーストを出す。
 */
async function loadData() {
    document.getElementById('loader').style.display = 'flex';

    // オフライン: キャッシュ + キュー overlay で表示
    if (!isOnline) {
        currentData = loadFromCacheWithQueueOverlay_();
        initCalendar();
        document.getElementById('loader').style.display = 'none';
        return;
    }

    try {
        const year = viewDate.getFullYear();
        // GAS のキャッシュ + ブラウザの中間キャッシュを避けるための cache-buster
        const cacheBuster = `&t=${Date.now()}`;
        const url = `${GAS_URL}?p=${encodeURIComponent(currentPass)}&u=${encodeURIComponent(currentUser)}&year=${year}${cacheBuster}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

        const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const result = await parseJsonOrThrow_(res);
        if (!result.ok) {
            // forbidden は認証情報を破棄してログイン画面に戻す
            if (result.error === 'forbidden') {
                alert('ログインに失敗しました。\nパスワードが間違っているか、ユーザーが存在しません。');
                localStorage.removeItem(STORAGE_KEYS.USER_PASS);
                location.reload();
                return;
            }
            throw new Error(result.error || 'server-error');
        }

        currentData = result.data || {};
        // 未送信キューの内容を最新サーバ値の上に上書き反映 (ローカル変更を優先)
        applySyncQueueOverlay_(currentData);
        // キャッシュ保存 (祝日は別キャッシュにも累積)
        persistCaches_(currentData);
        initCalendar();
    } catch (err) {
        console.error('loadData failed:', err);
        // ネットワークやサーバ起因で失敗しても、可能な限り画面を出す
        currentData = loadFromCacheWithQueueOverlay_();
        initCalendar();
        if (Object.keys(currentData).length === 0) {
            alert(`データの取得に失敗しました: ${err.message || err}`);
        } else {
            showToast_('オフライン用のキャッシュを表示しています');
        }
    } finally {
        document.getElementById('loader').style.display = 'none';
    }
}

/**
 * data 全体を localStorage に保存する。
 * ついでに祝日マップだけは別キャッシュ (HOLIDAYS_CACHE) に累積マージしておく。
 * これで「年をまたいで月送りしたあとオフラインになる」場合でも、
 * 過去に閲覧した年の祝日が残り続ける。
 */
function persistCaches_(data) {
    localStorage.setItem(STORAGE_KEYS.DATA_CACHE, JSON.stringify(data));

    let holidays;
    try { holidays = JSON.parse(localStorage.getItem(STORAGE_KEYS.HOLIDAYS_CACHE)) || {}; }
    catch { holidays = {}; }

    for (const [date, info] of Object.entries(data)) {
        if (info && info.isHoliday && info.holidayName) holidays[date] = info.holidayName;
    }
    localStorage.setItem(STORAGE_KEYS.HOLIDAYS_CACHE, JSON.stringify(holidays));
}

/**
 * キャッシュから読み出した勤怠 + 累積祝日キャッシュをマージして返す。
 * オフライン時 / サーバ取得失敗時のフォールバック描画に使う。
 */
function readMergedFromCache_() {
    let data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEYS.DATA_CACHE)) || {}; }
    catch { data = {}; }

    let holidays;
    try { holidays = JSON.parse(localStorage.getItem(STORAGE_KEYS.HOLIDAYS_CACHE)) || {}; }
    catch { holidays = {}; }

    for (const [date, name] of Object.entries(holidays)) {
        if (!data[date]) {
            data[date] = makeHolidayOnlyEntry_(name);
        } else {
            data[date].isHoliday = true;
            data[date].holidayName = name;
        }
    }
    return data;
}

/**
 * キュー (送信待ち / 失敗) の内容を data の上にかぶせる。
 * サーバ応答にもキャッシュにも反映されていない、ローカル限定の最新変更を優先するため。
 */
function applySyncQueueOverlay_(data) {
    syncQueue.forEach((q) => {
        if (q.status !== 'pending' && q.status !== 'failed') return;
        // 別ユーザーのキューは無視 (logout cleanup の漏れ対策)
        if (q.user && q.user !== currentUser) return;
        const p = q.payload;
        if (p.isDelete) {
            const old = data[p.date];
            if (old && old.isHoliday) {
                Object.assign(old, {
                    place: '', start: '', end: '', vacationType: '',
                    isAbsent: false, isHalfDay: false, absenceReason: '',
                });
            } else {
                delete data[p.date];
            }
        } else {
            data[p.date] = { ...(data[p.date] || {}), ...p };
        }
    });
    return data;
}

function loadFromCacheWithQueueOverlay_() {
    return applySyncQueueOverlay_(readMergedFromCache_());
}

function makeHolidayOnlyEntry_(name) {
    return {
        place: '', start: '', end: '', vacationType: '',
        isAbsent: false, isHalfDay: false,
        isHoliday: true, holidayName: name, absenceReason: '',
    };
}


// =============================================================================
// 同期キュー (送信 / リトライ)
// =============================================================================

/**
 * 編集 1 回分の payload を受け取り、ローカル反映 → キュー追加 → 非同期送信開始する。
 * payload の例:
 *   - 通常編集: { date, place, start, end, isAbsent, isHalfDay, halfDayType }
 *   - 削除:     { date, isDelete: true }
 */
function syncToGAS(payload) {
    // 1) ローカルデータを楽観的に更新する (UI を即反映)
    if (payload.isDelete) {
        const old = currentData[payload.date];
        if (old && old.isHoliday) {
            // 祝日の日は勤怠情報のみクリアして祝日表示は残す
            currentData[payload.date] = makeHolidayOnlyEntry_(old.holidayName);
        } else {
            delete currentData[payload.date];
        }
    } else {
        const old = currentData[payload.date] || {};
        currentData[payload.date] = {
            ...old,
            ...payload,
            vacationType: deriveVacationType_(payload),
            absenceReason: deriveVacationType_(payload) || old.absenceReason,
        };
    }
    persistCaches_(currentData);

    // 2) 同じ日付の未送信があれば最新で上書き (整合性のため)
    syncQueue = syncQueue.filter((q) => q.date !== payload.date);
    syncQueue.push({
        id: Date.now(),
        user: currentUser,         // 送信時の owner 検証に使う
        date: payload.date,
        payload: payload,
        status: 'pending',
        retryCount: 0,
    });
    saveQueue();

    // 3) 送信処理を開始 (await しない: ユーザー操作はブロックしない)
    processQueue();
}

/** payload から vacationType (E 列に書く文字列) を導出する。 */
function deriveVacationType_(payload) {
    if (payload.isAbsent) return payload.place || '';
    if (payload.isHalfDay) {
        if (payload.halfDayType === 'morning') return VACATION_TYPES.HALF_MORNING;
        if (payload.halfDayType === 'afternoon') return VACATION_TYPES.HALF_AFTERNOON;
    }
    return '';
}

/**
 * キューに溜まった pending な編集を、上から順に GAS に送る。
 * - 直列実行 (Apps Script のスループット観点で並列は避ける)
 * - 失敗時は status='failed' にして、指数バックオフで自動再送をスケジュール
 * - MAX_RETRY_ATTEMPTS を超えたら手動再送のみ受け付ける
 */
async function processQueue() {
    if (isQueueProcessing) return;
    isQueueProcessing = true;
    try {
        let pendings;
        while ((pendings = syncQueue.filter((q) => q.status === 'pending')).length > 0) {
            const item = pendings[0];

            // owner が違う (= ログアウト→別ユーザーログイン後にキューが残っていた等) なら破棄
            if (item.user && item.user !== currentUser) {
                console.warn(`Queue owner mismatch (queued for ${item.user}, current ${currentUser}); discarding.`);
                syncQueue = syncQueue.filter((q) => q.id !== item.id);
                saveQueue();
                continue;
            }

            // オフラインなら次の online イベントに任せる
            if (!isOnline) break;

            try {
                const result = await postToGAS_(item.payload);
                if (!result.ok) throw new Error(result.error || 'server-error');

                // 成功したらキューから外す
                syncQueue = syncQueue.filter((q) => q.id !== item.id);
                saveQueue();
            } catch (err) {
                console.error('Queue send failed:', err);
                const target = syncQueue.find((q) => q.id === item.id);
                if (target) {
                    target.status = 'failed';
                    target.retryCount = (target.retryCount || 0) + 1;
                    target.lastError = err && err.message ? err.message : String(err);
                    if (target.retryCount < MAX_RETRY_ATTEMPTS) {
                        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, target.retryCount - 1);
                        setTimeout(() => promotePendingAndRun_(target.id), delay);
                    }
                }
                saveQueue();
                // この日付は失敗扱い (status='failed' で pending フィルタから除外される)。
                // ループは抜けず次の pending へ進む (別日付を巻き込んで止めない)。
                // 失敗分の再送は上で仕込んだ backoff (promotePendingAndRun_) に任せる。
                continue;
            }
        }
    } finally {
        isQueueProcessing = false;
    }
}

/** 失敗状態のキューを pending に戻して再送を始める (バックオフ後の自動再送 / 手動再送共通)。 */
function promotePendingAndRun_(id) {
    const target = syncQueue.find((q) => q.id === id);
    if (!target || target.status !== 'failed') return;
    target.status = 'pending';
    saveQueue();
    processQueue();
}

/** ⚠️ アイコンタップによる手動再送。 retryCount をリセットして再開する。 */
function retrySync(id) {
    const item = syncQueue.find((q) => q.id === id);
    if (!item) return;
    item.status = 'pending';
    item.retryCount = 0;
    item.lastError = undefined;
    saveQueue();
    processQueue();
}

/**
 * GAS へ POST する低レベル関数。
 * Content-Type を text/plain にしているので CORS preflight (OPTIONS) は発生しない。
 * GAS 側は JSON で { ok, ... } を返す。
 */
async function postToGAS_(payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
        const res = await fetch(GAS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ ...payload, password: currentPass, user: currentUser }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await parseJsonOrThrow_(res);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function parseJsonOrThrow_(res) {
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('invalid-response'); }
}

function loadSyncQueueFromStorage_() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.SYNC_QUEUE)) || []; }
    catch { return []; }
}

function saveQueue() {
    localStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(syncQueue));
    // キュー状態 (⌛/⚠️) を反映するためカレンダーを再描画する。
    // (差分更新にしたいが現状はフル再描画で許容している)
    initCalendar();
}


// =============================================================================
// カレンダー描画
// =============================================================================

/**
 * 月切り替え。 表示月を localStorage に保存して、再ログイン時にも復元できるようにする。
 */
function changeMonth(diff) {
    viewDate.setMonth(viewDate.getMonth() + diff);
    localStorage.setItem(STORAGE_KEYS.LAST_VIEWED_MONTH, isoMonthOf_(viewDate));
    loadData();
}

/** カレンダーグリッドを再構築する。 currentData / syncQueue から表示を組み立てる。 */
function initCalendar() {
    const calEl = document.getElementById('calendar');
    if (!calEl) return; // 防御コード: 想定外で calendar 要素が DOM に無い場合は何もしない

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const todayStr = isoDateOf_(new Date());

    document.getElementById('monthDisplay').textContent = `${year}年 ${month + 1}月`;
    calEl.replaceChildren();

    // 曜日ヘッダー
    ['日', '月', '火', '水', '木', '金', '土'].forEach((label, i) => {
        const h = el_('div', 'day-header', label);
        if (i === 0) h.style.color = '#e57373';
        if (i === 6) h.style.color = '#64b5f6';
        calEl.appendChild(h);
    });

    const firstDow = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    // 1 日の曜日まで空セルで埋める
    for (let i = 0; i < firstDow; i++) calEl.appendChild(document.createElement('div'));

    for (let d = 1; d <= lastDate; d++) {
        const key = `${year}-${pad2_(month + 1)}-${pad2_(d)}`;
        const dow = new Date(year, month, d).getDay();
        const info = currentData[key] || {};
        const isHoliday = !!info.isHoliday;
        const holidayName = info.holidayName || '';

        const div = document.createElement('div');
        div.className = dayClass_(dow, isHoliday);
        if (key === todayStr) div.classList.add('today');

        // 日付番号
        div.appendChild(el_('div', 'day-num', d));

        // 祝日名 (日付の下段)
        if (isHoliday) div.appendChild(el_('div', 'holiday-lbl', holidayName));

        // 同期ステータスアイコン (同じ日付・同じ user のキューだけ拾う)
        const qItem = syncQueue.find((q) =>
            q.date === key && (q.user === currentUser || !q.user)
        );
        if (qItem) {
            if (qItem.status === 'pending') {
                const icon = el_('div', 'sync-icon sync-pending', '⌛');
                icon.title = '送信中';
                icon.setAttribute('aria-label', '送信中');
                div.appendChild(icon);
            } else if (qItem.status === 'failed') {
                const icon = el_('div', 'sync-icon sync-failed', '⚠️');
                icon.title = qItem.lastError ? `送信失敗: ${qItem.lastError}` : '送信失敗 (タップで再送)';
                icon.setAttribute('aria-label', '送信失敗 (タップで再送)');
                icon.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    retrySync(qItem.id);
                });
                div.appendChild(icon);
            }
        }

        // 勤怠 / 休暇エントリ (textContent 経由なので XSS なし)
        if (info.isAbsent) {
            const reason = info.absenceReason || info.place || '休暇';
            div.appendChild(el_('div', 'entry entry-absent', reason));
        } else if (info.isHalfDay) {
            const halfLabel =
                info.vacationType === VACATION_TYPES.HALF_MORNING ? '午前休' :
                info.vacationType === VACATION_TYPES.HALF_AFTERNOON ? '午後休' : '半休';
            div.appendChild(el_('div', 'entry entry-halfday', halfLabel));
            if (info.place) div.appendChild(el_('div', 'entry entry-place', info.place));
            if (info.start) div.appendChild(el_('div', 'entry entry-start', `▶ ${info.start}`));
            if (info.end)   div.appendChild(el_('div', 'entry entry-end',   `■ ${info.end}`));
        } else if (info.place || info.start || info.end) {
            if (info.place) div.appendChild(el_('div', 'entry entry-place', info.place));
            if (info.start) div.appendChild(el_('div', 'entry entry-start', `▶ ${info.start}`));
            if (info.end)   div.appendChild(el_('div', 'entry entry-end',   `■ ${info.end}`));
        }
        // 祝日のみの日 (勤怠なし) は背景色 + 祝日名のみで何も追加しない

        div.addEventListener('click', () => openEdit(key));
        calEl.appendChild(div);
    }
}

/** day セルに付与するクラス名を決定する (背景色の塗り分け)。 */
function dayClass_(dow, isHoliday) {
    if (dow === 6) return 'day sat';                 // 土
    if (dow === 0 || isHoliday) return 'day sun';    // 日 / 祝日
    return 'day';
}


// =============================================================================
// クイック打刻 (出社で開始 / 在宅で開始 / 作業を終了する)
// =============================================================================

/**
 * クイック打刻ボタンの処理。
 * - 開始: 9 時前は 9:00 に丸め、それ以降は 10 分単位で切り上げ
 * - 終了: 10 分単位で切り捨て
 * - 同時に Teams 報告用文字列をクリップボードへコピー
 */
function quickLog(type, place = '') {
    const now = new Date();
    const dateKey = isoDateOf_(now);
    const data = currentData[dateKey] || {
        start: '', end: '', place: '', isAbsent: false, isHalfDay: false,
    };

    // サーバ読み出し由来の entry には halfDayType / 休暇理由が directly に保存されないため、
    // 半休 or 欠勤の状態を維持したまま quickLog で打刻すると、 GAS のバリデーションで弾かれる。
    // ここで vacationType から逆引きして payload を補完しておく。
    //   - 半休: halfDayType を 'morning'/'afternoon' に補完 (無いと halfDayType-required エラー)
    //   - 欠勤: place フィールドに休暇種別を入れる (空のままだと absent-reason-required エラー)
    if (data.isHalfDay && !data.halfDayType) {
        if (data.vacationType === VACATION_TYPES.HALF_MORNING) data.halfDayType = 'morning';
        else if (data.vacationType === VACATION_TYPES.HALF_AFTERNOON) data.halfDayType = 'afternoon';
    }
    if (data.isAbsent && !data.place) {
        data.place = data.vacationType || data.absenceReason || '';
    }

    let h = now.getHours();
    let m = now.getMinutes();
    let timeStr = '';
    let clipText = '';

    if (type === 'start') {
        if (h < WORK_START_HOUR) {
            h = WORK_START_HOUR; m = 0;
        } else if (m > 0) {
            m = Math.ceil(m / TIME_ROUND_MINUTES) * TIME_ROUND_MINUTES;
            if (m === 60) { h += 1; m = 0; }
        }
        timeStr = `${pad2_(h)}:${pad2_(m)}`;

        data.start = timeStr;
        data.end = '';                  // 同日に再開始した場合に古い end を残さない
        data.place = place;
        data.isAbsent = false;
        data.isHalfDay = false;
        data.halfDayType = '';

        // Teams 用: 時刻はゼロ埋めなし (例: 9:00)
        clipText = `作業開始　${place}　${h}:${pad2_(m)}`;
    } else {
        m = Math.floor(m / TIME_ROUND_MINUTES) * TIME_ROUND_MINUTES;
        timeStr = `${pad2_(h)}:${pad2_(m)}`;
        data.end = timeStr;
        clipText = `作業終了　${h}:${pad2_(m)}`;
    }

    navigator.clipboard.writeText(clipText)
        .then(() => showToast_('記録を保存し、Teams用にコピーしました'))
        .catch((err) => console.error('Clipboard copy failed:', err));

    syncToGAS({ ...data, date: dateKey });
}


// =============================================================================
// モーダル (個別日の編集)
// =============================================================================

function openEdit(key) {
    editingKey = key;
    const info = currentData[key] || {
        start: '', end: '', place: '', vacationType: '', isAbsent: false, isHalfDay: false,
    };
    document.getElementById('editDateLabel').textContent = key;

    const placeInput = document.getElementById('editPlace');
    const vacationType = info.vacationType || '';

    if (vacationType === VACATION_TYPES.HALF_MORNING || vacationType === VACATION_TYPES.HALF_AFTERNOON) {
        // 半休
        document.getElementById('editIsHalfDay').checked = true;
        document.getElementById('editIsAbsent').checked = false;
        placeInput.value = info.place || '';
        placeInput.setAttribute('list', 'places');
        document.getElementById('halfDayMorning').checked = vacationType === VACATION_TYPES.HALF_MORNING;
        document.getElementById('halfDayAfternoon').checked = vacationType === VACATION_TYPES.HALF_AFTERNOON;
    } else if (info.isAbsent) {
        // 全日休暇: place 入力を理由として表示
        document.getElementById('editIsAbsent').checked = true;
        document.getElementById('editIsHalfDay').checked = false;
        placeInput.value = vacationType;
        placeInput.setAttribute('list', 'absenceReasons');
    } else {
        // 通常勤務
        document.getElementById('editIsAbsent').checked = false;
        document.getElementById('editIsHalfDay').checked = false;
        placeInput.value = info.place || '';
        placeInput.setAttribute('list', 'places');
    }

    document.getElementById('editStart').value = formatTimeForInput_(info.start);
    document.getElementById('editEnd').value = formatTimeForInput_(info.end);

    toggleAbsent();
    toggleHalfDay();
    document.getElementById('editModal').style.display = 'flex';

    // 初期フォーカスを当てる (キーボード操作のため)
    setTimeout(() => placeInput.focus(), 0);
}

function toggleAbsent() {
    const isAbsent = document.getElementById('editIsAbsent').checked;
    const isHalf = document.getElementById('editIsHalfDay').checked;
    const placeInput = document.getElementById('editPlace');
    const timeBox = document.getElementById('timeInputs');

    timeBox.style.opacity = isAbsent ? '0.3' : '1';
    timeBox.style.pointerEvents = isAbsent ? 'none' : 'auto';

    if (isAbsent) {
        placeInput.setAttribute('list', 'absenceReasons');
        document.getElementById('editStart').value = '';
        document.getElementById('editEnd').value = '';
        placeInput.value = '';
        // 欠勤と半休は両立しないので半休側を外す
        if (isHalf) {
            document.getElementById('editIsHalfDay').checked = false;
            toggleHalfDay();
        }
    } else {
        placeInput.setAttribute('list', 'places');
    }
}

function toggleHalfDay() {
    const isHalf = document.getElementById('editIsHalfDay').checked;
    const isAbsent = document.getElementById('editIsAbsent').checked;
    const halfOpts = document.getElementById('halfDayOptions');

    // 欠勤と半休は両立しないので欠勤側を外す
    if (isHalf && isAbsent) {
        document.getElementById('editIsAbsent').checked = false;
        toggleAbsent();
    }

    if (isHalf) {
        halfOpts.style.display = 'block';
        // どちらも未選択ならデフォルトで午前休
        const morning = document.getElementById('halfDayMorning');
        const afternoon = document.getElementById('halfDayAfternoon');
        if (!morning.checked && !afternoon.checked) morning.checked = true;
    } else {
        halfOpts.style.display = 'none';
        document.getElementById('halfDayMorning').checked = false;
        document.getElementById('halfDayAfternoon').checked = false;
    }

    // 半休のときも時間入力は使えるようにしておく (半休扱いだが時刻も記録できる UX)
    document.getElementById('timeInputs').style.opacity = '1';
    document.getElementById('timeInputs').style.pointerEvents = 'auto';
}

function saveEdit() {
    const isAbsent = document.getElementById('editIsAbsent').checked;
    const isHalfDay = document.getElementById('editIsHalfDay').checked;
    const placeValue = document.getElementById('editPlace').value.trim();

    // バリデーション: 休暇は理由必須 (ユーザー操作が消えるバグの根本対策)
    if (isAbsent && !placeValue) {
        alert('休暇の理由を選択または入力してください。');
        document.getElementById('editPlace').focus();
        return;
    }

    let halfDayType = '';
    if (isHalfDay) {
        if (document.getElementById('halfDayMorning').checked) halfDayType = 'morning';
        else if (document.getElementById('halfDayAfternoon').checked) halfDayType = 'afternoon';
        else {
            alert('半休は午前/午後のどちらかを選択してください。');
            return;
        }
    }

    syncToGAS({
        date: editingKey,
        isAbsent,
        isHalfDay,
        halfDayType,
        place: placeValue,
        start: document.getElementById('editStart').value,
        end: document.getElementById('editEnd').value,
    });
    closeModal();
}

function deleteEntry() {
    if (!confirm('完全に削除しますか？')) return;
    // closeModal() で editingKey が null にリセットされるため、 先に値をキャプチャしておく
    const targetDate = editingKey;
    closeModal();
    if (!targetDate) return;
    syncToGAS({ date: targetDate, isDelete: true });
}

function closeModal() {
    document.getElementById('editModal').style.display = 'none';
    editingKey = null;
}

/** input[type=time] が要求する 'HH:mm' 形式に整える (秒・1 桁の数値も吸収)。 */
function formatTimeForInput_(t) {
    if (!t || typeof t !== 'string') return '';
    const parts = t.split(':');
    if (parts.length < 2) return '';
    return `${pad2_(parts[0])}:${pad2_(parts[1])}`;
}


// =============================================================================
// Excel 用 1 ヶ月分エクスポート
// =============================================================================

function copyForExcel() {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    let txt = '日付\t場所\t開始\t終了\t備考\n';

    for (let d = 1; d <= 31; d++) {
        const date = new Date(y, m, d);
        if (date.getMonth() !== m) break; // 月またぎで終了
        const key = isoDateOf_(date);
        const info = currentData[key] || {};

        // 備考は休暇 → 半休 → 祝日 の優先順で 1 つだけ書く
        let note = '';
        if (info.isAbsent)        note = info.absenceReason || info.vacationType || '休暇';
        else if (info.isHalfDay)  note = info.vacationType || '半休';
        else if (info.isHoliday)  note = info.holidayName || '祝日';

        txt += `${key}\t${info.place || ''}\t${info.start || ''}\t${info.end || ''}\t${note}\n`;
    }

    navigator.clipboard.writeText(txt)
        .then(() => showToast_('1ヶ月分をコピーしました'))
        .catch((err) => alert(`コピーに失敗しました: ${err.message || err}`));
}


// =============================================================================
// 通知 UI (オフライン / オンライン / トースト)
// =============================================================================

function showOfflineIndicator() {
    let el = document.getElementById('offline-indicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'offline-indicator';
        el.className = 'offline-indicator';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.textContent = 'オフライン: データはローカルで保存され、オンライン時に同期されます';
        document.body.appendChild(el);
    }
    el.style.display = 'block';
}

function hideOfflineIndicator() {
    const el = document.getElementById('offline-indicator');
    if (el) el.style.display = 'none';
}

/**
 * オンライン復帰時の一時表示。 1.5s 表示 → 0.5s でフェードアウト。
 * 連続発火時に再アニメ可能なよう、毎回 opacity を一旦 1 に戻してから setTimeout で 0 にする。
 */
function showOnlineIndicator() {
    let el = document.getElementById('online-indicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'online-indicator';
        el.className = 'online-indicator';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.textContent = 'オンライン: データを同期しています';
        document.body.appendChild(el);
    }
    el.style.display = 'block';
    el.style.opacity = '1';
    clearTimeout(showOnlineIndicator._t1);
    clearTimeout(showOnlineIndicator._t2);
    showOnlineIndicator._t1 = setTimeout(() => { el.style.opacity = '0'; }, 1500);
    showOnlineIndicator._t2 = setTimeout(() => { el.style.display = 'none'; }, 2000);
}

/** ヘッダー部分の #msg 領域を使った軽量トースト。 連続呼び出しは最後の text のみ残る。 */
function showToast_(text, ms = 2500) {
    const elMsg = document.getElementById('msg');
    if (!elMsg) return;
    elMsg.textContent = text;
    clearTimeout(showToast_._t);
    showToast_._t = setTimeout(() => { elMsg.textContent = ''; }, ms);
}


// =============================================================================
// 汎用ユーティリティ
// =============================================================================

function pad2_(n) {
    return String(n).padStart(2, '0');
}

function isoDateOf_(date) {
    return `${date.getFullYear()}-${pad2_(date.getMonth() + 1)}-${pad2_(date.getDate())}`;
}

function isoMonthOf_(date) {
    return `${date.getFullYear()}-${pad2_(date.getMonth() + 1)}`;
}

/** className とテキストを一発で当てる createElement のラッパ (XSS 対策で textContent を使う)。 */
function el_(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = String(text);
    return e;
}


// =============================================================================
// グローバルイベント
// =============================================================================

window.addEventListener('online', () => {
    isOnline = true;
    hideOfflineIndicator();
    showOnlineIndicator();
    // failed なキューは pending に戻して即時再送 (バックオフはリセット)
    syncQueue.forEach((q) => {
        if (q.status === 'failed') { q.status = 'pending'; q.retryCount = 0; }
    });
    saveQueue();
    processQueue();
});

window.addEventListener('offline', () => {
    isOnline = false;
    showOfflineIndicator();
});

// モーダル中の Esc / Enter ショートカット (キーボード操作の利便性向上)
document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('editModal');
    if (!modal || modal.style.display !== 'flex') return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
    } else if (e.key === 'Enter') {
        // ボタン / textarea 上での Enter は誤発火を避けて素通し
        const tag = e.target && e.target.tagName;
        if (tag === 'BUTTON' || tag === 'TEXTAREA') return;
        e.preventDefault();
        saveEdit();
    }
});


// =============================================================================
// Service Worker
// =============================================================================

if ('serviceWorker' in navigator) {
    // ページ初回ロード時点でコントロール下にあったかを記録しておく
    // (true なら新 SW が乗っ取った瞬間に reload する。 初回インストールでは reload しない)
    const hadController = !!navigator.serviceWorker.controller;
    let swReloaded = false;

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
            .then((reg) => console.log('Service Worker registered.', reg))
            .catch((err) => console.error('Service Worker registration failed.', err));
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (swReloaded || !hadController) return;
        swReloaded = true;
        // 新しい SW が制御を取った直後に最新のアセットでリロードする
        location.reload();
    });
}
