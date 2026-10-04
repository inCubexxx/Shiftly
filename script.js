/* ============================================================
   データの置き場所（Firebase / Firestore）
   店舗ごとに stores/{店舗ID}/ の下へ分けて置く。
     storeCodes/{店舗コード}              店舗コード → 店舗ID・店舗名（コードを指定した1件だけ誰でも読める）
     stores/{店舗ID}/app/main             店舗全体のデータ：従業員・必要人数・設定・シフト（書けるのは管理者）
     stores/{店舗ID}/prefs/{ユーザーID}    勤務希望（本人と管理者だけ）
     stores/{店舗ID}/logins/{社員番号}     社員番号 → 内部ID（番号を指定した1件だけ誰でも読める）
     stores/{店舗ID}/lastLogin/{ユーザーID} 最終ログイン日（読めるのは管理者だけ）
   ・店舗コードではなく、変わらない店舗IDの下に置く → 店舗コードを変えてもデータを移さなくて済む
   ・勤務希望を人ごとに分ける → 何人かが同時に提出しても、ほかの人の希望を上書きしない
   ・画面側は DB を書き換えて save() を呼ぶだけでよい（save() が変わった部分だけ送る）
   ============================================================ */
// Firebase の接続先。apiKey は「どのプロジェクトか」を示すだけの値で、公開してよい（データを守るのは firestore.rules）
const firebaseConfig = {
  apiKey: "AIzaSyBv4fN-9-H4yCVtFyaxb1szktYVEy_i3hs",
  authDomain: "shiftly-b6e52.firebaseapp.com",
  projectId: "shiftly-b6e52",
  storageBucket: "shiftly-b6e52.firebasestorage.app",
  messagingSenderId: "920164464388",
  appId: "1:920164464388:web:18462acb6a115b42c48251"
};
// 自分の PC で開いたとき（ローカル確認）は、本番ではなく PC の中のテスト用 Firebase（エミュレーター。start-local.bat で起動）につなぐ。
// プロジェクトID を「demo-」で始めると、エミュレーター専用になり、本番には絶対につながらない
const USE_EMULATOR = location.protocol==='file:' || location.hostname==='localhost' || location.hostname==='127.0.0.1';
firebase.initializeApp(USE_EMULATOR ? {...firebaseConfig, projectId:'demo-shiftly'} : firebaseConfig);
const auth=firebase.auth();
const fs=firebase.firestore();
if(USE_EMULATOR){
  auth.useEmulator('http://127.0.0.1:9099'); // ポート番号は firebase.json と同じにする
  fs.useEmulator('127.0.0.1', 8080);
}
// ログイン状態は、タブ（ウィンドウ）を閉じるまで保つ
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
// Firebase のログインはメールアドレスの形の ID を使うので、内部ID から「内部ID@authDomain」を作る（メールは送られない）。
// 社員番号から作らないのは、社員番号を変更してもログインできるようにするため
const emailOf = userId => userId+'@'+firebaseConfig.authDomain;
const userIdOfAuth = user => (user && user.email) ? user.email.split('@')[0] : null;
// クラウド同期の状態（save() などから使う）
const cloud={
  authKnown:false,     // ログイン状態の確認が終わったか（ページを開いた直後は未確認）
  ready:false,         // 共有データを読み込み終えたか
  mainLoaded:false, prefsLoaded:false,
  mainJson:null,       // 最後にクラウドと一致していた内容（変わった部分だけ送るための比較用）
  prefsJson:{},        // userId -> 同上
  logins:{},           // 社員番号 -> 内部ID（同上）
  mainUnsub:null, prefsUnsub:null, lastLoginUnsub:null, // リアルタイム受信を止める関数
  prefsAsAdmin:null,   // 勤務希望を「全員分（管理者）」「自分の分」のどちらで受信しているか
  lastLogins:{},       // userId -> 最終ログイン日 'YYYY-MM-DD'（管理者だけ受信する。DB には入れないので save() では送らない）
  lastLoginError:false, // 最終ログイン日を読み込めなかったか（セキュリティルールが古いままのときなど）
  setupInProgress:false, // 店舗の登録中（店舗のデータを書き込み終えるまで受信を始めない）
};

// ログインする店舗 {code:店舗コード, id:店舗ID, name:店舗名}（未選択は null）。
// 選んだ店舗は端末に覚えておき、次からは店舗選択を飛ばしてログイン画面から始める。
// localStorage（ブラウザを閉じても残る）と sessionStorage（タブごと）の両方に入れ、タブの方を優先して読む
// （別のタブで店舗を変えても、このタブを再読み込みしたときに店舗が入れ替わらないようにするため）。
// 保存を禁止しているブラウザでは触れただけでエラーになるので、毎回 try の中で使う
const STORE_KEY='shiftly_store';
const STORE_STORAGES=['sessionStorage','localStorage']; // 前にある方を優先して読む
let currentStore=loadSavedStore();
function loadSavedStore(){
  for(const name of STORE_STORAGES){
    try{
      const s=JSON.parse(window[name].getItem(STORE_KEY));
      if(s && s.code && s.id && s.name) return s;
    }catch(e){} // 保存できない設定のブラウザや、壊れた値は無視する
  }
  return null;
}
function setCurrentStore(s){
  currentStore=s;
  STORE_STORAGES.forEach(name=>{
    try{ if(s) window[name].setItem(STORE_KEY, JSON.stringify(s)); else window[name].removeItem(STORE_KEY); }catch(e){}
  });
}
// 今の店舗の中の保存場所（例：storePath('app/main') → 'stores/{店舗ID}/app/main'）
const storePath = path => 'stores/'+currentStore.id+'/'+path;
// HTML の記号（< > & " '）を、文字のまま表示される形にする（XSS 対策）。
// 店舗名・職務名などの入力をそのまま innerHTML に入れると、紛れ込ませた <script> などが動いてしまうため
function escHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- 自動作成のルールに使う値 ---------- */
// PA種：週の上限は月曜〜日曜の週で判定し、「未満」を守る
const PA_TYPES = {
  general:           { label:'一般PA',     weekCapMin:null  }, // 制限なし
  dependent:         { label:'扶養PA',     weekCapMin:20*60 }, // 週20時間未満
  dependent_student: { label:'扶養学生PA', weekCapMin:40*60 }, // 週40時間未満
};
const DEPENDENT_STUDENT_DAY_CAP_MIN = 8*60; // 扶養学生PAは1日8時間未満（ちょうど8時間も不可）
const SLOT_MIN = 10; // 自動作成で扱う時間の最小単位（分）。9:40 のような10分単位の時刻（シフト記号）も数えられるように10分
// 優先順位：扶養の上限・月最低休日数・希望休（絶対に守る）＞ 人員不足を出さない ＞ 連勤3日まで
// （社員は、月最低休日数と希望休だけ守り、提出した日は必ず入れる）
// （人員不足を埋めるためなら、連勤は4日目まで認める）
const MAX_CONSECUTIVE_WORK_DAYS = 3; // これを超える連勤は避ける
// 休みの日の入れ替え（generateShifts の手順3）を試す回数と時間の上限。どちらかに達したら、そこまでの結果で終える
const REST_SWAP_MAX_TRIES = 2000;
const REST_SWAP_TIME_LIMIT_MS = 10*1000;
const MIN_SHIFT_MIN = 3*60; // 1日の勤務（出勤〜退勤の1本）は3時間以上（3時間ちょうどは可）
// 希望提出締切の初期値：対象期間の初日の8日前。締切日の当日までは入力できるので、初日のちょうど1週間前から締切後になる
const DEFAULT_DEADLINE_DAYS_BEFORE = 8;
const DOW=['日','月','火','水','木','金','土'];
/* ---------- 役職・職務 ---------- */
// 役職。「社員」は勤務希望をシフト記号で出し、自動作成では提出した日に必ず入る（usesShiftCodes）。
// 「PA」は PA種の欄が出て、カレンダーの時刻が3行になる。
// 未設定（null）や、ここに無い役職は空欄で表示する。管理者かどうかは役職とは別に role で持つ
const POSITIONS = {
  regular: { label:'社員' },
  pa:      { label:'PA'   },
};
const positionLabel = u => (u.position && POSITIONS[u.position]) ? POSITIONS[u.position].label : '';
// 職務：従業員ごとに1つ（未設定は null）。必要最低人数も自動作成も職務ごと。
// 一覧は店舗ごとのデータ DB.duties（[{id,label}]、この並び順で表示）で、「職務設定」で変更できる。
// 従業員・必要最低人数は名前ではなく変わらない id で職務を覚えるので、名前を変えても設定は残る
const DEFAULT_DUTIES = [ // 新しい店舗の最初の職務（DB.duties が無い店舗もこれを使う）
  {id:'avc',       label:'AVC'},
  {id:'hlh',       label:'HLH'},
  {id:'office',    label:'事務'},
  {id:'logistics', label:'物流'},
  {id:'counter',   label:'カウンター'},
  {id:'corporate', label:'法人'},
  {id:'management',label:'管理'},
];
const dutyList = () => Array.isArray(DB.duties) ? DB.duties : DEFAULT_DUTIES;
const dutyById = id => dutyList().find(d=>d.id===id) || null;
// 職務のプルダウンの選択肢（selected の職務を選んだ状態にする）
const dutyOptions = selected => dutyList()
  .map(d=>`<option value="${d.id}" ${selected===d.id?'selected':''}>${escHtml(d.label)}</option>`).join('');
// その人（または不足の記録・時間帯）の職務の id。知らない職務・未設定は null
const dutyOf = x => (x && dutyById(x.duty)) ? x.duty : null;
// 職務名（画面に出す用。escHtml 済み）。職務が無ければ空文字
const dutyLabelOf = x => dutyOf(x) ? escHtml(dutyById(x.duty).label) : '';
// 月最低休日数（職務ごと・月ごと）：DB.settings.min_days_off = {'YYYY-MM': {職務の id: 日数}}。
// 月は対象期間の初日の月。設定が無ければ 0（決まりなし）
const monthKeyOf = isoDate => isoDate.slice(0,7);
function minDaysOffFor(duty, monthKey){
  const n=(((DB.settings||{}).min_days_off||{})[monthKey]||{})[duty];
  return (Number.isInteger(n) && n>0) ? n : 0;
}
// 「役職・管理者」をまとめた表示（例：「PA・管理者」「社員」「管理者」）。どちらも無ければ空文字
const roleDisplay = u => [positionLabel(u), u.role==='admin'?'管理者':''].filter(s=>s).join('・');
const paLabel = u => u.permission ? (PA_TYPES[u.permission]?PA_TYPES[u.permission].label:'') : '';
// その人の PA種（PA_TYPES のキー）。役職が PA で PA種が空の人は一般PA とみなす。
// PA種は扶養の時間の上限にだけ使う（シフト対象かどうかには使わない）
const paTypeOf = u => (u && PA_TYPES[u.permission]) ? u.permission : (u && u.position==='pa' ? 'general' : null);
// シフト対象：職務が決まっている人（管理者でも職務があれば対象）。
// 勤務希望入力のメニュー・シフトカレンダー・ダッシュボードの提出状況・CSV もこの人たちを出す
const isStaff = u => !!dutyOf(u);
// 自動作成で選んでよい人：シフト対象で、在籍中の人
const isAutoCandidate = u => isStaff(u) && u.is_active;

/* ---------- シフト記号（社員の勤務希望・シフトの表示に使う） ---------- */
// 社員（役職が「社員」の人）は、勤務希望を時刻ではなく記号（A・B など）で出し、カレンダーにも記号で表示する。
// 一覧は店舗ごとのデータ DB.shift_codes（[{id,label,start,end}]、開始時刻の順）で、「シフト記号設定」で変更できる。
// 勤務希望は変わらない id で記号を覚える。シフトには時刻だけを保存し、表示するときに時刻が同じ記号を探す
const DEFAULT_SHIFT_CODES = [ // 新しい店舗の最初の記号
  {id:'a',   label:'A',   start:'09:00', end:'18:00'},
  {id:'a40', label:'A40', start:'09:40', end:'18:40'},
  {id:'b',   label:'B',   start:'10:00', end:'19:00'},
  {id:'b2',  label:'B2',  start:'10:30', end:'19:30'},
  {id:'c2',  label:'C2',  start:'14:30', end:'20:30'},
];
const shiftCodeList = () => Array.isArray(DB.shift_codes) ? DB.shift_codes : DEFAULT_SHIFT_CODES;
const shiftCodeById = id => shiftCodeList().find(c=>c.id===id) || null;
// 時刻がちょうど同じ記号（無ければ null）
const shiftCodeOfTimes = (start,end) => shiftCodeList().find(c=>c.start===start && c.end===end) || null;
// 記号で勤務希望を出す人か（役職が「社員」の人）
const usesShiftCodes = u => !!u && u.position==='regular';
// 勤務希望 p で選んでいる記号（知らない id は除く）。記号で出す前の、時刻で出した希望なら null
const prefCodesOf = p => (p && Array.isArray(p.codes)) ? p.codes.map(shiftCodeById).filter(Boolean) : null;

/* ============================================================
   店舗のデータ（DB）
   ============================================================ */

function seed(){
  const nextMonth=addMonthsIso(iso(new Date()).slice(0,8)+'01', 1); // 翌月の1日
  return {
    users:[],
    // 必要最低人数（職務ごと・時間帯ごと。全営業日に共通）：{id,start,end,count,max,duty}
    //   count：必要最低人数、max：最高人数（null は上限なし）。新しい店舗は空から始める。
    //   全職務の最も早い開始〜最も遅い終了が、そのまま営業時間になる（businessWindow）
    required_staff:[],
    // 職務の一覧 [{id,label}]（この並び順で表示する）
    duties: DEFAULT_DUTIES.map(d=>({...d})),
    // シフト記号の一覧 [{id,label,start,end}]（開始時刻の順）
    shift_codes: DEFAULT_SHIFT_CODES.map(c=>({...c})),
    default_availability:{}, // userId -> 勤務希望の一括設定の既定値（平日／土日。次の期間にも引き継ぐ）
    employee_preferences:{}, // userId -> {'YYYY-MM-DD': {day_off, start, end, avail_start, avail_end}}
    submissions:{},          // userId -> 提出済みの対象期間の初日
    shifts:[],               // {user_id, date, start, end}
    settings:{
      // 対象期間（初期値は翌月の1日〜月末。シフトは1か月単位で作る）
      period_start: nextMonth,
      period_end: lastDayOfMonthIso(nextMonth),
      // 希望提出締切は「対象期間の初日の何日前か」で持つ（締切日は deadlineDateOf で計算する）。
      // こうすると、対象期間が次へ進んでも締切日が自動でついてくる
      deadline_days_before: DEFAULT_DEADLINE_DAYS_BEFORE,
      // 公開済みの期間 {start,end,published_at,last_generated}。公開すると対象期間は次へ進むので、
      // 公開済みかどうかは対象期間ではなく、この一覧で判定する
      published_periods:[],
      last_generated:null, // 最後に自動作成した日時
      shortages:[] // 人員不足の記録 {date,start,end,required,assigned,duty}（日付ごとに、期間をまたいで残す）
    }
  };
}
let DB=seed(); // 中身はログイン後にクラウドから読み込む（startCloudSync）

/* ---------- クラウド同期 ---------- */
const MAIN_KEYS=['users','required_staff','settings','shifts','duties','shift_codes']; // app/main に入れる項目
// キーの並び順をそろえた JSON 文字列にする（中身が同じなら必ず同じ文字列になる）。
// Firestore から戻るデータはキーの順番が変わることがあり、普通の JSON.stringify だと
// 「中身は同じなのに違う」と判定して、無駄な保存や再描画が起きるため
function stableStringify(v){
  if(Array.isArray(v)) return '['+v.map(stableStringify).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined)
    .map(k=>JSON.stringify(k)+':'+stableStringify(v[k])).join(',')+'}';
  return JSON.stringify(v===undefined ? null : v);
}
// Firestore は undefined を保存できないので、JSON を通して取り除いたコピーを作る
function clean(o){ return JSON.parse(JSON.stringify(o)); }

// app/main に送る部分を取り出す（src は DB か、店舗を登録するときの最初のデータ）
function mainPartOf(src){
  const o={};
  MAIN_KEYS.forEach(k=>{ if(src[k]!==undefined) o[k]=src[k]; });
  o.users=(src.users||[]).map(({password,mustSetPassword,...u})=>u); // パスワードは Firebase 側で管理するので送らない
  return clean(o);
}
// セキュリティルールで使う admins（管理者）・members（在籍中の人）の一覧を添えて、app/main に書き込む形にする
function mainDocOf(part){
  return {...part,
    admins: part.users.filter(u=>u.role==='admin' && u.is_active).map(u=>u.id),
    members: part.users.filter(u=>u.is_active).map(u=>u.id)};
}
// 社員番号 → 内部ID の対応（在籍中の人だけ）。クラウドには店舗の logins/{社員番号} に1件ずつ置く
function loginsOf(src){
  const m={};
  (src.users||[]).filter(u=>u.is_active).forEach(u=>{ m[u.empNo]=u.id; });
  return m;
}
// その人の勤務希望の保存場所（prefs/{userId}）に送る部分を取り出す
function prefsPartOf(src,uid){
  const o={};
  const p=(src.employee_preferences||{})[uid]; if(p && Object.keys(p).length) o.employee_preferences=p;
  const d=(src.default_availability||{})[uid]; if(d && Object.keys(d).length) o.default_availability=d;
  const sub=(src.submissions||{})[uid]; if(sub) o.submission=sub;
  return clean(o);
}

// 変わった部分だけクラウドへ送る。画面側はデータを書き換えたら save() を呼ぶだけでよい
function save(){
  if(!cloud.ready) return; // ログイン前・読み込み前は送らない
  const me=currentUser(); if(!me) return;
  // 管理者として送るかは、手元の role ではなく、クラウドで最後に確認した役割で決める（書き込めるかはクラウドの役割で決まるため）。
  // 手元の role で決めると、自分を管理者から外した直後に「従業員」と判断され、その変更自体が送られなくなる
  const admin=cloud.prefsAsAdmin===true;
  if(admin){
    const main=mainPartOf(DB), json=stableStringify(main);
    if(json!==cloud.mainJson){ cloud.mainJson=json; cloudWrite(fs.doc(storePath('app/main')).set(mainDocOf(main))); }
    // 社員番号の追加・変更・在籍の変更があった分だけ logins を書き換える
    const logins=loginsOf(DB);
    Object.keys({...cloud.logins, ...logins}).forEach(no=>{
      if(cloud.logins[no]===logins[no]) return;
      const ref=fs.doc(storePath('logins/'+no));
      cloudWrite(logins[no] ? ref.set({uid:logins[no]}) : ref.delete());
    });
    cloud.logins=logins;
  }
  // 勤務希望：従業員は自分の分だけ、管理者は全員分（削除した人の分は消す）
  const ids = admin ? [...new Set([...Object.keys(cloud.prefsJson), ...DB.users.map(u=>u.id)])] : [me.id];
  ids.forEach(uid=>{
    const part = DB.users.some(u=>u.id===uid) ? prefsPartOf(DB,uid) : {};
    const json=stableStringify(part);
    if(json===(cloud.prefsJson[uid]||'{}')) return;
    cloud.prefsJson[uid]=json;
    const ref=fs.doc(storePath('prefs/'+uid));
    cloudWrite(json==='{}' ? ref.delete() : ref.set(part));
  });
}
// 保存に失敗したら知らせる
function cloudWrite(promise){
  promise.catch(err=>{
    console.error(err);
    alert('クラウドへの保存に失敗しました。通信状況を確認して、ページを再読み込みしてください。\n（'+(err.code||err.message)+'）');
  });
}

// ログインしたら、共有データのリアルタイム受信を始める（他の人が変更すると自動で届く）
function startCloudSync(){
  stopCloudSync();
  Object.assign(cloud,{ready:false, mainLoaded:false, prefsLoaded:false, mainJson:null, prefsJson:{}, logins:{}, prefsAsAdmin:null, lastLogins:{}, lastLoginError:false});
  DB=seed(); // 読み込み終わるまでは空のデータ（前にログインしていた人のデータを残さない）
  cloud.mainUnsub=fs.doc(storePath('app/main')).onSnapshot(onMainSnapshot, cloudReadError);
}
function stopCloudSync(){
  if(cloud.mainUnsub){ cloud.mainUnsub(); cloud.mainUnsub=null; }
  if(cloud.prefsUnsub){ cloud.prefsUnsub(); cloud.prefsUnsub=null; }
  if(cloud.lastLoginUnsub){ cloud.lastLoginUnsub(); cloud.lastLoginUnsub=null; }
  cloud.ready=false;
}
function onMainSnapshot(snap){
  if(!snap.exists){
    cloudReadError(appError('この店舗のデータが見つかりません。「変更」から店舗を選び直してください。')); return;
  }
  const part=mainPartOf(snap.data()), json=stableStringify(part);
  const changed = json!==cloud.mainJson; // 自分が送った内容が戻ってきただけなら何もしない
  if(changed){
    Object.assign(DB, part);
    DB.shifts=DB.shifts||[]; DB.required_staff=DB.required_staff||[];
    cloud.mainJson=json;
    cloud.logins=loginsOf(DB); // logins は app/main の従業員一覧と同じ内容で保存されている
  }
  const me=currentUser();
  if(!me || !me.is_active){ cloudReadError({code:'permission-denied'}); return; }
  cloud.mainLoaded=true;
  const asAdmin = me.role==='admin';
  if(cloud.prefsAsAdmin!==asAdmin){ subscribeLastLogins(asAdmin); subscribePrefs(asAdmin); return; } // 勤務希望を読み込み終えてから描画する
  if(changed) refreshAfterCloud();
}
function subscribePrefs(asAdmin){
  if(cloud.prefsUnsub) cloud.prefsUnsub();
  cloud.prefsAsAdmin=asAdmin; cloud.prefsLoaded=false;
  if(asAdmin){
    cloud.prefsUnsub=fs.collection(storePath('prefs')).onSnapshot(qs=>{
      let changed=false;
      qs.docChanges().forEach(c=>{ changed = applyPrefsDoc(c.doc.id, c.type==='removed' ? null : c.doc.data()) || changed; });
      prefsLoaded(changed);
    }, cloudReadError);
  } else {
    cloud.prefsUnsub=fs.doc(storePath('prefs/'+currentUserId)).onSnapshot(snap=>{
      prefsLoaded(applyPrefsDoc(currentUserId, snap.exists ? snap.data() : null));
    }, cloudReadError);
  }
}
// 1人分の勤務希望を DB に反映する。内容が変わっていれば true
function applyPrefsDoc(uid,data){
  const part=clean(data||{}), json=stableStringify(part);
  if(json===(cloud.prefsJson[uid]||'{}')) return false;
  cloud.prefsJson[uid]=json;
  if(part.employee_preferences) DB.employee_preferences[uid]=part.employee_preferences; else delete DB.employee_preferences[uid];
  if(part.default_availability) DB.default_availability[uid]=part.default_availability; else delete DB.default_availability[uid];
  if(part.submission) DB.submissions[uid]=part.submission; else delete DB.submissions[uid];
  return true;
}
// 勤務希望を読み込み終えたとき
function prefsLoaded(changed){
  cloud.prefsLoaded=true;
  if(changed || !cloud.ready) refreshAfterCloud();
}
// 古いデータを消す（保存できる量に上限があるため。app/main は1MBまで）。何か消したら true を返す。
// 今月を含めて7か月より前の月（今が10月なら3月以前）の、シフト・人員不足の記録・公開の記録・勤務希望・月最低休日数を消す。
// データを書き換えられるのは管理者だけなので、管理者がアプリを開いたときに行う（refreshAfterCloud）
const KEEP_MONTHS = 6; // 今月より前に残す月数
function pruneOldData(){
  const s=DB.settings;
  let cutoff=addMonthsIso(iso(new Date()).slice(0,8)+'01', -KEEP_MONTHS); // この日より前を消す
  if(s.period_start && s.period_start<cutoff) cutoff=s.period_start; // 作成中の対象期間のデータは消さない
  let changed=false;
  const keepNew=(list,dateOf)=>{
    const out=list.filter(x=>dateOf(x)>=cutoff);
    if(out.length!==list.length) changed=true;
    return out;
  };
  DB.shifts=keepNew(DB.shifts, sh=>sh.date);
  s.shortages=keepNew(s.shortages||[], x=>x.date);
  s.published_periods=keepNew(publishedPeriods(), pp=>pp.end); // 最後の日まで古い期間だけ消す
  const offs=s.min_days_off||{};
  for(const month in offs){ if(month<cutoff.slice(0,7)){ delete offs[month]; changed=true; } }
  for(const uid in DB.employee_preferences){
    const p=DB.employee_preferences[uid]||{};
    for(const date in p){ if(date<cutoff){ delete p[date]; changed=true; } }
  }
  return changed;
}
// クラウドから読み込んだあとの処理。最初の読み込みが終わったときは、ログインの記録などもする
function refreshAfterCloud(){
  if(cloud.mainLoaded && cloud.prefsLoaded && !cloud.ready){
    cloud.ready=true;
    recordLogin(); // 読み込みが終わって画面を表示できた＝ログインできたので、今日の日付を記録する
    if(cloud.prefsAsAdmin===true && pruneOldData()) save(); // 管理者が開いたときだけ、古いデータを消す
  } else if(activeTab==='password'){
    return; // パスワード変更の画面はクラウドのデータを表示しないので、描き直さない（入力途中のパスワードが消えないように）
  }
  render();
}
// 最終ログイン日（今日の日付だけ）を lastLogin/{自分のID} に保存する。
// 記録に失敗してもアプリはそのまま使えるので、アラートは出さない
function recordLogin(){
  fs.doc(storePath('lastLogin/'+currentUserId)).set({date:iso(new Date())})
    .catch(err=>console.error('最終ログイン日を記録できませんでした', err));
}
// 管理者だけ、全員の最終ログイン日を受信する（「ログイン履歴」の画面で使う）。従業員はルールで読めないので受信しない
function subscribeLastLogins(asAdmin){
  if(cloud.lastLoginUnsub){ cloud.lastLoginUnsub(); cloud.lastLoginUnsub=null; }
  cloud.lastLogins={}; cloud.lastLoginError=false;
  if(!asAdmin) return;
  cloud.lastLoginUnsub=fs.collection(storePath('lastLogin')).onSnapshot(qs=>{
    qs.docChanges().forEach(c=>{
      if(c.type==='removed') delete cloud.lastLogins[c.doc.id];
      else cloud.lastLogins[c.doc.id]=c.doc.data().date;
    });
    if(activeTab==='logins') render(); // 入力欄のない画面なので、表示中に描き直しても入力途中の内容が消えることはない
  }, err=>{
    // 読めなくてもアプリは使えるので、ログアウトはさせず、画面で知らせるだけにする
    console.error(err);
    cloud.lastLoginError=true;
    if(activeTab==='logins') render();
  });
}
// 読み込めなかったとき（在籍中でない・削除された・通信エラーなど）はログアウトして理由を表示する
function cloudReadError(err){
  console.error(err);
  stopCloudSync();
  loginError = err.code==='permission-denied'
    ? 'このアカウントは現在利用できません（在籍中でない、または削除されています）。管理者に確認してください。'
    : authErrorMessage(err);
  auth.signOut();
}

// 新しい店舗のデータを作る（店舗コードの登録と、最初の管理者1人だけの店舗データ）。
// batch（一括書き込み）なので、途中で失敗しても中途半端な状態にはならない
// （同じ店舗コードが直前にほかの人に登録された場合も、ルールで断られて全体が取り消される）
async function createStoreData(store, admin){
  const src=seed();
  src.users=[admin];
  const base='stores/'+store.id+'/';
  const batch=fs.batch();
  batch.set(fs.doc('storeCodes/'+store.code), {storeId:store.id, name:store.name});
  batch.set(fs.doc(base+'app/main'), mainDocOf(mainPartOf(src)));
  Object.entries(loginsOf(src)).forEach(([no,uid])=>batch.set(fs.doc(base+'logins/'+no), {uid}));
  await batch.commit();
}

/* ============================================================
   日付ユーティリティ
   ============================================================ */
function iso(d){ const z=new Date(d); z.setMinutes(z.getMinutes()-z.getTimezoneOffset()); return z.toISOString().slice(0,10); }
function isoAddDays(isoStr,n){ const d=new Date(isoStr+'T00:00'); d.setDate(d.getDate()+n); return iso(d); }
function rangeDates(a,b){ const out=[]; let d=a; let guard=0; while(d<=b && guard<400){ out.push(d); d=isoAddDays(d,1); guard++; } return out; }
function dowOf(isoStr){ return new Date(isoStr+'T00:00').getDay(); }
const isWeekendDow = dow => dow===0 || dow===6; // 日(0)・土(6)

/* ---------- 日本の祝日（アプリが自動で計算する） ---------- */
// 今の法律（祝日法）の決まりで計算する。法律が変わったときは、ここを直す。
//   ・日付が決まっている祝日、「◯月の第◯月曜日」の祝日、春分の日・秋分の日（計算式。1980〜2099年で使える）
//   ・振替休日：祝日が日曜日なら、その後のいちばん近い祝日でない日が休み
//   ・国民の休日：前の日と次の日が祝日の日（祝日でない日）も休み（例：2026年9月22日）
const jpHolidayCache={}; // 西暦 -> {'YYYY-MM-DD': 祝日の名前}
function jpHolidaysOf(y){
  if(jpHolidayCache[y]) return jpHolidayCache[y];
  const ymd=(m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  // その月の第 n 月曜日
  const nthMonday=(m,n)=>{ const first=new Date(y,m-1,1).getDay(); return 1+((8-first)%7)+(n-1)*7; };
  const springDay=Math.floor(20.8431+0.242194*(y-1980)-Math.floor((y-1980)/4));
  const autumnDay=Math.floor(23.2488+0.242194*(y-1980)-Math.floor((y-1980)/4));
  const h={};
  [[1,1,'元日'],[1,nthMonday(1,2),'成人の日'],[2,11,'建国記念の日'],[2,23,'天皇誕生日'],[3,springDay,'春分の日'],
   [4,29,'昭和の日'],[5,3,'憲法記念日'],[5,4,'みどりの日'],[5,5,'こどもの日'],[7,nthMonday(7,3),'海の日'],
   [8,11,'山の日'],[9,nthMonday(9,3),'敬老の日'],[9,autumnDay,'秋分の日'],[10,nthMonday(10,2),'スポーツの日'],
   [11,3,'文化の日'],[11,23,'勤労感謝の日']].forEach(([m,d,name])=>{ h[ymd(m,d)]=name; });
  const national=Object.keys(h); // 「国民の祝日」そのもの（振替休日・国民の休日を足す前）
  // 国民の休日：前の日と次の日が国民の祝日で、その日は祝日でない日
  for(const d of national){
    const mid=isoAddDays(d,1);
    if(!h[mid] && h[isoAddDays(d,2)] && national.includes(isoAddDays(d,2))) h[mid]='国民の休日';
  }
  // 振替休日：日曜日の祝日のあと、いちばん近い祝日でない日
  for(const d of national){
    if(dowOf(d)!==0) continue;
    let x=isoAddDays(d,1);
    while(h[x]) x=isoAddDays(x,1);
    h[x]='振替休日';
  }
  return jpHolidayCache[y]=h;
}
// その日の祝日の名前（祝日でなければ空文字）
const jpHolidayName = isoStr => jpHolidaysOf(Number(isoStr.slice(0,4)))[isoStr] || '';
// 日付の種類：'sun'（日曜日・祝日）／'sat'（土曜日）／''（平日）。カレンダーと A3 画像で、列の背景色を分けるのに使う
const dayKindOf = isoStr => (dowOf(isoStr)===0 || jpHolidayName(isoStr)) ? 'sun' : dowOf(isoStr)===6 ? 'sat' : '';

/* ---------- 職務の休業日 ---------- */
// 土日祝が休業日の職務（変わらない id で決める。法人は土日祝休み）。
// 休業日は、その職務の必要最低人数を数えず、その職務の人もシフトに入れない（カレンダーなどには「公」と出す）
const CLOSED_ON_WEEKENDS_AND_HOLIDAYS = ['corporate'];
const isDutyClosed = (duty, isoStr) => CLOSED_ON_WEEKENDS_AND_HOLIDAYS.includes(duty) && (isWeekendDow(dowOf(isoStr)) || !!jpHolidayName(isoStr));
// 勤務希望を提出していない社員に使う記号（職務の id → 記号名）。法人の社員は、提出していなければ休業日以外すべて「A2」。
// 記号の時間は「シフト記号設定」の、記号名がこの名前の記号に従う（無ければ使えない）
const FIXED_CODE_IF_UNSUBMITTED = {corporate:'A2'};
// その社員に使う「提出していないときの記号」（シフト記号設定に無ければ null）
const fixedCodeIfUnsubmitted = u => {
  const label=FIXED_CODE_IF_UNSUBMITTED[dutyOf(u)];
  return (label && usesShiftCodes(u)) ? (shiftCodeList().find(c=>c.label===label) || null) : null;
};
// 平日／土日の一括設定の既定値（無ければ null）。
// 出勤可能時間（avail_start/avail_end）が無い古いデータは、希望（start/end）と同じ値を使う
function groupDefaultAvail(uid,group){
  const def=DB.default_availability && DB.default_availability[uid];
  if(!def) return null;
  const g=def[group];
  if(g && g.start && g.end) return {start:g.start, end:g.end, avail_start:g.avail_start||g.start, avail_end:g.avail_end||g.end};
  if(def.start && def.end) return {start:def.start, end:def.end, avail_start:def.avail_start||def.start, avail_end:def.avail_end||def.end}; // 旧形式（平日／土日を分ける前のデータ）
  return null;
}
// 営業時間：必要最低人数の時間帯の、最も早い開始〜最も遅い終了（職務が未設定の時間帯は含めない）
function businessWindow(){
  const rows=(DB.required_staff||[]).filter(r=>dutyOf(r));
  if(rows.length===0) return null;
  let open=null, close=null;
  for(const r of rows){
    const s=toMin(r.start), e=toMin(r.end);
    if(open===null || s<open) open=s;
    if(close===null || e>close) close=e;
  }
  return { open: toHM(open), close: toHM(close) };
}
// 一括設定の欄の初期値（本人の既定値が無いとき）：営業時間。
// businessWindow() は {open,close} の形なので、勤務希望と同じ {start,end} の形に直す
function groupBizHoursFallback(group){
  const bw=businessWindow();
  const fb = bw ? {start:bw.open, end:bw.close} : {start:'10:00', end:'18:00'};
  return {...fb, avail_start:fb.start, avail_end:fb.end}; // 出勤可能時間も、まずは希望と同じ値を初期値にしておく
}
// その日の勤務希望の初期値：本人の一括設定の既定値（平日／土日）、無ければ営業時間。
// {start,end}（希望）と {avail_start,avail_end}（出勤可能。人員不足のときだけ頼ってよい範囲）を返す
function defaultAvailFor(uid,dateIso){
  const group=isWeekendDow(dowOf(dateIso))?'weekend':'weekday';
  const g=groupDefaultAvail(uid,group);
  if(g) return {start:g.start, end:g.end, avail_start:g.avail_start, avail_end:g.avail_end};
  const bw=businessWindow();
  const fb = bw ? {start:bw.open, end:bw.close} : {start:'10:00', end:'18:00'};
  return {...fb, avail_start:fb.start, avail_end:fb.end};
}
// 画面に出す日付（例：11/3(火)）
function fmtDate(isoStr){ const d=new Date(isoStr+'T00:00'); return `${d.getMonth()+1}/${d.getDate()}(${DOW[d.getDay()]})`; }
// その日が含まれる週（月曜〜日曜）の月曜日。週ごとに集計するときの名前に使う
function isoWeekKey(isoStr){ const d=new Date(isoStr+'T00:00'); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); return iso(d); }

/* ---------- 希望提出締切 ---------- */
// 締切は「対象期間の初日の何日前か」（1〜60の整数）。設定が無ければ初期値を使う
function deadlineDaysBefore(){
  const n=DB.settings.deadline_days_before;
  return (Number.isInteger(n) && n>=1) ? n : DEFAULT_DEADLINE_DAYS_BEFORE;
}
// 対象期間の初日が periodStart のときの締切日（初日が未設定なら空文字）
function deadlineDateOf(periodStart){
  return periodStart ? isoAddDays(periodStart,-deadlineDaysBefore()) : '';
}
// 今の対象期間の締切を過ぎているか。締切日の当日はまだ受付中で、翌日から締切後になる。
// 日付は 'YYYY-MM-DD' の文字列のまま比べる（桁数がそろっているので、文字列の大小＝日付の前後になる）
function isAfterDeadline(){
  const deadline=deadlineDateOf(DB.settings.period_start);
  return deadline!=='' && iso(new Date())>deadline;
}

/* ---------- 月の計算・次の対象期間 ---------- */
// isoStr の n か月後の同じ日。その月に同じ日が無ければ月末にそろえる（例：1/31 の1か月後 → 2/28）
function addMonthsIso(isoStr,n){
  const d=new Date(isoStr+'T00:00');
  const day=d.getDate();
  const t=new Date(d.getFullYear(), d.getMonth()+n, 1);
  const lastDay=new Date(t.getFullYear(), t.getMonth()+1, 0).getDate(); // 「翌月の0日」＝その月の末日
  t.setDate(Math.min(day,lastDay));
  return iso(t);
}
// その日が含まれる月の末日
function lastDayOfMonthIso(isoStr){ const d=new Date(isoStr+'T00:00'); return iso(new Date(d.getFullYear(), d.getMonth()+1, 0)); }
// 2つの日付の差（日数）。Math.round で、時差などで端数が出ても整数にそろえる
function daysBetween(a,b){ return Math.round((new Date(b+'T00:00')-new Date(a+'T00:00'))/86400000); }
// 今の対象期間の次の期間（公開したときに進める先）。必ず今の期間の翌日から始める（すき間・重なりを作らない）。
//   ① 1か月単位（1日〜月末、21日〜翌月20日など）→ 次の1か月
//   ② 半月単位（1日〜15日 → 16日〜月末、16日〜月末 → 翌月1日〜15日）
//   ③ それ以外（1週間・2週間など）→ 同じ日数
function nextPeriodOf(start,end){
  const nextStart=isoAddDays(end,1);
  if(isoAddDays(addMonthsIso(start,1),-1)===end){ // ① 1か月単位
    return {start:nextStart, end:isoAddDays(addMonthsIso(nextStart,1),-1)};
  }
  if(start.slice(8)==='01' && end.slice(8)==='15'){ // ② 半月単位（前半 → 後半）
    return {start:nextStart, end:lastDayOfMonthIso(nextStart)};
  }
  if(start.slice(8)==='16' && end===lastDayOfMonthIso(start)){ // ② 半月単位（後半 → 翌月の前半）
    return {start:nextStart, end:nextStart.slice(0,8)+'15'};
  }
  const len=daysBetween(start,end)+1; // ③ 決まった日数（1週間・2週間など）
  return {start:nextStart, end:isoAddDays(end,len)};
}

/* ---------- 時刻 ---------- */
// "10:30" → 630（0時からの分）、630 → "10:30"
const toMin=t=>{ const [h,m]=t.split(':').map(Number); return h*60+m; };
const toHM =m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
// 出勤・退勤時刻の入力を00分／30分だけに固定する（最も近い30分刻みに丸める）
const snapHalfHour=t=>{ if(!t) return t; const snapped=Math.min(1410, Math.max(0, Math.round(toMin(t)/30)*30)); return toHM(snapped); };
// シフト記号の時刻は10分刻みにそろえる（9:40 のような時刻も入れられるように）
const snapTenMin=t=>{ if(!t) return t; return toHM(Math.min(1430, Math.max(0, Math.round(toMin(t)/10)*10))); };

/* 希望（start/end）と出勤可能時間（avail_start/avail_end）
   ・希望：普段働きたい時間。自動作成でまず入れるのはこちら。
   ・出勤可能時間：人員不足の穴埋めのときだけ頼ってよい、希望と同じか広い範囲。
   availRangeMin は出勤可能時間を [開始分, 終了分] で返す。入力が無ければ希望と同じ範囲とし、
   希望がはみ出していれば広げる（穴埋めできるはずの人を、誤って対象外にしないため） */
function availRangeMin(p){
  const ps=toMin(p.start), pe=toMin(p.end);
  const as=p.avail_start ? toMin(p.avail_start) : ps;
  const ae=p.avail_end ? toMin(p.avail_end) : pe;
  return [Math.min(as,ps), Math.max(ae,pe)];
}

/* ============================================================
   ログイン・画面の状態
   ============================================================ */
let currentUserId = null;    // ログイン中の人の内部ID（Firebase のログイン状態から決まる。onAuthStateChanged 参照）
let editingCell = null;      // カレンダーで編集中のマス {userId, date}（カレンダーを離れたら null）
let calPeriodKey = 'target'; // カレンダーで表示中の期間（'target'＝対象期間、それ以外は公開済み期間の 'start_end'）
let generating = false;      // 自動作成の計算中か（ボタンを「作成中…」にして、二重に押せないようにする）
let calDuty = null;          // カレンダーで表示中の職務の id（null＝自分の職務か一覧の先頭、'none'＝職務が未設定の人）
let myShiftPeriodKey = null; // 「自分のシフト確認」で選んでいる公開済み期間の 'start_end'（null＝自動で選ぶ）
function currentUser(){ return DB.users.find(u=>u.id===currentUserId); }
function isAdmin(){ return currentUser() && currentUser().role==='admin'; }
// 社員番号として使えるか。使えなければ理由の文章を、使えれば空文字を返す（数字7桁以内で、ほかの人と重ならないこと）。
// exceptId：番号を変更するときの本人の内部ID（本人の今の番号とは比べない）
function empNoError(empNo, exceptId){
  if(!/^[0-9]{1,7}$/.test(empNo)) return '社員番号は数字7桁以内で入力してください。';
  if(DB.users.some(u=>u.id!==exceptId && u.empNo===empNo)) return `社員番号「${empNo}」はすでに他の人が使っています。`;
  return '';
}
// 内部IDを作る。ログイン用アカウントは全店舗で1つの名簿なので、ほかの店舗の人と重ならないよう、
// 時刻（36進数）にランダムな文字を足す。英小文字と数字だけなのは、メールアドレスの形では大文字が小文字に直されるため
function genUserId(){ return 'u_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10); }
let loginError='';
let authScreen='login';       // 'login' | 'setPassword' | 'storeRegister'（店舗が未選択なら店舗選択の画面を出す）
let pwSetError='';
let storeError='';            // 店舗選択・店舗登録の画面に出すエラー
let storeRegDraft={};         // 店舗登録の入力途中の内容（エラーで描き直しても消えないように。パスワードは残さない）
let authBusy=false;           // 通信中（ボタンの二度押し防止）
function go2Auth(screen){ authScreen=screen; loginError=''; pwSetError=''; storeError=''; render(); }
// エラーの種類ごとに、利用者に見せる文章を決める
function appError(msg){ return {code:'app/message', message:msg}; }
function authErrorMessage(e){
  const c=(e && e.code) || '';
  if(c==='app/message') return e.message;
  if(c==='auth/invalid-credential' || c==='auth/invalid-login-credentials' || c==='auth/wrong-password' || c==='auth/user-not-found')
    return '社員番号またはパスワードが正しくありません。初めてログインする方は「初めてログインする（パスワード設定）」から設定してください。';
  if(c==='auth/email-already-in-use') return 'この社員番号はすでにパスワードが設定されています。ログイン画面からログインしてください。';
  if(c==='auth/weak-password') return 'パスワードは6文字以上にしてください。';
  if(c==='auth/too-many-requests') return 'ログインの失敗が続いたため、一時的にログインできなくなっています。しばらく待ってからやり直してください。';
  if(c==='auth/network-request-failed' || c==='unavailable') return USE_EMULATOR
    ? 'ローカル確認用の Firebase（エミュレーター）につながりません。start-local.bat を起動してから、ページを再読み込みしてください。'
    : '通信できませんでした。インターネット接続を確認してください。';
  if(c==='permission-denied') return 'データにアクセスする権限がありません。Firebase のセキュリティルール（firestore.rules）が公開されているか確認してください。';
  if(c==='auth/api-key-not-valid.-please-pass-a-valid-api-key.' || c==='auth/invalid-api-key') return 'Firebase の設定（apiKey）が正しくありません。script.js の firebaseConfig を確認してください。';
  return 'エラーが発生しました（'+(c || (e && e.message) || '不明')+'）';
}
// 今選んでいる店舗の中で、社員番号から内部IDを調べる
async function lookupLogin(empNo){
  // 数字以外（「/」など）が入ると保存場所の指定がおかしくなるので、先に形を確かめる
  if(!/^[0-9]{1,7}$/.test(empNo)) throw appError('社員番号は数字7桁以内で入力してください。');
  const login=await fs.doc(storePath('logins/'+empNo)).get();
  if(!login.exists) throw appError('この店舗に、その社員番号の人は登録されていません。店舗と社員番号を確認してください。');
  return login.data().uid;
}
// ログイン・パスワード設定・店舗登録の共通処理。login には Firebase にログインする関数を渡す
async function runAuth(errorTarget, login){
  if(authBusy) return;
  authBusy=true; loginError=''; pwSetError=''; storeError=''; render();
  try{
    await login();
    activeTab='dash'; // 従業員の場合は、render() で従業員用の最初のタブに切り替わる
    authScreen='login';
  }catch(e){
    console.error(e);
    const msg=authErrorMessage(e);
    if(errorTarget==='login') loginError=msg; else if(errorTarget==='store') storeError=msg; else pwSetError=msg;
    if(cloud.setupInProgress){ cloud.setupInProgress=false; auth.signOut(); }
  }
  authBusy=false; render();
}
function doLogin(){
  const empNo=(document.getElementById('lgEmpNo').value||'').trim();
  const pw=document.getElementById('lgPw').value||'';
  if(!empNo || !pw){ loginError='社員番号とパスワードを入力してください。'; render(); return; }
  runAuth('login', async ()=>{
    const uid=await lookupLogin(empNo);
    await auth.signInWithEmailAndPassword(emailOf(uid),pw);
  });
}
/* 初回ログイン時のパスワード設定（Firebase にその人のアカウントを作る） */
function setInitialPassword(){
  const empNo=(document.getElementById('spEmpNo').value||'').trim();
  const pw=document.getElementById('spPw').value||'';
  const pw2=document.getElementById('spPw2').value||'';
  if(!empNo){ pwSetError='社員番号を入力してください。'; render(); return; }
  if(pw.length<6){ pwSetError='パスワードは6文字以上にしてください。'; render(); return; }
  if(pw!==pw2){ pwSetError='パスワードが一致しません。'; render(); return; }
  runAuth('setPassword', async ()=>{
    const uid=await lookupLogin(empNo);
    await auth.createUserWithEmailAndPassword(emailOf(uid),pw);
    alert('パスワードを設定しました。次回からは社員番号とこのパスワードでログインしてください。');
  });
}

/* ---------- 店舗の選択・登録 ---------- */
const STORE_NAME_MAX=30; // 店舗名の最大文字数（firestore.rules でも同じ数で確かめている）
// 店舗コードから店舗を探して、ログインする店舗に決める（ログイン画面へ進む）
async function selectStore(){
  if(authBusy) return;
  const code=(document.getElementById('stCode').value||'').trim();
  // 4桁の数字以外（「/」など）が入ると保存場所の指定がおかしくなるので、先に形を確かめる
  if(!/^[0-9]{4}$/.test(code)){ storeError='店舗コードは4桁の数字で入力してください。'; render(); return; }
  authBusy=true; storeError=''; render();
  try{
    const snap=await fs.doc('storeCodes/'+code).get();
    if(snap.exists){
      setCurrentStore({code, id:snap.data().storeId, name:snap.data().name});
      authScreen='login'; loginError='';
    } else {
      storeError=`店舗コード「${code}」の店舗は見つかりません。番号を確認してください。`;
    }
  }catch(e){
    console.error(e);
    storeError=authErrorMessage(e);
  }
  authBusy=false; render();
}
// ログイン画面の「変更」：覚えていた店舗を忘れて、店舗選択の画面に戻る
function changeStore(){ setCurrentStore(null); go2Auth('login'); }
// 店舗を登録する：Firebase に最初の管理者のアカウントを作り、店舗のデータを書き込んで、そのままログインする
function registerStore(){
  const val=id=>(document.getElementById(id).value||'').trim();
  const d=storeRegDraft={code:val('rgCode'), name:val('rgName'), adminName:val('rgAdminName'), empNo:val('rgEmpNo')};
  const pw=document.getElementById('rgPw').value||'';
  const pw2=document.getElementById('rgPw2').value||'';
  let err='';
  if(!/^[0-9]{4}$/.test(d.code)) err='店舗コードは4桁の数字で入力してください。';
  else if(!d.name) err='店舗名を入力してください。';
  else if(d.name.length>STORE_NAME_MAX) err=`店舗名は${STORE_NAME_MAX}文字以内にしてください。`;
  else if(!d.adminName) err='管理者の氏名を入力してください。';
  else if(!/^[0-9]{1,7}$/.test(d.empNo)) err='社員番号は数字7桁以内で入力してください。';
  else if(pw.length<6) err='パスワードは6文字以上にしてください。';
  else if(pw!==pw2) err='パスワードが一致しません。';
  if(err){ storeError=err; render(); return; }
  runAuth('store', async ()=>{
    // アカウントを作る前に確かめる（使われているコードだと分かっているのに、アカウントだけ作ってしまわないように）
    if((await fs.doc('storeCodes/'+d.code).get()).exists) throw appError(`店舗コード「${d.code}」はすでに使われています。別の番号にしてください。`);
    // 店舗ID は Firestore に自動で決めてもらう（ほかと重ならないランダムな20文字）
    const store={code:d.code, id:fs.collection('stores').doc().id, name:d.name};
    // 登録した人は管理者になる。職務は付けない（シフトに入る場合は、ログイン後に従業員管理で職務を設定する）
    const id=genUserId();
    const admin={id, name:d.adminName, empNo:d.empNo, role:'admin', permission:null,
      is_active:true, openingDuty:false, closingDuty:false};
    cloud.setupInProgress=true; // 店舗のデータを書き込み終えるまで、受信を始めない（onAuthStateChanged 参照）
    await auth.createUserWithEmailAndPassword(emailOf(id),pw);
    try{
      await createStoreData(store, admin);
    }catch(e){
      await auth.currentUser.delete().catch(()=>{}); // 使われないアカウントを残さない（消すとログアウトもされる）
      throw e;
    }
    cloud.setupInProgress=false;
    setCurrentStore(store);
    storeRegDraft={};
    startCloudSync();
    alert(`店舗「${store.name}」（店舗コード ${store.code}）を登録しました。\n従業員は「従業員管理」から追加してください。`);
  });
}

function doLogout(){ auth.signOut(); }

// ログイン状態が変わったとき（ログイン・ログアウト・ページを開いたとき前回のログインが残っていた場合）
auth.onAuthStateChanged(user=>{
  cloud.authKnown=true;
  const uid=userIdOfAuth(user);
  if(!uid){
    stopCloudSync();
    currentUserId=null; editingCell=null; calPeriodKey='target'; calDuty=null; myShiftPeriodKey=null;
    DB=seed(); // ログアウトしたら画面にデータを残さない
    render(); return;
  }
  currentUserId=uid;
  if(cloud.setupInProgress){ render(); return; } // 店舗の登録中は、店舗のデータを書き込み終えてから受信を始める（registerStore 参照）
  // どの店舗のデータを読めばよいか分からない（端末に覚えていた店舗が消えたなど）ときは、ログアウトして店舗を選び直してもらう
  if(!currentStore){ auth.signOut(); return; }
  startCloudSync();
  render();
});

// ログイン画面・パスワード設定の画面の上に出す、どの店舗にログインするかの表示
function storeBoxHTML(){
  return `<div class="store-box">
    <span>店舗：<b>${escHtml(currentStore.code)} ${escHtml(currentStore.name)}</b></span>
    <button class="ghost mini" onclick="changeStore()">変更</button>
  </div>`;
}
function viewStoreSelect(){
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">店舗</span> 店舗の選択</h2>
    <p class="desc">ログインする店舗の店舗コード（4桁の数字）を入力してください。一度選んだ店舗は、この端末に記録されます。</p>
    ${storeError?`<div class="banner warn">${storeError}</div>`:''}
    <div class="row"><label style="width:100%">店舗コード（4桁）<br>
      <input id="stCode" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" style="width:100%" placeholder="1234"
        onkeydown="if(event.key==='Enter')selectStore()"></label></div>
    <div class="row"><button style="width:100%" ${authBusy?'disabled':''} onclick="selectStore()">${authBusy?'確認中…':'次へ'}</button></div>
    <div class="row" style="margin-bottom:4px"><button class="ghost" style="width:100%" onclick="go2Auth('storeRegister')">新しい店舗を登録する</button></div>
    <p class="note">店舗コードは、店舗の管理者から伝えられた番号です。</p>
  </div>`;
}
function viewStoreRegister(){
  const d=storeRegDraft;
  const v=k=>d[k]?` value="${escHtml(d[k])}"`:''; // 入力途中の内容を戻す
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">新規登録</span> 店舗の登録</h2>
    <p class="desc">店舗コードと店舗名、最初の管理者を登録します。登録が終わると、その管理者でそのままログインします。</p>
    ${storeError?`<div class="banner warn">${storeError}</div>`:''}
    <fieldset><legend>店舗</legend>
      <div class="row"><label style="width:100%">店舗コード（4桁の数字）<br>
        <input id="rgCode" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" style="width:100%" placeholder="1234"${v('code')}></label></div>
      <div class="row" style="margin-bottom:0"><label style="width:100%">店舗名（${STORE_NAME_MAX}文字以内）<br>
        <input id="rgName" type="text" maxlength="${STORE_NAME_MAX}" style="width:100%" placeholder="〇〇店"${v('name')}></label></div>
    </fieldset>
    <fieldset><legend>最初の管理者</legend>
      <div class="row"><label style="width:100%">氏名<br>
        <input id="rgAdminName" type="text" style="width:100%" placeholder="氏名"${v('adminName')}></label></div>
      <div class="row"><label style="width:100%">社員番号（7桁以内）<br>
        <input id="rgEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" style="width:100%" placeholder="1234567"${v('empNo')}></label></div>
      <div class="row"><label style="width:100%">パスワード（6文字以上）<br>
        <input id="rgPw" type="password" style="width:100%" placeholder="パスワード"></label></div>
      <div class="row" style="margin-bottom:0"><label style="width:100%">パスワード（確認）<br>
        <input id="rgPw2" type="password" style="width:100%" placeholder="パスワード（再入力）"
          onkeydown="if(event.key==='Enter')registerStore()"></label></div>
    </fieldset>
    <div class="row"><button style="width:100%" ${authBusy?'disabled':''} onclick="registerStore()">${authBusy?'処理中…':'登録してログイン'}</button></div>
    <div class="row" style="margin-bottom:4px"><button class="ghost mini" onclick="go2Auth('login')">← 店舗の選択に戻る</button></div>
    <p class="note">店舗コードは、ほかの店舗と同じ番号にはできません。管理者自身もシフトに入る場合は、ログイン後に「従業員管理」で自分の職務を設定してください。</p>
  </div>`;
}
function viewSetPassword(){
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">初回ログイン</span> パスワード設定</h2>
    ${storeBoxHTML()}
    <p class="desc">初めてログインする方は、社員番号と、今後ログインに使うパスワード（6文字以上）を設定してください。社員番号は管理者から伝えられた番号です。</p>
    ${pwSetError?`<div class="banner warn">${pwSetError}</div>`:''}
    <div class="row"><label style="width:100%">社員番号（7桁以内）<br>
      <input id="spEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" style="width:100%" placeholder="1234567"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（6文字以上）<br>
      <input id="spPw" type="password" style="width:100%" placeholder="パスワード"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（確認）<br>
      <input id="spPw2" type="password" style="width:100%" placeholder="パスワード（再入力）"
        onkeydown="if(event.key==='Enter')setInitialPassword()"></label></div>
    <div class="row"><button style="width:100%" ${authBusy?'disabled':''} onclick="setInitialPassword()">${authBusy?'処理中…':'設定してログイン'}</button></div>
    <div class="row" style="margin:0"><button class="ghost mini" onclick="go2Auth('login')">← ログイン画面に戻る</button></div>
  </div>`;
}
// ログイン前の画面：店舗登録 ／ 店舗選択（店舗が未選択のとき）／ パスワード設定 ／ ログイン
function viewLogin(){
  if(authScreen==='storeRegister') return viewStoreRegister();
  if(!currentStore) return viewStoreSelect();
  if(authScreen==='setPassword') return viewSetPassword();
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">ログイン</span> ログイン画面</h2>
    ${storeBoxHTML()}
    <p class="desc">社員番号（7桁以内）とパスワードでログインしてください。</p>
    ${loginError?`<div class="banner warn">${loginError}</div>`:''}
    <div class="row"><label style="width:100%">社員番号（7桁以内）<br>
      <input id="lgEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" style="width:100%" placeholder="1234567"
        onkeydown="if(event.key==='Enter')doLogin()"></label></div>
    <div class="row"><label style="width:100%">パスワード<br>
      <input id="lgPw" type="password" style="width:100%" placeholder="パスワード"
        onkeydown="if(event.key==='Enter')doLogin()"></label></div>
    <div class="row"><button style="width:100%" ${authBusy?'disabled':''} onclick="doLogin()">${authBusy?'処理中…':'ログイン'}</button></div>
    <div class="row" style="margin-bottom:4px"><button class="ghost" style="width:100%" onclick="go2Auth('setPassword')">初めてログインする（パスワード設定）</button></div>
    <p class="note">初めて使う方は「初めてログインする」から、管理者に伝えられた社員番号でパスワードを設定してください。</p>
  </div>`;
}


/* ============================================================
   シフト自動作成エンジン
   ============================================================ */
// 必要最低人数を、職務ごとに10分（SLOT_MIN）刻みへ広げる：{職務: {開始分: 人数}}。
// 同じ職務で時間帯が重なるときは大きい方を使う。職務が未設定の時間帯は使わない
function slotRequiredByDuty(){
  const byDuty={};
  for(const r of DB.required_staff){
    const duty=dutyOf(r);
    if(!duty) continue;
    const map=byDuty[duty]=byDuty[duty]||{};
    for(let m=toMin(r.start); m<toMin(r.end); m+=SLOT_MIN){
      map[m]=Math.max(map[m]||0, r.count);
    }
  }
  return byDuty;
}
// 最高人数も同じように広げる：{職務: {開始分: 人数}}。空欄の行は入れない（その時間帯は上限なし）。
// 重なるときは、最高人数が入っている行のうち大きい方を使う。必要最低人数より少なくはしない
function slotMaxByDuty(reqBy){
  const byDuty={};
  for(const r of DB.required_staff){
    const duty=dutyOf(r);
    if(!duty || !Number.isInteger(r.max)) continue;
    const map=byDuty[duty]=byDuty[duty]||{};
    for(let m=toMin(r.start); m<toMin(r.end); m+=SLOT_MIN){
      map[m]=Math.max(map[m]||0, r.max, reqBy[duty][m]);
    }
  }
  return byDuty;
}
// 必要最低人数が設定されている職務（職務の一覧の並び順）
const dutiesWithRequirement = reqBy => dutyList().map(d=>d.id).filter(id=>reqBy[id]);

function generateShifts(){
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end);
  DB.shifts = DB.shifts.filter(sh=> !(sh.date>=s.period_start && sh.date<=s.period_end));

  // 全体の流れ
  //   手順1：月最低休日数を守るため、休みにする日を先に決める（forcedRest）
  //   手順2：職務設定の並び順に、1つの職務の1か月分ずつ作る（buildDuty）
  //   手順3：休みの日を入れ替えて、人員不足を減らす
  //   手順4：でき上がったシフトを保存し、人員不足を記録する
  // 人数を数えるのも不足を埋めるのも同じ職務の人だけなので、職務どうしは影響し合わない。

  // ---- 準備：何度も使う値を先に求めておく ----
  // （休みの日を決めるときなどは何千回も計算するので、"10:30" のような文字列を毎回分に直すと遅くなる）
  const reqBy=slotRequiredByDuty();   // 職務 -> {開始分: 必要最低人数}
  const maxBy=slotMaxByDuty(reqBy);   // 職務 -> {開始分: 最高人数}（上限なしの時間帯は無い）
  const userDuty={};                   // userId -> 職務（未設定は null）
  DB.users.forEach(u=>{ userDuty[u.id]=dutyOf(u); });
  // 勤務希望を提出していない法人の社員は、入力の有無にかかわらず、毎日「A2」を選んだものとして扱う（休業日は hasPref で外れる）
  const fixedPref={}; // userId -> その人の毎日の勤務希望
  DB.users.forEach(u=>{
    const c=fixedCodeIfUnsubmitted(u);
    if(c && DB.submissions[u.id]!==s.period_start) fixedPref[u.id]={day_off:false, codes:[c.id], start:c.start, end:c.end, avail_start:c.start, avail_end:c.end};
  });
  const prefOf=(u,d)=>fixedPref[u.id] || (DB.employee_preferences[u.id]||{})[d];
  // その日に出勤できると希望を出しているか（希望休でない。社員は記号を1つ以上選んでいる）。
  // その人の職務の休業日（法人の土日祝）は、希望を出していても出勤できない日として扱う
  const hasPref=(u,d)=>{
    const p=prefOf(u,d);
    if(!(p && !p.day_off && p.start && p.end) || isDutyClosed(userDuty[u.id],d)) return false;
    const codes=usesShiftCodes(u) ? prefCodesOf(p) : null;
    return !(codes && codes.length===0);
  };
  const minCache={}; // "10:30" → 630 の変換結果を覚えておく
  const mins=t=>minCache[t]!==undefined ? minCache[t] : (minCache[t]=toMin(t));
  const hmCache={}; // 630 → "10:30" の変換結果も覚えておく
  const hmOf=m=>hmCache[m]!==undefined ? hmCache[m] : (hmCache[m]=toHM(m));
  // 出勤可能時間 [開始分, 終了分]（availRangeMin と同じ。変換結果を覚えておく mins を使う）
  const availOf=p=>{ const ps=mins(p.start), pe=mins(p.end), as=p.avail_start?mins(p.avail_start):ps, ae=p.avail_end?mins(p.avail_end):pe; return [Math.min(as,ps), Math.max(ae,pe)]; };

  // 穴埋めで勤務を30分刻みに広げるときの基準（営業時間の開始から30分ごと）
  const bwAnchor=businessWindow(); const anchor=bwAnchor?mins(bwAnchor.open):0;
  const snapDown30=t=>anchor+Math.floor((t-anchor)/30)*30;
  const snapUp30=t=>anchor+Math.ceil((t-anchor)/30)*30;

  // 立ち上げ番・閉め番の時間帯。出勤できるラベルの人のうち最優先の人（従業員一覧で上の人）を、②で最初に入れる
  const labelWindows=[
    {start:'09:30', end:'10:00', label:'openingDuty'},
    {start:'20:00', end:'20:30', label:'closingDuty'},
  ];

  const weekDates={}; // weekKey -> その週に含まれる対象期間内の日付一覧
  for(const d of days){ const wk=isoWeekKey(d); (weekDates[wk]=weekDates[wk]||[]).push(d); }
  const membersOf={}; // 職務 -> 自動作成で選べる人の一覧（従業員一覧の並び順）
  DB.users.forEach(u=>{ if(isAutoCandidate(u)) (membersOf[userDuty[u.id]]=membersOf[userDuty[u.id]]||[]).push(u); });
  const prefMin={};   // userId -> 日付 -> [希望の出勤分, 希望の退勤分]（希望を出していて希望休でない日だけ）
  DB.users.forEach(u=>{
    prefMin[u.id]={};
    // 社員の start/end は、選んだ記号の最も早い開始〜最も遅い終了（見積もりにだけ使う）
    for(const d of days){ const p=prefOf(u,d); if(hasPref(u,d)) prefMin[u.id][d]=[mins(p.start), mins(p.end)]; }
  });
  const reqList={};   // 職務 -> [[開始分, 必要最低人数], ...]
  for(const duty in reqBy) reqList[duty]=Object.keys(reqBy[duty]).map(t=>[Number(t), reqBy[duty][t]]);
  // 「u がいなかったら、d の日にその職務で何分不足するか」（足りない人数 × 分）。
  // ほかの人の希望だけで見積もる。先に休みと決めた人（forcedRest）はいないものとして数える
  // （休みの日を一人ずつ決めるとき、全員の休みが同じ日に集まらないようにするため）
  const deficitMinutesIfAbsent=(u,d)=>{
    const others=(membersOf[userDuty[u.id]]||[])
      .filter(cu=>cu.id!==u.id && prefMin[cu.id][d] && !forcedRest[cu.id][d])
      .map(cu=>prefMin[cu.id][d]);
    let deficit=0;
    for(const [t,need] of (reqList[userDuty[u.id]]||[])){
      const covering=others.filter(([ps,pe])=>ps<=t && pe>t).length;
      if(covering<need) deficit += (need-covering)*SLOT_MIN;
    }
    return deficit;
  };

  // ---- 手順1：月最低休日数（絶対に守る）のため、休みの日を先に決める ----
  // 出勤できる日（希望を出していて希望休でない日）が「期間の日数 − 月最低休日数」より多い人は、
  // 多い分だけ休みの日を先に決め、その日はどの段階でも入れない（穴埋めにも使わない）。
  // 休みにするのは、その人がいなくても足りやすい日（deficitMinutesIfAbsent が小さい日）から。
  // 同じなら、休みがかたまらないよう、もともと休みの日からいちばん離れた日にする
  const forcedRest={}; // userId -> {日付: true}（先に決めた休みの日）
  DB.users.forEach(u=>{ forcedRest[u.id]={}; });
  const minOffMonth=monthKeyOf(s.period_start);
  for(const u of DB.users){
    if(!isAutoCandidate(u)) continue;
    const minOff=minDaysOffFor(userDuty[u.id], minOffMonth);
    if(!minOff) continue;
    const avail=days.filter(d=>hasPref(u,d));
    const restCount=avail.length-Math.max(0, days.length-minOff); // 休みにしなければならない、出勤できる日の数
    if(restCount<=0) continue;
    const restIdx=days.map((d,i)=>avail.includes(d)?-1:i).filter(i=>i>=0); // もともと出勤しない日の位置
    const pool=avail.map(d=>({d, i:days.indexOf(d), deficit:deficitMinutesIfAbsent(u,d)}));
    const distToRest=x=>restIdx.length ? Math.min(...restIdx.map(i=>Math.abs(i-x.i))) : Infinity;
    for(let k=0;k<restCount;k++){
      const minDef=Math.min(...pool.map(x=>x.deficit));
      const pick=pool.filter(x=>x.deficit===minDef).reduce((a,b)=> distToRest(b)>distToRest(a) ? b : a);
      forcedRest[u.id][pick.d]=true;
      restIdx.push(pick.i);
      pool.splice(pool.indexOf(pick),1);
    }
  }
  // その日に入れられるか：希望を出していて希望休でなく、先に決めた休みの日でもない
  const canWork=(u,d)=>hasPref(u,d) && !forcedRest[u.id][d];
  // 社員がその日に入れる時間の候補 [[開始分, 終了分], ...]（選んだ記号の時間。時刻で出した古い希望なら、その時刻）
  const codeOptions=(u,d)=>{
    const p=prefOf(u,d), codes=prefCodesOf(p);
    return codes ? codes.map(c=>[mins(c.start), mins(c.end)]) : [[mins(p.start), mins(p.end)]];
  };

  // 扶養PA・扶養学生PAの週の上限を、あらかじめ出勤できる日に配分する（members はその職務の人）。
  // 日ごとに前から使っていくと、週の前半で上限を使い切り、後半の人手が足りない日に頼れなくなるため、
  // 「この人がいないと何分不足するか」が大きい日ほど多く配分しておく。
  // 戻り値：userId -> 日付 -> その日に割り当ててよい上限（分・30分刻み）
  const weeklyBudget=members=>{
    const paDayBudget={};
    members.forEach(u=>{ paDayBudget[u.id]={}; });
    for(const wk in weekDates){
      const datesInWeek=weekDates[wk];
      for(const u of members){
        const pa=PA_TYPES[u.permission];
        if(!pa || pa.weekCapMin==null || usesShiftCodes(u)) continue; // 上限のある扶養PA・扶養学生PAだけ（社員は対象外）
        const availableDates=datesInWeek.filter(d=>canWork(u,d)); // 先に決めた休みの日には配分しない
        if(availableDates.length===0) continue;
        const capForWeek=pa.weekCapMin-1; // 週の上限は「未満」
        const dayCapForStudent=(u.permission==='dependent_student') ? Math.floor((DEPENDENT_STUDENT_DAY_CAP_MIN-1)/30)*30 : Infinity;
        // 不足しやすい日から順に並べる
        const items=availableDates.map(d=>{
          const p=DB.employee_preferences[u.id][d];
          const submitted=Math.min(mins(p.end)-mins(p.start), dayCapForStudent);
          return {d, deficit:deficitMinutesIfAbsent(u,d), submitted, budget:0};
        }).sort((a,b)=>b.deficit-a.deficit);
        // (a) 不足しやすい日から、まず「最低3時間（希望がそれより短ければ希望の時間）」ずつ確保する。
        //     上限が足りなければ、不足しにくい日が後回しになる
        let remaining=capForWeek;
        for(const item of items){
          const base=Math.floor(Math.min(MIN_SHIFT_MIN, item.submitted)/30)*30;
          if(base>0 && base<=remaining){ item.budget=base; remaining-=base; }
        }
        // (b) 余った分を、不足しやすい日から順に希望の時間いっぱいまで足す
        for(const item of items){
          if(remaining<=0) break;
          if(item.budget<=0) continue; // (a) で確保できなかった日には、短い時間だけ足すことはしない
          const room=item.submitted-item.budget;
          const extra=Math.floor(Math.min(room, remaining)/30)*30;
          item.budget+=extra; remaining-=extra;
        }
        for(const item of items) paDayBudget[u.id][item.d]=item.budget;
      }
    }
    return paDayBudget;
  };

  // その日の立ち上げ番・閉め番の最優先の人（全職務の中から、時間帯ごとに1人）：[{u, ws, we}]。
  // 休みの日（forcedRest）で変わるので、使うたびに求める
  const topsOn=date=>{
    const out=[];
    for(const lw of labelWindows){
      const ws=mins(lw.start), we=mins(lw.end);
      const top=DB.users.find(u=>u[lw.label] && isAutoCandidate(u) && canWork(u,date)
        && mins(prefOf(u,date).start)<=ws && mins(prefOf(u,date).end)>=we);
      if(top) out.push({u:top, ws, we});
    }
    return out;
  };

  // ---- 手順2：1つの職務の1か月分を作る（buildDuty） ----
  // 今の休みの日（forcedRest）で作る。手順3で休みの日を入れ替えるたびに、その職務だけ作り直せるよう関数にしてある。
  // 月初の日から1日ずつ、その日の①〜⑤と穴埋めをすべて終えてから次の日へ進む
  const buildDuty=duty=>{
    const members=membersOf[duty]||[]; // この職務で自動作成に使える人
    const shifts=[];
    const req=reqBy[duty]||{};   // 開始分 -> 必要最低人数
    const maxOf=maxBy[duty]||{}; // 開始分 -> 最高人数
    const times=Object.keys(req).map(Number).sort((a,b)=>a-b);
    // ③で入れる目標の人数：最高人数があればそこまで、空欄なら必要最低人数まで
    const target=t=>maxOf[t]!=null ? maxOf[t] : req[t];
    const paDayBudget=weeklyBudget(members);
    // 日をまたいで積み上げる状態（その職務の人の分だけ）
    const weekMin={};  // userId -> weekKey -> それまでの週の実働分（扶養の週の上限の判定に使う）
    const streaks={};  // userId -> それまでの連続勤務日数（連勤ルール・穴埋めの判定に使う）
    members.forEach(u=>{ weekMin[u.id]={}; streaks[u.id]=0; });

    for(const date of (members.length ? days : [])){ // 選べる人がいない職務は作らない（不足として数えるだけ）
      const wk=isoWeekKey(date);
      let dayShifts=[]; // この日の、この職務のシフト（この日の最後に shifts へまとめて入れる）
      // その時刻 m に、この職務の人が何人入っているか（ignore は数えないシフト）
      const workingAt=(m,ignore)=>dayShifts.filter(sh=>sh!==ignore && mins(sh.start)<=m && mins(sh.end)>m).length;
      // その時刻 m が、すでに最高人数に達しているか（最高人数が空欄の時間帯は達しない）
      const isFull=(m,ignore)=>maxOf[m]!=null && workingAt(m,ignore)>=maxOf[m];
      // 勤務 [hs,he) の両端から、最高人数に達している時間を削る。
      // 達している時間が勤務の途中に残るなら null（1日の勤務は2つに分けないので、その人は入れない）
      const trimEdges=(hs,he)=>{
        while(hs<he && isFull(hs)) hs+=SLOT_MIN;
        while(he>hs && isFull(he-SLOT_MIN)) he-=SLOT_MIN;
        for(let m=hs;m<he;m+=SLOT_MIN){ if(isFull(m)) return null; }
        return [hs,he];
      };
      // 勤務 [hs,he) のうち、入ってほしい時間 [ks,ke) を含み、最高人数に達している時間を含まない、いちばん長い範囲。
      // [ks,ke) を覆えない・そこが達している場合は null
      const widestAround=(hs,he,ks,ke,ignore)=>{
        if(hs>ks || he<ke) return null;
        for(let m=ks;m<ke;m+=SLOT_MIN){ if(isFull(m,ignore)) return null; }
        while(ks-SLOT_MIN>=hs && !isFull(ks-SLOT_MIN,ignore)) ks-=SLOT_MIN;
        while(ke+SLOT_MIN<=he && !isFull(ke,ignore)) ke+=SLOT_MIN;
        return [ks,ke];
      };

      // ---- ①希望休 ----
      // 希望休の日・希望を出していない日・先に決めた休みの日は、canWork で入れないようにしてある

      // ---- ⓪社員：出勤できる日は必ず入れる ----
      // 選んだ記号のうち、まだ必要最低人数に足りない時間をいちばん多く埋められる記号の時間で入れる（同じなら一覧で先の記号）。
      // その日の立ち上げ番・閉め番の最優先の人なら、その時間帯をいちばん多く覆う記号の中から選ぶ。
      // 社員は、最高人数・扶養の上限・連勤のルールで外したり、時間を短くしたり伸ばしたりはしない
      for(const u of members){
        if(!usesShiftCodes(u) || !canWork(u,date)) continue;
        let opts=codeOptions(u,date);
        const myWindows=topsOn(date).filter(t=>t.u.id===u.id);
        if(myWindows.length){
          const covers=([a,b])=>myWindows.filter(w=>a<=w.ws && b>=w.we).length;
          const most=Math.max(...opts.map(covers));
          opts=opts.filter(o=>covers(o)===most);
        }
        const gain=([a,b])=>times.reduce((sum,t)=>sum+(t>=a && t<b ? Math.max(0, req[t]-workingAt(t)) : 0), 0);
        const best=opts.reduce((x,y)=>gain(y)>gain(x) ? y : x);
        dayShifts.push({user_id:u.id, date, start:hmOf(best[0]), end:hmOf(best[1])});
      }

      // ---- ②立ち上げ番・閉め番の最優先の人を、最初に入れる ----
      // 先に入れておかないと、③で最高人数まで埋まって入れなくなることがある（④扶養・⑤連勤で外れることはある）。
      // 最高人数に達している時間があれば、立ち上げ・閉めの時間は残して勤務の端を短くする（3時間未満になるなら入れない）
      for(const {u,ws,we} of topsOn(date)){
        if(userDuty[u.id]!==duty || dayShifts.some(sh=>sh.user_id===u.id)) continue;
        const p=prefOf(u,date), ps=mins(p.start), pe=mins(p.end);
        const fit=widestAround(ps,pe,ws,we);
        if(!fit) continue;
        const [hs,he]=fit;
        if((hs!==ps || he!==pe) && he-hs<MIN_SHIFT_MIN) continue;
        dayShifts.push({user_id:u.id, date, start:hmOf(hs), end:hmOf(he)});
      }

      // ---- ③最高人数まで（空欄の時間帯は必要最低人数まで）、希望どおりの時間で入れる ----
      // ・連勤日数が少ない人から選ぶ（同じなら、その週の実働時間が少ない人）。連勤が続いた人に休みが入りやすくなり、
      //   あとで穴埋めに呼べる余力のある人が残りやすい
      // ・入れるのは、目標の人数に届いていない時間帯に入れる人だけ（足りている時間だけ人が増えないように）
      // ・最高人数に達している時間が勤務の端なら、その分だけ短くする（3時間未満になる・途中で達する場合は入れない）
      const belowTarget=(a,b)=>times.some(t=>t>=a && t<b && workingAt(t)<target(t));
      const candidates=members.filter(u=>!usesShiftCodes(u) && canWork(u,date) && !dayShifts.some(sh=>sh.user_id===u.id)).sort((a,b)=>{
        const sa=streaks[a.id]||0, sb=streaks[b.id]||0;
        if(sa!==sb) return sa-sb;
        return (weekMin[a.id][wk]||0)-(weekMin[b.id][wk]||0);
      });
      for(const u of candidates){
        if(!belowTarget(-Infinity,Infinity)) break; // すべての時間帯が目標の人数に届いた
        const p=prefOf(u,date), ps=mins(p.start), pe=mins(p.end);
        const fit=trimEdges(ps,pe);
        if(!fit) continue;
        const [hs,he]=fit;
        if((hs!==ps || he!==pe) && he-hs<MIN_SHIFT_MIN) continue;
        if(!belowTarget(hs,he)) continue;
        dayShifts.push({user_id:u.id, date, start:hmOf(hs), end:hmOf(he)});
      }

      // ---- ④扶養PA・扶養学生PAの上限を守る ----
      for(const sh of [...dayShifts]){
        const u=DB.users.find(x=>x.id===sh.user_id);
        const pa=PA_TYPES[u.permission];
        if(!pa || usesShiftCodes(u)) continue;
        const hasWeekCap=pa.weekCapMin!=null, hasDayCap=(u.permission==='dependent_student');
        if(!hasWeekCap && !hasDayCap) continue;
        let dur=mins(sh.end)-mins(sh.start);
        if(hasDayCap){
          const maxDay=Math.floor((DEPENDENT_STUDENT_DAY_CAP_MIN-1)/30)*30;
          dur=Math.min(dur,maxDay);
        }
        if(hasWeekCap){
          const soFar=weekMin[u.id][wk]||0;
          const maxAdd=Math.floor((pa.weekCapMin-soFar-1)/30)*30;
          const budget=paDayBudget[u.id][date]; // 週の後半のために温存した、この日の持ち分
          dur=Math.min(dur, Math.max(0,maxAdd), budget!=null?Math.max(0,budget):Infinity);
        }
        if(dur<MIN_SHIFT_MIN){ dayShifts=dayShifts.filter(x=>x!==sh); } // 3時間未満になるなら日ごと外す（後で穴埋めを試みる）
        else { sh.end=hmOf(mins(sh.start)+dur); }
      }

      // ---- ⑤連勤は3日まで（人員不足が出る日だけ4日目まで認める） ----
      const overLimit=[];
      for(const sh of [...dayShifts]){
        const u=DB.users.find(x=>x.id===sh.user_id);
        if(usesShiftCodes(u)) continue; // 社員は外さない
        const nextStreak=(streaks[u.id]||0)+1;
        if(nextStreak>MAX_CONSECUTIVE_WORK_DAYS){ overLimit.push({u,shift:sh,nextStreak}); dayShifts=dayShifts.filter(x=>x!==sh); }
      }
      // 今の時点で、必要最低人数に足りない時間があるか
      const hasShortageNow=()=>times.some(t=>workingAt(t)<req[t]);
      // 4日目の人は、不足が出る場合だけ戻す（一度入れたシフトを戻すだけなので、最高人数は超えない）
      for(const o of overLimit.filter(o=>o.nextStreak<=4)){
        if(!hasShortageNow()) continue;
        dayShifts.push(o.shift);
      }

      // 不足区間 [start,end) を埋められる、この職務の人を探す。
      // 対象になれるかは「出勤可能時間」で判定するが、入れる時間はできるだけ「希望」に近づけるため、
      // 対象者全員について ①希望の時間そのまま → ②不足区間を30分刻みに広げた時間 → ③不足区間ぴったり の順に試す
      const findBackfillHelper=(start,end,excludeIds)=>{
        const eligible=members.filter(cu=>{
          if(excludeIds.has(cu.id) || usesShiftCodes(cu)) return false; // 社員は⓪で入れ終わっている
          if(!canWork(cu,date)) return false; // 希望休・先に決めた休みの日は使わない
          // 穴埋めは希望ではなく出勤可能時間で判定する
          const [as,ae]=availOf(prefOf(cu,date));
          if(as>start || ae<end) return false;
          // 不足を埋めるためなので、⑤と同じく4日目まで認める
          if((streaks[cu.id]||0)+1>MAX_CONSECUTIVE_WORK_DAYS+1) return false;
          return true;
        });
        // 扶養の上限。穴埋めでは週の配分（paDayBudget）は見ず、週の上限そのものに収まれば入れてよい
        // （配分は前半で使い切らないための目安で、実際に不足しているなら埋める方を優先する）
        const fitsCaps=(cu,a,b)=>{
          const pa=PA_TYPES[cu.permission];
          if(pa && pa.weekCapMin!=null && (weekMin[cu.id][wk]||0)+(b-a)>=pa.weekCapMin) return false;
          if(cu.permission==='dependent_student' && (b-a)>=DEPENDENT_STUDENT_DAY_CAP_MIN) return false;
          return true;
        };
        // 勤務を [hs,he) にしてみる。最高人数に達している時間があれば、不足区間を残して端を短くする。
        // 不足区間を覆えて、3時間以上で、扶養の上限にも収まるなら、その範囲を返す
        const tryRange=(cu,hs,he)=>{
          const r=widestAround(hs,he,start,end);
          if(!r) return null;
          [hs,he]=r;
          if(he-hs<MIN_SHIFT_MIN || !fitsCaps(cu,hs,he)) return null;
          return [hs,he];
        };
        for(const cu of eligible){ // ①希望時間そのまま
          const p=prefOf(cu,date);
          const r=tryRange(cu, mins(p.start), mins(p.end));
          if(r) return {helper:cu, hs:r[0], he:r[1]};
        }
        for(const cu of eligible){ // ②不足区間を30分刻みに広げた時間（出勤可能時間の範囲内）
          const [as,ae]=availOf(prefOf(cu,date));
          const r=tryRange(cu, Math.max(snapDown30(start),as), Math.min(snapUp30(end),ae));
          if(r) return {helper:cu, hs:r[0], he:r[1]};
        }
        for(const cu of eligible){ // ③不足区間ぴったり
          const r=tryRange(cu, start, end);
          if(r) return {helper:cu, hs:r[0], he:r[1]};
        }
        return null;
      };

      // 新しい人で埋まらないときは、すでに入っている人の勤務を、出勤可能時間の範囲で伸ばして埋める
      // （④の週の配分で短くなった人など。扶養の週の上限そのものに収まれば伸ばしてよい）
      const tryExtendExisting=(gapStart,gapEnd)=>{
        for(const sh of dayShifts){
          if(mins(sh.start)<=gapStart && mins(sh.end)>=gapEnd) continue; // すでにカバー済み
          if(mins(sh.start)>gapEnd || mins(sh.end)<gapStart) continue; // 隣接・重なりがなければ対象外（1本のシフトを保つ）
          const u=DB.users.find(x=>x.id===sh.user_id);
          if(usesShiftCodes(u)) continue; // 社員の勤務は記号どおりのまま（伸ばさない）
          const p=prefOf(u,date);
          if(!p || p.day_off || !p.start || !p.end) continue;
          const [as,ae]=availOf(p); // 希望ではなく出勤可能時間の範囲まで伸ばしてよい
          if(as>gapStart || ae<gapEnd) continue; // 出勤可能時間そのものが不足区間をカバーしていない
          // 最高人数を数えるときは、伸ばしている本人を数えない（本人の今のシフトは、伸ばした後のシフトに置き換わるため）
          const r=widestAround(Math.max(Math.min(mins(sh.start),gapStart), as), Math.min(Math.max(mins(sh.end),gapEnd), ae), gapStart, gapEnd, sh);
          if(!r) continue; // 最高人数の都合で不足区間を覆えないなら諦める
          const [ns,ne]=r;
          if(ne-ns<MIN_SHIFT_MIN) continue;
          const pa=PA_TYPES[u.permission];
          if(pa && pa.weekCapMin!=null && (weekMin[u.id][wk]||0)+(ne-ns)>=pa.weekCapMin) continue;
          if(u.permission==='dependent_student' && (ne-ns)>=DEPENDENT_STUDENT_DAY_CAP_MIN) continue;
          sh.start=hmOf(ns); sh.end=hmOf(ne);
          return true;
        }
        return false;
      };

      // ---- 穴埋め：④⑤で人を減らしたことなどで残った人員不足を、ほかの人で埋める ----
      // （埋められなかった分は、手順4でまとめて人員不足として記録する）
      {
        const excludeIds=new Set(dayShifts.map(x=>x.user_id)); // 1人1日1本なので、すでに入っている人は使わない
        let i=0;
        while(i<times.length){
          const t=times[i], working=workingAt(t), need=req[t];
          if(working>=need){ i++; continue; }
          let j=i;
          while(j<times.length && workingAt(times[j])===working && req[times[j]]===need) j++;
          const gapStart=t, gapEnd=times[j-1]+SLOT_MIN;
          const found=findBackfillHelper(gapStart,gapEnd,excludeIds);
          if(found){
            dayShifts.push({user_id:found.helper.id, date, start:hmOf(found.hs), end:hmOf(found.he)});
            excludeIds.add(found.helper.id);
            continue; // 埋まったので同じiから再判定する
          }
          if(tryExtendExisting(gapStart,gapEnd)){
            continue; // 埋まったので同じiから再判定する
          }
          i=j; // 埋められなかった
        }
      }

      // ---- この日を確定し、週の実働時間・連続勤務日数を更新して次の日へ ----
      shifts.push(...dayShifts);
      members.forEach(u=>{
        const sh=dayShifts.find(x=>x.user_id===u.id);
        if(sh) weekMin[u.id][wk]=(weekMin[u.id][wk]||0)+(mins(sh.end)-mins(sh.start));
        streaks[u.id]=sh?(streaks[u.id]||0)+1:0;
      });
    }

    // この職務の人員不足を日ごとに数える（手順3で、入れ替えの前後を比べたり、入れ替える日を選んだりするのに使う）。
    // 戻り値：{shifts, byDay, shortAt, working, total（不足の合計）}
    const byDate={};
    for(const sh of shifts) (byDate[sh.date]=byDate[sh.date]||[]).push(sh);
    const byDay={};     // 日付 -> 人員不足（足りない人数 × 分）
    const shortAt={};   // 日付 -> 人が足りない時刻（開始分）の一覧
    const working={};   // 日付 -> その日にシフトがある人の userId の Set
    let total=0;
    for(const date of days){
      const list=(byDate[date]||[]).map(sh=>[mins(sh.start), mins(sh.end)]);
      let v=0; shortAt[date]=[];
      for(const [t,need] of (isDutyClosed(duty,date) ? [] : (reqList[duty]||[]))){ // 休業日は数えない
        const n=list.filter(([a,b])=>a<=t && b>t).length;
        if(n<need){ v+=(need-n)*SLOT_MIN; shortAt[date].push(t); }
      }
      byDay[date]=v; total+=v;
      working[date]=new Set((byDate[date]||[]).map(sh=>sh.user_id));
    }
    return {shifts, byDay, shortAt, working, total};
  };
  const dutyIds=dutyList().map(d=>d.id);
  const results={}; // 職務 -> buildDuty の結果
  for(const duty of dutyIds) results[duty]=buildDuty(duty);

  // ---- 手順3：休みの日を入れ替えて、人員不足を減らす ----
  // 手順1の休みの日は作る前の見込みで選ぶので、実際に作ると「その人が休みでなければ埋まった不足」が残ることがある。
  // そこで、不足が出た日の休みを、不足が無い日へ1日ずつ動かして作り直し、不足の合計が減ったときだけ採用する。
  // 減らなくなるまで繰り返す。休みの日数は変わらないので、月最低休日数は守られる。
  // 作り直すのはその人の職務だけ。ただし立ち上げ番・閉め番の人の休みを動かして、その日の最優先の人が
  // ほかの職務の人に替わったときは、その職務も作り直す
  const topIds=dates=>dates.map(d=>topsOn(d).map(t=>t.u.id).join(',')).join('|'); // その日の最優先の人（比べる用）
  // u の休みを from の日から to の日へ動かしてみる。不足の合計が減れば採用して true、減らなければ元に戻して false
  const trySwap=(u,from,to)=>{
    const labeled=u.openingDuty || u.closingDuty;
    const before=labeled ? [from,to].map(d=>topsOn(d)) : null;
    delete forcedRest[u.id][from]; forcedRest[u.id][to]=true;
    const duties=new Set([userDuty[u.id]]);
    if(labeled && topIds([from,to])!==before.map(list=>list.map(t=>t.u.id).join(',')).join('|')){
      // 最優先の人が替わった日は、替わる前と後の人の職務も作り直す
      before.forEach(list=>list.forEach(t=>duties.add(userDuty[t.u.id])));
      [from,to].forEach(d=>topsOn(d).forEach(t=>duties.add(userDuty[t.u.id])));
    }
    const trial={}; let diff=0;
    for(const duty of duties){ trial[duty]=buildDuty(duty); diff+=trial[duty].total-results[duty].total; }
    if(diff<0){ Object.assign(results,trial); Object.keys(trial).forEach(d=>{ version[d]++; }); return true; }
    forcedRest[u.id][from]=true; delete forcedRest[u.id][to];
    return false;
  };
  // 一度試してだめだった入れ替えは、その職務の結果が変わる（version が増える）まで試し直さない
  const version={}; dutyIds.forEach(d=>{ version[d]=0; });
  const failed={}; // "userId|元の日|先の日" -> 試したときのその職務の version
  const swapStartedAt=Date.now(); let swapTries=0;
  search: for(;;){
    for(const u of DB.users){
      if(!isAutoCandidate(u)) continue;
      const duty=userDuty[u.id], r=results[duty];
      // 動かす元：不足が出た日に決めた休みのうち、その人の出勤可能時間が不足の時刻にかかる日（不足が大きい日から）
      const from=days.filter(d=>{
        if(!forcedRest[u.id][d] || !(r.byDay[d]>0)) return false;
        const [as,ae]=availOf(prefOf(u,d));
        return r.shortAt[d].some(t=>t>=as && t<ae);
      }).sort((a,b)=>r.byDay[b]-r.byDay[a]);
      if(from.length===0) continue;
      // 動かす先：出勤できて、その職務に不足が無い日。今シフトが入っていない日（休みにしても困らない日）を先に試す
      const to=days.filter(d=>prefMin[u.id][d] && !forcedRest[u.id][d] && r.byDay[d]===0)
        .sort((a,b)=>(r.working[a].has(u.id)?1:0)-(r.working[b].has(u.id)?1:0));
      for(const x of from) for(const w of to){
        const key=u.id+'|'+x+'|'+w;
        if(failed[key]===version[duty]) continue;
        if(swapTries>=REST_SWAP_MAX_TRIES || Date.now()-swapStartedAt>REST_SWAP_TIME_LIMIT_MS) break search;
        swapTries++;
        if(trySwap(u,x,w)) continue search; // 採用したら、新しい結果でもう一度最初から探す
        failed[key]=version[duty];
      }
    }
    break; // どの入れ替えでも減らなかった
  }

  // ---- 手順4：でき上がったシフトを入れ、人員不足を記録する ----
  for(const duty of dutyIds) DB.shifts.push(...results[duty].shifts);

  // 人員不足は、でき上がったシフトから数え直す（カレンダーで手直ししたときと同じ数え方になり、記録が実際と必ず一致する）
  const shiftsByDate={};
  for(const sh of DB.shifts){
    if(sh.date>=s.period_start && sh.date<=s.period_end) (shiftsByDate[sh.date]=shiftsByDate[sh.date]||[]).push(sh);
  }
  const shortages=[];
  for(const date of days) shortages.push(...shortagesOfDay(date, shiftsByDate[date]||[]));

  // 記録は対象期間の分だけ入れ替える（ほかの期間の記録は、カレンダーで表示するときのために残す）
  const otherPeriodShortages=(s.shortages||[]).filter(x=> x.date<s.period_start || x.date>s.period_end);
  s.shortages=mergeShortages([...otherPeriodShortages, ...shortages]);
  s.last_generated=new Date().toLocaleString("ja-JP");
  // 公開済みの期間を作り直したら、非公開に戻す（内容を確認してから公開し直してもらう）
  s.published_periods=publishedPeriods().filter(pp=>!(pp.start===s.period_start && pp.end===s.period_end));
  save();
}

// 不足の記録を「日付 → 職務（職務の一覧の並び順）→ 開始時刻」の順に並べ、
// 同じ日・同じ職務で時間がつながっていて人数も同じものを1件にまとめる
function mergeShortages(list){
  const dutyKeys=dutyList().map(d=>d.id);
  const dutyRank=s=>dutyKeys.indexOf(s.duty); // 職務の無い古い記録は -1（先頭）
  list.sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:(dutyRank(a)-dutyRank(b)) || (toMin(a.start)-toMin(b.start)));
  const out=[];
  for(const s of list){
    const last=out[out.length-1];
    if(last && last.date===s.date && (last.duty||null)===(s.duty||null) && last.end===s.start && last.required===s.required && last.assigned===s.assigned){
      last.end=s.end;
    } else out.push({...s});
  }
  return out;
}
// その日のシフトから、必要最低人数に足りない時間帯を職務ごとに数える（同じ状態が続く所は1件にまとめる）。
// 人はその人の今の職務で数える（職務が未設定の人はどの職務にも数えない）。
// 自動作成とカレンダーでの手直しの両方でこの関数を使うので、不足の数え方はいつも同じになる
function shortagesOfDay(date, dayShifts){
  const reqBy=slotRequiredByDuty();
  const out=[];
  // シフトごとの職務と出勤・退勤（分）を先に求めておく（10分ごとに何度も数えるため）
  const rows=dayShifts.map(sh=>({duty:dutyOf(DB.users.find(x=>x.id===sh.user_id)), s:toMin(sh.start), e:toMin(sh.end)}));
  for(const duty of dutiesWithRequirement(reqBy)){
    if(isDutyClosed(duty,date)) continue; // 休業日は、その職務の必要最低人数を数えない
    const req=reqBy[duty];
    const mine=rows.filter(x=>x.duty===duty);
    const workingAt=m=>mine.filter(x=>x.s<=m && x.e>m).length;
    const times=Object.keys(req).map(Number).sort((a,b)=>a-b);
    let i=0;
    while(i<times.length){
      const t=times[i], working=workingAt(t), need=req[t];
      if(working>=need){ i++; continue; }
      let j=i+1;
      // 時間がつながっていて（必要最低人数の設定がない時間をはさまない）、人数も同じ間は1件にまとめる
      while(j<times.length && times[j]===times[j-1]+SLOT_MIN && workingAt(times[j])===working && req[times[j]]===need) j++;
      out.push({date, start:toHM(t), end:toHM(times[j-1]+SLOT_MIN), required:need, assigned:working, duty});
      i=j;
    }
  }
  return out;
}
// カレンダーでシフトを手直ししたあと、その日の人員不足だけ数え直す（ほかの日の記録はそのまま）
function recomputeShortagesForDate(date){
  const newForDate=shortagesOfDay(date, DB.shifts.filter(x=>x.date===date));
  const others=(DB.settings.shortages||[]).filter(s=>s.date!==date);
  DB.settings.shortages = mergeShortages([...others, ...newForDate]);
}

/* ============================================================
   画面の描画・メニュー
   ============================================================ */
// メニューのページ一覧 [ページの id, 表示名]
const TABS_ADMIN=[
  ['dash','ダッシュボード'],
  ['emps','従業員管理'],
  ['duties','職務設定'],
  ['codes','シフト記号設定'],
  ['need','必要最低人数設定'],
  ['deadline','締切設定'],
  ['make','シフト作成・確認'],
  ['cal','シフトカレンダー'],
  ['logins','ログイン履歴'],
];
const TABS_EMP=[
  ['home','従業員ホーム'],
  ['pref','勤務希望入力'],
  ['myshift','自分のシフト確認'],
];
// 職務がある（シフト対象の）管理者に足すページ（自分の勤務希望の提出・シフト確認）
const TABS_ADMIN_STAFF_EXTRA=[
  ['pref','勤務希望入力'],
  ['myshift','自分のシフト確認'],
];
// パスワード変更は、全員のメニューの一番下に出す
const TAB_PASSWORD=['password','パスワード変更'];
// 職務がある従業員は、シフトカレンダー（公開済みの期間・見るだけ）も見られる（管理者は TABS_ADMIN で見て編集できる）
const TAB_CAL_EMP=['cal','シフトカレンダー'];
function tabsFor(u){
  let tabs;
  if(u.role==='admin') tabs = isStaff(u) ? [...TABS_ADMIN, ...TABS_ADMIN_STAFF_EXTRA] : TABS_ADMIN;
  else tabs = dutyOf(u) ? [...TABS_EMP, TAB_CAL_EMP] : TABS_EMP;
  return [...tabs, TAB_PASSWORD];
}
let activeTab='dash';
let menuOpen=false; // 三本線メニューのページ一覧が開いているか

function render(){
  const who=document.getElementById('who');
  const menuEl=document.getElementById('menu');

  // ログイン状態の確認中・共有データの読み込み中
  if(!cloud.authKnown || (currentUserId && !cloud.ready)){
    who.innerHTML='';
    menuEl.innerHTML=''; menuOpen=false;
    document.getElementById('view').innerHTML=`<div class="card" style="max-width:420px;margin:40px auto;text-align:center">
      <p class="desc" style="margin:0">読み込み中…</p></div>`;
    return;
  }
  // 未ログイン → ログイン画面のみ
  if(!currentUser()){
    who.innerHTML='';
    menuEl.innerHTML=''; menuOpen=false;
    document.getElementById('view').innerHTML=viewLogin();
    return;
  }

  const u=currentUser();
  const roleDisp = roleDisplay(u);
  who.innerHTML=`<span class="store-name">${escHtml(currentStore.name)}</span>
    <span>${u.name}${roleDisp?`（${roleDisp}）`:''}</span>
    <button class="ghost mini" onclick="doLogout()">ログアウト</button>`;

  const tabs=tabsFor(u);
  if(!tabs.find(t=>t[0]===activeTab)) activeTab=tabs[0][0];
  // ロゴの左の三本線ボタンと、押すと開くページの一覧（今のページは active で色を変える）
  menuEl.innerHTML=`
    <button class="menu-btn" id="menuBtn" aria-label="メニュー" aria-controls="menuPanel" aria-expanded="${menuOpen}" onclick="toggleMenu()">
      <span></span><span></span><span></span>
    </button>
    <nav class="menu-panel${menuOpen?' open':''}" id="menuPanel">
      ${tabs.map(([id,label])=>`<button class="${id===activeTab?'active':''}" onclick="go('${id}')">${label}</button>`).join('')}
    </nav>`;

  const v=document.getElementById('view');
  v.innerHTML=({
    dash:viewDash, emps:viewEmps, duties:viewDuties, codes:viewShiftCodes, need:viewNeed, deadline:viewDeadline,
    make:viewMake, cal:viewCal, logins:viewLogins,
    home:viewHome, pref:viewPref, myshift:viewMyShift,
    password:viewPassword
  }[activeTab])();
  if(window._afterRender){ window._afterRender(); window._afterRender=null; }
}
function go(id){ activeTab=id; menuOpen=false; pwChangeMsg=null; render(); } // ページを移ったら、パスワード変更のお知らせは消す
// 三本線メニューを開く・閉じる（open を省略すると、開いていれば閉じ、閉じていれば開く）。
// render() で画面全体を描き直すと入力欄に打ちかけの内容が消えてしまうので、一覧の表示だけを切り替える
function toggleMenu(open){
  menuOpen = (open===undefined) ? !menuOpen : open;
  document.getElementById('menuPanel').classList.toggle('open', menuOpen);
  document.getElementById('menuBtn').setAttribute('aria-expanded', menuOpen);
}
// メニューの外をクリックしたとき・Esc キーを押したときは閉じる
document.addEventListener('click', e=>{ if(menuOpen && !e.target.closest('#menu')) toggleMenu(false); });
document.addEventListener('keydown', e=>{ if(menuOpen && e.key==='Escape') toggleMenu(false); });

/* ---------- 管理者: ダッシュボード ---------- */
function viewDash(){
  const s=DB.settings;
  const emps=DB.users.filter(u=>isStaff(u)&&u.is_active);
  const days=rangeDates(s.period_start,s.period_end);
  const submitted=emps.filter(u=>DB.submissions[u.id]===s.period_start);
  const notSubmitted=emps.filter(u=>DB.submissions[u.id]!==s.period_start); // 希望提出状況の表には、未提出の人だけを出す
  // 人員不足の合計（人時）＝「足りない人数 × その時間の長さ」をすべて足したもの（例：2人足りない状態が30分なら1人時）
  const shortPersonMin=shortagesInTarget().reduce((a,x)=>a+(x.required-x.assigned)*(toMin(x.end)-toMin(x.start)),0);
  const shortPersonHours=Math.round(shortPersonMin/6)/10; // 時間に直して小数第1位まで
  const afterDeadline = isAfterDeadline();
  const latestPub=latestPublishedPeriod();
  return `
  <div class="card">
    <h2><span class="tag">概要</span> システム概要</h2>
    <div class="kpi" style="margin-top:10px">
      <div class="box"><span class="note">対象期間</span><b>${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}</b></div>
      <div class="box"><span class="note">希望提出締切</span><b>${fmtDate(deadlineDateOf(s.period_start))} ${afterDeadline?'<span class="pill bad">締切後</span>':'<span class="pill ok">受付中</span>'}</b></div>
      <div class="box"><span class="note">希望提出状況</span><b>${submitted.length} / ${emps.length} 名</b></div>
      <div class="box"><span class="note">人員不足</span><b>${shortPersonMin>0?`<span style="color:var(--bad)">${shortPersonHours} 人時</span>`:'<span style="color:var(--ok)">なし</span>'}</b></div>
      <div class="box"><span class="note">公開済みの最新シフト</span><b>${latestPub?`${fmtDate(latestPub.start)}〜${fmtDate(latestPub.end)}`:'<span class="pill muted">まだありません</span>'}</b></div>
    </div>
  </div>

  <div class="card">
    <h2><span class="tag">状況</span> 希望提出状況：未提出</h2>
    ${notSubmitted.length===0
      ? '<div class="banner ok">✅ 全員が提出済みです。</div>'
      : `<div class="scroll"><table>
      <tr><th>氏名</th><th>希望入力日数</th></tr>
      ${notSubmitted.map(u=>{
        const p=DB.employee_preferences[u.id]||{};
        const cnt=days.filter(d=>p[d]).length;
        const offCnt=days.filter(d=>p[d]&&p[d].day_off).length;
        return `<tr>
          <td>${u.name}</td>
          <td>${cnt} / ${days.length}（希望休 ${offCnt}）</td>
        </tr>`;
      }).join('')}
    </table></div>`}
  </div>`;
}

/* ---------- 管理者: 従業員管理 ---------- */
function viewEmps(){
  // 社員番号の欄の幅 calc(7ch + 8px)：7ch が数字7桁分（1ch は「0」1文字の幅で、文字の大きさに合わせて変わる）、
  // 8px はブラウザ標準の左右の余白（2px×2）と枠線（2px×2）
  // ログインできる最後の1人の管理者は、「管理者」「在籍」を外すと管理画面に誰も入れなくなるので、
  // チェック欄を最初から押せなくする（editUser でも念のため止める）
  const lockIfLastAdmin = u => isLastActiveAdmin(u) ? 'disabled title="ログインできる管理者が1人だけなので外せません"' : '';
  window._afterRender = fitNameInputs; // 表を描いた後で、氏名の欄の幅をいちばん長い氏名に合わせる
  // PA種の欄は、役職が PA の人だけプルダウンを出し、ほかの人は空欄にする（表示だけ。保存されている値はそのまま）
  return `
  <div class="card">
    <h2>従業員管理</h2>
    <div class="scroll" style="margin-top:10px"><table id="empTable">
      <tr><th>管理者</th><th>氏名</th><th>社員番号</th><th>役職</th><th>職務</th><th>PA種</th><th>在籍</th><th>立ち上げ番</th><th>閉め番</th><th></th></tr>
      ${DB.users.map(u=>`<tr>
        <td><input type="checkbox" ${u.role==='admin'?'checked':''} ${lockIfLastAdmin(u)} onchange="editUser('${u.id}','role',this.checked?'admin':'employee')"></td>
        <td><input class="emp-name" value="${u.name}" oninput="fitNameInputs()" onchange="editUser('${u.id}','name',this.value)"></td>
        <td><input value="${u.empNo}" inputmode="numeric" maxlength="7" style="width:calc(7ch + 8px)" onchange="editUser('${u.id}','empNo',this.value)"></td>
        <td><select onchange="editUser('${u.id}','position',this.value)">
          <option value="" ${!POSITIONS[u.position]?'selected':''}>—（未設定）</option>
          ${Object.entries(POSITIONS).map(([key,p])=>`<option value="${key}" ${u.position===key?'selected':''}>${p.label}</option>`).join('')}
        </select></td>
        <td><select onchange="editUser('${u.id}','duty',this.value)">
          <option value="" ${!u.duty?'selected':''}>—（未設定）</option>
          ${dutyOptions(u.duty)}
        </select></td>
        <td>${u.position==='pa' ? `<select onchange="editUser('${u.id}','permission',this.value)">
          <option value="general" ${paTypeOf(u)==='general'?'selected':''}>一般PA（制限なし）</option>
          <option value="dependent" ${paTypeOf(u)==='dependent'?'selected':''}>扶養PA（週20h未満）</option>
          <option value="dependent_student" ${paTypeOf(u)==='dependent_student'?'selected':''}>扶養学生PA（週40h未満）</option>
        </select>` : ''}</td>
        <td><input type="checkbox" ${u.is_active?'checked':''} ${lockIfLastAdmin(u)} onchange="editUser('${u.id}','is_active',this.checked)"></td>
        <td><input type="checkbox" ${u.openingDuty?'checked':''} onchange="editUser('${u.id}','openingDuty',this.checked)"></td>
        <td><input type="checkbox" ${u.closingDuty?'checked':''} onchange="editUser('${u.id}','closingDuty',this.checked)"></td>
        <td>${u.id===currentUserId?'<span class="pill muted">ログイン中</span>':`<button class="mini danger" onclick="delUser('${u.id}')">削除</button>`}</td>
      </tr>`).join('')}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input id="newName" type="text" placeholder="氏名" onkeydown="if(event.key==='Enter')addUser()">
      <input id="newEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" placeholder="社員番号（7桁以内）" onkeydown="if(event.key==='Enter')addUser()">
      <button onclick="addUser()">＋ 従業員を追加</button>
    </div>
  </div>`;
}
// 従業員管理の氏名の欄を、いちばん長い氏名がちょうど入る幅にそろえる（入力中も、打った内容に合わせて測り直す）。
// 文字の幅は文字ごとに違う（漢字・かなは英数字のほぼ2倍）ので、文字数ではなく、
// 画面と同じ文字の設定で canvas（図を描くための部品）に文字を当てて、実際の幅を測る
let measureCanvas=null;
function fitNameInputs(){
  const inputs=[...document.querySelectorAll('#empTable input.emp-name')];
  if(!inputs.length) return;
  const cs=getComputedStyle(inputs[0]);
  if(!measureCanvas) measureCanvas=document.createElement('canvas');
  const ctx=measureCanvas.getContext('2d');
  ctx.font=`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  // いちばん長い氏名の幅（短すぎないよう、見出しの「氏名」の幅より狭くはしない）
  const textWidth=Math.max(ctx.measureText('氏名').width, ...inputs.map(el=>ctx.measureText(el.value).width));
  // 入力欄の幅には、文字の左右の余白（padding）と枠線（border）も含まれる（style.css の box-sizing:border-box）。
  // 最後の +2 は、入力中のカーソルと小数点以下の切り上げの分
  const extra=['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'].reduce((sum,k)=>sum+parseFloat(cs[k]),0);
  const width=Math.ceil(textWidth+extra+2)+'px';
  inputs.forEach(el=>{ el.style.width=width; });
}
// その人を管理者から外す（従業員に変える・在籍を外す・削除する）と、ログインできる管理者が
// 1人もいなくなるかどうか。管理者がいなくなると、誰も管理画面を開けなくなってしまう。
function isLastActiveAdmin(u){
  return !!u && u.role==='admin' && u.is_active && !DB.users.some(x=>x.id!==u.id && x.role==='admin' && x.is_active);
}
function editUser(id,f,val){ const u=DB.users.find(x=>x.id===id);
  if(((f==='role' && val!=='admin') || (f==='is_active' && !val)) && isLastActiveAdmin(u)){
    alert('ログインできる管理者が1人もいなくなるため、変更できません。先に別の管理者を追加してください。'); render(); return;
  }
  // 自分の在籍・管理者を外すと、自分では元に戻せないので、確認してから変える（キャンセルしたらチェックを元に戻す）
  if(id===currentUserId && f==='is_active' && !val
    && !confirm('自分の「在籍」を外すと、すぐにログアウトされます。\nほかの管理者に在籍へ戻してもらうまで、ログインできなくなります。外しますか？')){ render(); return; }
  if(id===currentUserId && f==='role' && val!=='admin'
    && !confirm('自分の「管理者」を外すと、従業員管理やシフト作成などの管理者用の画面が使えなくなります。\nほかの管理者に戻してもらうまで、元に戻せません。外しますか？')){ render(); return; }
  if(f==='empNo'){
    val=String(val).trim();
    if(val===u.empNo) return;
    const err=empNoError(val, u.id);
    if(err){ alert(err); render(); return; }
    if(!confirm(`「${u.name}」さんの社員番号を「${u.empNo}」から「${val}」に変更しますか？\n次回から新しい番号でログインすることになります。本人に伝えてください。`)){ render(); return; }
  }
  if((f==='position'||f==='duty') && val==='') val=null; // 「—（未設定）」は null で持つ
  u[f]=val;
  // 役職を PA にしたとき、PA種が決まっていなければ初期値の一般PA にする
  if(f==='position' && val==='pa' && !PA_TYPES[u.permission]) u.permission='general';
  save(); if(f==='empNo'||f==='role'||f==='name'||f==='is_active'||f==='permission'||f==='position'||f==='duty'||f==='closingDuty'||f==='openingDuty') render(); }
// 従業員・管理者のアカウントを削除する。
// ただし、ログイン中の自分自身と、ログインできる最後の管理者は削除できない（管理画面に誰も入れなくなるのを防ぐ）。
function delUser(id){ const t=DB.users.find(x=>x.id===id);
  if(!t) return;
  if(id===currentUserId){ alert('ログイン中の自分のアカウントは削除できません。別の管理者でログインしてから削除してください。'); return; }
  if(isLastActiveAdmin(t)){ alert('ログインできる管理者が1人もいなくなるため、削除できません。先に別の管理者を追加してください。'); return; }
  const who = t.role==='admin' ? `管理者「${t.name}」さんのアカウント` : `「${t.name}」さん`;
  if(!confirm(`${who}を削除しますか？\n関連する希望・シフトも削除されます。この操作は元に戻せません。`)) return;
  const affectedDates=[...new Set(DB.shifts.filter(s=>s.user_id===id).map(s=>s.date))]; // この人がシフトに入っていた日
  DB.users=DB.users.filter(u=>u.id!==id);
  delete DB.employee_preferences[id]; delete DB.submissions[id]; delete DB.default_availability[id];
  DB.shifts=DB.shifts.filter(s=>s.user_id!==id);
  affectedDates.forEach(d=>recomputeShortagesForDate(d)); // 抜けたシフトの分、その日の人員不足を計算し直す
  if(editingCell && editingCell.userId===id) editingCell=null;
  save(); render(); }
// 氏名と社員番号を入力して従業員を追加する。入力に問題があれば、入力欄はそのままでエラーを知らせる
// （確かめる順番は、画面の並びと同じ「氏名 → 社員番号」）
function addUser(){
  const nameEl=document.getElementById('newName'), empNoEl=document.getElementById('newEmpNo');
  const n=nameEl.value.trim(), empNo=empNoEl.value.trim();
  if(!n){ alert('氏名を入力してください。'); nameEl.focus(); return; }
  if(!empNo){ alert('社員番号を入力してください。'); empNoEl.focus(); return; }
  const err=empNoError(empNo);
  if(err){ alert(err); empNoEl.focus(); return; }
  const id=genUserId();
  DB.users.push({id,name:n,empNo,role:'employee',permission:'general',is_active:true,openingDuty:false,closingDuty:false});
  save(); render();
  alert(`「${n}」さん（社員番号 ${empNo}）を追加しました。PA種は一旦「一般PA」です。\nログイン画面の「初めてログインする（パスワード設定）」から、本人にパスワードを設定してもらってください。`); }

/* ---------- 管理者: 職務設定 ---------- */
// 職務の名前の変更・追加・並べ替え・削除。職務は id で覚えているので、名前を変えても設定はそのまま。
// 並び順は、プルダウン・必要最低人数の表・人員不足の表示の順番と、自動作成で作る順番になる
const DUTY_NAME_MAX=20;
function viewDuties(){
  const list=dutyList();
  return `
  <div class="card">
    <h2>職務設定</h2>
    <div class="scroll" style="margin-top:10px"><table id="dutyTable">
      <tr><th>並べ替え</th><th>職務名</th><th>この職務の従業員</th><th>必要最低人数の時間帯</th><th></th></tr>
      ${list.map(d=>`<tr data-duty-id="${d.id}">
        <td><span class="drag-handle" role="button" tabindex="0" title="掴んで上下に動かすと並べ替えられます（キーボードは ↑ ↓）"
          aria-label="${escHtml(d.label)}を並べ替え（↑ ↓ キーでも動かせます）"
          onpointerdown="startDutyDrag(event,'${d.id}')" onpointermove="moveDutyDrag(event)"
          onpointerup="endDutyDrag(event)" onpointercancel="endDutyDrag(event)"
          onkeydown="dutyHandleKey(event,'${d.id}')">≡</span></td>
        <td><input type="text" value="${escHtml(d.label)}" maxlength="${DUTY_NAME_MAX}" onchange="renameDuty('${d.id}',this.value)"></td>
        <td>${DB.users.filter(u=>u.duty===d.id).length}人</td>
        <td>${DB.required_staff.filter(r=>r.duty===d.id).length}件</td>
        <td><button class="mini danger" onclick="deleteDuty('${d.id}')">削除</button></td>
      </tr>`).join('')}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input id="newDutyName" type="text" maxlength="${DUTY_NAME_MAX}" placeholder="職務名（${DUTY_NAME_MAX}文字以内）" onkeydown="if(event.key==='Enter')addDuty()">
      <button onclick="addDuty()">＋ 職務を追加</button>
    </div>
  </div>
  ${viewMinDaysOff()}`;
}

/* ---------- 職務設定: 月最低休日数（職務ごと・月ごと） ---------- */
// その月にその職務の人が、少なくとも何日休むか。自動作成では絶対に守る
let offMonth=null; // 設定画面で選んでいる月 'YYYY-MM'（null＝対象期間の月）
// 選べる月：対象期間の月の、1か月前〜4か月後
function offMonthChoices(){
  const base=new Date(DB.settings.period_start+'T00:00');
  const out=[];
  for(let k=-1;k<=4;k++){
    const d=new Date(base.getFullYear(), base.getMonth()+k, 1);
    out.push({key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label:`${d.getFullYear()}年${d.getMonth()+1}月`});
  }
  return out;
}
function viewMinDaysOff(){
  const choices=offMonthChoices();
  const month=choices.some(c=>c.key===offMonth) ? offMonth : monthKeyOf(DB.settings.period_start);
  const monthLabel=choices.find(c=>c.key===month).label;
  return `
  <div class="card">
    <h2>月最低休日数</h2>
    <div class="row" style="margin-top:10px">
      <label>月
        <select onchange="selectOffMonth(this.value)">
          ${choices.map(c=>`<option value="${c.key}" ${c.key===month?'selected':''}>${c.label}${c.key===monthKeyOf(DB.settings.period_start)?'（対象期間）':''}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="scroll"><table id="offTable">
      <tr><th>職務</th><th>月最低休日数（${monthLabel}）</th></tr>
      ${dutyList().map(d=>{
        const n=minDaysOffFor(d.id, month);
        return `<tr>
        <td>${escHtml(d.label)}</td>
        <td><input type="number" min="0" max="31" step="1" style="width:80px" value="${n||''}" placeholder="なし"
          onchange="setMinDaysOff('${month}','${d.id}',this.value)"> 日</td>
      </tr>`;
      }).join('')}
    </table></div>
  </div>`;
}
function selectOffMonth(key){ offMonth=key; render(); }
// 日数を保存する（空欄・0 は「決まりなし」として消す）
function setMinDaysOff(month, duty, value){
  const v=String(value).trim();
  const n=Number(v);
  if(v!=='' && !(Number.isInteger(n) && n>=0 && n<=31)){ alert('月最低休日数は 0〜31 の整数で入力してください。'); render(); return; }
  const all=DB.settings.min_days_off=DB.settings.min_days_off||{};
  const m=all[month]=all[month]||{};
  if(v==='' || n===0) delete m[duty]; else m[duty]=n;
  if(Object.keys(m).length===0) delete all[month];
  save(); render();
}
// 職務名として使えるか。使えなければ理由の文章を、使えれば空文字を返す（exceptId：名前を変える職務自身の id）
function dutyNameError(label, exceptId){
  if(!label) return '職務名を入力してください。';
  if(label.length>DUTY_NAME_MAX) return `職務名は${DUTY_NAME_MAX}文字以内にしてください。`;
  if(dutyList().some(d=>d.id!==exceptId && d.label===label)) return `職務名「${label}」はすでにあります。`;
  return '';
}
// 初期値の職務をそのまま使っている店舗は、初めて編集するときに店舗のデータとして写してから変える
// （初期値の一覧 DEFAULT_DUTIES そのものを書き換えると、ほかの場面の初期値まで変わってしまうため）
function ensureOwnDuties(){
  if(!Array.isArray(DB.duties)) DB.duties=DEFAULT_DUTIES.map(d=>({...d}));
}
function renameDuty(id,label){
  label=String(label).trim();
  const d=dutyById(id);
  if(!d || label===d.label) return;
  const err=dutyNameError(label,id);
  if(err){ alert(err); render(); return; }
  ensureOwnDuties();
  DB.duties.find(x=>x.id===id).label=label;
  save(); render();
}
// 新しい職務の id（ほかの職務と重ならない、変わらない目印）
const genDutyId = () => 'd_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function addDuty(){
  const el=document.getElementById('newDutyName');
  const label=el.value.trim();
  const err=dutyNameError(label);
  if(err){ alert(err); el.focus(); return; }
  ensureOwnDuties();
  DB.duties.push({id:genDutyId(), label});
  save(); render();
}
// 職務の順番を1つ上（dir=-1）・下（dir=1）の職務と入れ替える
function moveDuty(id,dir){
  ensureOwnDuties();
  const i=DB.duties.findIndex(d=>d.id===id), j=i+dir;
  if(i<0 || j<0 || j>=DB.duties.length) return;
  [DB.duties[i], DB.duties[j]] = [DB.duties[j], DB.duties[i]]; // 分割代入で2つを入れ替える
  save(); render();
}
// 職務を from 番目から to 番目へ移す（間の職務は1つずつずれる）
function moveDutyTo(id,to){
  ensureOwnDuties();
  const from=DB.duties.findIndex(d=>d.id===id);
  if(from<0 || from===to) return;
  const [d]=DB.duties.splice(from,1); // いったん取り出して
  DB.duties.splice(to,0,d);           // 移動先に入れる
  save();
}

/* ---------- 職務の並べ替え：つまみ（≡）を掴んで上下に動かす ----------
   マウスでもスマホの指でも動かせるよう、ポインターイベント（マウス・タッチ・ペンをまとめて扱う仕組み）で作る。
   ・押した（pointerdown）とき：その行の位置と、ほかの行の中心の高さを覚えておく
   ・動かしている（pointermove）間：掴んだ行を指について動かし、ほかの行は移動先を空けるようにずらす
   ・離した（pointerup）とき：移動先に並び順を変えて保存し、表を描き直す
   setPointerCapture で、指が行の外に出ても動きの知らせを受け取り続けられるようにする */
let dutyDrag=null; // 動かしている最中の情報 {id, row, rows, from, to, startY, mids, height}
function startDutyDrag(ev, id){
  if(ev.pointerType==='mouse' && ev.button!==0) return; // マウスは左ボタンだけ
  ev.preventDefault();
  const handle=ev.currentTarget, row=handle.closest('tr');
  const rows=[...row.parentNode.querySelectorAll('tr[data-duty-id]')];
  const from=rows.indexOf(row);
  dutyDrag={id, row, rows, from, to:from, startY:ev.clientY,
    mids:rows.map(r=>{ const b=r.getBoundingClientRect(); return b.top+b.height/2; }), // 各行の中心の高さ
    height:row.getBoundingClientRect().height};
  try{ handle.setPointerCapture(ev.pointerId); }catch(e){}
  row.classList.add('dragging');
}
function moveDutyDrag(ev){
  if(!dutyDrag) return;
  const g=dutyDrag, dy=ev.clientY-g.startY;
  g.row.style.transform=`translateY(${dy}px)`;
  // 移動先：掴んだ行の中心より上にある「ほかの行」の数
  const center=g.mids[g.from]+dy;
  g.to=g.mids.filter((m,i)=>i!==g.from && m<center).length;
  g.rows.forEach((r,i)=>{
    if(i===g.from) return;
    let shift=0;
    if(g.from<g.to && i>g.from && i<=g.to) shift=-g.height; // 下へ動かすとき：間の行を1つ上へ
    if(g.from>g.to && i>=g.to && i<g.from) shift=g.height;  // 上へ動かすとき：間の行を1つ下へ
    r.style.transform=shift?`translateY(${shift}px)`:'';
  });
}
function endDutyDrag(ev){
  if(!dutyDrag) return;
  const g=dutyDrag;
  dutyDrag=null;
  g.rows.forEach(r=>{ r.style.transform=''; r.classList.remove('dragging'); });
  if(ev.type==='pointerup' && g.to!==g.from) moveDutyTo(g.id, g.to); // 途中で取り消された（pointercancel）ときは動かさない
  render();
}
// キーボードで並べ替える：つまみにフォーカスして ↑ ↓。動かした後も、同じ職務のつまみにフォーカスを戻す
function dutyHandleKey(ev, id){
  if(ev.key!=='ArrowUp' && ev.key!=='ArrowDown') return;
  ev.preventDefault();
  const dir=ev.key==='ArrowUp' ? -1 : 1;
  const i=dutyList().findIndex(d=>d.id===id), j=i+dir;
  if(i<0 || j<0 || j>=dutyList().length) return; // いちばん上で ↑・いちばん下で ↓ は何もしない
  window._afterRender=()=>{ const h=document.querySelector(`tr[data-duty-id="${id}"] .drag-handle`); if(h) h.focus(); };
  moveDuty(id, dir);
}
// 職務を削除する。その職務の従業員は「職務が未設定」に、その職務の必要最低人数の時間帯と人員不足の記録は削除する
// （作成済みのシフトは人ごとの記録なので、そのまま残る）。影響を示して確認してから消す
function deleteDuty(id){
  const d=dutyById(id);
  if(!d) return;
  const users=DB.users.filter(u=>u.duty===id);
  const rows=DB.required_staff.filter(r=>r.duty===id);
  const shorts=(DB.settings.shortages||[]).filter(x=>x.duty===id);
  const effects=[];
  if(users.length){
    const names=users.slice(0,5).map(u=>u.name).join('、')+(users.length>5?' ほか':'');
    effects.push(`・従業員 ${users.length}人（${names}）の職務が未設定になります。`);
  }
  if(rows.length) effects.push(`・必要最低人数の時間帯 ${rows.length}件が削除されます。`);
  if(shorts.length) effects.push(`・この職務の人員不足の記録 ${shorts.length}件が削除されます。`);
  const msg=`職務「${d.label}」を削除しますか？\n`+(effects.length?effects.join('\n')+'\n':'')+'作成済みのシフトはそのまま残ります。この操作は元に戻せません。';
  if(!confirm(msg)) return;
  ensureOwnDuties();
  DB.duties=DB.duties.filter(x=>x.id!==id);
  users.forEach(u=>{ u.duty=null; });
  DB.required_staff=DB.required_staff.filter(r=>r.duty!==id);
  DB.settings.shortages=(DB.settings.shortages||[]).filter(x=>x.duty!==id);
  for(const month of Object.keys(DB.settings.min_days_off||{})){ // その職務の月最低休日数の設定も消す
    delete DB.settings.min_days_off[month][id];
    if(Object.keys(DB.settings.min_days_off[month]).length===0) delete DB.settings.min_days_off[month];
  }
  save(); render();
}

/* ---------- 管理者: シフト記号設定 ---------- */
// 社員の勤務希望とカレンダーで使う記号（A・B など）と、その時間。一覧は開始時刻の順に並べる
const SHIFT_CODE_LABEL_MAX=8; // 記号の最大文字数
function viewShiftCodes(){
  return `
  <div class="card">
    <h2>シフト記号設定</h2>
    <div class="scroll" style="margin-top:10px"><table id="codeTable">
      <tr><th>記号</th><th>開始</th><th>終了</th><th></th></tr>
      ${shiftCodeList().map(c=>`<tr>
        <td><input type="text" value="${escHtml(c.label)}" maxlength="${SHIFT_CODE_LABEL_MAX}" style="width:90px" onchange="editShiftCode('${c.id}','label',this.value)"></td>
        <td><input type="time" value="${c.start}" step="600" onchange="editShiftCode('${c.id}','start',this.value)"></td>
        <td><input type="time" value="${c.end}" step="600" onchange="editShiftCode('${c.id}','end',this.value)"></td>
        <td><button class="mini danger" onclick="deleteShiftCode('${c.id}')">削除</button></td>
      </tr>`).join('')}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input id="newCodeLabel" type="text" maxlength="${SHIFT_CODE_LABEL_MAX}" placeholder="記号" style="width:90px">
      <input id="newCodeStart" type="time" step="600" value="09:00">
      <input id="newCodeEnd" type="time" step="600" value="18:00">
      <button onclick="addShiftCode()">＋ 記号を追加</button>
    </div>
  </div>`;
}
// 記号として使えるか。使えなければ理由の文章を、使えれば空文字を返す（exceptId：変更する記号自身の id）
function shiftCodeError(c, exceptId){
  if(!c.label) return '記号を入力してください。';
  if(c.label.length>SHIFT_CODE_LABEL_MAX) return `記号は${SHIFT_CODE_LABEL_MAX}文字以内にしてください。`;
  if(!c.start || !c.end || toMin(c.start)>=toMin(c.end)) return '終了は開始より後の時刻にしてください。';
  const others=shiftCodeList().filter(x=>x.id!==exceptId);
  if(others.some(x=>x.label===c.label)) return `記号「${c.label}」はすでにあります。`;
  const same=others.find(x=>x.start===c.start && x.end===c.end);
  if(same) return `${c.start}〜${c.end} の記号は、すでに「${same.label}」があります。`;
  return '';
}
// 記号の一覧を開始時刻の順に並べて保存する。社員の勤務希望の時刻も、新しい記号の時刻に合わせ直す
function saveShiftCodes(list){
  DB.shift_codes=list.slice().sort((a,b)=>toMin(a.start)-toMin(b.start) || toMin(a.end)-toMin(b.end));
  refreshCodePrefs();
  save(); render();
}
function editShiftCode(id,f,v){
  const c=shiftCodeById(id); if(!c) return;
  const next={...c, [f]: f==='label' ? String(v).trim() : snapTenMin(v)};
  const err=shiftCodeError(next,id);
  if(err){ alert(err); render(); return; }
  saveShiftCodes(shiftCodeList().map(x=>x.id===id ? next : x));
}
// 新しい記号の id（ほかの記号と重ならない、変わらない目印）
const genShiftCodeId = () => 'c_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
function addShiftCode(){
  const c={id:genShiftCodeId(), label:document.getElementById('newCodeLabel').value.trim(),
    start:snapTenMin(document.getElementById('newCodeStart').value), end:snapTenMin(document.getElementById('newCodeEnd').value)};
  const err=shiftCodeError(c);
  if(err){ alert(err); return; }
  saveShiftCodes([...shiftCodeList(), c]);
}
// 記号を削除する。その記号を選んでいた社員の勤務希望からも外す（作成済みのシフトは残り、時刻で表示される）
function deleteShiftCode(id){
  const c=shiftCodeById(id); if(!c) return;
  if(!confirm(`記号「${c.label}」（${c.start}〜${c.end}）を削除しますか？\nこの記号を選んでいた社員の勤務希望からも外れます。作成済みのシフトはそのまま残り、時刻で表示されます。`)) return;
  saveShiftCodes(shiftCodeList().filter(x=>x.id!==id));
}

/* ---------- 管理者: 必要最低人数 ---------- */
// 必要最低人数は職務ごとの表に分けて表示する。職務の無い（または知らない職務の）古い時間帯は、
// 消さずに「職務が未設定の時間帯」として出し、職務を選べばその職務の表へ移せるようにする
function viewNeed(){
  const needCells = r => `
        <td><input type="time" value="${r.start}" step="1800" onchange="editNeed('${r.id}','start',this.value)"></td>
        <td><input type="time" value="${r.end}" step="1800" onchange="editNeed('${r.id}','end',this.value)"></td>
        <td><input type="number" min="0" style="width:70px" value="${r.count}" onchange="editNeed('${r.id}','count',+this.value)"></td>
        <td><input type="number" min="0" style="width:70px" value="${Number.isInteger(r.max)?r.max:''}" placeholder="なし" onchange="editNeed('${r.id}','max',this.value)"></td>
        <td><button class="mini danger" onclick="delNeed('${r.id}')">削除</button></td>`;
  const noDuty = DB.required_staff.filter(r=>!dutyById(r.duty));
  return `
  <div class="card">
    <h2 style="margin-bottom:14px">必要最低動員人数設定</h2>
    ${noDuty.length ? `
    <fieldset><legend>職務が未設定の時間帯</legend>
      <div class="scroll"><table>
        <tr><th>職務</th><th>開始</th><th>終了</th><th>必要最低人数</th><th>最高人数</th><th></th></tr>
        ${noDuty.map(r=>`<tr>
          <td><select onchange="editNeed('${r.id}','duty',this.value)">
            <option value="" selected>—（未設定）</option>
            ${dutyOptions(null)}
          </select></td>${needCells(r)}
        </tr>`).join('')}
      </table></div>
    </fieldset>` : ''}
    ${dutyList().map(d=>{
      const rows=DB.required_staff.filter(r=>r.duty===d.id);
      return `
    <fieldset><legend>${escHtml(d.label)}${CLOSED_ON_WEEKENDS_AND_HOLIDAYS.includes(d.id)?'（土日祝は休業）':''}</legend>
      ${rows.length ? `<div class="scroll"><table>
        <tr><th>開始</th><th>終了</th><th>必要最低人数</th><th>最高人数</th><th></th></tr>
        ${rows.map(r=>`<tr>${needCells(r)}</tr>`).join('')}
      </table></div>` : '<p class="note" style="margin:0">まだ設定がありません。</p>'}
      <div class="row" style="margin:8px 0 0"><button class="mini" onclick="addNeed('${d.id}')">＋ ${escHtml(d.label)}の時間帯を追加</button></div>
    </fieldset>`;
    }).join('')}
  </div>`;
}
function editNeed(id,f,v){ const r=DB.required_staff.find(x=>x.id===id);
  if(f==='start'||f==='end') v=snapHalfHour(v); // 開始・終了は00分／30分に固定（そのまま営業時間にもなる）
  if(f==='duty' && !dutyById(v)) return; // 「—（未設定）」のまま変えていないときは何もしない
  let redraw=(f==='start'||f==='end'||f==='duty');
  if(f==='max'){
    // 最高人数：空欄は上限なし（null）。必要最低人数より少ない数は、必要最低人数にそろえる
    const typed=String(v).trim(), n=Number(typed);
    v=(typed==='' || !Number.isInteger(n) || n<0) ? null : Math.max(n, r.count||0);
    if(v!==(typed===''?null:n)) redraw=true; // そろえた数（または空欄）を画面に出し直す
  }
  if(f==='count' && Number.isInteger(r.max) && v>r.max){ r.max=v; redraw=true; } // 最高人数も同じ数にそろえる
  r[f]=v; save(); if(redraw) render(); }
function delNeed(id){ DB.required_staff=DB.required_staff.filter(r=>r.id!==id); save(); render(); }
function addNeed(duty){ DB.required_staff.push({id:'r'+Date.now(),start:'09:00',end:'12:00',count:1,max:null,duty}); save(); render(); }

/* ---------- 管理者: 締切設定 ---------- */
function viewDeadline(){
  const s=DB.settings;
  const validPeriod = s.period_start && s.period_end && s.period_start<=s.period_end;
  const next = validPeriod ? nextPeriodOf(s.period_start,s.period_end) : null;
  const deadline = deadlineDateOf(s.period_start);
  return `
  <div class="card">
    <h2>希望提出締切設定 / 対象期間</h2>
    ${next?`<p class="note">公開後の次の対象期間：<b>${fmtDate(next.start)}〜${fmtDate(next.end)}</b>（締切 ${fmtDate(deadlineDateOf(next.start))}）</p>`:''}
    <fieldset><legend>シフト対象期間</legend>
      <div class="row">
        <label>開始 <input type="date" value="${s.period_start}" onchange="setS('period_start',this.value)"></label>
        <label>終了 <input type="date" value="${s.period_end}" onchange="setS('period_end',this.value)"></label>
      </div>
    </fieldset>
    <fieldset><legend>希望提出締切</legend>
      <div class="row">
        <label>対象期間の初日の <input type="number" min="1" max="60" step="1" style="width:70px" value="${deadlineDaysBefore()}" onchange="setDeadlineDays(this.value)"> 日前</label>
      </div>
      ${deadline?`<p class="note">今の対象期間の締切日：<b>${fmtDate(deadline)}</b></p>`:''}
    </fieldset>
  </div>`;
}
function setS(f,v){ DB.settings[f]=v; save(); render(); }
// 締切を「初日の何日前か」で設定する。空欄（Number('') は 0 になる）や小数などは受け付けず、元の値に戻す
function setDeadlineDays(v){
  const n=Number(v);
  if(!Number.isInteger(n) || n<1 || n>60){
    alert('締切は「初日の何日前か」を 1〜60 の整数で入力してください。');
    render(); // 入力欄を元の値に戻す
    return;
  }
  DB.settings.deadline_days_before=n; save(); render();
}

/* ---------- 管理者: シフト作成・確認 ---------- */
function viewMake(){
  const s=DB.settings;
  const short=shortagesInTarget();
  const targetPub=publishedPeriods().find(pp=>pp.start===s.period_start && pp.end===s.period_end); // 対象期間そのものが公開済みか
  const pubList=publishedPeriods().slice().sort((a,b)=> a.start<b.start ? 1 : -1); // 新しい期間を上に
  const latestPub=latestPublishedPeriod();
  // 法人の社員がいるのに、提出していない人に使う記号（A2）がシフト記号設定に無いときは知らせる
  const missingFixed=[...new Set(DB.users.filter(u=>isAutoCandidate(u) && usesShiftCodes(u) && FIXED_CODE_IF_UNSUBMITTED[dutyOf(u)] && !fixedCodeIfUnsubmitted(u))
    .map(u=>FIXED_CODE_IF_UNSUBMITTED[dutyOf(u)]))];
  return `
  <div class="card">
    <h2>シフト自動作成</h2>
    ${missingFixed.length?`<div class="banner warn">⚠️ シフト記号「${missingFixed.map(escHtml).join('」「')}」がありません。勤務希望を提出していない法人の社員はシフトに入りません。「シフト記号設定」で追加してください。</div>`:''}
    <div class="row">
      <button ${generating?'disabled':''} onclick="doGenerate()">${generating?'⚙️ 作成中…':'⚙️ シフトを自動作成する'}</button>
      <span class="note">${s.last_generated?'最終作成: '+s.last_generated:'未作成'}</span>
    </div>
  </div>

  <div class="card">
    <h2>人員不足</h2>
    ${short.length===0
      ? `<div class="banner ok">✅ 必要最低人数を満たしています（人員不足なし）</div>`
      : `<div class="banner warn">⚠️ ${short.length} 件の時間帯で人員が不足しています</div>
         <div class="scroll"><table>
           <tr><th>日付</th><th>職務</th><th>時間帯</th><th>必要最低人数</th><th>配置人数</th><th>不足</th></tr>
           ${short.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${dutyLabelOf(x)||'—'}</td><td>${x.start}〜${x.end}</td>
             <td>${x.required}人</td><td>${x.assigned}人</td><td class="short">${x.required-x.assigned}人</td></tr>`).join('')}
         </table></div>`}
  </div>

  <div class="card">
    <h2>シフト公開</h2>
    <div class="row">
      ${targetPub
        ? `<span class="pill ok">この期間は公開済み（${targetPub.published_at||'日時不明'}）</span>
           <button onclick="advanceToNextPeriod()">次の対象期間へ進む →</button>`
        : `<button onclick="publish()">📣 ${fmtDate(s.period_start)}〜${fmtDate(s.period_end)} のシフトを公開する</button>`}
    </div>
    ${DB.shifts.filter(x=>x.date>=s.period_start&&x.date<=s.period_end).length===0?'<p class="note">※ まだシフトが作成されていません。</p>':''}
    ${pubList.length?`
    <div class="scroll" style="margin-top:12px"><table>
      <tr><th>公開済みの期間</th><th>公開日時</th><th></th></tr>
      ${pubList.map(pp=>`<tr>
        <td>${fmtDate(pp.start)}〜${fmtDate(pp.end)}</td>
        <td>${pp.published_at||'—'}</td>
        <td>${pp===latestPub?`<button class="ghost mini" onclick="unpublishLatest()">非公開に戻す</button>`:''}</td>
      </tr>`).join('')}
    </table></div>`:''}
  </div>`;
}
function doGenerate(){
  if(generating) return;
  generating=true; render();
  // 計算している間は画面が描き直されないので、「作成中…」が画面に出るまで少し待ってから計算を始める
  setTimeout(()=>{
    try{ generateShifts(); }
    finally{ generating=false; }
    alert('シフトを自動作成しました。人員不足の有無を確認してください。');
    render();
  }, 50);
}

/* ---------- 公開済み期間（公開したシフトの記録） ---------- */
function publishedPeriods(){ return DB.settings.published_periods||[]; }
// いちばん新しい（開始日がいちばん遅い）公開済み期間
function latestPublishedPeriod(){
  const list=publishedPeriods();
  if(list.length===0) return null;
  return list.reduce((a,b)=> b.start>a.start ? b : a);
}
// 作成中の対象期間の人員不足だけを取り出す（人員不足の記録は、公開済みの期間の分も日付ごとに残しているため）
function shortagesInTarget(){
  const s=DB.settings;
  return (s.shortages||[]).filter(x=>x.date>=s.period_start && x.date<=s.period_end);
}
function publish(){
  const s=DB.settings;
  if(DB.shifts.filter(x=>x.date>=s.period_start&&x.date<=s.period_end).length===0){ alert('先にシフトを作成してください。'); return; }
  if(shortagesInTarget().length>0 && !confirm('人員不足の時間帯があります。このまま公開しますか？')) return;
  // 公開済み期間の一覧に記録する（同じ期間を公開し直す場合は入れ替える）。
  // 最終作成日時も覚えておき、「非公開に戻す」ときに元どおりにできるようにする。
  s.published_periods=publishedPeriods().filter(pp=>!(pp.start===s.period_start && pp.end===s.period_end));
  s.published_periods.push({start:s.period_start, end:s.period_end,
    published_at:new Date().toLocaleString('ja-JP'), last_generated:s.last_generated||null});
  const publishedLabel=`${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}`;
  moveTargetToNextPeriod();
  save(); render();
  alert(`${publishedLabel} のシフトを公開しました。\n${nextPeriodMessage()}`);
}
// 対象期間がすでに公開済みのときに、公開し直さずに次の対象期間へ進む（締切設定で公開済みの期間に戻した場合など）
function advanceToNextPeriod(){
  moveTargetToNextPeriod();
  save(); render();
  alert(nextPeriodMessage());
}
// 対象期間を次の期間に切り替える（締切日は初日から計算するので一緒に進む。保存と再描画は呼び出し側で行う）
function moveTargetToNextPeriod(){
  const s=DB.settings;
  const next=nextPeriodOf(s.period_start,s.period_end);
  s.period_start=next.start; s.period_end=next.end;
  delete s.deadline; // 使わなくなった古い値（締切日の日付）が残っていれば消す
  s.last_generated=null; // 次の期間はまだ自動作成していない
  calPeriodKey='target'; editingCell=null; // カレンダーは新しい対象期間の表示に戻す
}
// 切り替え後の対象期間・締切を知らせる文。締切日がもう過ぎていたら直すよう促す
function nextPeriodMessage(){
  const s=DB.settings;
  const deadline=deadlineDateOf(s.period_start);
  let msg=`締切設定を次の対象期間（${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}、締切 ${fmtDate(deadline)}）に切り替えました。`;
  if(deadline<iso(new Date())) msg+='\n※ 新しい締切日はすでに過ぎています。「締切設定」で「初日の何日前か」を見直してください。';
  return msg;
}
// 最後に公開した期間を非公開に戻す。締切設定（対象期間・締切日）もその期間に戻し、修正して公開し直せるようにする。
// 次の期間に入力済みの勤務希望や作成済みのシフトは日付ごとに保存しているので、戻しても消えない。
function unpublishLatest(){
  const s=DB.settings;
  const latest=latestPublishedPeriod();
  if(!latest) return;
  if(!confirm(`${fmtDate(latest.start)}〜${fmtDate(latest.end)} のシフトを非公開に戻します。\n締切設定（対象期間・締切日）もこの期間に戻ります。よろしいですか？`)) return;
  s.published_periods=publishedPeriods().filter(pp=>pp!==latest);
  s.period_start=latest.start; s.period_end=latest.end; // 締切日は初日から計算するので、これで締切日も元に戻る
  s.last_generated=latest.last_generated||null;
  calPeriodKey='target'; editingCell=null;
  save(); render();
}

/* ---------- 管理者: ログイン履歴 ---------- */
// 各アカウントの最終ログイン日だけを表示する（時刻は記録しない）。データは subscribeLastLogins で受信した cloud.lastLogins
function viewLogins(){
  const today=iso(new Date());
  return `
  <div class="card">
    <h2>ログイン履歴</h2>
    ${cloud.lastLoginError?'<div class="banner warn">⚠️ 最終ログイン日を読み込めませんでした。Firebase のセキュリティルール（firestore.rules）が最新の内容で公開されているか確認してください。</div>':''}
    <div class="scroll"><table>
      <tr><th>氏名</th><th>社員番号</th><th>役職</th><th>最終ログイン日</th></tr>
      ${DB.users.map(u=>{
        const d=cloud.lastLogins[u.id];
        return `<tr>
          <td>${u.name} ${u.is_active?'':'<span class="pill muted">在籍外</span>'}</td>
          <td>${u.empNo}</td>
          <td>${roleDisplay(u)||'—'}</td>
          <td>${d ? `${fmtDate(d)} <span class="note">（${daysAgoLabel(d,today)}）</span>` : '<span class="pill muted">記録なし</span>'}</td>
        </tr>`;
      }).join('')}
    </table></div>
  </div>`;
}
// 日付 d が today の何日前かを「今日」「昨日」「3日前」の形で返す
function daysAgoLabel(d,today){
  const n=daysBetween(d,today);
  if(n===0) return '今日';
  if(n===1) return '昨日';
  return n+'日前';
}

/* ---------- 共通: パスワード変更（ログイン中の本人だけ） ---------- */
let pwChangeMsg=null;    // パスワード変更の画面に出すお知らせ {type:'ok'|'warn', text}
let pwChangeBusy=false;  // 変更の通信中（ボタンの二度押し防止）
function viewPassword(){
  const u=currentUser();
  return `
  <div class="card" style="max-width:480px">
    <h2>パスワード変更</h2>
    <p class="desc">${u.name}さん（社員番号 ${u.empNo}）のログイン用パスワードを変更します。本人確認のため、現在のパスワードも入力してください。</p>
    ${pwChangeMsg?`<div class="banner ${pwChangeMsg.type}">${pwChangeMsg.text}</div>`:''}
    <div class="row"><label style="width:100%">現在のパスワード<br>
      <input id="pcCur" type="password" autocomplete="current-password" style="width:100%" placeholder="現在のパスワード"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（6文字以上）<br>
      <input id="pcNew" type="password" autocomplete="new-password" style="width:100%" placeholder="新しいパスワード"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（確認）<br>
      <input id="pcNew2" type="password" autocomplete="new-password" style="width:100%" placeholder="新しいパスワード（再入力）"
        onkeydown="if(event.key==='Enter')changePassword()"></label></div>
    <div class="row" style="margin-bottom:0"><button style="width:100%" ${pwChangeBusy?'disabled':''} onclick="changePassword()">${pwChangeBusy?'変更中…':'パスワードを変更'}</button></div>
  </div>`;
}
// Firebase ではパスワードの変更に「最近ログインした証明」が要るので、現在のパスワードで本人確認（再認証）してから変える
// （席を離れている間に、ほかの人に勝手に変えられるのも防げる）。変更後もログインしたまま使える
async function changePassword(){
  if(pwChangeBusy) return;
  const cur=document.getElementById('pcCur').value||'';
  const pw=document.getElementById('pcNew').value||'';
  const pw2=document.getElementById('pcNew2').value||'';
  let err='';
  if(!cur) err='現在のパスワードを入力してください。';
  else if(pw.length<6) err='新しいパスワードは6文字以上にしてください。';
  else if(pw!==pw2) err='新しいパスワード（確認）が一致しません。';
  else if(pw===cur) err='新しいパスワードが、現在のパスワードと同じです。';
  if(err){ pwChangeMsg={type:'warn', text:err}; render(); return; }
  pwChangeBusy=true; pwChangeMsg=null; render();
  try{
    const user=auth.currentUser;
    await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, cur));
    await user.updatePassword(pw);
    pwChangeMsg={type:'ok', text:'パスワードを変更しました。次回からは新しいパスワードでログインしてください。'};
  }catch(e){
    console.error(e);
    const c=e && e.code;
    const wrongPw = c==='auth/wrong-password' || c==='auth/invalid-credential' || c==='auth/invalid-login-credentials';
    pwChangeMsg={type:'warn', text: wrongPw ? '現在のパスワードが正しくありません。' : authErrorMessage(e)};
  }
  pwChangeBusy=false; render();
}

/* ---------- 管理者/共通: シフトカレンダー ---------- */
// 管理者：作成中の対象期間も含めて見て、編集できる。従業員（職務がある人）：公開済みの期間を見るだけ
function viewCal(){ return calendarHTML(isAdmin()); }
// カレンダーで切り替えられる期間の一覧：作成中の対象期間 ＋ 公開済みの期間（新しい順）。
// 編集できない人（従業員）には、公開済みの期間だけを出す（作成中のシフトは見せない）
function calendarPeriodOptions(editable){
  const s=DB.settings;
  const published=publishedPeriods().slice().sort((a,b)=> a.start<b.start ? 1 : -1);
  if(!editable) return published.map(pp=>({key:pp.start+'_'+pp.end, start:pp.start, end:pp.end,
    label:`${fmtDate(pp.start)}〜${fmtDate(pp.end)}`}));
  const opts=[{key:'target', start:s.period_start, end:s.period_end,
    label:`作成中の対象期間：${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}`}];
  published.forEach(pp=>{
    if(pp.start===s.period_start && pp.end===s.period_end) return; // 対象期間そのものが公開済みなら、重ねて出さない
    opts.push({key:pp.start+'_'+pp.end, start:pp.start, end:pp.end,
      label:`公開済み：${fmtDate(pp.start)}〜${fmtDate(pp.end)}`});
  });
  return opts;
}
// カレンダーで表示中の期間（選んでいた期間が無くなっていたら先頭＝対象期間／最新の公開済み）。期間が1つも無ければ null
function selectedCalPeriod(editable){
  const opts=calendarPeriodOptions(editable);
  return opts.find(o=>o.key===calPeriodKey) || opts[0] || null;
}
function selectCalPeriod(key){ calPeriodKey=key; editingCell=null; render(); }
function selectCalDuty(key){ calDuty=key; editingCell=null; render(); }
// シフトの表示。社員は時刻が同じ記号があれば記号（例：A）、PA は「出勤 / - / 退勤」の3行、それ以外は1行
function shiftTimeHTML(u, sh){
  const code=usesShiftCodes(u) ? shiftCodeOfTimes(sh.start,sh.end) : null;
  if(code) return `<div class="shift-code" title="${sh.start}〜${sh.end}">${escHtml(code.label)}</div>`;
  return (u && u.position==='pa') ? `<div class="shift-time">${sh.start}<br>-<br>${sh.end}</div>` : `<div>${sh.start}〜${sh.end}</div>`;
}
// シフトを1行の文字にする（CSV など）。社員は記号があれば記号
function shiftText(u, sh){
  const code=usesShiftCodes(u) ? shiftCodeOfTimes(sh.start,sh.end) : null;
  return code ? code.label : sh.start+'〜'+sh.end;
}
function calendarHTML(editable){
  const s=DB.settings;
  const periodOpts=calendarPeriodOptions(editable);
  if(periodOpts.length===0) return `<div class="card"><h2>シフトカレンダー</h2>
    <div class="banner warn">🔒 シフトはまだ公開されていません。公開までお待ちください。</div></div>`;
  const period=selectedCalPeriod(editable);
  const periodPublished=publishedPeriods().some(pp=>pp.start===period.start && pp.end===period.end);
  const days=rangeDates(period.start,period.end);
  // 表示する職務：選んだ職務 → 自分の職務 → 一覧の先頭。管理者には「職務が未設定の人」も選べるようにする（手入力したシフトを直せるように）
  const dutyChoices=dutyList().map(d=>({key:d.id, label:escHtml(d.label)}));
  // 「職務が未設定の人」：職務が無いのに、この期間にシフトがある人（手で入れたシフトを直せるように）
  const noDutyWithShifts=DB.users.filter(u=>!dutyOf(u) && DB.shifts.some(x=>x.user_id===u.id && x.date>=period.start && x.date<=period.end));
  if(editable && noDutyWithShifts.length) dutyChoices.push({key:'none', label:'職務が未設定の人'});
  const dutyChoice=dutyChoices.find(c=>c.key===calDuty) || dutyChoices.find(c=>c.key===dutyOf(currentUser())) || dutyChoices[0] || {key:'none'};
  const duty=dutyChoice.key;
  const emps=duty==='none' ? noDutyWithShifts : DB.users.filter(u=>dutyOf(u)===duty);
  // シフトが無い日は「公」。希望休は赤い「公」、それ以外の休み（選ばれなかった日・休業日）は出勤と同じ色の「公」。
  // まだ自動作成していない期間（シフトが1本も無い期間）は、希望休以外は空白のままにする
  const periodHasShifts=DB.shifts.some(x=>x.date>=period.start && x.date<=period.end);
  const cell=(u,date)=>{
    const p=(DB.employee_preferences[u.id]||{})[date];
    const list=DB.shifts.filter(x=>x.user_id===u.id&&x.date===date).sort((a,b)=>toMin(a.start)-toMin(b.start));
    const selected=editable && editingCell && editingCell.userId===u.id && editingCell.date===date;
    const closed=isDutyClosed(dutyOf(u),date); // 職務の休業日（法人の土日祝）は、希望休が入っていても希望休とは見せない
    const requestedOff=!list.length && !closed && !!(p&&p.day_off);                // 希望休
    const otherRest=!list.length && !requestedOff && (periodHasShifts || closed);  // それ以外の休み
    const cls=[dayKindOf(date)].filter(Boolean); // 列の背景色：平日は白、土曜は薄い青、日曜・祝日は薄い赤
    if(requestedOff) cls.push('req-off');        // 希望休の「公」だけ赤い文字（それ以外の公は黒）
    if(editable) cls.push('editable-cell');
    if(selected) cls.push('selected');
    const onclick=editable?` onclick="selectCell('${u.id}','${date}')"`:'';
    let inner;
    if(list.length){
      inner=list.map(x=>shiftTimeHTML(u,x)).join('');
    } else if(requestedOff || otherRest){
      inner='公';
    } else {
      inner='';
    }
    return `<td class="${cls.join(' ')}"${onclick}>${inner}</td>`;
  };
  // 「休み」の列（管理者だけ）：表示中の期間で、シフトが入っていない日の数。
  // その人の職務に、その月の月最低休日数があれば「休み / 最低日数」で出し、足りなければ赤くする
  const offMonthKey=monthKeyOf(period.start);
  const offCell=u=>{
    const workDays=new Set(DB.shifts.filter(x=>x.user_id===u.id && x.date>=period.start && x.date<=period.end).map(x=>x.date)).size;
    const off=days.length-workDays;
    const minOff=minDaysOffFor(dutyOf(u), offMonthKey);
    if(!minOff) return `<td>${off}日</td>`;
    return `<td class="${off<minOff?'short':''}">${off} / ${minOff}日</td>`;
  };
  const editingUser = editingCell && DB.users.find(u=>u.id===editingCell.userId);
  const editingShift = editingCell && DB.shifts.find(x=>x.user_id===editingCell.userId && x.date===editingCell.date);
  return `
  <div class="card">
    <h2>シフトカレンダー</h2>
    <div class="row">
      <label>表示する職務
        <select onchange="selectCalDuty(this.value)">
          ${dutyChoices.map(c=>`<option value="${c.key}" ${c.key===duty?'selected':''}>${c.label}</option>`).join('')}
        </select>
      </label>
      <label>表示する期間
        <select onchange="selectCalPeriod(this.value)">
          ${periodOpts.map(o=>`<option value="${o.key}" ${o.key===period.key?'selected':''}>${o.label}</option>`).join('')}
        </select>
      </label>
      ${editable?'<button class="ghost" onclick="exportCalendarCsv()">CSVで出力（全職務）</button>':''}
      ${editable?'<button class="ghost" onclick="exportCalendarA3()">A3画像で保存（全職務）</button>':''}
    </div>
    <p class="desc">${fmtDate(period.start)}〜${fmtDate(period.end)}　${periodPublished?'<span class="pill ok">公開中</span>':'<span class="pill muted">非公開</span>'}</p>
    <div class="scroll"><table class="cal">
      <tr><th>従業員</th>${editable?'<th>休み</th>':''}${days.map(d=>`<th class="${dayKindOf(d)}">${fmtDate(d)}</th>`).join('')}</tr>
      ${emps.map(u=>`<tr><th>${u.name}</th>${editable?offCell(u):''}${days.map(d=>cell(u,d)).join('')}</tr>`).join('')}
      <tr><th>必要最低人数充足</th>${editable?'<td></td>':''}${days.map(d=>{
        const list=s.shortages.filter(x=>x.date===d && x.duty===duty); // 表示中の職務の不足だけ
        if(list.length===0) return `<td class="${dayKindOf(d)}">—</td>`;
        return `<td class="short">${list.map(x=>x.start+'〜'+x.end).join('<br>')}</td>`;
      }).join('')}</tr>
    </table></div>
    ${editable && editingCell?`
    <fieldset style="margin-top:14px"><legend>シフト編集：${editingUser?editingUser.name:''}（${fmtDate(editingCell.date)}）</legend>
      <div class="row">
        ${usesShiftCodes(editingUser) ? `<select id="edCode">
          <option value="">—（記号を選ぶ）</option>
          ${shiftCodeList().map(c=>`<option value="${c.id}" ${editingShift && editingShift.start===c.start && editingShift.end===c.end ? 'selected' : ''}>${escHtml(c.label)}（${c.start}〜${c.end}）</option>`).join('')}
        </select>` : `
        <input type="time" id="edStart" value="${editingShift?editingShift.start:'10:00'}" step="1800">
        <input type="time" id="edEnd" value="${editingShift?editingShift.end:'18:00'}" step="1800">`}
        <button onclick="saveCellShift()">${editingShift?'更新':'追加'}</button>
        ${editingShift?`<button class="danger" onclick="deleteCellShift()">このシフトを削除</button>`:''}
        <button class="ghost" onclick="closeCellEditor()">閉じる</button>
      </div>
    </fieldset>`:''}
  </div>`;
}
/* ---------- シフトカレンダーの CSV 出力（管理者だけ） ---------- */
// カレンダーと同じ形（縦に従業員・横に日付）で、表示中の期間の全職務分を出す。
// 完成したシフトを出すためのものなので、人員不足の行は出さない。職務ごとに従業員をまとめ、職務が未設定の人は最後に出す
function exportCalendarCsv(){
  if(!isAdmin()) return;
  const period=selectedCalPeriod(true);
  if(!period) return;
  const days=rangeDates(period.start,period.end);
  const periodHasShifts=DB.shifts.some(x=>x.date>=period.start && x.date<=period.end);
  const cellText=(u,date)=>{
    const list=DB.shifts.filter(x=>x.user_id===u.id&&x.date===date).sort((a,b)=>toMin(a.start)-toMin(b.start));
    if(list.length) return list.map(x=>shiftText(u,x)).join(' / ');
    const p=(DB.employee_preferences[u.id]||{})[date];
    // シフトが無い日は「公」（まだ自動作成していない期間は、希望休と休業日だけ）
    return ((p&&p.day_off) || isDutyClosed(dutyOf(u),date) || periodHasShifts) ? '公' : '';
  };
  const userRow=(dutyName,u)=>[dutyName, u.name, u.empNo, positionLabel(u), ...days.map(d=>cellText(u,d))];
  const rows=[['職務','氏名','社員番号','役職', ...days.map(fmtDate)]];
  for(const d of dutyList()){
    DB.users.filter(u=>isStaff(u) && dutyOf(u)===d.id).forEach(u=>rows.push(userRow(d.label,u)));
  }
  // 職務が無いのに、この期間にシフトがある人（手で入れたシフト）
  DB.users.filter(u=>!dutyOf(u) && DB.shifts.some(x=>x.user_id===u.id && x.date>=period.start && x.date<=period.end))
    .forEach(u=>rows.push(userRow('（職務未設定）',u)));
  // 先頭の ﻿（BOM）は「この文字は UTF-8 です」という印。これが無いと、Excel が文字化けして開いてしまう
  const csv='﻿'+rows.map(r=>r.map(csvField).join(',')).join('\r\n')+'\r\n';
  downloadTextFile(`シフト_${currentStore.code}_${period.start}_${period.end}.csv`, csv, 'text/csv;charset=utf-8');
}
// CSV の1マス分の文字にする。
// ・「,」「"」改行を含むときは全体を "" で囲み、中の " は "" にする（CSV の決まり）
// ・= + - @ などで始まると、Excel が数式として実行してしまう（CSV インジェクション）ので、先頭に ' を付けて文字として扱わせる
function csvField(v){
  let s=String(v==null ? '' : v);
  if(/^[=+\-@\t\r]/.test(s)) s="'"+s;
  return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
// 文字列をファイルとしてダウンロードさせる
function downloadTextFile(filename, text, type){ downloadBlob(filename, new Blob([text],{type})); }
// データ（Blob）をファイルとしてダウンロードさせる（画面には出さないリンクを作って押す）
function downloadBlob(filename, blob){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000); // ダウンロードが始まったら、作った一時的な URL を片付ける
}

/* ---------- シフトカレンダーの A3 画像出力（管理者だけ） ---------- */
// 表示中の期間の全職務分を、A3 縦（297×420mm）の紙1枚の表にして PNG 画像で保存する。
// 外部の部品は使わず、canvas（図を描く機能）に表を直接描く。
// 大きさは、A3 を 96dpi（1インチ＝96px）で表した 1123×1587 の2倍で描く（印刷しても文字がつぶれないように）
const A3_W=1123, A3_H=1587, A3_SCALE=2;
const A3_FONT='"Yu Gothic","YuGothic","Hiragino Sans","Hiragino Kaku Gothic ProN","Meiryo","Noto Sans JP",sans-serif';
// 列の色（見出し・マス・見出しの文字）：平日は白、土曜は薄い青、日曜・祝日は薄い赤
const A3_DAY_COLORS = {
  '':  {head:'#e8eef8', cell:'#fff',    text:'#1d2433'},
  sat: {head:'#dce9ff', cell:'#e8f1ff', text:'#1b4fa0'},
  sun: {head:'#ffe0e0', cell:'#ffe9e9', text:'#b42318'},
};
function exportCalendarA3(){
  if(!isAdmin()) return;
  const period=selectedCalPeriod(true);
  if(!period) return;
  const days=rangeDates(period.start,period.end);
  const short=t=>t.replace(/^0/,''); // 09:00 → 9:00

  // ---- 表の中身：職務ごとの従業員の行（CSV と同じ人を、同じ順に出す）。完成したシフトを出すので、人員不足の行は出さない ----
  const periodHasShifts=DB.shifts.some(x=>x.date>=period.start && x.date<=period.end);
  const personRow=u=>({u, cells:days.map(date=>{
    const list=DB.shifts.filter(x=>x.user_id===u.id && x.date===date).sort((a,b)=>toMin(a.start)-toMin(b.start));
    if(list.length){
      const sh=list[0], code=usesShiftCodes(u) ? shiftCodeOfTimes(sh.start,sh.end) : null;
      return code ? {code:code.label, more:list.length>1} : {start:short(sh.start), end:short(sh.end), more:list.length>1};
    }
    const p=(DB.employee_preferences[u.id]||{})[date];
    // 希望休は off（赤い「公」）、それ以外の休みは rest（出勤と同じ色の「公」）
    if(isDutyClosed(dutyOf(u),date)) return {rest:true}; // 休業日は、希望休が入っていても「そのほかの休み」
    if(p && p.day_off) return {off:true};
    return periodHasShifts ? {rest:true} : {};
  })});
  const sections=[];
  for(const d of dutyList()){
    const staff=DB.users.filter(u=>isStaff(u) && dutyOf(u)===d.id);
    if(staff.length===0) continue; // 従業員のいない職務は出さない
    sections.push({label:`${d.label}（${staff.length}人）`, rows:staff.map(personRow)});
  }
  const noDuty=DB.users.filter(u=>!dutyOf(u) && DB.shifts.some(x=>x.user_id===u.id && x.date>=period.start && x.date<=period.end));
  if(noDuty.length) sections.push({label:'職務未設定', rows:noDuty.map(personRow)});

  // ---- 行の高さを決める（用紙が余れば行を広げ、足りなければ全体を縮める） ----
  const M=22, NAME_W=92, OFF_W=20, TOP=M+70, FOOT=18;
  const HEAD_H=24, BAND_H=17;
  let personH=20;
  const tableH=()=>HEAD_H+sections.reduce((a,sec)=>a+BAND_H+sec.rows.length*personH, 0);
  const rowCount=sections.reduce((a,sec)=>a+sec.rows.length, 0);
  const room=A3_H-TOP-FOOT-M-tableH();
  if(room>0 && rowCount>0) personH+=Math.min(14, room/rowCount);
  const totalH=TOP+tableH()+FOOT+M;
  const fit=Math.min(1, A3_H/totalH);  // 1枚に入らなければ、この割合で全体を縮める
  const W=A3_W/fit;                    // 縮める分、横幅を広く描いておく（縮めると A3 の横幅にちょうど合う）
  const dayW=(W-2*M-NAME_W-OFF_W)/days.length;

  // ---- canvas に描く ----
  const canvas=document.createElement('canvas');
  canvas.width=A3_W*A3_SCALE; canvas.height=A3_H*A3_SCALE;
  const g=canvas.getContext('2d');
  g.scale(A3_SCALE*fit, A3_SCALE*fit);
  g.fillStyle='#fff'; g.fillRect(0,0,W,A3_H/fit);
  const box=(x,y,w,h,fill)=>{ if(fill){ g.fillStyle=fill; g.fillRect(x,y,w,h); } g.strokeStyle='#c9d3e3'; g.lineWidth=0.75; g.strokeRect(x,y,w,h); };
  // 文字を書く。clip を渡すと、その幅からはみ出す部分は描かない
  const text=(s,x,y,{size=9,weight=400,color='#1d2433',align='center',clip=null}={})=>{
    g.save();
    if(clip){ g.beginPath(); g.rect(clip[0],clip[1],clip[2],clip[3]); g.clip(); }
    g.font=`${weight} ${size}px ${A3_FONT}`; g.fillStyle=color; g.textAlign=align; g.textBaseline='middle';
    g.fillText(s,x,y); g.restore();
  };
  const dayColor=d=>A3_DAY_COLORS[dayKindOf(d)];
  const dayX=i=>M+NAME_W+OFF_W+i*dayW;

  // 見出し・期間・記号の説明
  const totalShifts=DB.shifts.filter(x=>x.date>=period.start && x.date<=period.end).length;
  text(`シフト表　${currentStore.code} ${currentStore.name}`, M, M+10, {size:19, weight:700, align:'left'});
  text(`対象期間 ${fmtDate(period.start)}〜${fmtDate(period.end)}　／　シフト ${totalShifts} 本`, M, M+32, {size:10.5, color:'#445', align:'left'});
  let lx=M;
  text('社員の記号：', lx, M+52, {size:10, align:'left'}); lx+=60;
  for(const c of shiftCodeList()){
    g.font=`700 10px ${A3_FONT}`; const cw=Math.max(24, g.measureText(c.label).width+8);
    box(lx, M+45, cw, 14, '#fff'); text(c.label, lx+cw/2, M+52, {size:10, weight:700, color:'#333'});
    const t=`${short(c.start)}〜${short(c.end)}`; text(t, lx+cw+4, M+52, {size:10, align:'left'});
    g.font=`400 10px ${A3_FONT}`; lx+=cw+4+g.measureText(t).width+12;
  }
  // 記号が多くて右端からはみ出すときは、この説明の文字を小さくして1行におさめる
  const note='／ PA は出勤・退勤を2行で表示　／ 赤い公＝希望休　／ 公＝そのほかの休み　／「休」列＝その期間の休みの日数';
  g.font=`400 10px ${A3_FONT}`;
  const noteSize=Math.max(6, Math.min(10, 10*(W-M-lx)/g.measureText(note).width));
  text(note, lx, M+52, {size:noteSize, align:'left', color:'#445'});

  // 表の見出し（日付）
  let y=TOP;
  box(M, y, NAME_W, HEAD_H, '#e8eef8'); text('従業員', M+NAME_W/2, y+HEAD_H/2, {size:9, weight:700});
  box(M+NAME_W, y, OFF_W, HEAD_H, '#e8eef8'); text('休', M+NAME_W+OFF_W/2, y+HEAD_H/2, {size:9, weight:700});
  days.forEach((d,i)=>{
    const dt=new Date(d+'T00:00'), c=dayColor(d); // 祝日は日曜日と同じ色
    box(dayX(i), y, dayW, HEAD_H, c.head);
    text(`${dt.getMonth()+1}/${dt.getDate()}`, dayX(i)+dayW/2, y+HEAD_H/2-5, {size:8.6, weight:700, color:c.text});
    text(DOW[dt.getDay()], dayX(i)+dayW/2, y+HEAD_H/2+5, {size:8.6, weight:700, color:c.text});
  });
  y+=HEAD_H;

  for(const sec of sections){
    // 職務の帯
    g.fillStyle='#2f6fd6'; g.fillRect(M, y, W-2*M, BAND_H);
    text(sec.label, M+6, y+BAND_H/2, {size:10.5, weight:700, color:'#fff', align:'left'});
    y+=BAND_H;
    // 従業員の行
    for(const row of sec.rows){
      const u=row.u;
      box(M, y, NAME_W, personH, '#f7f9fc');
      const tag=usesShiftCodes(u) ? '社員' : ({dependent:'扶養', dependent_student:'学生'}[paTypeOf(u)] || 'PA');
      g.font=`700 7.5px ${A3_FONT}`; const tw=g.measureText(tag).width+4;
      g.fillStyle=usesShiftCodes(u) ? '#173a7a' : '#e3e8ef'; g.fillRect(M+3, y+personH/2-5, tw, 10);
      text(tag, M+3+tw/2, y+personH/2, {size:7.5, weight:700, color:usesShiftCodes(u) ? '#fff' : '#334'});
      text(u.name, M+6+tw, y+personH/2, {size:9, weight:600, align:'left', clip:[M, y, NAME_W-2, personH]});
      box(M+NAME_W, y, OFF_W, personH, '#f7f9fc');
      text(String(row.cells.filter(c=>!c.code && !c.start).length), M+NAME_W+OFF_W/2, y+personH/2, {size:8.6, color:'#556'});
      row.cells.forEach((c,i)=>{
        // 背景はどのマスも列の色。文字は黒で、希望休の「公」だけ赤
        const x=dayX(i), cx=x+dayW/2, cy=y+personH/2;
        box(x, y, dayW, personH, dayColor(days[i]).cell);
        if(c.code) text(c.code+(c.more?'+':''), cx, cy, {size:10, weight:700, color:'#333'});
        else if(c.start){ text(c.start, cx, cy-4.6, {size:8, color:'#333'}); text(c.end+(c.more?'+':''), cx, cy+4.6, {size:8, color:'#333'}); }
        else if(c.off || c.rest){
          const staffSize=usesShiftCodes(u); // 社員は記号と、PA は時刻と同じくらいの大きさ
          text('公', cx, cy, {size:staffSize?10:9, weight:staffSize?700:400, color:c.off ? '#c0392b' : '#333'});
        }
      });
      y+=personH;
    }
  }
  text(`Shiftly ／ ${new Date().toLocaleString('ja-JP')} 出力`, M, y+12, {size:9, color:'#667', align:'left'});

  canvas.toBlob(blob=>{
    if(!blob){ alert('画像を作れませんでした。'); return; }
    // ファイル名は「shift_店舗コード_西暦-月.png」（月は期間の初日の月。例：shift_1508_2026-11.png）
    downloadBlob(`shift_${currentStore.code}_${monthKeyOf(period.start)}.png`, blob);
  }, 'image/png');
}
// カレンダーのシフト編集：マスを押すと、その人・その日の編集欄を開く（もう一度押すと閉じる）
function selectCell(userId,date){
  editingCell = (editingCell && editingCell.userId===userId && editingCell.date===date) ? null : {userId,date};
  render();
}
function closeCellEditor(){ editingCell=null; render(); }
function saveCellShift(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  // 社員は記号から選ぶ。それ以外の人は時刻を入れる（00分／30分に固定）
  const codeEl=document.getElementById('edCode');
  const code=codeEl ? shiftCodeById(codeEl.value) : null;
  if(codeEl && !code){ alert('記号を選んでください'); return; }
  const st=code ? code.start : snapHalfHour(document.getElementById('edStart').value);
  const en=code ? code.end : snapHalfHour(document.getElementById('edEnd').value);
  if(toMin(st)>=toMin(en)){ alert('終了は開始より後にしてください'); return; }
  const u=DB.users.find(x=>x.id===userId);
  const dur=toMin(en)-toMin(st);
  const pa=u && !usesShiftCodes(u) && PA_TYPES[u.permission]; // 扶養の上限は PA だけ
  // 手動編集でも、扶養PA（週20時間未満）・扶養学生PA（週40時間未満・1日8時間未満）の上限は超えないようにする
  if(pa && u.permission==='dependent_student' && dur>=DEPENDENT_STUDENT_DAY_CAP_MIN){
    alert(`${paLabel(u)}は1日8時間未満までです（入力内容だと${(dur/60).toFixed(1)}時間になります）`); return;
  }
  if(pa && pa.weekCapMin!=null){
    const wk=isoWeekKey(date);
    const weekTotal=DB.shifts.filter(x=>x.user_id===userId && x.date!==date && isoWeekKey(x.date)===wk)
      .reduce((a,x)=>a+(toMin(x.end)-toMin(x.start)),0) + dur;
    if(weekTotal>=pa.weekCapMin){
      alert(`${paLabel(u)}は週${pa.weekCapMin/60}時間未満までです（この週の合計が${(weekTotal/60).toFixed(1)}時間になります）`); return;
    }
  }
  DB.shifts=DB.shifts.filter(x=>!(x.user_id===userId&&x.date===date));
  DB.shifts.push({user_id:userId,date,start:st,end:en});
  recomputeShortagesForDate(date);
  save(); render();
}
function deleteCellShift(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  if(!confirm('このシフトを削除しますか？')) return;
  DB.shifts=DB.shifts.filter(x=>!(x.user_id===userId&&x.date===date));
  recomputeShortagesForDate(date);
  save(); render();
}

/* ---------- 従業員: ホーム ---------- */
function viewHome(){
  const s=DB.settings, u=currentUser();
  const days=rangeDates(s.period_start,s.period_end);
  const p=DB.employee_preferences[u.id]||{};
  const done=days.filter(d=>p[d]).length;
  const submitted=DB.submissions[u.id]===s.period_start;
  const afterDeadline=isAfterDeadline();
  const latestPub=latestPublishedPeriod();
  return `
  <div class="card">
    <h2>従業員ホーム（${u.name}）</h2>
    <div class="kpi">
      <div class="box"><span class="note">対象期間</span><b>${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}</b></div>
      <div class="box"><span class="note">提出締切</span><b>${fmtDate(deadlineDateOf(s.period_start))}</b> ${afterDeadline?'<span class="pill bad">締切後（編集不可）</span>':'<span class="pill ok">編集できます</span>'}</div>
      <div class="box"><span class="note">希望入力</span><b>${done} / ${days.length} 日</b> ${submitted?'<span class="pill ok">提出済み</span>':'<span class="pill warn">未提出</span>'}</div>
      <div class="box"><span class="note">公開済みの最新シフト</span><b>${latestPub?`${fmtDate(latestPub.start)}〜${fmtDate(latestPub.end)}`:'<span class="pill muted">未公開</span>'}</b></div>
    </div>
    <div class="row" style="margin-top:12px">
      <button onclick="go('pref')">勤務希望を入力・編集する</button>
      <button class="ghost" onclick="go('myshift')">自分のシフトを確認する</button>
    </div>
  </div>`;
}

/* ---------- 従業員: 勤務希望入力 ---------- */
function viewPref(){
  const s=DB.settings, u=currentUser();
  const days=rangeDates(s.period_start,s.period_end);
  const locked = isAfterDeadline() && !isAdmin();
  DB.employee_preferences[u.id]=DB.employee_preferences[u.id]||{};
  const p=DB.employee_preferences[u.id];
  const submitted=DB.submissions[u.id]===s.period_start;
  if(usesShiftCodes(u)) return viewPrefCodes(u,days,locked,submitted); // 社員は記号で入力する
  return `
  <div class="card">
    <h2>勤務希望入力</h2>
    ${locked?'<div class="banner warn">⚠️ 提出締切を過ぎているため編集できません（管理者のみ編集可）</div>':''}
    ${u.permission==='dependent_student'?'<div class="banner ok">🎓 扶養学生PAのため、自動作成では「1日の勤務は8時間未満」「週の勤務時間は40時間未満」になるよう調整されます。</div>'
      :u.permission==='dependent'?'<div class="banner ok">📌 扶養PAのため、自動作成では「週の勤務時間が20時間未満」になるよう調整されます。</div>':''}
    <p class="desc">📌 「出勤可能」と「希望」は意味が違います。<b>出勤可能</b>は、人手が足りない時だけ頼ってもよい、一番外側の限界の時間です。<b>希望</b>は、普段このシフトで働きたい時間です。希望は出勤可能の範囲内で入力してください（自動作成では、まず希望どおりに配置し、人員不足の穴埋めが必要な時だけ出勤可能の範囲まで頼ります）。</p>
    <fieldset><legend>勤務可能時間・希望の一括設定（平日／土日）</legend>
      <p class="desc">平日と土日で別々に設定できます。反映すると、この期間の対象日（希望休の日を除く）に一括で適用されます。あわせて既定値として保存されるので、次の期間でも自動的にこの内容が初期値になり、毎回入力し直す手間がなくなります。</p>
      <div class="row">
        <b style="width:60px;display:inline-block">平日</b>
        <label>出勤可能 開始 <input type="time" id="bulkWeekdayAvailStart" value="${(groupDefaultAvail(u.id,'weekday')||groupBizHoursFallback('weekday')).avail_start}" step="1800" ${locked?'disabled':''}></label>
        <label>終了 <input type="time" id="bulkWeekdayAvailEnd" value="${(groupDefaultAvail(u.id,'weekday')||groupBizHoursFallback('weekday')).avail_end}" step="1800" ${locked?'disabled':''}></label>
      </div>
      <div class="row">
        <b style="width:60px;display:inline-block"></b>
        <label>希望　出勤 <input type="time" id="bulkWeekdayStart" value="${(groupDefaultAvail(u.id,'weekday')||groupBizHoursFallback('weekday')).start}" step="1800" ${locked?'disabled':''}></label>
        <label>退勤 <input type="time" id="bulkWeekdayEnd" value="${(groupDefaultAvail(u.id,'weekday')||groupBizHoursFallback('weekday')).end}" step="1800" ${locked?'disabled':''}></label>
        <button ${locked?'disabled':''} onclick="applyBulkAvailability('${u.id}','weekday')">平日に反映して既定値として保存</button>
      </div>
      <div class="row">
        <b style="width:60px;display:inline-block">土日</b>
        <label>出勤可能 開始 <input type="time" id="bulkWeekendAvailStart" value="${(groupDefaultAvail(u.id,'weekend')||groupBizHoursFallback('weekend')).avail_start}" step="1800" ${locked?'disabled':''}></label>
        <label>終了 <input type="time" id="bulkWeekendAvailEnd" value="${(groupDefaultAvail(u.id,'weekend')||groupBizHoursFallback('weekend')).avail_end}" step="1800" ${locked?'disabled':''}></label>
      </div>
      <div class="row">
        <b style="width:60px;display:inline-block"></b>
        <label>希望　出勤 <input type="time" id="bulkWeekendStart" value="${(groupDefaultAvail(u.id,'weekend')||groupBizHoursFallback('weekend')).start}" step="1800" ${locked?'disabled':''}></label>
        <label>退勤 <input type="time" id="bulkWeekendEnd" value="${(groupDefaultAvail(u.id,'weekend')||groupBizHoursFallback('weekend')).end}" step="1800" ${locked?'disabled':''}></label>
        <button ${locked?'disabled':''} onclick="applyBulkAvailability('${u.id}','weekend')">土日に反映して既定値として保存</button>
      </div>
    </fieldset>
    <fieldset><legend>希望休日 ＆ 出勤可能時間・希望（日ごと）</legend>
    <div class="scroll"><table>
      <tr><th>日付</th><th>希望休</th><th>出勤可能<br>開始</th><th>出勤可能<br>終了</th><th>希望<br>出勤</th><th>希望<br>退勤</th></tr>
      ${days.map(d=>{
        // 職務の休業日（法人の土日祝）は入力できない
        if(isDutyClosed(dutyOf(u),d)) return `<tr><td>${fmtDate(d)}</td><td colspan="5"><span class="pill muted">公（休業日）</span></td></tr>`;
        const rec=p[d]||{day_off:false, ...defaultAvailFor(u.id,d)};
        return `<tr>
          <td>${fmtDate(d)}</td>
          <td><input type="checkbox" ${rec.day_off?'checked':''} ${locked?'disabled':''} onchange="setPref('${u.id}','${d}','day_off',this.checked)"></td>
          <td><input type="time" value="${rec.avail_start}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','avail_start',this.value)"></td>
          <td><input type="time" value="${rec.avail_end}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','avail_end',this.value)"></td>
          <td><input type="time" value="${rec.start}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','start',this.value)"></td>
          <td><input type="time" value="${rec.end}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','end',this.value)"></td>
        </tr>`;
      }).join('')}
    </table></div>
    </fieldset>
    <div class="row">
      ${locked
        ? '<span class="pill bad">締切後のため提出・変更できません</span>'
        : `<button onclick="submitPref('${u.id}')">${submitted?'この内容で再提出する':'この内容で提出する'}</button>
           ${submitted?'<span class="pill ok">提出済み</span>':'<span class="pill warn">未提出</span>'}`}
    </div>
    <p class="note">入力内容は自動保存されます。<br>
      希望休が無くても提出できます。変更していない日は、表に表示されている時間（出勤可能・希望とも）で提出されます。</p>
  </div>`;
}
function submitPref(uid){
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end);
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  const p=DB.employee_preferences[uid];
  if(usesShiftCodes(DB.users.find(x=>x.id===uid))){
    // 社員：表に表示されている記号（未入力の日は一括設定の既定値）で提出する
    const recs=days.map(d=>codeRecOf(uid,d));
    if(recs.every(r=>r.day_off) && !confirm('出勤できる日が1日もありません（すべて希望休）。このまま提出しますか？')) return;
    days.forEach((d,i)=>{ p[d]=recs[i]; });
    DB.submissions[uid]=s.period_start;
    save(); render();
    alert('勤務希望を提出しました。');
    return;
  }
  // 未入力の日は、初期値（一括設定の既定値か営業時間）の出勤可能時間・希望で埋める
  for(const d of days){
    if(p[d]) continue;
    p[d]={day_off:false, ...defaultAvailFor(uid,d)};
  }
  DB.submissions[uid]=s.period_start;
  save(); render();
  alert('勤務希望を提出しました。');
}
function setPref(uid,date,f,v){
  if(f==='start'||f==='end'||f==='avail_start'||f==='avail_end') v=snapHalfHour(v); // 出勤・退勤時刻は00分／30分に固定
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  const rec=DB.employee_preferences[uid][date]||{day_off:false, ...defaultAvailFor(uid,date)};
  rec[f]=v; DB.employee_preferences[uid][date]=rec; save();
  if(f==='day_off'||f==='start'||f==='end'||f==='avail_start'||f==='avail_end') render(); // 丸めた値を入力欄に反映するため再描画
}
// 出勤可能時間・希望の一括設定：既定値として保存し（次の期間にも引き継ぐ）、この期間の該当する日（希望休を除く）に反映する
function applyBulkAvailability(uid,group){
  const prefix = group==='weekend' ? 'bulkWeekend' : 'bulkWeekday';
  const start=snapHalfHour(document.getElementById(prefix+'Start').value); // 出勤・退勤時刻は00分／30分に固定
  const end=snapHalfHour(document.getElementById(prefix+'End').value);
  const availStart=snapHalfHour(document.getElementById(prefix+'AvailStart').value);
  const availEnd=snapHalfHour(document.getElementById(prefix+'AvailEnd').value);
  if(!start||!end||!availStart||!availEnd){ alert('出勤可能・希望の開始・終了をすべて入力してください。'); return; }
  if(toMin(start)>=toMin(end)){ alert('希望の終了は開始より後にしてください。'); return; }
  if(toMin(availStart)>=toMin(availEnd)){ alert('出勤可能の終了は開始より後にしてください。'); return; }
  DB.default_availability[uid]=DB.default_availability[uid]||{};
  DB.default_availability[uid][group]={start,end,avail_start:availStart,avail_end:availEnd}; // 平日／土日を分けて保存する
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end).filter(d=>isWeekendDow(dowOf(d))===(group==='weekend'));
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  const p=DB.employee_preferences[uid];
  days.forEach(d=>{
    const rec=p[d]||{day_off:false,start:'',end:'',avail_start:'',avail_end:''};
    if(!rec.day_off){ rec.start=start; rec.end=end; rec.avail_start=availStart; rec.avail_end=availEnd; }
    p[d]=rec;
  });
  save(); render();
  alert(`${group==='weekend'?'土日':'平日'}の出勤可能時間・希望を反映し、今後の期間にも使う既定値として保存しました。`);
}

/* ---------- 社員の勤務希望入力（シフト記号） ---------- */
// 社員は、日ごとに働ける記号をいくつでも選ぶ（どれも選ばない日は希望休）。
// 勤務希望には、選んだ記号の id（codes）と、記号の最も早い開始〜最も遅い終了（start/end・avail_start/avail_end）を保存する。
// start/end は、自動作成で「その日に出勤できるか」「いなかったら何分不足するか」を見積もるのに使う
function codePrefOf(codeIds){
  const order=shiftCodeList().map(c=>c.id);
  const ids=[...new Set(codeIds)].filter(id=>shiftCodeById(id)).sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  if(ids.length===0) return {day_off:true, codes:[], start:'', end:'', avail_start:'', avail_end:''};
  const codes=ids.map(shiftCodeById);
  const start=toHM(Math.min(...codes.map(c=>toMin(c.start)))), end=toHM(Math.max(...codes.map(c=>toMin(c.end))));
  return {day_off:false, codes:ids, start, end, avail_start:start, avail_end:end};
}
// 一括設定の既定値の記号（平日／土日）
function defaultCodesFor(uid,group){
  const g=((DB.default_availability||{})[uid]||{})[group];
  return (g && Array.isArray(g.codes)) ? g.codes.filter(id=>shiftCodeById(id)) : [];
}
// その日の勤務希望（codePrefOf の形）。未入力の日は一括設定の既定値。
// 時刻で出した古い希望は、時刻が同じ記号があればその記号として扱う
function codeRecOf(uid,date){
  const p=(DB.employee_preferences[uid]||{})[date];
  if(p && Array.isArray(p.codes)) return codePrefOf(p.codes);
  if(p && p.day_off) return codePrefOf([]);
  if(p && p.start && p.end){ const c=shiftCodeOfTimes(p.start,p.end); return codePrefOf(c ? [c.id] : []); }
  return codePrefOf(defaultCodesFor(uid, isWeekendDow(dowOf(date)) ? 'weekend' : 'weekday'));
}
// 記号の一覧を変えたあと、記号で出した勤務希望・一括設定の時刻を、今の記号に合わせ直す（消した記号は外れる）
function refreshCodePrefs(){
  for(const uid in DB.employee_preferences){
    const p=DB.employee_preferences[uid]||{};
    for(const d in p){ if(Array.isArray(p[d].codes)) p[d]=codePrefOf(p[d].codes); }
  }
  for(const uid in DB.default_availability){
    const def=DB.default_availability[uid]||{};
    for(const g of ['weekday','weekend']){ if(def[g] && Array.isArray(def[g].codes)) def[g]=codeDefaultOf(def[g].codes); }
  }
}
// 一括設定の既定値として保存する形（記号が無ければ codes だけ）
function codeDefaultOf(codeIds){
  const r=codePrefOf(codeIds);
  return r.day_off ? {codes:[]} : {codes:r.codes, start:r.start, end:r.end, avail_start:r.avail_start, avail_end:r.avail_end};
}
function viewPrefCodes(u,days,locked,submitted){
  const codes=shiftCodeList();
  const dis=locked?'disabled':'';
  const bulkRow=(group,label)=>{
    const def=defaultCodesFor(u.id,group);
    return `<div class="row">
        <b style="width:60px;display:inline-block">${label}</b>
        ${codes.map(c=>`<label><input type="checkbox" class="bulkCode-${group}" value="${c.id}" ${def.includes(c.id)?'checked':''} ${dis}> ${escHtml(c.label)}</label>`).join('')}
        <button ${dis} onclick="applyBulkCodes('${u.id}','${group}')">${label}に反映して既定値として保存</button>
      </div>`;
  };
  return `
  <div class="card">
    <h2>勤務希望入力</h2>
    ${locked?'<div class="banner warn">⚠️ 提出締切を過ぎているため編集できません（管理者のみ編集可）</div>':''}
    <p class="desc">その日に働ける記号を、すべて選んでください（いくつでも選べます）。どれも選ばない日は希望休になります。</p>
    ${fixedCodeIfUnsubmitted(u)?`<p class="note">提出しない場合は、休業日以外の日はすべて「${escHtml(fixedCodeIfUnsubmitted(u).label)}」（${fixedCodeIfUnsubmitted(u).start}〜${fixedCodeIfUnsubmitted(u).end}）で入ります。</p>`:''}
    <fieldset><legend>記号の一括設定（平日／土日）</legend>
      <p class="desc">反映すると、この期間の平日（または土日）のうち、希望休でない日に入ります。既定値として保存されるので、次の期間でも初期値になります。</p>
      ${bulkRow('weekday','平日')}
      ${bulkRow('weekend','土日')}
    </fieldset>
    <fieldset><legend>日ごとの記号</legend>
    <div class="scroll"><table>
      <tr><th>日付</th>${codes.map(c=>`<th>${escHtml(c.label)}<br><span class="note">${c.start}〜${c.end}</span></th>`).join('')}<th></th></tr>
      ${days.map(d=>{
        if(isDutyClosed(dutyOf(u),d)) return `<tr><td>${fmtDate(d)}</td><td colspan="${codes.length+1}"><span class="pill muted">公（休業日）</span></td></tr>`; // 職務の休業日は入力できない
        const rec=codeRecOf(u.id,d);
        return `<tr><td>${fmtDate(d)}</td>
          ${codes.map(c=>`<td><input type="checkbox" aria-label="${fmtDate(d)} ${escHtml(c.label)}" ${rec.codes.includes(c.id)?'checked':''} ${dis} onchange="setPrefCode('${u.id}','${d}','${c.id}',this.checked)"></td>`).join('')}
          <td>${rec.day_off?'<span class="pill muted">希望休</span>':''}</td></tr>`;
      }).join('')}
    </table></div>
    </fieldset>
    <div class="row">
      ${locked
        ? '<span class="pill bad">締切後のため提出・変更できません</span>'
        : `<button onclick="submitPref('${u.id}')">${submitted?'この内容で再提出する':'この内容で提出する'}</button>
           ${submitted?'<span class="pill ok">提出済み</span>':'<span class="pill warn">未提出</span>'}`}
    </div>
    <p class="note">入力内容は自動保存されます。<br>変更していない日は、表に表示されている記号で提出されます。</p>
  </div>`;
}
// 日ごとの記号のチェックを付けた・外した
function setPrefCode(uid,date,codeId,checked){
  const rec=codeRecOf(uid,date);
  const ids=checked ? [...rec.codes, codeId] : rec.codes.filter(id=>id!==codeId);
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  DB.employee_preferences[uid][date]=codePrefOf(ids);
  save(); render();
}
// 記号の一括設定：既定値として保存し（次の期間にも引き継ぐ）、この期間の該当する日（希望休を除く）に反映する
function applyBulkCodes(uid,group){
  const ids=[...document.querySelectorAll('.bulkCode-'+group)].filter(el=>el.checked).map(el=>el.value);
  DB.default_availability[uid]=DB.default_availability[uid]||{};
  DB.default_availability[uid][group]=codeDefaultOf(ids);
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end).filter(d=>isWeekendDow(dowOf(d))===(group==='weekend'));
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  const p=DB.employee_preferences[uid];
  days.forEach(d=>{ if(!(p[d] && p[d].day_off)) p[d]=codePrefOf(ids); });
  save(); render();
  alert(`${group==='weekend'?'土日':'平日'}の記号を反映し、今後の期間にも使う既定値として保存しました。`);
}

/* ---------- 従業員: 自分のシフト確認 ---------- */
// 最初に表示する公開済み期間を選ぶ：今日を含む期間 → なければ一番近い未来の期間 → なければ一番新しい期間
function defaultMyShiftPeriod(list){
  const today=iso(new Date());
  const current=list.find(pp=>pp.start<=today && today<=pp.end);
  if(current) return current;
  const upcoming=list.filter(pp=>pp.start>today).sort((a,b)=> a.start<b.start ? -1 : 1);
  if(upcoming.length) return upcoming[0];
  return latestPublishedPeriod();
}
function selectMyShiftPeriod(key){ myShiftPeriodKey=key; render(); }
function viewMyShift(){
  const u=currentUser();
  const list=publishedPeriods().slice().sort((a,b)=> a.start<b.start ? 1 : -1); // 新しい期間を上に
  if(list.length===0) return `<div class="card"><h2>シフト確認</h2>
    <div class="banner warn">🔒 シフトはまだ公開されていません。公開までお待ちください。</div></div>`;
  const period=list.find(pp=>pp.start+'_'+pp.end===myShiftPeriodKey) || defaultMyShiftPeriod(list);
  const newer=list.filter(pp=>pp.start>period.start); // 表示中より後の期間も公開されていれば知らせる
  const days=rangeDates(period.start,period.end);
  const rows=days.map(d=>{
    const list=DB.shifts.filter(x=>x.user_id===u.id&&x.date===d).sort((a,b)=>toMin(a.start)-toMin(b.start));
    const p=(DB.employee_preferences[u.id]||{})[d];
    // 社員は記号に時刻を添える（例：A（09:00〜18:00））
    const text=x=>{ const t=shiftText(u,x); return t===x.start+'〜'+x.end ? t : `${escHtml(t)}（${x.start}〜${x.end}）`; };
    let cellTxt = list.length?list.map(text).join(' , '):(p&&p.day_off?'休み':'—');
    return `<tr><td>${fmtDate(d)}</td><td class="${list.length?'work':(p&&p.day_off?'off':'')}">${cellTxt}</td></tr>`;
  }).join('');
  const totalShiftMin=DB.shifts.filter(x=>x.user_id===u.id&&x.date>=period.start&&x.date<=period.end)
    .reduce((a,x)=>a+(toMin(x.end)-toMin(x.start)),0);
  const totalShiftText=`${Math.floor(totalShiftMin/60)}時間${totalShiftMin%60 ? (totalShiftMin%60)+'分' : ''}`;
  return `<div class="card">
    <h2>自分の勤務シフト（${u.name}）</h2>
    <div class="row">
      <label>表示する期間
        <select onchange="selectMyShiftPeriod(this.value)">
          ${list.map(pp=>`<option value="${pp.start}_${pp.end}" ${pp===period?'selected':''}>${fmtDate(pp.start)}〜${fmtDate(pp.end)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${newer.length?`<div class="banner ok">📢 ${newer.map(pp=>`${fmtDate(pp.start)}〜${fmtDate(pp.end)}`).join('、')} のシフトも公開されています。上のプルダウンで切り替えられます。</div>`:''}
    <div class="banner ok">✅ 公開済み（${period.published_at||'日時不明'}）／ 合計勤務時間 ${totalShiftText}</div>
    <div class="scroll"><table><tr><th>日付</th><th>勤務時間</th></tr>${rows}</table></div>
  </div>`;
}

render();
