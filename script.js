// --- 設定 ---
const GAS_URL = "https://script.google.com/macros/s/AKfycbxBuj2t_H7eYgxydjzv-4BMIRBtdcspzBf-ulFw3v8A36QeE3P5CnHeghaX9HFjgo86qA/exec";

let currentData = {}, viewDate = new Date(), editingKey = null;
let currentUser = localStorage.getItem('work_user_name');
let currentPass = localStorage.getItem('work_user_pass');
let syncQueue = []; 
let isQueueProcessing = false; // 排他制御フラグ

// キューのロード
try {
    syncQueue = JSON.parse(localStorage.getItem('work_sync_queue')) || [];
} catch(e) { syncQueue = []; }

let holidays = {}; // 祝日データキャッシュ
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
    try {
        // キャッシュ対策（cacheBuster）を追加
        const cacheBuster = `&t=${new Date().getTime()}`;
        const res = await fetch(`${GAS_URL}?p=${encodeURIComponent(currentPass)}&u=${encodeURIComponent(currentUser)}${cacheBuster}`, { 
            method: 'GET', 
            redirect: 'follow' 
        });
        
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

// 祝日データの取得処理
async function fetchHolidays(year) {
    if (holidays[year] || holidays[`fetched_${year}`]) return;
    holidays[`fetched_${year}`] = true;
    
    try {
        const res = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
        if (res.ok) {
            const data = await res.json();
            holidays[year] = data;
            // 該当年の表示中なら再描画
            if (viewDate.getFullYear() === year) initCalendar();
        }
    } catch (e) {
        console.error("祝日データ取得失敗", e);
    }
}

// サーバーへデータ送信＆同期
async function syncToGAS(payload) {
// 1. ローカルデータを即時更新（楽観的UI）
    if (payload.isDelete) {
        delete currentData[payload.date];
    } else {
        // 現在のデータと結合（placeだけ更新などで消えないように）
        const old = currentData[payload.date] || {};
        currentData[payload.date] = { ...old, ...payload };
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
                await fetch(GAS_URL, {
                    method: "POST",
                    mode: "no-cors", 
                    header: { "Content-Type": "text/plain" },
                    body: JSON.stringify({ ...item.payload, password: currentPass, user: currentUser })
                });

                // 成功したら削除
                syncQueue = syncQueue.filter(q => q.id !== item.id);
                saveQueue();
                initCalendar(); // アイコン更新
            } catch (e) {
                console.error("Queue Failed", e);
                // 失敗ステータスへ
                const target = syncQueue.find(q => q.id === item.id);
                if(target) target.status = 'failed';
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
    
    // 祝日データ取得開始（未取得の場合）
    if (!holidays[`fetched_${year}`]) fetchHolidays(year);

    document.getElementById('monthDisplay').innerText = `${year}年 ${month + 1}月`;
    const calEl = document.getElementById('calendar'); calEl.innerHTML = '';
    
    ['日','月','火','水','木','金','土'].forEach((d, i) => {
        const h = document.createElement('div'); h.className = 'day-header';
        if(i===0) h.style.color = '#e57373'; if(i===6) h.style.color = '#64b5f6'; h.innerText = d; calEl.appendChild(h);
    });

    const first = new Date(year, month, 1).getDay(), last = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < first; i++) calEl.appendChild(document.createElement('div'));
    
    const yearHolidays = holidays[year] || {}; // 祝日データ

    for (let d = 1; d <= last; d++) {
        const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`, div = document.createElement('div'), dow = new Date(year, month, d).getDay();
        
        // 祝日の判定
        const holidayName = yearHolidays[key];
        const isHoliday = !!holidayName;

        div.className = `day ${dow===6?'sat':dow===0 || isHoliday ?'sun':''}`; 
        if (key === todayStr) div.classList.add('today');
        
        const info = currentData[key] || {}; 
        
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
            div.innerHTML += `<div class="entry entry-absent">休暇</div>`;
        } else { 
            // 場所があれば表示
            if (info.place) div.innerHTML += `<div class="entry entry-place">${info.place}</div>`;

            // 記号を復活（省スペースのためスペースはなし）
            if (info.start) div.innerHTML += `<div class="entry entry-start">▶ ${info.start}</div>`; 
            if (info.end) div.innerHTML += `<div class="entry entry-end">■ ${info.end}</div>`; 
        }
        div.onclick = () => openEdit(key); calEl.appendChild(div);
    }
}

function quickLog(type, place = "") {
    const now = new Date();
    // 日付キー生成 YYYY-MM-DD
    const dateKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    let data = currentData[dateKey] || { start: "", end: "", place: "", isAbsent: false };
    
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
    editingKey = key; const info = currentData[key] || { start: "", end: "", place: "", isAbsent: false };
    document.getElementById('editDateLabel').innerText = key; 
    document.getElementById('editIsAbsent').checked = info.isAbsent;
    document.getElementById('editPlace').value = info.place || ""; 
    
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
    document.getElementById('editModal').style.display = 'flex';
}

function toggleAbsent() {
    const is = document.getElementById('editIsAbsent').checked;
    document.getElementById('timeInputs').style.opacity = is ? "0.3" : "1";
    document.getElementById('timeInputs').style.pointerEvents = is ? "none" : "auto";
}

function saveEdit() {
    syncToGAS({ 
        date: editingKey, 
        isAbsent: document.getElementById('editIsAbsent').checked, 
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
