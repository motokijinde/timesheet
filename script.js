// --- 設定 ---
const GAS_URL = "https://script.google.com/macros/s/AKfycby2iRDr_4PABeo5AHDTWFh9PiVgvGSJCIlhu9qwLwgUGMurOL800B8WcwNlpSzmIsLEfA/exec";
const OFFLINE_TIMEOUT = 5000; // オフライン判定タイムアウト(ms)
const MAX_RETRY_ATTEMPTS = 3; // 最大リトライ回数
const RETRY_DELAY = 2000; // リトライ間隔(ms)

let currentData = {}, viewDate = new Date(), editingKey = null;
let currentUser = localStorage.getItem('work_user_name');
let currentPass = localStorage.getItem('work_user_pass');
let syncQueue = []; 
let isQueueProcessing = false; // 排他制御フラグ
let isOnline = navigator.onLine; // オンライン状態フラグ

// キューのロード
try {
    syncQueue = JSON.parse(localStorage.getItem('work_sync_queue')) || [];
} catch(e) { syncQueue = []; }

// オンライン/オフライン状態の監視
window.addEventListener('online', () => {
    isOnline = true;
    console.log('Online detected');
    // オンラインになったらキューを処理
    processQueue();
    // オンライン通知を表示
    showOnlineIndicator();
});

window.addEventListener('offline', () => {
    isOnline = false;
    console.log('Offline detected');
    // オフライン通知を表示
    showOfflineIndicator();
});

// オフライン/オンライン状態のインジケータ表示
function showOfflineIndicator() {
    const indicator = document.getElementById('offline-indicator');
    if (!indicator) {
        const el = document.createElement('div');
        el.id = 'offline-indicator';
        el.className = 'offline-indicator';
        el.innerText = 'オフライン: データはローカルで保存され、オンライン時に同期されます';
        document.body.appendChild(el);
    } else {
        indicator.style.display = 'block';
    }
}

function showOnlineIndicator() {
    const indicator = document.getElementById('online-indicator');
    if (!indicator) {
        const el = document.createElement('div');
        el.id = 'online-indicator';
        el.className = 'online-indicator';
        el.innerText = 'オンライン: データを同期しています';
        document.body.appendChild(el);
    } else {
        indicator.style.display = 'block';
        // 2秒後にフェードアウト
        setTimeout(() => {
            indicator.style.display = 'none';
        }, 2000);
    }
}

window.onload = () => {
    if (currentUser) {
        document.getElementById('userNameInput').value = currentUser;
    }
    if (currentPass) {
        // パスワードが保存されていれば自動入力しておく
        document.getElementById('passwordInput').value = currentPass;
    }
    
    // 両方揃っていれば自動ログインを試みる
    if (currentUser && currentPass) {
        showApp();
    }
};

function saveQueue() {
    localStorage.setItem('work_sync_queue', JSON.stringify(syncQueue));
    initCalendar(); // アイコン更新
}

function login() {
    const name = document.getElementById('userNameInput').value.trim();
    const pass = document.getElementById('passwordInput').value.trim();
    
    if (!name || !pass) return alert("ユーザー名とパスワードを入力してください");
    
    currentUser = name;
    currentPass = pass;
    
    // ローカルストレージに保存
    localStorage.setItem('work_user_name', name);
    localStorage.setItem('work_user_pass', pass);
    
    showApp();
}

function logout(confirmLogout = true) {
    if(confirmLogout && !confirm("ログアウトしますか？")) return;
    localStorage.removeItem('work_user_name');
    localStorage.removeItem('work_user_pass');
    location.reload();
}

function showApp() {
    document.getElementById('loginArea').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    
    // ユーザー名表示箇所（上部バッジ）
    document.getElementById('displayUserName').innerText = currentUser;

    loadData();
    var now = new Date();
    viewDate = new Date(now.getFullYear(), now.getMonth(), 1);
    initCalendar();
}

// サーバーから最新データを取得
async function loadData() {
    document.getElementById('loader').style.display = 'flex';
    
    // オフライン状態の場合はキャッシュから読み込む
    if (!isOnline) {
        const cached = localStorage.getItem('cached_work_data');
        if (cached) {
            currentData = JSON.parse(cached);
            // キューの内容を反映
            syncQueue.forEach(q => {
                if (q.status !== 'pending' && q.status !== 'failed') return;
                const payload = q.payload;
                if (payload.isDelete) {
                    delete currentData[payload.date];
                } else {
                    const old = currentData[payload.date] || {};
                    currentData[payload.date] = { ...old, ...payload };
                }
            });
            initCalendar();
            document.getElementById('loader').style.display = 'none';
            return;
        }
    }
    
    try {
        // キャッシュ対策（cacheBuster）と年パラメータを追加
        const year = viewDate.getFullYear();
        const cacheBuster = `&t=${new Date().getTime()}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OFFLINE_TIMEOUT);
        
        const res = await fetch(`${GAS_URL}?p=${encodeURIComponent(currentPass)}&u=${encodeURIComponent(currentUser)}&year=${year}${cacheBuster}`, {
            method: 'GET', 
            redirect: 'follow',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // テキストとして取得して判定
        const text = await res.text();
        
        // エラー判定（GASが "Forbidden" を返す場合）
        if (text.includes("Forbidden")) {
            alert("ログインに失敗しました。\nパスワードが間違っているか、ユーザーが存在しません。");
            document.getElementById('loader').style.display = 'none';
            localStorage.removeItem('work_user_pass');
            location.reload(); 
            return;
        }

        try {
            currentData = JSON.parse(text);

            // ★未送信キューの内容をローカルデータに反映（最新のローカル変更を優先）
            syncQueue.forEach(q => {
                // 処理待ち・送信失敗の変更を適用
                if (q.status !== 'pending' && q.status !== 'failed') return;
                
                const payload = q.payload;
                if (payload.isDelete) {
                    delete currentData[payload.date];
                } else {
                    const old = currentData[payload.date] || {};
                    currentData[payload.date] = { ...old, ...payload };
                }
            });

            // 正常に取得・マージできたらローカルストレージにも保存
            localStorage.setItem('cached_work_data', JSON.stringify(currentData));
        } catch (e) {
            // JSONパースエラーの場合
            console.error("データ形式エラー", text);
            throw new Error("サーバーからの応答が不正です");
        }
        
        initCalendar();
    } catch (e) { 
        console.error("同期失敗", e);
        
        // オフラインまたはエラー時はキャッシュを表示
        const cached = localStorage.getItem('cached_work_data');
        if (cached) {
            currentData = JSON.parse(cached);
            alert("データの取得に失敗しました。\nオフライン用の過去データを表示します。");
            initCalendar();
        } else {
            alert("データの取得に失敗しました: " + e.message);
        }
    }
    document.getElementById('loader').style.display = 'none';
}


// サーバーへデータ送信＆同期
async function syncToGAS(payload) {
// 1. ローカルデータを即時更新（楽観的UI）
    if (payload.isDelete) {
        // 勤怠データのみ削除、祝日情報は保持
        const old = currentData[payload.date] || {};
        if (old.isHoliday) {
            // 祝日の場合は勤怠情報のみクリア
            currentData[payload.date] = {
                place: "",
                start: "",
                end: "",
                vacationType: "",
                isAbsent: false,
                isHalfDay: false,
                isHoliday: old.isHoliday,
                holidayName: old.holidayName,
                absenceReason: ""
            };
        } else {
            // 祝日でない場合は完全削除
            delete currentData[payload.date];
        }
    } else {
        // 現在のデータと結合（placeだけ更新などで消えないように）
        const old = currentData[payload.date] || {};
        
        // vacationTypeを計算してローカルデータに反映
        let vacationType = "";
        if (payload.isAbsent) {
            vacationType = payload.place || "有給休暇";
        } else if (payload.isHalfDay) {
            if (payload.halfDayType === "morning") {
                vacationType = "午前半休";
            } else if (payload.halfDayType === "afternoon") {
                vacationType = "午後半休";
            }
        }
        
        currentData[payload.date] = { 
            ...old, 
            ...payload,
            vacationType: vacationType,
            absenceReason: vacationType || old.absenceReason
        };
    }
    localStorage.setItem('cached_work_data', JSON.stringify(currentData));
    
    // 2. キューに追加
    // 同じ日付への未処理リクエストがあれば削除（最新の上書きでOKとする）
    syncQueue = syncQueue.filter(q => q.date !== payload.date);
    
    syncQueue.push({
        id: Date.now(),
        date: payload.date,
        payload: payload,
        status: 'pending'
    });
    saveQueue();

    // 3. 送信処理開始（待たない）
    processQueue();
}

// キュー処理
async function processQueue() {
    if (isQueueProcessing) return; // 実行中なら抜ける
    isQueueProcessing = true;

    try {
        let pendings;
        // 未処理がある限りループし続ける
        while ((pendings = syncQueue.filter(q => q.status === 'pending')).length > 0) {
            
            // 1つずつ処理（並列にするとGASが詰まる可能性があるので直列）
            const item = pendings[0];
            
            try {
                // オフライン状態の場合はリトライを設定して待機
                if (!isOnline) {
                    // オフライン時はリトライ回数を増やす
                    item.retryCount = (item.retryCount || 0) + 1;
                    if (item.retryCount <= MAX_RETRY_ATTEMPTS) {
                        setTimeout(() => {
                            processQueue();
                        }, RETRY_DELAY * item.retryCount);
                    } else {
                        item.status = 'failed';
                        saveQueue();
                        initCalendar();
                    }
                    break;
                }
                
                // オンライン時は通常の送信処理
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), OFFLINE_TIMEOUT);
                
                await fetch(GAS_URL, {
                    method: "POST",
                    mode: "no-cors", 
                    header: { "Content-Type": "text/plain" },
                    body: JSON.stringify({ ...item.payload, password: currentPass, user: currentUser }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

                // 成功したら削除
                syncQueue = syncQueue.filter(q => q.id !== item.id);
                saveQueue();
                initCalendar(); // アイコン更新
            } catch (e) {
                console.error("Queue Failed", e);
                // 失敗ステータスへ
                const target = syncQueue.find(q => q.id === item.id);
                if(target) {
                    target.status = 'failed';
                    target.retryCount = (target.retryCount || 0) + 1;
                }
                saveQueue();
                initCalendar(); // アイコン更新 (⚠️になる)
                
                // エラー時は一旦抜けて、次のトリガー(再送信など)を待つのが安全だが
                // 次のアイテムと関連がないなら続けてもいい。
                // ここでは安全のためループを抜ける（キュー詰まり防止で失敗アイテム以外は進めたい場合はcontinue）
                // 今回は「失敗したら止める」挙動の方が整合性がとりやすい
                break; 
            }
        }
    } finally {
        isQueueProcessing = false;
    }
}

// 再送信（手動）
async function retrySync(id) {
    const item = syncQueue.find(q => q.id === id);
    if (!item) return;
    
    // ステータスをpendingに戻して再実行
    item.status = 'pending';
    saveQueue();
    initCalendar(); // ⏳アイコンへ戻す
    processQueue();
}

function initCalendar() {
    const year = viewDate.getFullYear(), month = viewDate.getMonth(), todayStr = new Date().toLocaleDateString('sv-SE');

    document.getElementById('monthDisplay').innerText = `${year}年 ${month + 1}月`;
    const calEl = document.getElementById('calendar'); calEl.innerHTML = '';
    
    ['日','月','火','水','木','金','土'].forEach((d, i) => {
        const h = document.createElement('div'); h.className = 'day-header';
        if(i===0) h.style.color = '#e57373'; if(i===6) h.style.color = '#64b5f6'; h.innerText = d; calEl.appendChild(h);
    });

    const first = new Date(year, month, 1).getDay(), last = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < first; i++) calEl.appendChild(document.createElement('div'));

    for (let d = 1; d <= last; d++) {
        const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`, div = document.createElement('div'), dow = new Date(year, month, d).getDay();
        
        const info = currentData[key] || {};
        
        // サーバーから取得した祝日情報を使用
        const holidayName = info.holidayName || "";
        const isHoliday = info.isHoliday || false;

        div.className = `day ${dow===6?'sat':dow===0 || isHoliday ?'sun':''}`;
        if (key === todayStr) div.classList.add('today');
        
        // 日付・祝日名のHTML生成
        // 祝日名は日付の隣ではなく下段に配置（モバイルで見切れ防止）
        let layoutHtml = `<div class="day-num">${d}</div>`;
        if (isHoliday) {
            layoutHtml += `<div class="holiday-lbl">${holidayName}</div>`;
        }
        
        // --- 同期ステータスアイコン ---
        const qItem = syncQueue.find(q => q.date === key);
        if (qItem) {
            if (qItem.status === 'pending') {
                layoutHtml += `<div class="sync-icon sync-pending">⌛</div>`;
            } else if (qItem.status === 'failed') {
                layoutHtml += `<div class="sync-icon sync-failed" onclick="event.stopPropagation(); retrySync(${qItem.id});">⚠️</div>`;
            }
        }

        div.innerHTML = layoutHtml;
        
        if (info.isAbsent) {
            // 欠勤・休暇の理由を表示
            const reason = info.absenceReason || info.place || "休暇";
            div.innerHTML += `<div class="entry entry-absent">${reason}</div>`;
        } else if (info.isHalfDay) {
            // 半休の表示（午前休/午後休を表示）
            const halfDayLabel = info.vacationType === "午前半休" ? "午前休" : 
                                 info.vacationType === "午後半休" ? "午後休" : "半休";
            div.innerHTML += `<div class="entry entry-halfday">${halfDayLabel}</div>`;
            
            // 半休でも場所と時間を表示
            if (info.place) div.innerHTML += `<div class="entry entry-place">${info.place}</div>`;
            if (info.start) div.innerHTML += `<div class="entry entry-start">▶ ${info.start}</div>`; 
            if (info.end) div.innerHTML += `<div class="entry entry-end">■ ${info.end}</div>`;
        } else if (info.place || info.start || info.end) { 
            // 通常勤務（場所または時間がある場合）
            if (info.place) div.innerHTML += `<div class="entry entry-place">${info.place}</div>`;
            if (info.start) div.innerHTML += `<div class="entry entry-start">▶ ${info.start}</div>`; 
            if (info.end) div.innerHTML += `<div class="entry entry-end">■ ${info.end}</div>`; 
        }
        // 祝日のみの場合は何も表示しない（祝日名と背景色のみ）
        div.onclick = () => openEdit(key); calEl.appendChild(div);
    }
}

function quickLog(type, place = "") {
    const now = new Date();
    // 日付キー生成 YYYY-MM-DD
    const dateKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    let data = currentData[dateKey] || { start: "", end: "", place: "", isAbsent: false, isHalfDay: false };
    
    let h = now.getHours(), m = now.getMinutes();
    let timeStr = "", clipText = "";

    if (type === 'start') {
        // 開始時: 9時前なら9:00、それ以外は10分単位で切り上げ
        if (h < 9) { h = 9; m = 0; }
        else if (m > 0) {
            m = Math.ceil(m / 10) * 10;
            if (m === 60) { h++; m = 0; }
        }
        timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const clipTimeStr = `${h}:${String(m).padStart(2,'0')}`; // Teams用: ゼロ埋めなし(9:00)
        data.start = timeStr; 
        data.place = place; 
        data.isAbsent = false;
        data.isHalfDay = false;
        data.halfDayType = "";
        
        clipText = `作業開始　${place}　${clipTimeStr}`;
    } else {
        // 終了時: 10分単位で切り捨て
        m = Math.floor(m / 10) * 10;
        timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        const clipTimeStr = `${h}:${String(m).padStart(2,'0')}`; // Teams用: ゼロ埋めなし(18:00)
        data.end = timeStr;
        
        clipText = `作業終了　${clipTimeStr}`;
    }

    // クリップボードへコピー＆記録
    navigator.clipboard.writeText(clipText).then(() => {
        const msgEl = document.getElementById('msg');
        if (msgEl) {
            msgEl.innerText = "記録を保存し、Teams用にコピーしました";
            setTimeout(() => msgEl.innerText = "", 3000);
        }
    }).catch(e => console.error("Copy failed", e));

    syncToGAS({ ...data, date: dateKey });
}

function openEdit(key) {
    editingKey = key;
    const info = currentData[key] || { 
        start: "", end: "", place: "", 
        vacationType: "", isAbsent: false, isHalfDay: false 
    };
    
    document.getElementById('editDateLabel').innerText = key;
    
    // 休暇種別から状態を復元
    const vacationType = info.vacationType || "";
    
    const placeInput = document.getElementById('editPlace');
    
    if (vacationType === "午前半休" || vacationType === "午後半休") {
        // 半休の場合
        document.getElementById('editIsHalfDay').checked = true;
        document.getElementById('editIsAbsent').checked = false;
        placeInput.value = info.place || "";
        placeInput.setAttribute('list', 'places');
        
        // 午前/午後の選択を復元
        if (vacationType === "午前半休") {
            document.getElementById('halfDayMorning').checked = true;
            document.getElementById('halfDayAfternoon').checked = false;
        } else {
            document.getElementById('halfDayMorning').checked = false;
            document.getElementById('halfDayAfternoon').checked = true;
        }
    } else if (vacationType && info.isAbsent) {
        // 全日休暇の場合
        document.getElementById('editIsAbsent').checked = true;
        document.getElementById('editIsHalfDay').checked = false;
        placeInput.value = vacationType; // 休暇種別を表示
        placeInput.setAttribute('list', 'absenceReasons');
    } else {
        // 通常勤務の場合
        document.getElementById('editIsAbsent').checked = false;
        document.getElementById('editIsHalfDay').checked = false;
        placeInput.value = info.place || "";
        placeInput.setAttribute('list', 'places');
    }
    
    // input type="time" 用に HH:mm 形式へ整形
    const formatTime = (t) => {
        if (!t || typeof t !== 'string') return "";
        const parts = t.split(':');
        if (parts.length < 2) return "";
        return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
    };

    document.getElementById('editStart').value = formatTime(info.start); 
    document.getElementById('editEnd').value = formatTime(info.end);
    
    toggleAbsent(); 
    toggleHalfDay();
    document.getElementById('editModal').style.display = 'flex';
}

function toggleAbsent() {
    const is = document.getElementById('editIsAbsent').checked;
    const isHalf = document.getElementById('editIsHalfDay').checked;
    const placeInput = document.getElementById('editPlace');
    
    document.getElementById('timeInputs').style.opacity = is ? "0.3" : "1";
    document.getElementById('timeInputs').style.pointerEvents = is ? "none" : "auto";
    
    // 欠勤・休暇のチェックが変わったらdatalistを切り替える
    if (is) {
        // 欠勤・休暇時は理由の候補を表示
        placeInput.setAttribute('list', 'absenceReasons');
        
        // 時間と場所をクリア
        document.getElementById('editStart').value = "";
        document.getElementById('editEnd').value = "";
        placeInput.value = "";
        
        // 欠勤・休暇がチェックされたら半休を外す
        if (isHalf) {
            document.getElementById('editIsHalfDay').checked = false;
            toggleHalfDay();
        }
    } else {
        // 通常時は場所の候補を表示
        placeInput.setAttribute('list', 'places');
    }
}

function toggleHalfDay() {
    const isHalf = document.getElementById('editIsHalfDay').checked;
    const isAbsent = document.getElementById('editIsAbsent').checked;
    const halfDayOptions = document.getElementById('halfDayOptions');
    
    // 半休がチェックされたら欠勤・休暇を外す
    if (isHalf && isAbsent) {
        document.getElementById('editIsAbsent').checked = false;
        toggleAbsent();
    }
    
    // 半休オプションの表示/非表示
    if (isHalf) {
        halfDayOptions.style.display = 'block';
        // デフォルトで午前休を選択（時間は自動入力しない）
        if (!document.getElementById('halfDayMorning').checked && !document.getElementById('halfDayAfternoon').checked) {
            document.getElementById('halfDayMorning').checked = true;
        }
    } else {
        halfDayOptions.style.display = 'none';
        document.getElementById('halfDayMorning').checked = false;
        document.getElementById('halfDayAfternoon').checked = false;
    }
    
    // 半休時は時間入力を有効にする
    document.getElementById('timeInputs').style.opacity = "1";
    document.getElementById('timeInputs').style.pointerEvents = "auto";
}

function saveEdit() {
    const isHalfDay = document.getElementById('editIsHalfDay').checked;
    let halfDayType = "";
    
    if (isHalfDay) {
        if (document.getElementById('halfDayMorning').checked) {
            halfDayType = "morning";
        } else if (document.getElementById('halfDayAfternoon').checked) {
            halfDayType = "afternoon";
        }
    }
    
    syncToGAS({ 
        date: editingKey, 
        isAbsent: document.getElementById('editIsAbsent').checked, 
        isHalfDay: isHalfDay,
        halfDayType: halfDayType,
        place: document.getElementById('editPlace').value, 
        start: document.getElementById('editStart').value, 
        end: document.getElementById('editEnd').value 
    });
    closeModal();
}

async function deleteEntry() { 
    if (confirm("完全に削除しますか？")) { 
        closeModal(); 
        await syncToGAS({ date: editingKey, isDelete: true }); 
    } 
}

function closeModal() { document.getElementById('editModal').style.display = 'none'; }
function changeMonth(diff) { viewDate.setMonth(viewDate.getMonth() + diff); loadData(); }

function copyForExcel() {
    const y = viewDate.getFullYear(), m = viewDate.getMonth(); let txt = "日付\t場所\t開始\t終了\t備考\n";
    for (let d = 1; d <= 31; d++) {
        const date = new Date(y, m, d); if (date.getMonth() !== m) break;
        const key = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`, info = currentData[key] || {};
        txt += `${key}\t${info.place||''}\t${info.start||''}\t${info.end||''}\t${info.isAbsent?'休暇':''}\n`;
    }
    navigator.clipboard.writeText(txt).then(() => alert("コピーしました"));
}


// --- Service Worker の登録 ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((reg) => console.log('Service Worker registered.', reg))
            .catch((err) => console.log('Service Worker registration failed.', err));
    });
}
