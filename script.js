/* ============================================================
   データ層 (Firebase / Firestore でみんなと共有)
   ・店舗全体のデータ（従業員一覧・必要人数・設定・シフト・休憩）… app/main（管理者だけが書き込める）
   ・従業員ごとの勤務希望 ……………………………………………… prefs/{ユーザーID}（本人と管理者だけ）
   ・社員番号 → 内部ID（ログイン画面で使う）…………………………… logins/{社員番号}（番号を知っている1件だけ誰でも読める。一覧は取れない）
   ・初期設定が済んでいるかの印 …………………………………………… app/public（誰でも読める）
   勤務希望を人ごとに別の場所へ保存するのは、何人かが同時に提出しても、
   後から保存した人の内容で先に出した人の希望が上書きされて消えないようにするため。
   画面側のコードは今までどおり DB を書き換えて save() を呼ぶだけでよい（save() が変わった部分だけ送る）。
   ============================================================ */
// Firebase プロジェクトの接続先。apiKey は「どのプロジェクトにつなぐか」を示す値で、公開しても問題ない
// （データを守るのは firestore.rules のセキュリティルール）。
const firebaseConfig = {
  apiKey: "AIzaSyBv4fN-9-H4yCVtFyaxb1szktYVEy_i3hs",
  authDomain: "shiftly-b6e52.firebaseapp.com",
  projectId: "shiftly-b6e52",
  storageBucket: "shiftly-b6e52.firebasestorage.app",
  messagingSenderId: "920164464388",
  appId: "1:920164464388:web:18462acb6a115b42c48251"
};
firebase.initializeApp(firebaseConfig);
const auth=firebase.auth();
const fs=firebase.firestore();
// ログイン状態は、タブ（ウィンドウ）を閉じるまで保つ（以前の sessionStorage と同じ動き）
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
// ログインは社員番号で行うが、Firebase のログイン機能はメールアドレス形式のIDを使うので、
// 内部ID（変わらない値）からIDを作る。メールが送られることはない。
// 社員番号から作らないのは、管理者が社員番号を変更してもログインできなくならないようにするため。
const emailOf = userId => userId+'@'+firebaseConfig.authDomain;
const userIdOfAuth = user => (user && user.email) ? user.email.split('@')[0] : null;
// クラウド同期の状態（下の save() などから使う。save() はこの後の移行処理からも呼ばれるので、先に用意しておく）
const cloud={
  authKnown:false,     // ログイン状態の確認が終わったか（ページを開いた直後は未確認）
  ready:false,         // 共有データを読み込み終えたか
  mainLoaded:false, prefsLoaded:false,
  mainJson:null,       // 最後にクラウドと一致していた内容（変わった部分だけ送るための比較用）
  prefsJson:{},        // userId -> 同上
  logins:{},           // 社員番号 -> 内部ID（同上）
  mainUnsub:null, prefsUnsub:null, // リアルタイム受信を止める関数
  prefsAsAdmin:null,   // 勤務希望を「全員分（管理者）」「自分の分」のどちらで受信しているか
  setupInProgress:false, // 最初の1回のデータ移行中
};

const KEY='shiftapp_v2'; // v2: 学生ロール（1日7.5h / 週40h 上限）→ v3でPA権限体系に移行
// PA種別（権限）: 週の上限は月曜始まり〜日曜終わりの週で判定し、「未満」を厳密に守る
const PA_TYPES = {
  general:           { label:'一般PA',     weekCapMin:null  }, // 制限なし
  dependent:         { label:'扶養PA',     weekCapMin:20*60 }, // 週20時間未満
  dependent_student: { label:'扶養学生PA', weekCapMin:40*60 }, // 週40時間未満
};
const DEPENDENT_STUDENT_DAY_CAP_MIN = 8*60; // 扶養学生PAは1日8時間未満（ちょうど8時間の割当も避ける）
const SLOT_MIN = 15; // シフト自動作成エンジンが扱う最小時間単位（分）。必要最低人数の時間帯は15分刻みで指定できる
/* ---------- 自動作成の優先順位 ----------
   扶養の制限（週の上限「未満」／扶養学生PAの1日8時間未満）＞ 希望休＆人員不足なし ＞ 連勤3日以内
   ・扶養の制限と希望休は絶対条件（一切超えない・入れない）
   ・不足なしは希望休と同格の優先度（不足を埋めるためなら連勤3日以内を緩めることがある）
   ・連勤3日以内（4連勤以上を避ける）は最も優先度の低いガイドライン */
const MAX_CONSECUTIVE_WORK_DAYS = 3; // これを超える連勤（4連勤以上）は避ける。ただし不足なしの方が優先
/* ---------- 個人ごとのルールの目印（ruleKey） ----------
   個人ごとの特別ルールは、社員番号ではなく各ユーザーの ruleKey で判定する。
   社員番号は管理者が後から変更できるため、社員番号で判定すると番号を変えた人のルールが効かなくなる。
   ruleKey は一度記録したら変わらない値（既存の人は記録した時点の社員番号、新しく追加した人は内部ID）。 */
const ruleKeyOf = u => u && (u.ruleKey || u.id);
const MAX_CONSECUTIVE_WORK_DAYS_OVERRIDE_BY_RULE_KEY = {
  // 個人ごとの連勤上限の例外は現在なし（全員一律で3連勤まで。人員不足を避けるためだけ4連勤まで緩和する）
};
const maxConsecutiveFor = u => (u && MAX_CONSECUTIVE_WORK_DAYS_OVERRIDE_BY_RULE_KEY[ruleKeyOf(u)]) || MAX_CONSECUTIVE_WORK_DAYS;
const MIN_SHIFT_MIN = 3*60; // 1日の拘束時間（出勤〜退勤、1本の連続勤務）はこれ以上でなければならない（3時間未満は不可。3時間ちょうどはOK）
const DOW=['日','月','火','水','木','金','土'];
const roleLabel = r => r==='admin' ? '管理者' : '従業員';
const paLabel = u => u.permission ? (PA_TYPES[u.permission]?PA_TYPES[u.permission].label:'') : '';
const isStaff = u => !!u.permission; // PA種別を持つ人がシフト対象（管理者でもPA種別があれば対象）

/* ---------- 休憩時間ルール ----------
   ・実働6時間以上：45分／実働8時間以上：1時間
   ・水上さん（社員番号17833）は平日30分固定・土曜出勤は休憩なし（個人ルールが優先）
   ・金子さん・小林さん・星山さんは、本来45分になる休憩を50分に延長（個人ルールが優先）
   ・週の判定と同じく、ここでの「時間」はその日の実働（休憩を除く勤務）時間 */
const MIZUKAMI_RULE_KEY = '17833';
const EXTENDED_45MIN_BREAK_RULE_KEYS = new Set(['17649','44165','75643']); // 金子・小林・星山: 45分→50分
function breakMinutesFor(u, dateIso, workMin){
  if(!workMin || workMin<=0) return 0;
  if(u && ruleKeyOf(u)===MIZUKAMI_RULE_KEY){
    return dowOf(dateIso)===6 ? 0 : 30; // 土曜出勤は休憩なし、それ以外は30分固定
  }
  if(workMin>=8*60) return 60;
  if(workMin>=6*60) return (u && EXTENDED_45MIN_BREAK_RULE_KEYS.has(ruleKeyOf(u))) ? 50 : 45;
  return 0;
}

/* ---------- 個人ごとの優先勤務時間（自動作成時の「優先ヒント」） ----------
   ・長井さん（社員番号19111）：基本は12:00〜20:30を優先
   ・星山さん（社員番号75643）：基本は10:00〜16:00を優先
   ・あくまで優先ヒントであり絶対条件ではない。人員不足を避けることの方が優先なので、
     必要なら指定時間の外でも、また指定時間の人がいなくても他の人で割り当てる。 */
const PREFERRED_HOURS_BY_RULE_KEY = {
  '19111': {start:'12:00', end:'20:30'}, // 長井さん
  '75643': {start:'10:00', end:'16:00'}, // 星山さん
};
// 候補者ソート用のランク: 0=指定時間内（優先） / 1=指定なし（中立） / 2=指定時間外（できれば避ける）
function preferredHoursRank(u, slotStart, slotEnd){
  const pref = u && PREFERRED_HOURS_BY_RULE_KEY[ruleKeyOf(u)];
  if(!pref) return 1;
  return (toMin(pref.start)<=slotStart && toMin(pref.end)>=slotEnd) ? 0 : 2;
}

/* ---------- 9:30〜10:00（開店直後）・20:00〜20:30（閉店前）の上限人数 ----------
   ・社員番号による固定の優先順位ではなく、従業員管理画面で個人ごとに設定する
     「立ち上げ番」（openingDuty）「閉め番」（closingDuty）ラベルで優先する。
   ・9:30〜10:00は1人、20:00〜20:30は2人を超えないように調整する（generateShiftsのcapWindows参照）。
   ・優先枠から外れた人は、この時間帯には入れず開始／終了時刻をずらす
     （出勤を分割しないため、途中で切るのではなく端の時刻を動かす）。 */

function seed(){
  return {
    users:[],
    // 時間帯ごとの必要最低人数テンプレート（全営業日に適用）。
    // 営業時間設定は廃止し、この一覧の最早開始〜最遅終了がそのまま営業時間になる（businessWindow()参照）。
    required_staff:[
      {id:'r0',start:'09:30',end:'10:00',count:1}, // 開店直後は1人だけでよい（優先順位は「立ち上げ番」ラベル。generateShiftsのcapWindows参照）
      {id:'r1',start:'10:00',end:'20:00',count:2},
      {id:'r2',start:'20:00',end:'20:30',count:3}, // 必要最低人数は3人。ただし generateShifts の capWindows でこの時間帯は2人までに調整するため、実際に3人になることは基本的にない（意図的な設定）
    ],
    // 勤務可能時間の既定値（一括設定で保存。新しい期間になっても引き継がれる）
    default_availability:{}, // user_id -> {start,end}
    // 日ごとの勤務希望
    employee_preferences:{}, // user_id -> { 'YYYY-MM-DD': {day_off:bool,start:'',end:''} }
    submissions:{}, // user_id -> period_start (提出済みの対象期間)
    shifts:[], // {user_id,date,start,end}
    breaks:[], // {user_id,date,start,end} 休憩時間（自動作成時に必要最低人数を満たすように配置）
    settings:{
      period_start: isoAddDays(mondayOf(new Date()),7),
      period_end: isoAddDays(mondayOf(new Date()),13),
      deadline: iso(new Date()),
      // 公開済みの期間の一覧。{start,end,deadline,published_at,last_generated}
      // 公開すると対象期間（period_start〜period_end）は次の期間へ進むので、公開済みかどうかは
      // 「今の対象期間」ではなく、この一覧で判定する（公開したシフトを後からも見られるようにするため）。
      published_periods:[],
      last_generated:null,
      shortages:[] // {date,start,end,required,assigned}（期間をまたいで日付ごとに保持する）
    }
  };
}
let DB=load();
DB.submissions=DB.submissions||{}; // 旧データ互換
DB.default_availability=DB.default_availability||{}; // 旧データ互換
DB.breaks=DB.breaks||[]; // 旧データ互換
// 旧デモ用アカウント（従業員・管理者）を一掃
(function purgeDemo(){
  const demo=new Set(['admin@example.com','tanaka@example.com','sato@example.com','suzuki@example.com',
    'takahashi@example.com','ito@example.com','watanabe@example.com','kobayashi@example.com']);
  const before=DB.users.length;
  DB.users=DB.users.filter(u=>!demo.has((u.email||'').toLowerCase()));
  if(DB.users.length!==before) save();
})();
// 旧「学生」ロール → PA権限体系への移行 ＋ デフォルトの管理者・従業員アカウントを保証する
(function ensureDefaultAccounts(){
  let changed=false;
  DB.users.forEach(u=>{
    if(u.role==='student'){ u.role='employee'; if(!u.permission) u.permission='dependent_student'; changed=true; }
    if(u.role==='employee' && !u.permission){ u.permission='general'; changed=true; }
  });
  const defaults=[
    {empNo:'51180', name:'寺嶋'}, // デフォルト管理者（学生PAも兼務）
    {empNo:'17833', name:'水上'},
    {empNo:'17649', name:'金子'},
    {empNo:'44165', name:'小林'},
    {empNo:'75643', name:'星山'},
    {empNo:'19042', name:'平野'},
    {empNo:'19111', name:'長井'},
    {empNo:'9643',  name:'鈴木'},
  ];
  // 一度作成したデフォルトアカウントは社員番号で記録し、あとで削除されても作り直さない。
  // （以前は読み込みのたびに「足りないデフォルトアカウント」を作り直していたため、
  //   削除しても再読み込みで復活してしまっていた）
  // この記録を入れる前のデータは、すでに全員分を作成済みとして扱う（削除済みの人を復活させない）。
  // 初回起動・データ初期化の直後（利用者が0人）だけ、全員分を作成する。
  // defaults に新しい人を書き足した場合は、既存のデータにもその人だけ一度作成される。
  if(!Array.isArray(DB.settings._seededDefaultEmpNos)){
    DB.settings._seededDefaultEmpNos = DB.users.length>0 ? defaults.map(d=>d.empNo) : [];
    changed=true;
  }
  const seeded=DB.settings._seededDefaultEmpNos;
  defaults.forEach((d,i)=>{
    if(seeded.includes(d.empNo)) return; // 一度作成済み（削除されていても作り直さない）
    seeded.push(d.empNo); changed=true;
    if(DB.users.some(u=>u.empNo===d.empNo)) return;
    if(i===0){
      DB.users.push({id:'u_default_admin', name:d.name, empNo:d.empNo, ruleKey:d.empNo,
        role:'admin', owner:true, permission:'dependent_student', is_active:true});
    } else {
      DB.users.push({id:'u_default_'+d.empNo, name:d.name, empNo:d.empNo, ruleKey:d.empNo,
        role:'employee', permission:'general', is_active:true});
    }
    changed=true;
  });
  if(changed) save();
})();
// 社員番号を変更できるようにする前のデータには ruleKey が無いので、その時点の社員番号を一度だけ記録する。
// （この時点ではまだ誰も番号を変えていないので、社員番号＝個人ルールの目印として正しい）
// 一度だけにしないと、あとで追加した人にも社員番号が ruleKey として入ってしまうので、済んだ印を残す。
(function migrateRuleKeys(){
  if(DB.settings._ruleKeysMigrated) return;
  DB.users.forEach(u=>{ if(!u.ruleKey) u.ruleKey=u.empNo; });
  DB.settings._ruleKeysMigrated=true;
  save();
})();
// 氏名が「管理者」のアカウントを削除（依頼によるクリーンアップ）
(function purgeNamedAdmin(){
  const targets=DB.users.filter(u=>u.name==='管理者');
  if(targets.length===0) return;
  const ids=new Set(targets.map(u=>u.id));
  DB.users=DB.users.filter(u=>!ids.has(u.id));
  ids.forEach(id=>{ delete DB.employee_preferences[id]; delete DB.submissions[id]; });
  DB.shifts=DB.shifts.filter(s=>!ids.has(s.user_id));
  save();
})();
// 営業時間設定を廃止し、必要最低人数を「9:30-10:00:1人／10:00-20:30:2人」に統一する
// （依頼による一度きりの移行。以後は必要最低人数設定画面での変更を優先し再実行しない）
(function migrateToSimplifiedNeeds(){
  if(!DB.settings || DB.settings._migratedSimplifiedNeeds) return;
  delete DB.business_hours; // 必要最低人数の時間帯がそのまま営業時間になるため不要
  DB.required_staff = [
    {id:'r0', start:'09:30', end:'10:00', count:1},
    {id:'r1', start:'10:00', end:'20:30', count:2},
  ];
  DB.settings._migratedSimplifiedNeeds = true;
  save();
})();
// 不足をできるだけ出さないため、20:00〜20:30の必要最低人数（下回ってはいけない基準）を2人に設定する
// （2人は必要最低人数であり上限ではない。提出時間の都合で実際の配置人数が2人を超えるのは問題ない）
// （依頼による一度きりの移行。他の時間帯の設定はそのまま維持し、20:00〜20:30に重なる部分だけ調整する）
(function capEvening2030(){
  if(!DB.settings || DB.settings._cappedEvening2030) return;
  const toMinLocal=t=>{ const [h,m]=t.split(':').map(Number); return h*60+m; };
  const toHMLocal=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const CAP=2, ws=toMinLocal('20:00'), we=toMinLocal('20:30');
  const out=[]; let changed=false;
  (DB.required_staff||[]).forEach(r=>{
    const rs=toMinLocal(r.start), re=toMinLocal(r.end);
    if(re<=ws || rs>=we || r.count<=CAP){ out.push(r); return; } // 対象外、またはすでに2人以下
    changed=true;
    if(rs<ws) out.push({id:r.id+'_pre', start:r.start, end:'20:00', count:r.count}); // 20:00より前は維持
    out.push({id:r.id, start:toHMLocal(Math.max(rs,ws)), end:toHMLocal(Math.min(re,we)), count:CAP}); // 重なる部分だけ2人に
    if(re>we) out.push({id:r.id+'_post', start:'20:30', end:toHMLocal(re), count:r.count}); // 20:30より後は維持
  });
  if(changed) DB.required_staff=out;
  DB.settings._cappedEvening2030=true;
  save();
})();
// 20:00〜20:30の必要最低人数を1人追加して3人にする
// （依頼による一度きりの移行。他の時間帯の設定はそのまま維持し、20:00〜20:30に重なる部分だけ調整する）
(function raiseEvening2030To3(){
  if(!DB.settings || DB.settings._raisedEvening2030To3) return;
  const toMinLocal=t=>{ const [h,m]=t.split(':').map(Number); return h*60+m; };
  const toHMLocal=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const TARGET=3, ws=toMinLocal('20:00'), we=toMinLocal('20:30');
  const out=[]; let changed=false;
  (DB.required_staff||[]).forEach(r=>{
    const rs=toMinLocal(r.start), re=toMinLocal(r.end);
    if(re<=ws || rs>=we || r.count>=TARGET){ out.push(r); return; } // 対象外、またはすでに3人以上
    changed=true;
    if(rs<ws) out.push({id:r.id+'_pre2', start:r.start, end:'20:00', count:r.count}); // 20:00より前は維持
    out.push({id:r.id, start:toHMLocal(Math.max(rs,ws)), end:toHMLocal(Math.min(re,we)), count:TARGET}); // 重なる部分だけ3人に
    if(re>we) out.push({id:r.id+'_post2', start:'20:30', end:toHMLocal(re), count:r.count}); // 20:30より後は維持
  });
  if(changed) DB.required_staff=out;
  DB.settings._raisedEvening2030To3=true;
  save();
})();
// 公開状態を「公開フラグ1つ（published / published_at）」から「公開済み期間の一覧」へ移行する（一度きり）。
// 今の対象期間が公開中で、その期間のシフトが実際にある場合だけ一覧に移す。勝手に次の期間へは進めない。
// （公開後に対象期間だけ手動で次へ変えていた場合、古いフラグが残っているだけでシフトは無いので移さない）
(function migrateToPublishedPeriods(){
  const s=DB.settings;
  if(!s || Array.isArray(s.published_periods)) return;
  s.published_periods=[];
  const hasShifts=(DB.shifts||[]).some(sh=>sh.date>=s.period_start && sh.date<=s.period_end);
  if(s.published && hasShifts){
    s.published_periods.push({start:s.period_start, end:s.period_end, deadline:s.deadline,
      published_at:s.published_at||'', last_generated:s.last_generated||null});
  }
  delete s.published; delete s.published_at;
  save();
})();
// この端末に残っている、クラウド化する前のデータ（無ければ初期データ）。
// クラウドがまだ空のとき、最初にログインした管理者がこれをクラウドへ移す（uploadLocalData）。
const LOCAL_DB=JSON.parse(JSON.stringify(DB));
function load(){ try{const r=localStorage.getItem(KEY); if(r) return JSON.parse(r);}catch(e){} return seed(); }
// 全データを初期状態に戻す。従業員アカウントまで消すと誰もログインできなくなるので、従業員一覧は残す。
function resetAll(){ if(confirm('全データを初期状態に戻します（従業員アカウントは残します）。よろしいですか？')){ const users=DB.users; DB=seed(); DB.users=users; save(); render(); } }

/* ---------- クラウド同期 ---------- */
const MAIN_KEYS=['users','required_staff','settings','shifts','breaks']; // app/main に入れる項目
// 中身が同じなら同じ文字列になるようにする（キーの並び順を揃える）。
// Firestore から戻ってきたデータはキーの順番が変わることがあり、普通の JSON.stringify だと
// 「中身は同じなのに違う」と判定して無駄な保存や再描画が起きてしまうため。
function stableStringify(v){
  if(Array.isArray(v)) return '['+v.map(stableStringify).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined)
    .map(k=>JSON.stringify(k)+':'+stableStringify(v[k])).join(',')+'}';
  return JSON.stringify(v===undefined ? null : v);
}
// Firestore は undefined を保存できないので、JSON を通して取り除いたコピーを作る
function clean(o){ return JSON.parse(JSON.stringify(o)); }

// 送る形に切り出す（src は DB か、この端末の古いデータ LOCAL_DB）
function mainPartOf(src){
  const o={};
  MAIN_KEYS.forEach(k=>{ if(src[k]!==undefined) o[k]=src[k]; });
  o.users=(src.users||[]).map(({password,mustSetPassword,...u})=>u); // パスワードは Firebase 側で管理するので送らない
  return clean(o);
}
// セキュリティルールで使う「管理者」「利用できる人」の一覧を添えて app/main に書き込む形にする
function mainDocOf(part){
  return {...part,
    admins: part.users.filter(u=>u.role==='admin' && u.is_active).map(u=>u.id),
    members: part.users.filter(u=>u.is_active).map(u=>u.id)};
}
// 社員番号 → 内部ID の対応（在籍中の人だけ）。クラウドには logins/{社員番号} に1件ずつ置く
function loginsOf(src){
  const m={};
  (src.users||[]).filter(u=>u.is_active).forEach(u=>{ m[u.empNo]=u.id; });
  return m;
}
function prefsPartOf(src,uid){
  const o={};
  const p=(src.employee_preferences||{})[uid]; if(p && Object.keys(p).length) o.employee_preferences=p;
  const d=(src.default_availability||{})[uid]; if(d && Object.keys(d).length) o.default_availability=d;
  const sub=(src.submissions||{})[uid]; if(sub) o.submission=sub;
  return clean(o);
}

// 変わった部分だけクラウドへ送る。画面側はデータを書き換えたら今までどおり save() を呼ぶだけ。
function save(){
  if(!cloud.ready) return; // ログイン前・読み込み前は送らない
  const me=currentUser(); if(!me) return;
  const admin=me.role==='admin';
  if(admin){
    const main=mainPartOf(DB), json=stableStringify(main);
    if(json!==cloud.mainJson){ cloud.mainJson=json; cloudWrite(fs.doc('app/main').set(mainDocOf(main))); }
    // 社員番号の追加・変更・在籍の変更があった分だけ logins を書き換える
    const logins=loginsOf(DB);
    Object.keys({...cloud.logins, ...logins}).forEach(no=>{
      if(cloud.logins[no]===logins[no]) return;
      const ref=fs.doc('logins/'+no);
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
    const ref=fs.doc('prefs/'+uid);
    cloudWrite(json==='{}' ? ref.delete() : ref.set(part));
  });
}
function cloudWrite(promise){
  promise.catch(err=>{
    console.error(err);
    alert('クラウドへの保存に失敗しました。通信状況を確認して、ページを再読み込みしてください。\n（'+(err.code||err.message)+'）');
  });
}

// ログインしたら、共有データのリアルタイム受信を始める（他の人が変更すると自動で届く）
function startCloudSync(){
  stopCloudSync();
  Object.assign(cloud,{ready:false, mainLoaded:false, prefsLoaded:false, mainJson:null, prefsJson:{}, logins:{}, prefsAsAdmin:null});
  DB=seed(); // 読み込み終わるまでは空のデータ（前にログインしていた人のデータを残さない）
  cloud.mainUnsub=fs.doc('app/main').onSnapshot(onMainSnapshot, cloudReadError);
}
function stopCloudSync(){
  if(cloud.mainUnsub){ cloud.mainUnsub(); cloud.mainUnsub=null; }
  if(cloud.prefsUnsub){ cloud.prefsUnsub(); cloud.prefsUnsub=null; }
  cloud.ready=false;
}
function onMainSnapshot(snap){
  if(!snap.exists){
    if(cloud.setupInProgress) return;
    cloudReadError(appError('まだ初期設定が済んでいません。最初に管理者がログインしてください。')); return;
  }
  const part=mainPartOf(snap.data()), json=stableStringify(part);
  const changed = json!==cloud.mainJson; // 自分が送った内容が戻ってきただけなら何もしない
  if(changed){
    Object.assign(DB, part);
    DB.breaks=DB.breaks||[]; DB.shifts=DB.shifts||[]; DB.required_staff=DB.required_staff||[];
    cloud.mainJson=json;
    cloud.logins=loginsOf(DB); // logins は app/main の従業員一覧と同じ内容で保存されている
  }
  const me=currentUser();
  if(!me || !me.is_active){ cloudReadError({code:'permission-denied'}); return; }
  cloud.mainLoaded=true;
  const asAdmin = me.role==='admin';
  if(cloud.prefsAsAdmin!==asAdmin){ subscribePrefs(asAdmin); return; } // 勤務希望を読み込み終えてから描画する
  if(changed) refreshAfterCloud();
}
function subscribePrefs(asAdmin){
  if(cloud.prefsUnsub) cloud.prefsUnsub();
  cloud.prefsAsAdmin=asAdmin; cloud.prefsLoaded=false;
  if(asAdmin){
    cloud.prefsUnsub=fs.collection('prefs').onSnapshot(qs=>{
      let changed=false;
      qs.docChanges().forEach(c=>{ changed = applyPrefsDoc(c.doc.id, c.type==='removed' ? null : c.doc.data()) || changed; });
      prefsLoaded(changed);
    }, cloudReadError);
  } else {
    cloud.prefsUnsub=fs.doc('prefs/'+currentUserId).onSnapshot(snap=>{
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
function prefsLoaded(changed){
  cloud.prefsLoaded=true;
  if(changed || !cloud.ready) refreshAfterCloud();
}
function refreshAfterCloud(){
  if(cloud.mainLoaded && cloud.prefsLoaded) cloud.ready=true;
  render();
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

// クラウドが空のとき（最初の1回だけ）、この端末のデータをまとめてクラウドへ移す。
// batch（一括書き込み）を使うので、途中で失敗しても中途半端な状態にはならない。
async function uploadLocalData(){
  const src=LOCAL_DB;
  const batch=fs.batch();
  batch.set(fs.doc('app/main'), mainDocOf(mainPartOf(src)));
  batch.set(fs.doc('app/public'), {initialized:true}); // 初期設定済みの印（ルールで、2回目以降は書き込めない）
  Object.entries(loginsOf(src)).forEach(([no,uid])=>batch.set(fs.doc('logins/'+no), {uid}));
  (src.users||[]).forEach(u=>{
    const p=prefsPartOf(src,u.id);
    if(Object.keys(p).length) batch.set(fs.doc('prefs/'+u.id), p);
  });
  await batch.commit();
}

/* ============================================================
   日付ユーティリティ
   ============================================================ */
function iso(d){ const z=new Date(d); z.setMinutes(z.getMinutes()-z.getTimezoneOffset()); return z.toISOString().slice(0,10); }
function isoAddDays(isoStr,n){ const d=new Date(isoStr+'T00:00'); d.setDate(d.getDate()+n); return iso(d); }
function mondayOf(d){ const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return iso(x); }
function rangeDates(a,b){ const out=[]; let d=a; let guard=0; while(d<=b && guard<400){ out.push(d); d=isoAddDays(d,1); guard++; } return out; }
function dowOf(isoStr){ return new Date(isoStr+'T00:00').getDay(); }
const isWeekendDow = dow => dow===0 || dow===6; // 日(0)・土(6)
// 平日／土日いずれかの一括設定の既定値を取得（旧形式 {start,end} のデータにも対応）
// avail_start/avail_end（出勤可能時間）が保存されていない古いデータは、希望(start/end)と
// 同じ値を出勤可能時間としても使う（出勤可能・希望を分ける機能を追加する前のデータとの互換性）。
function groupDefaultAvail(uid,group){
  const def=DB.default_availability && DB.default_availability[uid];
  if(!def) return null;
  const g=def[group];
  if(g && g.start && g.end) return {start:g.start, end:g.end, avail_start:g.avail_start||g.start, avail_end:g.avail_end||g.end};
  if(def.start && def.end) return {start:def.start, end:def.end, avail_start:def.avail_start||def.start, avail_end:def.avail_end||def.end}; // 旧形式（平日／土日を分ける前のデータ）
  return null;
}
// 営業時間（必要最低人数テンプレートの最早開始〜最遅終了。営業時間設定は廃止したためここから求める）
function businessWindow(){
  if(!DB.required_staff || DB.required_staff.length===0) return null;
  let open=null, close=null;
  for(const r of DB.required_staff){
    const s=toMin(r.start), e=toMin(r.end);
    if(open===null || s<open) open=s;
    if(close===null || e>close) close=e;
  }
  return { open: toHM(open), close: toHM(close) };
}
// 平日／土日グループの営業時間フォールバック（一括設定欄の初期値に使う。個人の既定値が未設定の場合のみ使われる）
// ※businessWindow()は{open,close}という形で返ってくるので、ここで{start,end}に変換する
//   （この変換をせず businessWindow() をそのまま使っていたため、一括設定を一度もしていない
//   従業員の日ごとの勤務可能時間が{open,close}というキーで保存され、start/endが無いものとして
//   自動作成から除外されてしまう不具合があった）。
function groupBizHoursFallback(group){
  const bw=businessWindow();
  const fb = bw ? {start:bw.open, end:bw.close} : {start:'10:00', end:'18:00'};
  return {...fb, avail_start:fb.start, avail_end:fb.end}; // 出勤可能時間も、まずは希望と同じ値を初期値にしておく
}
// その日の勤務可能時間・希望の既定値：本人が一括設定した既定値（平日／土日別）があればそれを優先し、なければ営業時間を使う
// 戻り値は {start,end}（希望の出退勤）と {avail_start,avail_end}（出勤可能な範囲。人員不足のときだけ頼ってよい上限）の両方を持つ。
function defaultAvailFor(uid,dateIso){
  const group=isWeekendDow(dowOf(dateIso))?'weekend':'weekday';
  const g=groupDefaultAvail(uid,group);
  if(g) return {start:g.start, end:g.end, avail_start:g.avail_start, avail_end:g.avail_end};
  const bw=businessWindow();
  const fb = bw ? {start:bw.open, end:bw.close} : {start:'10:00', end:'18:00'};
  return {...fb, avail_start:fb.start, avail_end:fb.end};
}
function fmtDate(isoStr){ const d=new Date(isoStr+'T00:00'); return `${d.getMonth()+1}/${d.getDate()}(${DOW[d.getDay()]})`; }
function isoWeekKey(isoStr){ const d=new Date(isoStr+'T00:00'); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); return iso(d); }

/* ---------- シフトを公開したときに、対象期間・締切を次へ進めるための日付計算 ---------- */
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
// 今の対象期間と締切から、次の対象期間と締切を求める。
// 次の期間は必ず「今の期間の翌日」から始める（期間どうしにすき間や重なりを作らない）。
//   ① 1か月単位（1日〜月末、21日〜翌月20日など）→ 次の1か月。締切は翌月の同じ日
//   ② 半月単位（1日〜15日 → 16日〜月末、16日〜月末 → 翌月1日〜15日）
//   ③ それ以外（1週間・2週間など）→ 同じ日数で翌日から
//   ②③の締切は「期間の開始日の何日前か」を保ったまま、開始日と同じ日数だけずらす
function nextPeriodOf(start,end,deadline){
  const nextStart=isoAddDays(end,1);
  const shiftDays=daysBetween(start,nextStart); // 開始日が何日ずれるか
  // 締切日のずらし方（締切が未設定なら未設定のまま）
  const deadlineByDays =()=> deadline ? isoAddDays(deadline,shiftDays) : '';
  const deadlineByMonth=()=> deadline ? addMonthsIso(deadline,1) : '';
  if(isoAddDays(addMonthsIso(start,1),-1)===end){ // ① 1か月単位
    return {start:nextStart, end:isoAddDays(addMonthsIso(nextStart,1),-1), deadline:deadlineByMonth()};
  }
  if(start.slice(8)==='01' && end.slice(8)==='15'){ // ② 半月単位（前半 → 後半）
    return {start:nextStart, end:lastDayOfMonthIso(nextStart), deadline:deadlineByDays()};
  }
  if(start.slice(8)==='16' && end===lastDayOfMonthIso(start)){ // ② 半月単位（後半 → 翌月の前半）
    return {start:nextStart, end:nextStart.slice(0,8)+'15', deadline:deadlineByDays()};
  }
  const len=daysBetween(start,end)+1; // ③ 決まった日数（1週間・2週間など）
  return {start:nextStart, end:isoAddDays(end,len), deadline:deadlineByDays()};
}

const toMin=t=>{ const [h,m]=t.split(':').map(Number); return h*60+m; };
const toHM =m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
// 出勤・退勤時刻の入力を00分／30分だけに固定する（最も近い30分刻みに丸める）
const snapHalfHour=t=>{ if(!t) return t; const snapped=Math.min(1410, Math.max(0, Math.round(toMin(t)/30)*30)); return toHM(snapped); };

/* ---------- 出勤可能時間（avail_start/avail_end）と希望（start/end）の違い ----------
   ・希望（start/end）＝普段このシフトで働きたい時間。自動作成の最初の割り当て（②）はこちらを使う。
   ・出勤可能時間（avail_start/avail_end）＝人員不足や休憩の穴埋めなど「困ったとき」だけ頼ってよい、
     希望より広い（または同じ）上限の範囲。⑤の後の穴埋めと⑥の休憩バックフィルだけがこちらを使う。
   ・出勤可能時間を入力していない（この機能を追加する前の古いデータ含む）場合は、希望と同じ範囲を
     出勤可能時間とみなす。希望が出勤可能の外にはみ出て保存されていても、範囲を広げる方向に丸めて
     安全側に倒す（穴埋めできるはずの人が誤って対象外になるのを防ぐ）。 */
function availRangeMin(p){
  const ps=toMin(p.start), pe=toMin(p.end);
  const as=p.avail_start ? toMin(p.avail_start) : ps;
  const ae=p.avail_end ? toMin(p.avail_end) : pe;
  return [Math.min(as,ps), Math.max(ae,pe)];
}

/* ============================================================
   認証まわり（ログイン画面）
   ============================================================ */
let currentUserId = null; // ログイン中の人の内部ID（Firebase のログイン状態から決まる。onAuthStateChanged 参照）
let editingCell = null; // カレンダーでクリック中のセル {userId, date}（シフト表示画面を離れたらnullに戻る）
let calPeriodKey = 'target';   // シフトカレンダーで表示中の期間（'target'＝作成中の対象期間、それ以外は公開済み期間の 'start_end'）
let myShiftPeriodKey = null;   // 「自分のシフト確認」で選んでいる公開済み期間の 'start_end'（null＝自動で選ぶ）
function currentUser(){ return DB.users.find(u=>u.id===currentUserId); }
function isAdmin(){ return currentUser() && currentUser().role==='admin'; }
// 5桁の社員番号を重複なしでランダムに発行する
function genEmpNo(){
  let n;
  do{ n=String(Math.floor(Math.random()*100000)).padStart(5,'0'); }
  while(DB.users.some(u=>u.empNo===n));
  return n;
}
let loginError='';
let authScreen='login';       // 'login' | 'setPassword'
let pwSetError='';
let authBusy=false;           // 通信中（ボタンの二度押し防止）
function go2Auth(screen){ authScreen=screen; loginError=''; pwSetError=''; render(); }
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
  if(c==='auth/network-request-failed' || c==='unavailable') return '通信できませんでした。インターネット接続を確認してください。';
  if(c==='permission-denied') return 'データにアクセスする権限がありません。Firebase のセキュリティルール（firestore.rules）が公開されているか確認してください。';
  if(c==='auth/api-key-not-valid.-please-pass-a-valid-api-key.' || c==='auth/invalid-api-key') return 'Firebase の設定（apiKey）が正しくありません。script.js の firebaseConfig を確認してください。';
  return 'エラーが発生しました（'+(c || (e && e.message) || '不明')+'）';
}
// 社員番号から内部IDを調べる。クラウドがまだ空（最初の1回）なら、この端末のデータの管理者だけ通す
async function lookupLogin(empNo){
  // 数字以外（「/」など）が入ると保存場所の指定がおかしくなるので、先に形を確かめる
  if(!/^[0-9]{1,5}$/.test(empNo)) throw appError('社員番号は数字5桁以内で入力してください。');
  const login=await fs.doc('logins/'+empNo).get();
  if(login.exists) return {uid:login.data().uid, setup:false};
  // 初期設定が済んでいるなら、単に番号が違う（済んでいるのに初期設定をやり直すと、クラウドのデータを上書きしてしまう）
  const pub=await fs.doc('app/public').get();
  if(pub.exists) throw appError('社員番号またはパスワードが正しくありません。');
  const u=LOCAL_DB.users.find(x=>x.empNo===empNo && x.role==='admin' && x.is_active);
  if(!u) throw appError('まだ初期設定が済んでいません。最初に管理者がログインしてください。');
  return {uid:u.id, setup:true};
}
// ログインまたはパスワード設定の共通処理。login には Firebase にログインする関数を渡す
async function runAuth(errorTarget, login){
  if(authBusy) return;
  authBusy=true; loginError=''; pwSetError=''; render();
  try{
    await login();
    activeTab='dash'; // 従業員の場合は、render() で従業員用の最初のタブに切り替わる
    authScreen='login';
  }catch(e){
    console.error(e);
    if(errorTarget==='login') loginError=authErrorMessage(e); else pwSetError=authErrorMessage(e);
    if(cloud.setupInProgress){ cloud.setupInProgress=false; auth.signOut(); }
  }
  authBusy=false; render();
}
function doLogin(){
  const empNo=(document.getElementById('lgEmpNo').value||'').trim();
  const pw=document.getElementById('lgPw').value||'';
  if(!empNo || !pw){ loginError='社員番号とパスワードを入力してください。'; render(); return; }
  runAuth('login', async ()=>{
    const {uid,setup}=await lookupLogin(empNo);
    if(setup) cloud.setupInProgress=true;
    await auth.signInWithEmailAndPassword(emailOf(uid),pw);
    if(setup) await finishSetup();
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
    const {uid,setup}=await lookupLogin(empNo);
    if(setup) cloud.setupInProgress=true;
    await auth.createUserWithEmailAndPassword(emailOf(uid),pw);
    if(setup) await finishSetup();
    alert('パスワードを設定しました。次回からは社員番号とこのパスワードでログインしてください。');
  });
}
// 最初の1回：この端末のデータをクラウドへ移してから、受信を始める
async function finishSetup(){
  await uploadLocalData();
  cloud.setupInProgress=false;
  startCloudSync();
  alert('この端末のデータをクラウドに移しました。これからは、ほかの人の端末にも同じデータが表示されます。');
}
function doLogout(){ auth.signOut(); }
function quickLogin(empNo,pw){ document.getElementById('lgEmpNo').value=empNo; document.getElementById('lgPw').value=pw; doLogin(); }

// ログイン状態が変わったとき（ログイン・ログアウト・ページを開いたときに前回のログインが残っていた場合）
auth.onAuthStateChanged(user=>{
  cloud.authKnown=true;
  const uid=userIdOfAuth(user);
  if(!uid){
    stopCloudSync();
    currentUserId=null; editingCell=null; calPeriodKey='target'; myShiftPeriodKey=null;
    DB=seed(); // ログアウトしたら画面にデータを残さない
    render(); return;
  }
  currentUserId=uid;
  if(!cloud.setupInProgress) startCloudSync(); // 最初の1回のデータ移行中は、移し終えてから受信を始める
  render();
});

function viewSetPassword(){
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">初回ログイン</span> パスワード設定</h2>
    <p class="desc">初めてログインする方は、社員番号と、今後ログインに使うパスワード（6文字以上）を設定してください。社員番号は管理者から伝えられた番号です。</p>
    ${pwSetError?`<div class="banner warn">${pwSetError}</div>`:''}
    <div class="row"><label style="width:100%">社員番号（5桁）<br>
      <input id="spEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" style="width:100%" placeholder="12345"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（6文字以上）<br>
      <input id="spPw" type="password" style="width:100%" placeholder="パスワード"></label></div>
    <div class="row"><label style="width:100%">新しいパスワード（確認）<br>
      <input id="spPw2" type="password" style="width:100%" placeholder="パスワード（再入力）"
        onkeydown="if(event.key==='Enter')setInitialPassword()"></label></div>
    <div class="row"><button style="width:100%" ${authBusy?'disabled':''} onclick="setInitialPassword()">${authBusy?'処理中…':'設定してログイン'}</button></div>
    <div class="row" style="margin:0"><button class="ghost mini" onclick="go2Auth('login')">← ログイン画面に戻る</button></div>
  </div>`;
}
function viewLogin(){
  if(authScreen==='setPassword') return viewSetPassword();
  return `
  <div class="card" style="max-width:420px;margin:40px auto">
    <h2><span class="tag">ログイン</span> ログイン画面</h2>
    <p class="desc">社員番号（5桁）とパスワードでログインしてください。</p>
    ${loginError?`<div class="banner warn">${loginError}</div>`:''}
    <div class="row"><label style="width:100%">社員番号（5桁）<br>
      <input id="lgEmpNo" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" style="width:100%" placeholder="12345"
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
function slotRequired(dateIso){
  // テンプレートをSLOT_MIN刻みに展開: minute -> required count (最大値を採用)
  const map={};
  for(const r of DB.required_staff){
    for(let m=toMin(r.start); m<toMin(r.end); m+=SLOT_MIN){
      map[m]=Math.max(map[m]||0, r.count);
    }
  }
  return map; // {startMinute: count}
}

function generateShifts(){
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end);
  DB.shifts = DB.shifts.filter(sh=> !(sh.date>=s.period_start && sh.date<=s.period_end));
  DB.breaks = (DB.breaks||[]).filter(b=> !(b.date>=s.period_start && b.date<=s.period_end));

  // 月初の日から1日ずつ、その日のうちに全ステップ（①〜⑥）を終わらせてから次の日へ進む。
  // 週の実働時間・連続勤務日数は、日をまたいで積み上げる状態としてここで1つずつだけ持つ
  // （以前はステップごとに別々のカウンターを持っていたため、一部のステップだけ更新し忘れる
  // 不具合があった。1本化することで、その種の見落としを防ぐ）。
  const weekMin={};  // userId -> weekKey -> それまでの週の実働分（扶養PA上限・扶養学生PA上限判定に使う）
  const streaks={};  // userId -> それまでの連続勤務日数（3連勤ルール・休憩の穴埋め招集の判定に使う）
  DB.users.forEach(u=>{ weekMin[u.id]={}; streaks[u.id]=0; });

  const bwAnchor=businessWindow(); const anchor=bwAnchor?toMin(bwAnchor.open):0;
  const snapDown30=t=>anchor+Math.floor((t-anchor)/30)*30;
  const snapUp30=t=>anchor+Math.ceil((t-anchor)/30)*30;

  // 9:30〜10:00は1人（立ち上げ番を優先）、20:00〜20:30は2人（閉め番を優先）を超えない。
  // ラベル（立ち上げ番・閉め番）が同時に複数人につく日は、削られる人が公平ローテーションの
  // 巡り合わせで毎回変わってしまうと不公平感が出るため、priorityRuleKeysで固定の優先順位を
  // つける（リストに無い人はラベルが付いていても優先順位は一番低い扱いになる）。
  const capWindows=[
    {start:'09:30', end:'10:00', max:1, edge:'start', preferLabel:'openingDuty',
      priorityRuleKeys:['17649','44165','75643']}, // 金子＞小林＞星山
    {start:'20:00', end:'20:30', max:2, edge:'end', preferLabel:'closingDuty',
      priorityRuleKeys:['19111','9643','51180']}, // 長井＞鈴木＞寺嶋
  ];
  const priorityRank=(u,cw)=>{
    const idx=(cw.priorityRuleKeys||[]).indexOf(ruleKeyOf(u));
    return idx===-1 ? 999 : idx;
  };

  const shortages=[];

  // ---- 週ごとの下ごしらえ: 扶養PA・扶養学生PAの週の上限を、あらかじめ出勤可能日に配分する ----
  // 日ごとに前から順番に使ってしまうと、週の前半で上限を使い切ってしまい、後半の人手が
  // 足りない日にこの人たちの力を借りられなくなる（週をまたいだ見通しがないという弱点）。
  // これを避けるため、まず1週間分の希望を先読みし、「この人がいなかったら何分不足するか」
  // が大きい日ほど多くの持ち分を配分してから、日ごとの割り当てに入る。
  const weekDates={}; // weekKey -> その週に含まれる対象期間内の日付一覧
  for(const d of days){ const wk=isoWeekKey(d); (weekDates[wk]=weekDates[wk]||[]).push(d); }
  const paDayBudget={}; // userId -> date -> この人がその日に割り当てられる上限（分・30分刻み）
  DB.users.forEach(u=>{ paDayBudget[u.id]={}; });
  const deficitMinutesIfAbsent=(u,d)=>{
    const req=slotRequired(d);
    const others=DB.users.filter(cu=>cu.id!==u.id && isStaff(cu) && cu.is_active).filter(cu=>{
      const p=(DB.employee_preferences[cu.id]||{})[d];
      return p && !p.day_off && p.start && p.end;
    });
    let deficit=0;
    for(const t in req){
      const tn=Number(t);
      const covering=others.filter(cu=>{
        const p=DB.employee_preferences[cu.id][d];
        return toMin(p.start)<=tn && toMin(p.end)>tn;
      }).length;
      if(covering<req[t]) deficit += (req[t]-covering)*SLOT_MIN;
    }
    return deficit;
  };
  for(const wk in weekDates){
    const datesInWeek=weekDates[wk];
    for(const u of DB.users){
      if(!isStaff(u) || !u.is_active) continue;
      const pa=PA_TYPES[u.permission];
      if(!pa || pa.weekCapMin==null) continue; // 扶養PA・扶養学生PAだけが対象（一般PAは上限なしなので配分不要）
      const availableDates=datesInWeek.filter(d=>{
        const p=(DB.employee_preferences[u.id]||{})[d];
        return p && !p.day_off && p.start && p.end;
      });
      if(availableDates.length===0) continue;
      const capForWeek=pa.weekCapMin-1; // 週の上限は「未満」を厳守する
      const dayCapForStudent=(u.permission==='dependent_student') ? Math.floor((DEPENDENT_STUDENT_DAY_CAP_MIN-1)/30)*30 : Infinity;
      // 提出時間そのまま働ける日を優先度（不足しやすい日）順に並べる。
      // 不足しやすい日から優先して「提出時間そのまま」を確保し、それでも上限が余れば
      // 次に不足しやすい日にも回す、というように埋めていく（提出時間に近づけつつ、
      // 前半の日だけで上限を使い切らないようにする）。
      const items=availableDates.map(d=>{
        const p=DB.employee_preferences[u.id][d];
        const submitted=Math.min(toMin(p.end)-toMin(p.start), dayCapForStudent);
        return {d, deficit:deficitMinutesIfAbsent(u,d), submitted, budget:0};
      }).sort((a,b)=>b.deficit-a.deficit);
      // ① まず、上限が許す範囲で「その日に働くなら最低3時間（提出時間がそれ未満ならその時間）」を、
      //    不足しやすい日から優先して確保する。上限が足りず全員には確保できない場合は、
      //    最も不足しにくい日（＝他の人だけでも足りている日）から自然と後回しになる。
      let remaining=capForWeek;
      for(const item of items){
        const base=Math.floor(Math.min(MIN_SHIFT_MIN, item.submitted)/30)*30;
        if(base>0 && base<=remaining){ item.budget=base; remaining-=base; }
      }
      // ② 余った上限を、不足しやすい日から順に提出時間いっぱいまで積み増す
      for(const item of items){
        if(remaining<=0) break;
        if(item.budget<=0) continue; // ①で確保できなかった日は、無理に短時間だけ足さない
        const room=item.submitted-item.budget;
        const extra=Math.floor(Math.min(room, remaining)/30)*30;
        item.budget+=extra; remaining-=extra;
      }
      for(const item of items) paDayBudget[u.id][item.d]=item.budget;
    }
  }

  for(const date of days){
    const wk=isoWeekKey(date);
    const req=slotRequired(date);
    let dayShifts=[]; // この日のシフト（最後にDB.shiftsへまとめて反映する）

    // ---- ①希望休の反映 ----
    // （employee_preferences のdate_offをそのまま使うので特別な処理は不要）

    // ---- ②必要最低人数の1.5倍程度までは、提出時間どおりに出勤可能な人を入れる ----
    // 必要最低人数ぴったりで打ち切ると、提出人数が多い日にまったくシフトが入らない人が
    // 出てしまう。必要最低人数はあくまで「下限」なので、ある程度までは多めに入れてよい
    // （required_staffのcountは上限ではない）。目安として1.5倍まで入れ、それでも入りきらない
    // 分は、その週の実働時間が少ない人から優先的に選ぶ（登録順だけに頼ると特定の人に偏るため）。
    // 連勤日数が少ない人を優先して選ぶ（同じ連勤日数どうしなら週の実働時間が少ない人を優先）。
    // こうすると、連勤が続いている人はその分だけ選ばれにくくなって休みが入りやすくなり、
    // 連勤日数がリセットされて、後日また休憩の穴埋めなどに呼べる「余力のある人」に戻りやすい。
    // 結果として、3〜4連勤ぎりぎりの人ばかりになって誰も穴埋めできない、という状況を減らせる。
    const candidates=DB.users.filter(u=>{
      if(!isStaff(u) || !u.is_active) return false;
      const p=(DB.employee_preferences[u.id]||{})[date];
      return p && !p.day_off && p.start && p.end;
    }).sort((a,b)=>{
      const sa=streaks[a.id]||0, sb=streaks[b.id]||0;
      if(sa!==sb) return sa-sb;
      return (weekMin[a.id][wk]||0)-(weekMin[b.id][wk]||0);
    });
    const countAt2=t=>dayShifts.filter(sh=>toMin(sh.start)<=t && toMin(sh.end)>t).length;
    const target=t=>Math.ceil(req[t]*1.5);
    const isSatisfied=()=>{ for(const t in req){ if(countAt2(Number(t))<target(Number(t))) return false; } return true; };
    for(const u of candidates){
      if(isSatisfied()) break;
      const p=DB.employee_preferences[u.id][date];
      dayShifts.push({user_id:u.id, date, start:p.start, end:p.end});
    }

    // ---- ②-b 立ち上げ番・閉め番の枠に、最優先の人が必ず入るようにする ----
    // ②の公平な人選だけだと、優先順位が一番高い人がその日一度も選ばれず、⑤の優先が
    // 意味をなさなくなることがある。かといって②の段階でラベルの人を無条件に優先すると、逆に
    // その人たちだけで1.5倍の枠が埋まってしまい、他の人（扶養PAの人なども含む）が
    // 一切選ばれなくなる。そこで、②の通常の人選が終わったあとに、対象の時間帯を出勤可能な
    // ラベル付きの人のうち最優先の人が、まだ入っていなければ追加で入れる
    // （すでにその人より優先順位が低いラベルの人だけが入っている場合も、優先順位が高い人を
    // 追加し、⑤で正しい人が優先されるようにする）。
    for(const cw of capWindows){
      if(!cw.preferLabel) continue;
      const ws=toMin(cw.start), we=toMin(cw.end);
      const labeledAvailable=DB.users.filter(u=>{
        if(!u[cw.preferLabel] || !isStaff(u) || !u.is_active) return false;
        const p=(DB.employee_preferences[u.id]||{})[date];
        return p && !p.day_off && p.start && p.end && toMin(p.start)<=ws && toMin(p.end)>=we;
      }).sort((a,b)=>priorityRank(a,cw)-priorityRank(b,cw));
      if(labeledAvailable.length===0) continue;
      const top=labeledAvailable[0];
      if(!dayShifts.some(sh=>sh.user_id===top.id)){
        const p=DB.employee_preferences[top.id][date];
        dayShifts.push({user_id:top.id, date, start:p.start, end:p.end});
      }
    }

    // ---- ③扶養PA・扶養学生PAの上限を守る ----
    for(const sh of [...dayShifts]){
      const u=DB.users.find(x=>x.id===sh.user_id);
      const pa=PA_TYPES[u.permission];
      if(!pa) continue;
      const hasWeekCap=pa.weekCapMin!=null, hasDayCap=(u.permission==='dependent_student');
      if(!hasWeekCap && !hasDayCap) continue;
      let dur=toMin(sh.end)-toMin(sh.start);
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
      else { sh.end=toHM(toMin(sh.start)+dur); }
    }

    // ---- ④3連勤を超えないように調整（不足が出る日は4連勤目まで許容）----
    const overLimit=[];
    for(const sh of [...dayShifts]){
      const u=DB.users.find(x=>x.id===sh.user_id);
      const nextStreak=(streaks[u.id]||0)+1;
      if(nextStreak>maxConsecutiveFor(u)){ overLimit.push({u,shift:sh,nextStreak}); dayShifts=dayShifts.filter(x=>x!==sh); }
    }
    const hasShortageNow=()=>{
      for(const t in req){
        const working=dayShifts.filter(x=>toMin(x.start)<=Number(t) && toMin(x.end)>Number(t)).length;
        if(working<req[t]) return true;
      }
      return false;
    };
    for(const o of overLimit.filter(o=>o.nextStreak<=4)){
      if(!hasShortageNow()) break;
      dayShifts.push(o.shift);
    }

    // ---- ⑤9:30〜10:00は1人、20:00〜20:30は2人を超えないように調整（ラベル優先）----
    for(const cw of capWindows){
      const ws=toMin(cw.start), we=toMin(cw.end);
      let covering=dayShifts.filter(sh=>toMin(sh.start)<=ws && toMin(sh.end)>=we);
      if(cw.preferLabel){
        covering.sort((a,b)=>{
          const ua=DB.users.find(x=>x.id===a.user_id), ub=DB.users.find(x=>x.id===b.user_id);
          const la=(ua&&ua[cw.preferLabel])?1:0, lb=(ub&&ub[cw.preferLabel])?1:0;
          if(la!==lb) return lb-la; // ラベルありが先
          if(la===1) return priorityRank(ua,cw)-priorityRank(ub,cw); // ラベルありどうしは固定の優先順位
          return 0;
        });
      }
      if(covering.length<=cw.max) continue;
      for(const sh of covering.slice(cw.max)){
        if(cw.edge==='start') sh.start=cw.end; else sh.end=cw.start;
        if(toMin(sh.end)-toMin(sh.start)<MIN_SHIFT_MIN) dayShifts=dayShifts.filter(x=>x!==sh); // 3時間未満になるなら外す
      }
    }

    // 新しく人を追加する時（穴埋め・休憩バックフィル）、その人の勤務時間が9:30〜10:00や20:00〜20:30を
    // まるごと覆ってしまうと、⑤で調整したはずの上限人数を再び超えてしまう。追加する側の端を削って
    // 上限を超えないようにする（すでにこの時間帯が上限に達している場合だけ）。
    // 休憩の穴埋めで呼ぶ場合は、休憩に入る本人（excludeUserId）はその間その場にいないので、
    // 上限人数のカウントから外す（本人の休憩中に代わりに1人入るだけなら、上限を超えたことにはならない）。
    const clipForCapWindows=(hs,he,excludeUserId)=>{
      for(const cw of capWindows){
        const ws=toMin(cw.start), we=toMin(cw.end);
        if(hs<=ws && he>=we){
          const covering=dayShifts.filter(sh=>sh.user_id!==excludeUserId && toMin(sh.start)<=ws && toMin(sh.end)>=we).length;
          if(covering>=cw.max){
            if(cw.edge==='start') hs=Math.max(hs,we); else he=Math.min(he,ws);
          }
        }
      }
      return [hs,he];
    };

    // 不足区間[start,end)を埋められる人を探す。対象になれるかどうかは「出勤可能時間」
    // （希望より広い、頼ってよい上限）で判定するが、実際に入れる時間帯はまず「希望」の
    // 時間そのままプラスでシフトに入れることを優先する。まず対象者全員について希望時間
    // そのままで入れられないかを試し、それで誰も入れられない場合だけ、出勤可能時間の範囲内で
    // 30分広げた枠→不足区間ぴったりの順で対象者全員を試す（1人目が narrow な結果になっても、
    // 別の人なら希望時間そのまま入れられる、という場合を取りこぼさないようにする）。
    const findBackfillHelper=(start,end,excludeIds,coveringForUserId)=>{
      const eligible=DB.users.filter(cu=>{
        if(!isStaff(cu) || !cu.is_active || excludeIds.has(cu.id)) return false;
        const p=(DB.employee_preferences[cu.id]||{})[date];
        if(!p || p.day_off || !p.start || !p.end) return false;
        // 穴埋めは「希望」ではなく「出勤可能時間」（希望より広い、頼ってよい上限）で判定する。
        const [as,ae]=availRangeMin(p);
        if(as>start || ae<end) return false;
        // ④で「不足が出る日だけ4連勤目まで許容する」のと同じ基準に合わせる。ここは不足を
        // 埋めるための最後の砦なので、④より厳しい基準（3連勤まで）で弾いてしまうと、
        // ④なら救済されたはずの人まで穴埋めに使えなくなってしまう。
        if((streaks[cu.id]||0)+1>maxConsecutiveFor(cu)+1) return false;
        return true;
      });
      // 週の持ち分（paDayBudget）は「平常時に前半で使い切らない」ための平準化用の目安で、
      // ここ（穴埋め・休憩バックフィルという最後の砦）では見ない。実際に不足している以上、
      // 週の実働上限（weekCapMin）にさえ収まるなら、温存分を崩してでも埋める方を優先する。
      const fitsCaps=(cu,a,b)=>{
        const pa=PA_TYPES[cu.permission];
        if(pa && pa.weekCapMin!=null && (weekMin[cu.id][wk]||0)+(b-a)>=pa.weekCapMin) return false;
        if(cu.permission==='dependent_student' && (b-a)>=DEPENDENT_STUDENT_DAY_CAP_MIN) return false;
        return true;
      };
      const tryRange=(cu,hs,he)=>{
        if(!fitsCaps(cu,hs,he)) return null;
        [hs,he]=clipForCapWindows(hs,he,coveringForUserId);
        if(he-hs<MIN_SHIFT_MIN || hs>start || he<end) return null;
        return [hs,he];
      };
      for(const cu of eligible){ // ①希望時間そのまま
        const p=DB.employee_preferences[cu.id][date];
        const r=tryRange(cu, toMin(p.start), toMin(p.end));
        if(r) return {helper:cu, hs:r[0], he:r[1]};
      }
      for(const cu of eligible){ // ②30分広げた枠（出勤可能時間の範囲内まで）
        const p=DB.employee_preferences[cu.id][date];
        const [as,ae]=availRangeMin(p);
        const r=tryRange(cu, Math.max(snapDown30(start),as), Math.min(snapUp30(end),ae));
        if(r) return {helper:cu, hs:r[0], he:r[1]};
      }
      for(const cu of eligible){ // ③不足区間ぴったり
        const r=tryRange(cu, start, end);
        if(r) return {helper:cu, hs:r[0], he:r[1]};
      }
      return null;
    };

    // 新しく人を追加しても埋まらない場合、既にその日入っている人の中に、③（扶養上限の週配分）
    // などで提出時間より短く削られてしまった人がいないか確認する。その人の提出時間なら
    // 不足区間をカバーできて、週の実働上限（絶対条件）にさえ収まるなら、温存していた分を
    // 使い切ってでもその人の勤務時間を提出時間の方向へ伸ばして埋める
    // （他に誰もいない以上、平準化より目の前の不足を埋める方を優先する）。
    const tryExtendExisting=(gapStart,gapEnd)=>{
      for(const sh of dayShifts){
        if(toMin(sh.start)<=gapStart && toMin(sh.end)>=gapEnd) continue; // すでにカバー済み
        if(toMin(sh.start)>gapEnd || toMin(sh.end)<gapStart) continue; // 隣接・重なりがなければ対象外（1本のシフトを保つ）
        const u=DB.users.find(x=>x.id===sh.user_id);
        const p=(DB.employee_preferences[u.id]||{})[date];
        if(!p || p.day_off || !p.start || !p.end) continue;
        const [as,ae]=availRangeMin(p); // 希望ではなく出勤可能時間の範囲まで伸ばしてよい
        if(as>gapStart || ae<gapEnd) continue; // 出勤可能時間そのものが不足区間をカバーしていない
        let ns=Math.max(Math.min(toMin(sh.start),gapStart), as);
        let ne=Math.min(Math.max(toMin(sh.end),gapEnd), ae);
        const pa=PA_TYPES[u.permission];
        if(pa && pa.weekCapMin!=null && (weekMin[u.id][wk]||0)+(ne-ns)>=pa.weekCapMin) continue;
        if(u.permission==='dependent_student' && (ne-ns)>=DEPENDENT_STUDENT_DAY_CAP_MIN) continue;
        [ns,ne]=clipForCapWindows(ns,ne);
        if(ns>gapStart || ne<gapEnd) continue; // 上限人数の都合で結局不足区間を覆えないなら諦める
        if(ne-ns<MIN_SHIFT_MIN) continue;
        sh.start=toHM(ns); sh.end=toHM(ne);
        return true;
      }
      return false;
    };

    // ---- ⑤の後の穴埋め: ③④⑤で人を減らした結果できた「素の人員不足」を、可能なら別の人で埋める ----
    // （ここで埋められない分は、休憩を考慮する前からすでに不足しているとして正直に記録する。
    //   以前は休憩に絡まない不足がカレンダーの「不足」欄に出てこない見落としがあったための対策）
    {
      const workingAt2=m=>dayShifts.filter(sh=>toMin(sh.start)<=m && toMin(sh.end)>m).length;
      const excludeIds=new Set(dayShifts.map(x=>x.user_id));
      const times=Object.keys(req).map(Number).sort((a,b)=>a-b);
      let i=0;
      while(i<times.length){
        const t=times[i], working=workingAt2(t), need=req[t];
        if(working>=need){ i++; continue; }
        let j=i;
        while(j<times.length && workingAt2(times[j])===working && req[times[j]]===need) j++;
        const gapStart=t, gapEnd=times[j-1]+SLOT_MIN;
        const found=findBackfillHelper(gapStart,gapEnd,excludeIds);
        if(found){
          dayShifts.push({user_id:found.helper.id, date, start:toHM(found.hs), end:toHM(found.he)});
          excludeIds.add(found.helper.id);
          continue; // 埋まったので同じiから再判定する
        }
        if(tryExtendExisting(gapStart,gapEnd)){
          continue; // 埋まったので同じiから再判定する
        }
        shortages.push({date,start:toHM(gapStart),end:toHM(gapEnd),required:need,assigned:working});
        i=j;
      }
    }

    // ---- ⑥必要最低人数を割らないように休憩を入れる（バックフィル込み）----
    // 休憩の穴埋めで新しく呼んだ人（helper）も、その人自身が長時間勤務なら休憩が必要になる。
    // 最初に固定した一覧（dayShiftsのコピー）だけを回すと、その人の休憩判定が一生行われず
    // 「8時間以上勤務なのに休憩がない人」ができてしまうため、新しく追加した分もキューに足して
    // 同じ判定を行う。
    const breaksToday=[];
    const workingAt=m=>dayShifts.filter(sh=>toMin(sh.start)<=m && toMin(sh.end)>m).length;
    const onBreakAt=m=>breaksToday.filter(b=>toMin(b.start)<=m && toMin(b.end)>m).length;
    const breakQueue=[...dayShifts];
    for(let qi=0; qi<breakQueue.length; qi++){
      const sh=breakQueue[qi];
      const u=DB.users.find(x=>x.id===sh.user_id);
      const workMin=toMin(sh.end)-toMin(sh.start);
      const brk=u?breakMinutesFor(u,date,workMin):0;
      if(brk<=0) continue;
      const bs=toMin(sh.start), be=toMin(sh.end), mid=(bs+be)/2;
      // 休憩が退勤時刻ちょうどに終わる候補（t+brk===be）も許容する（<=）。以前は<だったため
      // その1候補だけ取りこぼしていた。
      const starts=[]; for(let t=bs;t+brk<=be;t+=SLOT_MIN) starts.push(t);
      starts.sort((a,b)=>Math.abs((a+brk/2)-mid)-Math.abs((b+brk/2)-mid));
      let placed=false, best=null, bestShort=Infinity, bestReq=0, bestWorking=0;
      for(const start of starts){
        const end=start+brk;
        let ok=true, worst=0, worstReq=0, worstWorking=0;
        for(let t=start;t<end;t+=SLOT_MIN){
          const working=workingAt(t)-onBreakAt(t)-1;
          const need=req[t]||0;
          if(working<need){ ok=false; const short=need-working; if(short>worst){ worst=short; worstReq=need; worstWorking=working; } }
        }
        if(ok){ breaksToday.push({user_id:sh.user_id,date,start:toHM(start),end:toHM(end)}); placed=true; break; }
        if(worst<bestShort){ bestShort=worst; best={start,end}; bestReq=worstReq; bestWorking=worstWorking; }
      }
      if(!placed){
        for(const start of starts){
          const end=start+brk;
          let okWithExtra=true;
          for(let t=start;t<end;t+=SLOT_MIN){
            const working=workingAt(t)-onBreakAt(t)-1+1;
            if(working<(req[t]||0)){ okWithExtra=false; break; }
          }
          if(!okWithExtra) continue;
          const excludeIds=new Set(dayShifts.map(x=>x.user_id)); // sh.user_id自身も含めて、既に入っている人は除く
          const found=findBackfillHelper(start,end,excludeIds,sh.user_id); // sh.user_idは休憩中いないので上限人数には数えない
          if(!found) continue;
          const helperShift={user_id:found.helper.id, date, start:toHM(found.hs), end:toHM(found.he)};
          dayShifts.push(helperShift);
          breakQueue.push(helperShift); // この人自身の休憩も後で判定する
          breaksToday.push({user_id:sh.user_id,date,start:toHM(start),end:toHM(end)});
          placed=true; break;
        }
      }
      if(!placed && best){
        breaksToday.push({user_id:sh.user_id,date,start:toHM(best.start),end:toHM(best.end)});
        shortages.push({date,start:toHM(best.start),end:toHM(best.end),required:bestReq,assigned:bestWorking});
      }
    }

    // ---- この日の結果を確定し、週の実働時間・連続勤務日数を更新してから次の日へ ----
    DB.shifts.push(...dayShifts);
    DB.breaks.push(...breaksToday);
    DB.users.forEach(u=>{
      if(!isStaff(u) || !u.is_active) return;
      const sh=dayShifts.find(x=>x.user_id===u.id);
      if(sh) weekMin[u.id][wk]=(weekMin[u.id][wk]||0)+(toMin(sh.end)-toMin(sh.start));
      streaks[u.id]=sh?(streaks[u.id]||0)+1:0;
    });
  }

  // 人員不足の記録は、対象期間の分だけを入れ替える（公開済みの過去の期間の記録は残し、
  // その期間をカレンダーで表示したときにも不足が正しく出るようにする）。
  const otherPeriodShortages=(s.shortages||[]).filter(x=> x.date<s.period_start || x.date>s.period_end);
  s.shortages=mergeShortages([...otherPeriodShortages, ...suppressClosingDutyShortages(shortages)]);
  s.last_generated=new Date().toLocaleString("ja-JP");
  // 公開済みの期間を作り直した場合は、これまでと同じく非公開に戻す（内容を確認してから公開し直してもらう）
  s.published_periods=publishedPeriods().filter(pp=>!(pp.start===s.period_start && pp.end===s.period_end));
  save();
}

function mergeShortages(list){
  list.sort((a,b)=> a.date<b.date?-1:a.date>b.date?1:toMin(a.start)-toMin(b.start));
  const out=[];
  for(const s of list){
    const last=out[out.length-1];
    if(last && last.date===s.date && last.end===s.start && last.required===s.required && last.assigned===s.assigned){
      last.end=s.end;
    } else out.push({...s});
  }
  return out;
}
// 20:00〜20:30は、閉め番の人が1人でも出勤していれば人員不足として扱わない
// （必要最低人数の設定上は2人だが、閉め番の人が1人いれば現場としては問題ないとの判断）。
// 不足の記録（date,start,end,required,assigned）のうち20:00〜20:30と重なる部分だけを
// 15分刻みで確認し、閉め番の人がその時間帯に出勤していれば、その部分だけ不足から取り除く。
function suppressClosingDutyShortages(list){
  const ws=toMin('20:00'), we=toMin('20:30');
  const out=[];
  for(const s of list){
    const ss=toMin(s.start), se=toMin(s.end);
    if(se<=ws || ss>=we){ out.push(s); continue; } // 20:00〜20:30と関係ない不足はそのまま
    if(ss<ws) out.push({...s, end:'20:00'}); // 20:00より前の部分はそのまま残す
    const clipStart=Math.max(ss,ws), clipEnd=Math.min(se,we);
    let segStart=null;
    for(let t=clipStart;t<clipEnd;t+=SLOT_MIN){
      const hasClosing=DB.shifts.some(sh=>{
        if(sh.date!==s.date || toMin(sh.start)>t || toMin(sh.end)<=t) return false;
        const u=DB.users.find(x=>x.id===sh.user_id);
        return u && u.closingDuty;
      });
      if(hasClosing){
        if(segStart!==null){ out.push({...s, start:toHM(segStart), end:toHM(t)}); segStart=null; }
      } else if(segStart===null){ segStart=t; }
    }
    if(segStart!==null) out.push({...s, start:toHM(segStart), end:toHM(clipEnd)});
    if(se>we) out.push({...s, start:'20:30'}); // 20:30より後の部分はそのまま残す
  }
  return out;
}
// カレンダーでのシフト手動編集（追加・更新・削除）のあと、その日だけ必要最低人数の充足状況を
// 作成し直す。他の日の不足はそのまま、全体の再作成をしなくてもその日の分だけ最新化される。
function recomputeShortagesForDate(date){
  const req=slotRequired(date);
  const dayShifts=DB.shifts.filter(x=>x.date===date);
  const dayBreaks=(DB.breaks||[]).filter(x=>x.date===date);
  const workingAt=m=>dayShifts.filter(sh=>toMin(sh.start)<=m && toMin(sh.end)>m).length
                     - dayBreaks.filter(b=>toMin(b.start)<=m && toMin(b.end)>m).length;
  const newForDate=[];
  const times=Object.keys(req).map(Number).sort((a,b)=>a-b);
  let i=0;
  while(i<times.length){
    const t=times[i], working=workingAt(t), need=req[t];
    if(working>=need){ i++; continue; }
    let j=i;
    while(j<times.length && workingAt(times[j])===working && req[times[j]]===need) j++;
    newForDate.push({date, start:toHM(t), end:toHM(times[j-1]+SLOT_MIN), required:need, assigned:working});
    i=j;
  }
  const others=(DB.settings.shortages||[]).filter(s=>s.date!==date);
  DB.settings.shortages = mergeShortages(suppressClosingDutyShortages([...others, ...newForDate]));
}

/* ============================================================
   画面描画
   ============================================================ */
const TABS_ADMIN=[
  ['dash','① ダッシュボード'],
  ['emps','② 従業員管理'],
  ['need','③ 必要最低人数設定'],
  ['deadline','④ 締切設定'],
  ['make','⑤ シフト作成・確認'],
  ['cal','⑥ シフトカレンダー'],
];
const TABS_EMP=[
  ['home','① 従業員ホーム'],
  ['pref','② 勤務希望入力'],
  ['myshift','③ 自分のシフト確認'],
];
// 管理者でありながらPA種別（権限）も持つユーザー（例：寺嶋）が、自分の勤務希望を提出できるようにする追加タブ
const TABS_ADMIN_STAFF_EXTRA=[
  ['pref','⑦ 勤務希望入力（自分の分）'],
  ['myshift','⑧ 自分のシフト確認'],
];
function tabsFor(u){
  if(u.role==='admin') return isStaff(u) ? [...TABS_ADMIN, ...TABS_ADMIN_STAFF_EXTRA] : TABS_ADMIN;
  return TABS_EMP;
}
let activeTab='dash';

function render(){
  const who=document.getElementById('who');
  const tabsEl=document.getElementById('tabs');

  // ログイン状態の確認中・共有データの読み込み中
  if(!cloud.authKnown || (currentUserId && !cloud.ready)){
    who.innerHTML='';
    tabsEl.innerHTML='';
    document.getElementById('view').innerHTML=`<div class="card" style="max-width:420px;margin:40px auto;text-align:center">
      <p class="desc" style="margin:0">読み込み中…</p></div>`;
    return;
  }
  // 未ログイン → ログイン画面のみ
  if(!currentUser()){
    who.innerHTML='';
    tabsEl.innerHTML='';
    document.getElementById('view').innerHTML=viewLogin();
    return;
  }

  const u=currentUser();
  const roleDisp = (u.role==='admin' && isStaff(u)) ? '管理者 / 従業員' : roleLabel(u.role);
  who.innerHTML=`${DB.settings.org_name?`<span>${DB.settings.org_name}</span>`:''}
    <span>${u.name}（${roleDisp}）</span>
    <button class="ghost mini" onclick="doLogout()">ログアウト</button>`;

  const tabs=tabsFor(u);
  if(!tabs.find(t=>t[0]===activeTab)) activeTab=tabs[0][0];
  document.getElementById('tabs').innerHTML=tabs.map(([id,label])=>
    `<button class="${id===activeTab?'active':''}" onclick="go('${id}')">${label}</button>`).join('');

  const v=document.getElementById('view');
  v.innerHTML=({
    dash:viewDash, emps:viewEmps, need:viewNeed, deadline:viewDeadline,
    make:viewMake, cal:viewCal,
    home:viewHome, pref:viewPref, myshift:viewMyShift
  }[activeTab])();
  if(window._afterRender){ window._afterRender(); window._afterRender=null; }
}
function go(id){ activeTab=id; render(); }

/* ---------- 管理者: ダッシュボード ---------- */
function viewDash(){
  const s=DB.settings;
  const emps=DB.users.filter(u=>isStaff(u)&&u.is_active);
  const days=rangeDates(s.period_start,s.period_end);
  const submitted=emps.filter(u=>DB.submissions[u.id]===s.period_start);
  const shortMin=shortagesInTarget().reduce((a,x)=>a+(x.required-x.assigned),0);
  const afterDeadline = iso(new Date())>s.deadline;
  const latestPub=latestPublishedPeriod();
  return `
  <div class="card">
    <h2><span class="tag">概要</span> システム概要</h2>
    <p class="desc">従業員の勤務希望・希望休日・勤務可能時間と、時間帯ごとの必要最低人数を考慮して、シフトを自動作成します（営業時間は必要最低人数の設定範囲から決まります）。</p>
    <div class="kpi">
      <div class="box"><span class="note">対象期間</span><b>${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}</b></div>
      <div class="box"><span class="note">希望提出締切</span><b>${fmtDate(s.deadline)} ${afterDeadline?'<span class="pill bad">締切後</span>':'<span class="pill ok">受付中</span>'}</b></div>
      <div class="box"><span class="note">希望提出状況</span><b>${submitted.length} / ${emps.length} 名</b></div>
      <div class="box"><span class="note">人員不足</span><b>${shortMin>0?`<span style="color:var(--bad)">${shortMin} 人時</span>`:'<span style="color:var(--ok)">なし</span>'}</b></div>
      <div class="box"><span class="note">公開済みの最新シフト</span><b>${latestPub?`${fmtDate(latestPub.start)}〜${fmtDate(latestPub.end)}`:'<span class="pill muted">まだありません</span>'}</b></div>
    </div>
  </div>

  <div class="card">
    <h2><span class="tag">状況</span> 従業員の希望提出状況</h2>
    <div class="scroll"><table>
      <tr><th>氏名</th><th>役職</th><th>希望入力日数</th><th>状況</th></tr>
      ${emps.map(u=>{
        const p=DB.employee_preferences[u.id]||{};
        const cnt=days.filter(d=>p[d]).length;
        const offCnt=days.filter(d=>p[d]&&p[d].day_off).length;
        const sub=DB.submissions[u.id]===s.period_start;
        return `<tr>
          <td>${u.name}</td>
          <td>${roleLabel(u.role)}${u.permission?` <span class="pill muted">${paLabel(u)}${u.permission==='dependent'?'（週20h未満）':u.permission==='dependent_student'?'（週40h未満・1日8h未満）':''}</span>`:''}</td>
          <td>${cnt} / ${days.length}（希望休 ${offCnt}）</td>
          <td>${sub?'<span class="pill ok">提出済み</span>':'<span class="pill warn">未提出</span>'}</td>
        </tr>`;
      }).join('')}
    </table></div>
  </div>

  <div class="card">
    <h2><span class="tag">処理フロー</span> システム全体の流れ</h2>
    <p class="desc">① 管理者が設定 → ② 従業員が希望入力 → ③ 提出締切 → ④ 希望データ集計 → ⑤ シフト自動作成 → ⑥ 人員不足チェック → ⑦ 管理者が編集・確認 → ⑧ シフト公開（対象期間と締切は自動で次の期間へ） → ⑨ 従業員が確認</p>
    <button onclick="go('make')">シフト作成へ進む →</button>
    <button class="ghost" onclick="resetAll()">データ初期化</button>
  </div>`;
}

/* ---------- 管理者: 従業員管理 ---------- */
function viewEmps(){
  return `
  <div class="card">
    <h2><span class="tag">4-1</span> 従業員管理機能</h2>
    <p class="desc">従業員の追加・編集・削除を行います。管理項目：氏名、ログイン情報、役職、権限（PA種別）、在籍状況。社員番号は追加時に自動発行されます。あとから管理者が変更することもできます（数字5桁以内・他の人と重複しない番号）。変更した場合、本人は次回から新しい番号でログインします。パスワードは本人がログイン画面の「初めてログインする」から設定します（安全のため、管理者はパスワードを見たり変更したりできません）。<br>
      管理者アカウント（登録者を含む）も削除できます。ただし、ログイン中の自分のアカウントと、ログインできる最後の1人の管理者は削除できません。</p>
    <div class="scroll"><table id="empTable">
      <tr><th>氏名</th><th>社員番号</th><th>役職</th><th>権限（PA種別）</th><th>在籍</th><th>立ち上げ番</th><th>閉め番</th><th></th></tr>
      ${DB.users.map(u=>`<tr>
        <td><input value="${u.name}" onchange="editUser('${u.id}','name',this.value)"></td>
        <td><input value="${u.empNo}" inputmode="numeric" maxlength="5" style="width:6em" onchange="editUser('${u.id}','empNo',this.value)"></td>
        <td>${u.owner
          ? `管理者 <span class="pill muted">登録者</span>`
          : `<select onchange="editUser('${u.id}','role',this.value)">
          <option value="employee" ${u.role==='employee'?'selected':''}>従業員</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>管理者</option>
        </select>`}</td>
        <td><select onchange="editUser('${u.id}','permission',this.value)">
          ${u.role==='admin'?`<option value="" ${!u.permission?'selected':''}>（PA権限なし）</option>`:''}
          <option value="general" ${u.permission==='general'?'selected':''}>一般PA（制限なし）</option>
          <option value="dependent" ${u.permission==='dependent'?'selected':''}>扶養PA（週20h未満）</option>
          <option value="dependent_student" ${u.permission==='dependent_student'?'selected':''}>扶養学生PA（週40h未満）</option>
        </select></td>
        <td><input type="checkbox" ${u.is_active?'checked':''} ${u.owner?'disabled':''} onchange="editUser('${u.id}','is_active',this.checked)"></td>
        <td><input type="checkbox" ${u.openingDuty?'checked':''} onchange="editUser('${u.id}','openingDuty',this.checked)"></td>
        <td><input type="checkbox" ${u.closingDuty?'checked':''} onchange="editUser('${u.id}','closingDuty',this.checked)"></td>
        <td>${u.id===currentUserId?'<span class="pill muted">ログイン中</span>':`<button class="mini danger" onclick="delUser('${u.id}')">削除</button>`}</td>
      </tr>`).join('')}
    </table></div>
    <div class="row" style="margin-top:12px">
      <input id="newName" placeholder="氏名">
      <button onclick="addUser()">＋ 従業員を追加</button>
    </div>
    <p class="note">追加すると5桁の社員番号が自動で発行されます（重複なし）。権限は一旦「一般PA」になります。発行された社員番号を本人に伝え、ログイン画面の「初めてログインする（パスワード設定）」からパスワードを設定してもらってください。</p>
  </div>`;
}
// その人を管理者から外す（従業員に変える・在籍を外す・削除する）と、ログインできる管理者が
// 1人もいなくなるかどうか。管理者がいなくなると、誰も管理画面を開けなくなってしまう。
function isLastActiveAdmin(u){
  return !!u && u.role==='admin' && u.is_active && !DB.users.some(x=>x.id!==u.id && x.role==='admin' && x.is_active);
}
function editUser(id,f,val){ const u=DB.users.find(x=>x.id===id);
  if(u.owner && (f==='role'||f==='is_active')){ alert('登録時に作成した管理者アカウントの権限・在籍状況は変更できません。'); render(); return; }
  if(((f==='role' && val!=='admin') || (f==='is_active' && !val)) && isLastActiveAdmin(u)){
    alert('ログインできる管理者が1人もいなくなるため、変更できません。先に別の管理者を追加してください。'); render(); return;
  }
  if(f==='empNo'){
    // 社員番号はログインに使うので、ログイン画面で入力できる形（数字5桁以内）で、他の人と重複しないこと
    val=String(val).trim();
    if(val===u.empNo) return;
    if(!/^[0-9]{1,5}$/.test(val)){ alert('社員番号は数字5桁以内で入力してください。'); render(); return; }
    if(DB.users.some(x=>x.id!==u.id && x.empNo===val)){ alert(`社員番号「${val}」はすでに他の人が使っています。`); render(); return; }
    if(!confirm(`「${u.name}」さんの社員番号を「${u.empNo}」から「${val}」に変更しますか？\n次回から新しい番号でログインすることになります。本人に伝えてください。`)){ render(); return; }
  }
  if(f==='permission' && val==='') val=null;
  u[f]=val;
  save(); if(f==='empNo'||f==='role'||f==='name'||f==='is_active'||f==='permission'||f==='closingDuty'||f==='openingDuty') render(); }
// 従業員・管理者（登録者を含む）のアカウントを削除する。
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
  DB.breaks=(DB.breaks||[]).filter(b=>b.user_id!==id);
  affectedDates.forEach(d=>recomputeShortagesForDate(d)); // 抜けたシフトの分、その日の人員不足を計算し直す
  if(editingCell && editingCell.userId===id) editingCell=null;
  save(); render(); }
function addUser(){ const n=document.getElementById('newName').value.trim(); if(!n){alert('氏名を入力してください');return;}
  const empNo=genEmpNo();
  const id='u_'+Date.now();
  DB.users.push({id,name:n,empNo,ruleKey:id,role:'employee',permission:'general',is_active:true,openingDuty:false,closingDuty:false});
  save(); render();
  alert(`「${n}」さんの社員番号は「${empNo}」です。権限は一旦「一般PA」です。\nログイン画面の「初めてログインする（パスワード設定）」から、本人にパスワードを設定してもらってください。`); }

/* ---------- 管理者: 必要最低人数 ---------- */
function viewNeed(){
  return `
  <div class="card">
    <h2><span class="tag">4-3</span> 必要最低動員人数設定機能</h2>
    <p class="desc">時間帯ごとに必要な最低従業員数を設定します（全営業日に適用）。この人数は、誰かが休憩中であっても実際に働いている人数として満たされるよう、自動作成時に休憩の配置やカバー要員の追加で調整されます。営業時間設定は廃止したため、ここで設定した時間帯の最早開始〜最遅終了がそのまま営業時間として使われます。</p>
    <div class="scroll"><table>
      <tr><th>開始</th><th>終了</th><th>必要最低人数</th><th></th></tr>
      ${DB.required_staff.map(r=>`<tr>
        <td><input type="time" value="${r.start}" step="1800" onchange="editNeed('${r.id}','start',this.value)"></td>
        <td><input type="time" value="${r.end}" step="1800" onchange="editNeed('${r.id}','end',this.value)"></td>
        <td><input type="number" min="0" style="width:70px" value="${r.count}" onchange="editNeed('${r.id}','count',+this.value)"></td>
        <td><button class="mini danger" onclick="delNeed('${r.id}')">削除</button></td>
      </tr>`).join('')}
    </table></div>
    <div class="row" style="margin-top:12px">
      <button onclick="addNeed()">＋ 時間帯を追加</button>
    </div>
    <p class="note">※ 重なる時間帯がある場合は大きい必要最低人数を採用します。</p>
  </div>`;
}
function editNeed(id,f,v){ const r=DB.required_staff.find(x=>x.id===id);
  if(f==='start'||f==='end') v=snapHalfHour(v); // 開始・終了は00分／30分に固定（そのまま営業時間にもなる）
  r[f]=v; save(); if(f==='start'||f==='end') render(); }
function delNeed(id){ DB.required_staff=DB.required_staff.filter(r=>r.id!==id); save(); render(); }
function addNeed(){ DB.required_staff.push({id:'r'+Date.now(),start:'09:00',end:'12:00',count:1}); save(); render(); }

/* ---------- 管理者: 締切設定 ---------- */
function viewDeadline(){
  const s=DB.settings;
  const validPeriod = s.period_start && s.period_end && s.period_start<=s.period_end;
  const next = validPeriod ? nextPeriodOf(s.period_start,s.period_end,s.deadline) : null;
  return `
  <div class="card">
    <h2><span class="tag">4-4</span> 希望提出締切設定機能 / 対象期間</h2>
    <p class="desc">シフト対象期間と、勤務希望の提出締切日を設定します。締切日まで：従業員は編集可能／締切日以降：管理者のみ編集可能。</p>
    <div class="banner ok">🔁 シフトを公開すると、対象期間と締切日は自動で次の期間に切り替わります。
      ${next?`<br>次の切り替わり先：<b>${fmtDate(next.start)}〜${fmtDate(next.end)}</b>（締切 ${next.deadline?fmtDate(next.deadline):'未設定'}）`:''}</div>
    <fieldset><legend>シフト対象期間</legend>
      <div class="row">
        <label>開始 <input type="date" value="${s.period_start}" onchange="setS('period_start',this.value)"></label>
        <label>終了 <input type="date" value="${s.period_end}" onchange="setS('period_end',this.value)"></label>
      </div>
    </fieldset>
    <fieldset><legend>希望提出締切日</legend>
      <div class="row">
        <input type="date" value="${s.deadline}" onchange="setS('deadline',this.value)">
        <span class="note">今日: ${iso(new Date())}</span>
      </div>
    </fieldset>
  </div>`;
}
function setS(f,v){ DB.settings[f]=v; save(); render(); }

/* ---------- 管理者: シフト作成・確認 ---------- */
function viewMake(){
  const s=DB.settings;
  const short=shortagesInTarget();
  const targetPub=publishedPeriods().find(pp=>pp.start===s.period_start && pp.end===s.period_end); // 対象期間そのものが公開済みか
  const pubList=publishedPeriods().slice().sort((a,b)=> a.start<b.start ? 1 : -1); // 新しい期間を上に
  const latestPub=latestPublishedPeriod();
  return `
  <div class="card">
    <h2><span class="tag">5</span> シフト自動作成機能</h2>
    <p class="desc">
      月初の日から1日ずつ、その日の分だけ次の1〜6をすべて終えてから翌日に進みます
      （週の実働時間・連続勤務日数は日をまたいで積み上げて判定します）。<br>
      1. 全員の希望休をカレンダーに当てはめる<br>
      2. 必要最低人数の1.5倍程度までは、提出時間どおりに出勤可能時間を当てはめる<br>
      3. 扶養PA（週20時間未満）・扶養学生PA（週40時間未満・1日8時間未満）の上限を守る<br>
      4. 3連勤を超えないように調整する（人員不足が出る場合のみ4連勤まで許容）<br>
      5. 9:30〜10:00は1人、20:00〜20:30は2人を超えないように調整する（「立ち上げ番」「閉め番」ラベルの人を優先。複数人つく場合は金子＞小林＞星山、長井＞鈴木＞寺嶋の順）<br>
      6. 必要最低人数を割らないように休憩を入れる（休憩で不足が出る場合は、他の人に代わりに出勤してもらう）
    </p>
    <div class="row">
      <button onclick="doGenerate()">⚙️ シフトを自動作成する</button>
      <span class="note">${s.last_generated?'最終作成: '+s.last_generated:'未作成'}</span>
    </div>
  </div>

  <div class="card">
    <h2><span class="tag">5-3</span> 人員不足検知機能</h2>
    ${short.length===0
      ? `<div class="banner ok">✅ 必要最低人数を満たしています（人員不足なし）</div>`
      : `<div class="banner warn">⚠️ ${short.length} 件の時間帯で人員が不足しています</div>
         <div class="scroll"><table>
           <tr><th>日付</th><th>時間帯</th><th>必要最低人数</th><th>配置人数</th><th>不足</th></tr>
           ${short.map(x=>`<tr><td>${fmtDate(x.date)}</td><td>${x.start}〜${x.end}</td>
             <td>${x.required}人</td><td>${x.assigned}人</td><td class="short">${x.required-x.assigned}人</td></tr>`).join('')}
         </table></div>`}
  </div>

  <div class="card">
    <h2><span class="tag">6-3</span> シフト公開機能</h2>
    <p class="desc">公開前：従業員は自分のシフトを閲覧できません。公開後：従業員は自分のシフトを閲覧できます。<br>
      公開すると、締切設定（対象期間・締切日）は自動で次の期間に切り替わり、次の期間の勤務希望の受付が始まります。</p>
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
    </table></div>
    <p class="note">※「非公開に戻す」は最後に公開した期間だけできます。戻すと、締切設定（対象期間・締切日）もその期間に戻るので、修正して公開し直せます。</p>`:''}
  </div>`;
}
function doGenerate(){ generateShifts(); alert('シフトを自動作成しました。人員不足の有無を確認してください。'); render(); }

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
  // 公開済み期間の一覧に記録する（同じ期間を公開し直す場合は、古い記録と入れ替える）。
  // 締切日と最終作成日時も一緒に覚えておき、「非公開に戻す」ときに元どおりにできるようにする。
  s.published_periods=publishedPeriods().filter(pp=>!(pp.start===s.period_start && pp.end===s.period_end));
  s.published_periods.push({start:s.period_start, end:s.period_end, deadline:s.deadline,
    published_at:new Date().toLocaleString('ja-JP'), last_generated:s.last_generated||null});
  const publishedLabel=`${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}`;
  moveTargetToNextPeriod();
  save(); render();
  alert(`${publishedLabel} のシフトを公開しました。\n${nextPeriodMessage()}`);
}
// 対象期間がすでに公開済みのときに、公開し直さずに次の対象期間へ進む
// （公開フラグ時代のデータを移行した直後や、締切設定で公開済みの期間に戻した場合に使う）
function advanceToNextPeriod(){
  moveTargetToNextPeriod();
  save(); render();
  alert(nextPeriodMessage());
}
// 対象期間と締切日を次の期間に切り替える（保存と再描画は呼び出し側で行う）
function moveTargetToNextPeriod(){
  const s=DB.settings;
  const next=nextPeriodOf(s.period_start,s.period_end,s.deadline);
  s.period_start=next.start; s.period_end=next.end; s.deadline=next.deadline;
  s.last_generated=null; // 次の期間はまだ自動作成していない
  calPeriodKey='target'; editingCell=null; // カレンダーは新しい対象期間の表示に戻す
}
// 切り替え後の対象期間・締切を知らせる文。締切日がもう過ぎていたら直すよう促す
function nextPeriodMessage(){
  const s=DB.settings;
  let msg=`締切設定を次の対象期間（${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}、締切 ${s.deadline?fmtDate(s.deadline):'未設定'}）に切り替えました。`;
  if(!s.deadline) msg+='\n※ 締切日が設定されていません。「④ 締切設定」で設定してください。';
  else if(s.deadline<iso(new Date())) msg+='\n※ 新しい締切日はすでに過ぎています。「④ 締切設定」で締切日を直してください。';
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
  s.period_start=latest.start; s.period_end=latest.end;
  if(latest.deadline) s.deadline=latest.deadline;
  s.last_generated=latest.last_generated||null;
  calPeriodKey='target'; editingCell=null;
  save(); render();
}

/* ---------- 管理者/共通: シフトカレンダー ---------- */
function viewCal(){ return calendarHTML(true); }
const TERASHIMA_RULE_KEY = '51180', SUZUKI_RULE_KEY = '9643';
// カレンダーで切り替えられる期間の一覧：作成中の対象期間 ＋ 公開済みの期間（新しい順）
function calendarPeriodOptions(){
  const s=DB.settings;
  const opts=[{key:'target', start:s.period_start, end:s.period_end,
    label:`作成中の対象期間：${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}`}];
  publishedPeriods().slice().sort((a,b)=> a.start<b.start ? 1 : -1).forEach(pp=>{
    if(pp.start===s.period_start && pp.end===s.period_end) return; // 対象期間そのものが公開済みなら、重ねて出さない
    opts.push({key:pp.start+'_'+pp.end, start:pp.start, end:pp.end,
      label:`公開済み：${fmtDate(pp.start)}〜${fmtDate(pp.end)}`});
  });
  return opts;
}
function selectCalPeriod(key){ calPeriodKey=key; editingCell=null; render(); }
function calendarHTML(editable){
  const s=DB.settings;
  const periodOpts=calendarPeriodOptions();
  const period=periodOpts.find(o=>o.key===calPeriodKey) || periodOpts[0]; // 選んでいた期間が無くなっていたら対象期間に戻す
  const periodPublished=publishedPeriods().some(pp=>pp.start===period.start && pp.end===period.end);
  const days=rangeDates(period.start,period.end);
  const emps=DB.users.filter(u=>isStaff(u));
  // 表示順: 寺嶋を鈴木の直後に表示する（それ以外は元の並び順のまま）
  emps.sort((a,b)=>{
    const idx=u=>{
      if(ruleKeyOf(u)===TERASHIMA_RULE_KEY){
        const suzuki=DB.users.find(x=>ruleKeyOf(x)===SUZUKI_RULE_KEY);
        if(suzuki) return DB.users.indexOf(suzuki)+0.5;
      }
      return DB.users.indexOf(u);
    };
    return idx(a)-idx(b);
  });
  const cell=(u,date)=>{
    const p=(DB.employee_preferences[u.id]||{})[date];
    const list=DB.shifts.filter(x=>x.user_id===u.id&&x.date===date).sort((a,b)=>toMin(a.start)-toMin(b.start));
    const selected=editable && editingCell && editingCell.userId===u.id && editingCell.date===date;
    const cls=[];
    if(list.length) cls.push('work');
    else if(p&&p.day_off) cls.push('off');
    if(editable) cls.push('editable-cell');
    if(selected) cls.push('selected');
    const onclick=editable?` onclick="selectCell('${u.id}','${date}')"`:'';
    let inner;
    if(list.length){
      const brk=(DB.breaks||[]).find(b=>b.user_id===u.id&&b.date===date);
      inner=`${list.map(x=>x.start+'〜'+x.end).join('<br>')}${brk?`<br><span class="note">休憩 ${brk.start}〜${brk.end}</span>`:''}`;
    } else if(p&&p.day_off){
      inner='休';
    } else {
      inner='';
    }
    return `<td class="${cls.join(' ')}"${onclick}>${inner}</td>`;
  };
  const editingUser = editingCell && DB.users.find(u=>u.id===editingCell.userId);
  const editingShift = editingCell && DB.shifts.find(x=>x.user_id===editingCell.userId && x.date===editingCell.date);
  const editingBreak = editingCell && (DB.breaks||[]).find(x=>x.user_id===editingCell.userId && x.date===editingCell.date);
  return `
  <div class="card">
    <h2><span class="tag">6-1</span> シフト表示機能（カレンダー形式）</h2>
    <div class="row">
      <label>表示する期間
        <select onchange="selectCalPeriod(this.value)">
          ${periodOpts.map(o=>`<option value="${o.key}" ${o.key===period.key?'selected':''}>${o.label}</option>`).join('')}
        </select>
      </label>
    </div>
    <p class="desc">${fmtDate(period.start)}〜${fmtDate(period.end)}　${periodPublished?'<span class="pill ok">公開中</span>':'<span class="pill muted">非公開</span>'}${editable?'　<span class="note">※ マスの上をクリックすると、その人・その日のシフトを編集できます。</span>':''}${editable&&periodPublished?'<br><span class="note">※ 公開済みの期間を編集すると、その内容はすぐに従業員にも見えます。</span>':''}</p>
    <div class="scroll"><table class="cal">
      <tr><th>従業員</th>${days.map(d=>`<th>${fmtDate(d)}</th>`).join('')}</tr>
      ${emps.map(u=>`<tr><th>${u.name}</th>${days.map(d=>cell(u,d)).join('')}</tr>`).join('')}
      <tr><th>必要最低人数充足</th>${days.map(d=>{
        const list=s.shortages.filter(x=>x.date===d);
        if(list.length===0) return `<td>—</td>`;
        return `<td class="short">${list.map(x=>x.start+'〜'+x.end).join('<br>')}</td>`;
      }).join('')}</tr>
    </table></div>
    ${editable && editingCell?`
    <fieldset style="margin-top:14px"><legend>6-2 シフト編集：${editingUser?editingUser.name:''}（${fmtDate(editingCell.date)}）</legend>
      <div class="row">
        <input type="time" id="edStart" value="${editingShift?editingShift.start:'10:00'}" step="1800">
        <input type="time" id="edEnd" value="${editingShift?editingShift.end:'18:00'}" step="1800">
        <button onclick="saveCellShift()">${editingShift?'更新':'追加'}</button>
        ${editingShift?`<button class="danger" onclick="deleteCellShift()">このシフトを削除</button>`:''}
        <button class="ghost" onclick="closeCellEditor()">閉じる</button>
      </div>
      ${editingShift?`
      <div class="row" style="margin-top:8px">
        <span class="note">休憩：</span>
        <input type="time" id="edBreakStart" value="${editingBreak?editingBreak.start:''}" step="1800">
        <input type="time" id="edBreakEnd" value="${editingBreak?editingBreak.end:''}" step="1800">
        <button onclick="saveCellBreak()">${editingBreak?'休憩を更新':'休憩を設定'}</button>
        ${editingBreak?`<button class="ghost" onclick="clearCellBreak()">休憩をなしにする</button>`:''}
      </div>`:''}
      <p class="note">※ 手動編集すると、その日の人員不足の判定はその場で自動的に更新されます（他の日には影響しません）。※ シフトを追加しただけでは休憩は自動配置されません。休憩も上の欄から手動で設定してください。</p>
    </fieldset>`:''}
  </div>`;
}
function selectCell(userId,date){
  editingCell = (editingCell && editingCell.userId===userId && editingCell.date===date) ? null : {userId,date};
  render();
}
function closeCellEditor(){ editingCell=null; render(); }
function saveCellShift(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  const st=snapHalfHour(document.getElementById('edStart').value), en=snapHalfHour(document.getElementById('edEnd').value); // 出勤・退勤時刻は00分／30分に固定
  if(toMin(st)>=toMin(en)){ alert('終了は開始より後にしてください'); return; }
  const u=DB.users.find(x=>x.id===userId);
  const dur=toMin(en)-toMin(st);
  const pa=u&&PA_TYPES[u.permission];
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
  // シフトを縮めた結果、既存の休憩がシフトの時間外にはみ出す場合は休憩ごと外す
  const brk=(DB.breaks||[]).find(b=>b.user_id===userId&&b.date===date);
  if(brk && (toMin(brk.start)<toMin(st) || toMin(brk.end)>toMin(en))){
    DB.breaks=(DB.breaks||[]).filter(b=>!(b.user_id===userId&&b.date===date));
  }
  recomputeShortagesForDate(date);
  save(); render();
}
function deleteCellShift(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  if(!confirm('このシフトを削除しますか？')) return;
  DB.shifts=DB.shifts.filter(x=>!(x.user_id===userId&&x.date===date));
  DB.breaks=(DB.breaks||[]).filter(b=>!(b.user_id===userId&&b.date===date));
  recomputeShortagesForDate(date);
  save(); render();
}
function saveCellBreak(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  const sh=DB.shifts.find(x=>x.user_id===userId&&x.date===date);
  if(!sh){ alert('先にシフトを追加してください'); return; }
  const bsRaw=document.getElementById('edBreakStart').value, beRaw=document.getElementById('edBreakEnd').value;
  if(!bsRaw || !beRaw){ alert('休憩の開始・終了を両方入力してください'); return; }
  const bs=snapHalfHour(bsRaw), be=snapHalfHour(beRaw); // 休憩の開始・終了も00分／30分に固定
  if(toMin(bs)>=toMin(be)){ alert('休憩の終了は開始より後にしてください'); return; }
  if(toMin(bs)<toMin(sh.start) || toMin(be)>toMin(sh.end)){ alert('休憩はシフトの時間内に収めてください'); return; }
  DB.breaks=(DB.breaks||[]).filter(x=>!(x.user_id===userId&&x.date===date));
  DB.breaks.push({user_id:userId,date,start:bs,end:be});
  recomputeShortagesForDate(date);
  save(); render();
}
function clearCellBreak(){
  if(!editingCell) return;
  const {userId,date}=editingCell;
  DB.breaks=(DB.breaks||[]).filter(x=>!(x.user_id===userId&&x.date===date));
  recomputeShortagesForDate(date);
  save(); render();
}

/* ---------- 管理者: 権限要件 ---------- */
/* ---------- 従業員: ホーム ---------- */
function viewHome(){
  const s=DB.settings, u=currentUser();
  const days=rangeDates(s.period_start,s.period_end);
  const p=DB.employee_preferences[u.id]||{};
  const done=days.filter(d=>p[d]).length;
  const submitted=DB.submissions[u.id]===s.period_start;
  const afterDeadline=iso(new Date())>s.deadline;
  const latestPub=latestPublishedPeriod();
  return `
  <div class="card">
    <h2><span class="tag">3</span> 従業員ホーム（${u.name}）</h2>
    <div class="kpi">
      <div class="box"><span class="note">対象期間</span><b>${fmtDate(s.period_start)}〜${fmtDate(s.period_end)}</b></div>
      <div class="box"><span class="note">提出締切</span><b>${fmtDate(s.deadline)}</b> ${afterDeadline?'<span class="pill bad">締切後（編集不可）</span>':'<span class="pill ok">編集できます</span>'}</div>
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
  const afterDeadline=iso(new Date())>s.deadline;
  const locked = afterDeadline && !isAdmin();
  DB.employee_preferences[u.id]=DB.employee_preferences[u.id]||{};
  const p=DB.employee_preferences[u.id];
  const submitted=DB.submissions[u.id]===s.period_start;
  return `
  <div class="card">
    <h2><span class="tag">3-1</span> 勤務希望入力機能</h2>
    ${locked?'<div class="banner warn">⚠️ 提出締切を過ぎているため編集できません（管理者のみ編集可）</div>':''}
    ${u.permission==='dependent_student'?'<div class="banner ok">🎓 扶養学生PAのため、自動作成では「1日の勤務は8時間未満」「週の勤務時間は40時間未満」になるよう調整されます。</div>'
      :u.permission==='dependent'?'<div class="banner ok">📌 扶養PAのため、自動作成では「週の勤務時間が20時間未満」になるよう調整されます。</div>':''}
    <p class="desc">📌 「出勤可能」と「希望」は意味が違います。<b>出勤可能</b>は、人手が足りない時だけ頼ってもよい、一番外側の限界の時間です。<b>希望</b>は、普段このシフトで働きたい時間です。希望は出勤可能の範囲内で入力してください（自動作成では、まず希望どおりに配置し、人員不足や休憩の穴埋めが必要な時だけ出勤可能の範囲まで頼ります）。</p>
    <fieldset><legend>勤務可能時間・希望の一括設定（平日／土日）</legend>
      <p class="desc">平日と土日で別々に設定できます。反映すると、この期間の対象日（希望休の日を除く）に一括で適用されます。あわせて既定値として保存されるので、来月・来週など次の期間でも自動的にこの内容が初期値になり、毎回入力し直す手間がなくなります。</p>
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
      <tr><th>日付</th><th>希望休</th><th>出勤可能<br>開始</th><th>出勤可能<br>終了</th><th>希望<br>出勤</th><th>希望<br>退勤</th><th>営業時間</th></tr>
      ${(()=>{ const bw=businessWindow(); return days.map(d=>{
        const rec=p[d]||{day_off:false, ...defaultAvailFor(u.id,d)};
        return `<tr>
          <td>${fmtDate(d)}</td>
          <td><input type="checkbox" ${rec.day_off?'checked':''} ${locked?'disabled':''} onchange="setPref('${u.id}','${d}','day_off',this.checked)"></td>
          <td><input type="time" value="${rec.avail_start}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','avail_start',this.value)"></td>
          <td><input type="time" value="${rec.avail_end}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','avail_end',this.value)"></td>
          <td><input type="time" value="${rec.start}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','start',this.value)"></td>
          <td><input type="time" value="${rec.end}" step="1800" ${locked||rec.day_off?'disabled':''} onchange="setPref('${u.id}','${d}','end',this.value)"></td>
          <td class="note">${bw?bw.open+'〜'+bw.close:'未設定'}</td>
        </tr>`;
      }).join(''); })()}
    </table></div>
    </fieldset>
    <div class="row">
      ${locked
        ? '<span class="pill bad">締切後のため提出・変更できません</span>'
        : `<button onclick="submitPref('${u.id}')">${submitted?'この内容で再提出する':'この内容で提出する'}</button>
           ${submitted?'<span class="pill ok">提出済み</span>':'<span class="pill warn">未提出</span>'}`}
    </div>
    <p class="note">入力内容は自動保存されます（3-2 希望内容の確認・編集）。<br>
      希望休が無くても提出できます。変更していない日は「営業時間どおり（出勤可能・希望とも）」として提出されます。</p>
  </div>`;
}
function submitPref(uid){
  const s=DB.settings;
  const days=rangeDates(s.period_start,s.period_end);
  DB.employee_preferences[uid]=DB.employee_preferences[uid]||{};
  const p=DB.employee_preferences[uid];
  // 未入力の日は既定値（一括設定 or 営業時間）どおりの出勤可能時間・希望として補完（希望休なしでOK）
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
// 出勤可能時間・希望を一括設定：既定値として保存（次の期間にも自動で引き継がれる）＋ 今表示中の期間の全日（希望休を除く）に反映
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
  DB.default_availability[uid][group]={start,end,avail_start:availStart,avail_end:availEnd}; // 上書き保存（平日／土日を分けて保持。旧形式のstart/endが残っていても、こちらを優先して使う）
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
  if(list.length===0) return `<div class="card"><h2><span class="tag">3-3</span> シフト確認機能</h2>
    <div class="banner warn">🔒 シフトはまだ公開されていません。公開までお待ちください。</div></div>`;
  const period=list.find(pp=>pp.start+'_'+pp.end===myShiftPeriodKey) || defaultMyShiftPeriod(list);
  const newer=list.filter(pp=>pp.start>period.start); // 表示中より後の期間も公開されていれば知らせる
  const days=rangeDates(period.start,period.end);
  let totalBreakMin=0;
  const rows=days.map(d=>{
    const list=DB.shifts.filter(x=>x.user_id===u.id&&x.date===d).sort((a,b)=>toMin(a.start)-toMin(b.start));
    const p=(DB.employee_preferences[u.id]||{})[d];
    const brk=(DB.breaks||[]).find(b=>b.user_id===u.id&&b.date===d);
    if(brk) totalBreakMin+=toMin(brk.end)-toMin(brk.start);
    let cellTxt = list.length?list.map(x=>x.start+'〜'+x.end).join(' , '):(p&&p.day_off?'休み':'—');
    return `<tr><td>${fmtDate(d)}</td><td class="${list.length?'work':(p&&p.day_off?'off':'')}">${cellTxt}</td><td>${brk?brk.start+'〜'+brk.end:(list.length?'なし':'—')}</td></tr>`;
  }).join('');
  const totalH=DB.shifts.filter(x=>x.user_id===u.id&&x.date>=period.start&&x.date<=period.end)
    .reduce((a,x)=>a+(toMin(x.end)-toMin(x.start)),0)/60;
  return `<div class="card">
    <h2><span class="tag">3-3</span> 自分の勤務シフト（${u.name}）</h2>
    <div class="row">
      <label>表示する期間
        <select onchange="selectMyShiftPeriod(this.value)">
          ${list.map(pp=>`<option value="${pp.start}_${pp.end}" ${pp===period?'selected':''}>${fmtDate(pp.start)}〜${fmtDate(pp.end)}</option>`).join('')}
        </select>
      </label>
    </div>
    ${newer.length?`<div class="banner ok">📢 ${newer.map(pp=>`${fmtDate(pp.start)}〜${fmtDate(pp.end)}`).join('、')} のシフトも公開されています。上のプルダウンで切り替えられます。</div>`:''}
    <div class="banner ok">✅ 公開済み（${period.published_at||'日時不明'}）／ 合計（実働） ${totalH} 時間／ 休憩合計 ${totalBreakMin} 分</div>
    <div class="scroll"><table><tr><th>日付</th><th>勤務時間</th><th>休憩</th></tr>${rows}</table></div>
  </div>`;
}

render();
