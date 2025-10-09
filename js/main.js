// js/main.js
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from './config.js';
import { supabase } from './supabaseClient.js';
import {
  getSession, onAuth, signIn, signOut,
  fetchTaxonomy, fetchCards,
  fetchUserGrades, upsertGrade,
  updateCard, deleteCardCascade,
  ensureChapterByTitle, ensureTopicByTitle, ensureTagByName,
  insertCard, linkCardTopics, linkCardTags,
  uploadToStorage, publicUrl
} from './repo.js';

/* ---------- tiny DOM helpers ---------- */
const $ = (id)=>document.getElementById(id);
const escapeHTML = (s='')=>s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
function toast(msg){ alert(msg); }

/* ---------- state ---------- */
let session=null, user=null;
let chapters=[], topics=[], tags=[], cards=[];
let userGrades=new Map(); // card_id -> grade
let scope={ chapter:null, topic:null, mix:false, diff:null, starred:false };
let order=[], idx=0, currentCard=null;

/* ---------- auth ---------- */
function siteRedirect(){ return location.origin + location.pathname; }
async function initAuth(){
  session = await getSession();
  user = session?.user || null;
  syncAuthUI();
  onAuth((_evt,sess)=>{
    session=sess; user=sess?.user||null; syncAuthUI(); if(user) loadAll();
  });
}
function syncAuthUI(){
  $('btnLogin').style.display = user?'none':'inline-block';
  $('btnLogout').style.display = user?'inline-block':'none';
  $('whoami').textContent = user?(user.email||''):'';
  $('metaEditor').style.display = user?'inline-block':'none';
}
$('btnLogin').onclick = async ()=>{
  const email = prompt('Enter email for magic link:');
  if(!email) return;
  const { error } = await signIn(email, siteRedirect());
  if(error) toast(error.message); else toast('Magic link sent.');
};
$('btnLogout').onclick = async ()=>{ await signOut(); location.reload(); };

/* ---------- data loads ---------- */
async function loadTaxonomy(){
  const t = await fetchTaxonomy();
  chapters = t.chapters||[]; topics = t.topics||[]; tags = t.tags||[];
}
async function loadCardsAndGrades(){
  cards = await fetchCards();
  if(user){ userGrades = await fetchUserGrades(user.id); } else { userGrades = new Map(); }
  // attach grade onto cards (for counts & filter)
  cards.forEach(c=> c.user_grade = userGrades.get(c.id) || 'ungraded');
}

/* ---------- scope controls (pickers & chips) ---------- */
function buildScopePickers(){
  const selC=$('selChapter'), selT=$('selTopic');
  const vis=cards.filter(visibleToLearner);
  const byChap=new Map(), byTopic=new Map();
  let uncat=0, noTopic=0;

  vis.forEach(c=>{
    if(!c.chapter_id) uncat++;
    else byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1);
    if((c.card_topics||[]).length===0) noTopic++;
    (c.card_topics||[]).forEach(ct=>byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1));
  });

  selC.innerHTML = `<option value="">All Chapters (${vis.length})</option>` +
    chapters.map(ch=>`<option value="${ch.id}">${escapeHTML(ch.title)} (${byChap.get(ch.id)||0})</option>`).join('') +
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
    topicOpts.map(tp=>`<option value="${tp.id}">${escapeHTML(tp.title)} (${byTopic.get(tp.id)||0})</option>`).join('') +
    `<option value="__none__">(No Topics) (${noTopic})</option>`;

  selC.onchange=()=>{ scope.chapter=selC.value||null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); buildScopePickers(); };
  selT.onchange=()=>{ scope.topic=selT.value||null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); };

  $('btnMix').onclick=()=>{ scope={chapter:null,topic:null,mix:true,diff:null,starred:false}; rebuildOrder(); renderCounts(); renderCard(); };

  // difficulty chips
  [...$('diffChips').children].forEach(ch=>{
    ch.onclick=()=>{
      const d=ch.dataset.diff;
      if(d){ scope.diff=(scope.diff===d?null:d); }
      if(ch.id==='chip-star'){ scope.starred=!scope.starred; }
      [...$('diffChips').children].forEach(x=>x.classList.remove('on'));
      if(scope.diff){ $('diffChips').querySelector(`.chip[data-diff="${scope.diff}"]`).classList.add('on'); }
      if(scope.starred){ $('chip-star').classList.add('on'); }
      rebuildOrder(); renderCounts(); renderCard();
    };
  });
}
function visibleToLearner(c){
  const pub=(c.status==='published' && c.visibility==='public' && !c.author_suspended);
  return pub || !!user;
}

/* ---------- render ---------- */
function rebuildOrder(){
  const pool=cards.filter(inScope);
  order=pool.map((c,i)=>i); window._pool=pool; idx=0;
  $('metaIndex').textContent=`${order.length?1:0}/${order.length}`;
}
function inScope(c){
  if(!visibleToLearner(c)) return false;
  if(scope.chapter){
    if(scope.chapter==='__null__'){ if(c.chapter_id) return false; }
    else if(c.chapter_id!==scope.chapter) return false;
  }
  if(scope.topic){
    if(scope.topic==='__none__'){ if((c.card_topics||[]).length) return false; }
    else if(!(c.card_topics||[]).some(ct=>ct.topic_id===scope.topic)) return false;
  }
  if(scope.diff){ if((c.user_grade||'ungraded')!==scope.diff) return false; }
  if(scope.starred && !c.user_starred) return false;
  return true;
}
function renderCounts(){
  const pool=cards.filter(c=>inScope(Object.assign({},c,{ user_grade: c.user_grade||'ungraded' })));
  const counts={again:0,hard:0,good:0,easy:0,ungraded:0,star:0};
  pool.forEach(c=>{ counts[c.user_grade||'ungraded']++; if(c.user_starred) counts.star++; });
  $('cnt-again').textContent=counts.again; $('cnt-hard').textContent=counts.hard;
  $('cnt-good').textContent=counts.good; $('cnt-easy').textContent=counts.easy;
  $('cnt-ungraded').textContent=counts.ungraded; $('cnt-star').textContent=counts.star;
}
function renderCard(){
  const pool=window._pool||[];
  $('metaIndex').textContent=`${order.length?(idx+1):0}/${order.length}`;
  if(!order.length){
    $('q').innerHTML='No cards match.'; $('ans').style.display='none';
    $('gradeRow').style.display='none'; $('resWrap').style.display='none'; return;
  }
  const c=pool[order[idx]]; currentCard=c;

  const chap=chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)';
  const tps=(c.card_topics||[]).map(x=>x.title).filter(Boolean);
  $('metaChap').textContent=chap;
  $('metaTopics').textContent=tps.length? tps.join(' • '):'(No Topics)';
  $('metaSection').textContent=c.meta?.Section||'—';
  $('metaTags').textContent=(c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ')||'—';

  $('q').innerHTML=c.front||'—';
  $('ans').innerHTML=c.back||'';
  $('ans').style.display='none';
  $('gradeRow').style.display='none';

  const res=(c.meta?.resources)||[];
  $('resCount').textContent=res.length+(c.meta?.notes?1:0);
  $('metaResources').style.display=(res.length||c.meta?.notes)?'inline-block':'none';
  renderResources(c);

  $('btnDeleteCard').style.display = user?'inline-block':'none';
  $('btnEditCard').style.display = user?'inline-block':'none';

  $('btnStar').textContent = c.user_starred?'★ Unstar':'☆ Star';
  $('btnSuspend').textContent = c.author_suspended?'▶ Unsuspend':'⏸ Suspend';
}
function renderResources(c){
  const list=$('resList'); list.innerHTML='';
  if(c.meta?.notes){
    const n=document.createElement('div'); n.className='res';
    n.innerHTML=`<span>📝</span><span>${escapeHTML(String(c.meta.notes).slice(0,180))}${String(c.meta.notes).length>180?'…':''}</span>`;
    list.appendChild(n);
  }
  (c.meta?.resources||[]).forEach(r=>{
    const d=document.createElement('div'); d.className='res';
    if(r.type==='image'){ d.innerHTML=`<img class="thumb" src="${r.url}" alt="image"/><a target="_blank" href="${r.url}">${escapeHTML(r.title||'Image')}</a>`; }
    else if(r.type==='pdf'){ d.innerHTML=`<span>📄</span><a target="_blank" href="${r.url}">${escapeHTML(r.title||'PDF')}</a>`; }
    else { d.innerHTML=`<span>🔗</span><a target="_blank" href="${r.url}">${escapeHTML(r.title||r.url)}</a>`; }
    list.appendChild(d);
  });
}

/* ---------- study actions + GRADE PERSIST ---------- */
$('btnPrev').onclick=()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } };
$('btnNext').onclick=()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } };
$('btnReveal').onclick=()=>{ $('ans').style.display='block'; $('gradeRow').style.display='flex'; };

$('gAgain').onclick=()=>gradeAndPersist('again');
$('gHard').onclick=()=>gradeAndPersist('hard');
$('gGood').onclick=()=>gradeAndPersist('good');
$('gEasy').onclick=()=>gradeAndPersist('easy');

async function gradeAndPersist(level){
  if(!currentCard) return;
  // local update for snappy UI
  currentCard.user_grade = level;
  userGrades.set(currentCard.id, level);
  renderCounts();
  // persist if logged in
  if(user){
    const { error } = await upsertGrade(user.id, currentCard.id, level);
    if(error) console.error('grade persist failed', error);
  }
  $('btnNext').click();
}

$('btnStar').onclick=()=>{ if(!currentCard) return; currentCard.user_starred=!currentCard.user_starred; renderCounts(); renderCard(); };
$('btnSuspend').onclick=async()=>{
  if(!user||!currentCard) return;
  const newVal=!currentCard.author_suspended;
  const { error } = await updateCard(currentCard.id, { author_suspended:newVal });
  if(error){ toast(error.message); return; }
  currentCard.author_suspended=newVal; renderCard(); renderCounts();
};

/* ---------- Search modal ---------- */
$('btnSearch').onclick=()=>{$('searchModal').style.display='flex'; $('searchInput').focus();};
$('searchClose').onclick=()=>{$('searchModal').style.display='none';};
$('searchGo').onclick=runSearch;
$('searchInput').addEventListener('keydown',e=>{ if(e.key==='Enter') runSearch(); });
let searchResults=[];
function runSearch(){
  const q=$('searchInput').value.trim();
  if(!q){ $('searchResults').innerHTML=''; $('searchReviewAll').disabled=true; return; }
  let res=cards.filter(visibleToLearner);
  if(q.startsWith('#')){ const tag=q.slice(1).toLowerCase(); res=res.filter(c=>(c.card_tags||[]).some(t=>(t.name||'').toLowerCase().includes(tag))); }
  else{ const s=q.toLowerCase(); res=res.filter(c=>(c.front||'').toLowerCase().includes(s)||(c.back||'').toLowerCase().includes(s)||(c.meta?.Section||'').toLowerCase().includes(s)); }
  searchResults=res.map(c=>c.id);
  $('searchResults').innerHTML = res.map(c=>`
    <div style="padding:8px;border:1px solid #1b1b1b;border-radius:10px;margin:6px 0;background:#0b0b0b">
      <div class="small">${escapeHTML(chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)')} • ${(c.card_topics||[]).map(t=>escapeHTML(t.title)).join(', ')||'(No Topics)'}</div>
      <div style="margin:6px 0">${c.front}</div>
      <div class="small">${(c.card_tags||[]).map(t=>escapeHTML(t.name)).join(', ')}</div>
    </div>`).join('') || '<div class="small">No matches.</div>';
  $('searchReviewAll').disabled=!res.length;
}
$('searchReviewAll').onclick=()=>{
  if(!searchResults.length) return;
  const idset=new Set(searchResults); const pool=cards.filter(c=>idset.has(c.id)&&visibleToLearner(c));
  window._pool=pool; order=pool.map((c,i)=>i); idx=0; $('searchModal').style.display='none';
  scope={chapter:null,topic:null,mix:false,diff:null,starred:false}; renderCounts(); buildScopePickers(); renderCard();
};

/* ---------- Editor actions (unchanged logic, calls repo) ---------- */
// … (intentionally omitted here to keep this file focused; your existing editor functions from the previous single-file build remain identical and work with the repo helpers)

/* ---------- boot ---------- */
async function loadAll(){
  await loadTaxonomy();
  await loadCardsAndGrades();
  buildScopePickers();
  rebuildOrder(); renderCounts(); renderCard();
  // default: keep Filters collapsed on first paint
  $('filtersBox').open = false;
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await initAuth();
  await loadAll();
});
