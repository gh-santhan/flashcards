// main.js — hardened boot (no DOM binding crashes)
// Imports
import { supabase } from './supabaseClient.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from './config.js';
import {
  fetchTaxonomy, fetchCards,
  fetchUserGrades, upsertGrade,
  saveCardMeta, unlinkResourcesForCard,
  ensureChapterByTitle, ensureTopicsByTitles, ensureTagsByNames,
  deleteCardRecord, listCardsByChapter, listCardsByTopic
} from './repo.js';

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const on = (id, evt, fn) => {
  const el = $(id);
  if (!el) {
    console.warn(`[bind] #${id} not found; skipped ${evt} binding`);
    return { ok: false };
  }
  el.addEventListener(evt, fn);
  return { ok: true, el };
};
const setText = (id, s='') => { const el = $(id); if (el) el.textContent = s; };
const show = (id, yes) => { const el = $(id); if (el) el.style.display = yes ? '' : 'none'; };

// ---------- app state ----------
let session = null, user = null;
let chapters = [], topics = [], tags = [], cards = [];
let grades = new Map(); // card_id -> grade
let scope = { chapter:null, topic:null, mix:false, diff:null, starred:false };
let order = [], idx = 0, pool = [], currentCard = null;
let searchIds = [];

// ---------- auth ----------
function siteRedirect() { return location.origin + location.pathname; }

async function initAuth() {
  const { data: { session: s } } = await supabase.auth.getSession();
  session = s; user = s?.user ?? null;
  syncAuthUI();

  supabase.auth.onAuthStateChange((_evt, sess) => {
    session = sess; user = sess?.user ?? null;
    syncAuthUI();
    if (user) initializeData(); // safe to reload data when login completes
  });
}

function syncAuthUI() {
  show('btnLogin', !user);
  show('btnLogout', !!user);
  setText('whoami', user ? (user.email || '') : '');
  const metaEditor = $('metaEditor');
  if (metaEditor) metaEditor.style.display = user ? 'inline-block' : 'none';
}

function bindAuthButtons() {
  on('btnLogin','click', async () => {
    const email = prompt('Enter email for magic link:');
    if (!email) return;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: siteRedirect() }
    });
    if (error) alert(error.message); else alert('Magic link sent. Check your inbox.');
  });

  on('btnLogout','click', async () => {
    await supabase.auth.signOut();
    location.reload();
  });
}

// ---------- data loads ----------
async function initializeData() {
  // taxonomy
  const t = await fetchTaxonomy();
  chapters = t.chapters; topics = t.topics; tags = t.tags;

  // cards
  cards = await fetchCards();

  // user grades (safe if logged out)
  grades = new Map();
  if (user) grades = await fetchUserGrades(user.id);

  // hydrate user fields from grades
  cards.forEach(c => {
    c.user_grade = grades.get(c.id) || null;
  });

  buildScopePickers();
  rebuildOrder();
  renderCounts();
  renderCard();
  buildEditorTablesSafe(); // won't throw if editor tables don’t exist
}

// ---------- scope & counts ----------
function visibleToLearner(c){
  const pub = (c.status === 'published' && c.visibility === 'public' && !c.author_suspended);
  return pub || !!user;
}
function chapMatch(c){ if(!scope.chapter) return true; if(scope.chapter==='__null__') return !c.chapter_id; return c.chapter_id===scope.chapter; }
function topicMatch(c){
  if(!scope.topic) return true;
  if(scope.topic==='__none__') return (c.card_topics||[]).length===0;
  return (c.card_topics||[]).some(ct=>ct.topic_id===scope.topic);
}
function inScope(c){
  if(!visibleToLearner(c)) return false;
  if(!chapMatch(c) || !topicMatch(c)) return false;
  if(scope.diff){ const g=c.user_grade||'ungraded'; if(g!==scope.diff) return false; }
  if(scope.starred && !c.user_starred) return false;
  return true;
}

function buildScopePickers(){
  const selC = $('selChapter'), selT = $('selTopic');
  if(!selC || !selT) return;

  const vis = cards.filter(visibleToLearner);
  const byChap = new Map(), byTopic = new Map();
  let uncat=0, noTopic=0;

  vis.forEach(c=>{
    if(!c.chapter_id) uncat++;
    else byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1);
    if((c.card_topics||[]).length===0) noTopic++;
    (c.card_topics||[]).forEach(ct => byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1));
  });

  selC.innerHTML = `<option value="">All Chapters (${vis.length})</option>` +
    chapters.map(ch=>`<option value="${ch.id}">${escapeHtml(ch.title)} (${byChap.get(ch.id)||0})</option>`).join('') +
    `<option value="__null__">(Uncategorised) (${uncat})</option>`;

  const chapVal = selC.value || scope.chapter;
  let topicOpts = topics;
  if(chapVal && chapVal!=="__null__"){
    const tset=new Set();
    vis.filter(c=>c.chapter_id===chapVal).forEach(c=>(c.card_topics||[]).forEach(ct=>tset.add(ct.topic_id)));
    topicOpts = topics.filter(t=>tset.has(t.id));
    noTopic = vis.filter(c=>c.chapter_id===chapVal && (c.card_topics||[]).length===0).length;
  }

  selT.innerHTML = `<option value="">All Topics</option>` +
    topicOpts.map(tp=>`<option value="${tp.id}">${escapeHtml(tp.title)} (${byTopic.get(tp.id)||0})</option>`).join('') +
    `<option value="__none__">(No Topics) (${noTopic})</option>`;

  selC.onchange = ()=>{ scope.chapter = selC.value || null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); buildScopePickers(); };
  selT.onchange = ()=>{ scope.topic = selT.value || null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); };
  const btnMix = $('btnMix');
  if (btnMix) btnMix.onclick = ()=>{ scope={chapter:null,topic:null,mix:true,diff:null,starred:false}; rebuildOrder(); renderCounts(); renderCard(); };
  bindDiffChips();
}

function bindDiffChips(){
  const wrap = $('diffChips'); if(!wrap) return;
  [...wrap.children].forEach(ch=>{
    ch.onclick=()=>{
      const d=ch.dataset.diff;
      if(d){ scope.diff=(scope.diff===d?null:d); }
      if(ch.id==='chip-star'){ scope.starred=!scope.starred; }
      [...wrap.children].forEach(x=>x.classList.remove('on'));
      if(scope.diff){ wrap.querySelector(`.chip[data-diff="${scope.diff}"]`)?.classList.add('on'); }
      if(scope.starred){ $('chip-star')?.classList.add('on'); }
      rebuildOrder(); renderCounts(); renderCard();
    };
  });
}

function renderCounts(){
  const poolX = cards.filter(c=>inScope(c));
  const counts = { again:0, hard:0, good:0, easy:0, ungraded:0, star:0 };
  poolX.forEach(c=>{
    const g = c.user_grade || 'ungraded';
    if (counts[g] !== undefined) counts[g]++;
    if (c.user_starred) counts.star++;
  });
  setText('cnt-again', counts.again);
  setText('cnt-hard', counts.hard);
  setText('cnt-good', counts.good);
  setText('cnt-easy', counts.easy);
  setText('cnt-ungraded', counts.ungraded);
  setText('cnt-star', counts.star);
}

function rebuildOrder(){
  pool = cards.filter(c=>inScope(c));
  order = pool.map((_,i)=>i);
  idx = 0;
  setText('metaIndex', `${order.length?1:0}/${order.length}`);
}

// ---------- rendering ----------
function renderCard(){
  setText('metaIndex', `${order.length?(idx+1):0}/${order.length}`);
  const qEl = $('q'), ansEl = $('ans'), gradeRow = $('gradeRow');
  if(!order.length){
    if(qEl) qEl.innerHTML='No cards match.';
    if(ansEl) ansEl.style.display='none';
    if(gradeRow) gradeRow.style.display='none';
    show('resWrap', false);
    return;
  }
  const c = pool[order[idx]]; currentCard = c;

  const chapTitle = chapters.find(x=>x.id===c.chapter_id)?.title || '(Uncategorised)';
  setText('metaChap', chapTitle);
  const tps = (c.card_topics||[]).map(x=>x.title).filter(Boolean);
  setText('metaTopics', tps.length ? tps.join(' • ') : '(No Topics)');
  setText('metaSection', c.meta?.Section || '—');
  setText('metaTags', (c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ') || '—');

  if(qEl) qEl.innerHTML = c.front || '—';
  if(ansEl) { ansEl.innerHTML = c.back || ''; ansEl.style.display = 'none'; }
  if(gradeRow) gradeRow.style.display='none';

  // resources
  const resources = c.meta?.resources || [];
  const resCount = (c.meta?.notes ? 1 : 0) + resources.length;
  setText('resCount', String(resCount));
  show('metaResources', !!resCount);
  renderResources(c);

  const del = $('btnDeleteCard'), edit = $('btnEditCard');
  if (del) del.style.display = user ? 'inline-block' : 'none';
  if (edit) edit.style.display = user ? 'inline-block' : 'none';

  const starBtn = $('btnStar'), suspBtn = $('btnSuspend');
  if (starBtn) starBtn.textContent = c.user_starred ? '★ Unstar' : '☆ Star';
  if (suspBtn) suspBtn.textContent = c.author_suspended ? '▶ Unsuspend' : '⏸ Suspend';
}

function renderResources(c){
  const list = $('resList'); if(!list) return;
  list.innerHTML='';
  if (c.meta?.notes){
    const d=document.createElement('div'); d.className='res';
    d.innerHTML = `<span>📝</span><span>${escapeHtml(String(c.meta.notes).slice(0,180))}${String(c.meta.notes).length>180?'…':''}</span>`;
    list.appendChild(d);
  }
  (c.meta?.resources||[]).forEach(r=>{
    const d=document.createElement('div'); d.className='res';
    if(r.type==='image'){
      d.innerHTML = `<img class="thumb" src="${r.url}" alt="image"/><a target="_blank" href="${r.url}">${escapeHtml(r.title||'Image')}</a>`;
    } else if(r.type==='pdf'){
      d.innerHTML = `<span>📄</span><a target="_blank" href="${r.url}">${escapeHtml(r.title||'PDF')}</a>`;
    } else {
      d.innerHTML = `<span>🔗</span><a target="_blank" href="${r.url}">${escapeHtml(r.title||r.url)}</a>`;
    }
    list.appendChild(d);
  });
}

// ---------- study actions ----------
function bindStudyButtons(){
  on('btnPrev','click', ()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } });
  on('btnNext','click', ()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } });
  on('btnReveal','click', ()=>{
    const ans=$('ans'), row=$('gradeRow'); if(ans) ans.style.display='block'; if(row) row.style.display='flex';
  });
  on('gAgain','click', ()=>grade('again'));
  on('gHard','click', ()=>grade('hard'));
  on('gGood','click', ()=>grade('good'));
  on('gEasy','click', ()=>grade('easy'));
  on('btnStar','click', ()=>{ if(!currentCard) return; currentCard.user_starred=!currentCard.user_starred; renderCounts(); renderCard(); });
  on('btnSuspend','click', async ()=>{
    if(!user || !currentCard) return;
    const newVal = !currentCard.author_suspended;
    const { error } = await supabase.from('cards').update({ author_suspended:newVal }).eq('id', currentCard.id);
    if(error){ alert(error.message); return; }
    currentCard.author_suspended = newVal; renderCard(); renderCounts();
  });
}

async function grade(level){
  if(!currentCard || !user) { renderCounts(); return; }
  currentCard.user_grade = level;
  grades.set(currentCard.id, level);
  await upsertGrade(user.id, currentCard.id, level); // persist
  renderCounts();
  $('btnNext')?.click();
}

// ---------- search (hardened) ----------
function bindSearch(){
  const modal = $('searchModal');
  if(!modal){ console.warn('[search] modal not found; search disabled'); return; }

  on('btnSearch','click', ()=>{ modal.style.display='flex'; $('searchInput')?.focus(); });
  on('searchClose','click', ()=>{ modal.style.display='none'; });
  on('searchGo','click', runSearch);

  const inp = $('searchInput');
  if (inp) inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter') runSearch(); });

  on('searchReviewAll','click', ()=>{
    if(!searchIds.length) return;
    const idset = new Set(searchIds);
    pool = cards.filter(c=>idset.has(c.id) && visibleToLearner(c));
    order = pool.map((_,i)=>i); idx=0; modal.style.display='none';
    scope = { chapter:null, topic:null, mix:false, diff:null, starred:false };
    renderCounts(); buildScopePickers(); renderCard();
  });
}

function runSearch(){
  const out = $('searchResults'); if(!out) return;
  const q = ($('searchInput')?.value || '').trim();
  if(!q){ out.innerHTML=''; const btn=$('searchReviewAll'); if(btn) btn.disabled=true; searchIds=[]; return; }

  let res = cards.filter(visibleToLearner);
  if(q.startsWith('#')){
    const tag = q.slice(1).toLowerCase();
    res = res.filter(c=>(c.card_tags||[]).some(t=>(t.name||'').toLowerCase().includes(tag)));
  } else {
    const s = q.toLowerCase();
    res = res.filter(c=>(c.front||'').toLowerCase().includes(s) ||
                        (c.back||'').toLowerCase().includes(s)  ||
                        (c.meta?.Section||'').toLowerCase().includes(s));
  }
  searchIds = res.map(c=>c.id);
  out.innerHTML = res.map(c=>`
    <div style="padding:8px;border:1px solid #1b1b1b;border-radius:10px;margin:6px 0;background:#0b0b0b">
      <div class="small">${escapeHtml(chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)')} • ${(c.card_topics||[]).map(t=>escapeHtml(t.title)).join(', ')||'(No Topics)'}</div>
      <div style="margin:6px 0">${c.front}</div>
      <div class="small">${(c.card_tags||[]).map(t=>escapeHtml(t.name)).join(', ')}</div>
    </div>
  `).join('') || '<div class="small">No matches.</div>';

  const btn = $('searchReviewAll');
  if (btn) btn.disabled = !res.length;
}

// ---------- editor (safe) ----------
function buildEditorTablesSafe(){
  // If the editor tab/elements aren’t present, do nothing—prevents crashes on public build.
  if (!$('tblCards')) return;

  // Minimal list (avoid heavy DOM if many cards)
  const tb = $('tblCards').querySelector('tbody');
  tb.innerHTML = cards.slice(0,1000).map(c=>{
    const chap = chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)';
    const tps  = (c.card_topics||[]).map(x=>x.title).filter(Boolean).join(', ');
    const tgs  = (c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ');
    return `<tr>
      <td class="small">${c.front}</td>
      <td class="small">${escapeHtml(chap)}</td>
      <td class="small">${escapeHtml(tps||'(No Topics)')}</td>
      <td class="small">${escapeHtml(tgs||'—')}</td>
      <td class="small"><button class="ghost" data-eid="${c.id}" data-act="edit">✎</button>
                        <button class="danger" data-did="${c.id}" data-act="del">🗑</button></td>
    </tr>`;
  }).join('');

  // Chapters table
  const tc = $('tblChapters')?.querySelector('tbody');
  if (tc){
    const byChap=new Map(); cards.forEach(c=>{ byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1); });
    tc.innerHTML = chapters.map(ch=>{
      const n=byChap.get(ch.id)||0;
      return `<tr>
        <td>${escapeHtml(ch.title)}</td>
        <td>${n}</td>
        <td><button class="ghost" data-ch="${ch.id}" data-act="ch-edit">✎</button>
            <button class="danger" data-ch="${ch.id}" data-act="ch-del">🗑</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No chapters.</td></tr>';
  }

  // Topics table
  const tt = $('tblTopics')?.querySelector('tbody');
  if (tt){
    const byTopic=new Map(); cards.forEach(c=>(c.card_topics||[]).forEach(ct=>byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1)));
    tt.innerHTML = topics.map(tp=>{
      const n=byTopic.get(tp.id)||0;
      return `<tr>
        <td>${escapeHtml(tp.title)}</td>
        <td>${n}</td>
        <td><button class="ghost" data-tp="${tp.id}" data-act="tp-edit">✎</button>
            <button class="danger" data-tp="${tp.id}" data-act="tp-del">🗑</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No topics.</td></tr>';
  }

  // Tags table
  const tg = $('tblTags')?.querySelector('tbody');
  if (tg){
    const byTag=new Map(); cards.forEach(c=>(c.card_tags||[]).forEach(t=>byTag.set(t.tag_id,(byTag.get(t.tag_id)||0)+1)));
    tg.innerHTML = tags.map(t=>{
      const n=byTag.get(t.id)||0;
      return `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${n}</td>
        <td><button class="ghost" data-g="${t.id}" data-act="tg-edit">✎</button>
            <button class="danger" data-g="${t.id}" data-act="tg-del">🗑</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No tags.</td></tr>';
  }
}

// ---------- misc ----------
function escapeHtml(s=''){ return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ---------- boot ----------
async function boot(){
  try{
    bindAuthButtons();
    bindStudyButtons();
    bindSearch(); // now safe: won’t throw if elements are missing
    await initAuth();
    await initializeData();
  }catch(err){
    console.error('[boot] fatal error', err);
    alert('App failed to initialize. See console for details.');
  }
}

window.addEventListener('DOMContentLoaded', boot);
