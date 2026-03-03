// --- 設定 ---
const GAS_URL = "https://script.google.com/macros/s/AKfycbxBuj2t_H7eYgxydjzv-4BMIRBtdcspzBf-ulFw3v8A36QeE3P5CnHeghaX9HFjgo86qA/exec";
const APP_PASS = "passwd";

let currentData = {}, viewDate = new Date(), editingKey = null, currentUser = localStorage.getItem('work_user_name');let holidays = {}; // 祝日データキャッシュ
window.onload = () => { 
    if (currentUser) {
        document.getElementById('userNameInput').value = currentUser;
        showApp(); 
    }
};

function login() {
    const name = document.getElementById('userNameInput').value.trim();
    if (!name) return alert("ユーザー名を入力してください");
    currentUser = name;
    localStorage.setItem('work_user_name', name);
    showApp();
}

function logout() {
    if(!confirm("ログアウトしますか？")) return;
    localStorage.removeItem('work_user_name');
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
        const res = await fetch(`${GAS_URL}?p=${APP_PASS}&u=${encodeURIComponent(currentUser)}${cacheBuster}`, { 
            method: 'GET', 
            redirect: 'follow' 
        });
        currentData = await res.json();
        initCalendar();
    } catch (e) { 
        console.error("同期失敗", e);
    }
    document.getElementById('loader').style.display = 'none';
}

// 祝日データの取得処理
async function fetchHolidays(year) {
    if (holidays[year] || holidays[`fethed_${year}`]) return;
    holidays[`fethed_${year}`] = true;
    
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

// GASへデータを送信
async function syncToGAS(payload) {
    document.getElementById('loader').style.display = 'flex';

    // 1. 楽観的UI更新（消えるのを防ぐために手元データを即更新）
    if (payload.isDelete) {
        delete currentData[payload.date];
    } else {
        currentData[payload.date] = { ...payload };
    }
    initCalendar();

    try {
        // 2. 確実に飛ばすための no-cors モード
        await fetch(GAS_URL, {
            method: "POST",
            mode: "no-cors", 
            header: { "Content-Type": "text/plain" },
            body: JSON.stringify({ ...payload, password: APP_PASS, user: currentUser })
        });

        // 3. GASの処理時間を待ってから再取得
        setTimeout(loadData, 2000); 
    } catch (e) { 
        alert("通信エラーが発生しました"); 
        loadData(); // 失敗時は元に戻す
    }
}

function initCalendar() {
    const year = viewDate.getFullYear(), month = viewDate.getMonth(), todayStr = new Date().toLocaleDateString('sv-SE');
    
    // 祝日データ取得開始（未取得の場合）
    if (!holidays[`fethed_${year}`]) fetchHolidays(year);

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
        let dayHtml = `<div class="day-top"><span class="day-num">${d}</span>`;
        if (isHoliday) {
            dayHtml += `<span class="holiday-lbl">${holidayName}</span>`;
        }
        dayHtml += `</div>`;

        div.innerHTML = dayHtml;
        
        if (info.isAbsent) {
            div.innerHTML += `<div class="entry entry-absent">休暇</div>`;
        } else { 
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
        data.start = timeStr; 
        data.place = place; 
        data.isAbsent = false;
        
        clipText = `作業開始　${place}　${timeStr}`;
    } else {
        // 終了時: 10分単位で切り捨て
        m = Math.floor(m / 10) * 10;
        timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        data.end = timeStr;
        
        clipText = `作業終了　${timeStr}`;
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
