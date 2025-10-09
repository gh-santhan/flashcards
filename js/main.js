import { EMAIL_REDIRECT } from './config.js';
import { supabase } from './supabaseClient.js';
import {
  getSession, onAuth, sendMagicLink, signOut,
  fetchTaxonomy, fetchCards, fetchUserGrades, upsertGrade,
  setSuspend, ensureChapter, ensureTopic, ensureTag, insertCard, linkTopics, linkTags
} from './repo.js';

/* --- Tiny helpers --- */
const $ = id=>document.getElementById(id);
const escapeHTML = (s='')=>s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
function stripHTML(s){return (s||'').replace(/<[^>]*>/g,'');}

/* --- State --- */
let session=null,user=null;
let chapters=[], topics=[], tags=[], cards=[];
let grades = new Map(); // cardId -> grade
let scope={chapter:null,topic:null,mix:false,diff:null,starred:false};
let order=[], idx=0, currentCard=null;

/* --- Auth UI --- */
function syncAuthUI(){
  $('btnLogin').style.display = user?'none':'inline-block';
  $('btnLogout').style.display = user?'inline-block':'none';
  $('whoami').textContent = user?(user.email||''):'';
  $('metaEditor').style.display = user?'inline-block':'none';
}

/* --- Init auth --- */
async function initAuth(){
  session = await getSession(); user = session?.user||null; syncAuthUI();
  onAuth(async (_evt,sess)=>{
    session=sess; user=sess?.user||null; syncAuthUI();
    await loadAll();
  });
}
$('btnLogin').onclick = async ()=>{
  const email = prompt('Enter email for magic link:'); if(!email) return;
  const { error } = await sendMagicLink(email, EMAIL_REDIRECT);
  if(error) alert(error.message); else alert('Magic link sent.');
};
$('btnLogout').onclick = async ()=>{ await signOut(); location.reload(); };

/* --- Data loads --- */
async function loadAll(){
  const tax = await fetchTaxonomy(); chapters=tax.chapters; topics=tax.topics; tags=tax.tags;
  cards = await fetchCards();
  grades = await fetchUserGrades(user?.id);
  // apply grades to card objects for UI filters
  cards.forEach(c=>{ c.user_grade = grades.get(c.id) || 'ungraded'; });
  buildScopePickers(); rebuildOrder(); renderCounts(); renderCard(); bindStudyChips(); buildEditorTables();
}

/* --- Pickers / counts (same as your working code, trimmed) --- */
function buildScopePickers(){
  const selC=$('selChapter'), selT=$('selTopic');
  const vis=cards.filter(visibleToLearner);
  const byChap=new Map(), byTopic=new Map();
  let uncat=0, noTopic=0;
  vis.forEach(c=>{
    if(!c.chapter_id) uncat++; else byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1);
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
}
function visibleToLearner(c){ const pub=(c.status==='published' && c.visibility==='public' && !c.author_suspended); return pub || !!user; }
function chapMatch(c){ if(!scope.chapter) return true; if(scope.chapter==='__null__') return !c.chapter_id; return c.chapter_id===scope.chapter; }
function topicMatch(c){ if(!scope.topic) return true; if(scope.topic==='__none__') return (c.card_topics||[]).length===0; return (c.card_topics||[]).some(ct=>ct.topic_id===scope.topic); }
function bindStudyChips(){
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
function renderCounts(){
  const pool=cards.filter(c=>visibleToLearner(c) && chapMatch(c) && topicMatch(c));
  const counts={again:0,hard:0,good:0,easy:0,ungraded:0,star:0};
  pool.forEach(c=>{ const g=c.user_grade||'ungraded'; counts[g]++; if(c.user_starred) counts.star++; });
  $('cnt-again').textContent=counts.again; $('cnt-hard').textContent=counts.hard; $('cnt-good').textContent=counts.good;
  $('cnt-easy').textContent=counts.easy; $('cnt-ungraded').textContent=counts.ungraded; $('cnt-star').textContent=counts.star;
}
function inScope(c){
  if(!visibleToLearner(c)) return false;
  if(!chapMatch(c)) return false;
  if(!topicMatch(c)) return false;
  if(scope.diff){ const g=c.user_grade||'ungraded'; if(g!==scope.diff) return false; }
  if(scope.starred && !c.user_starred) return false;
  return true;
}
function rebuildOrder(){ const pool=cards.filter(inScope); window._pool=pool; order=pool.map((c,i)=>i); idx=0; $('metaIndex').textContent=`${order.length?1:0}/${order.length}`; }

/* --- Render a card --- */
function renderCard(){
  const pool=window._pool||[];
  $('metaIndex').textContent=`${order.length?(idx+1):0}/${order.length}`;
  if(!order.length){ $('q').innerHTML='No cards match.'; $('ans').style.display='none'; $('gradeRow').style.display='none'; $('resWrap').style.display='none'; return; }
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

  const res=(c.meta?.resources)||[]; $('resCount').textContent=res.length+(c.meta?.notes?1:0);
  $('metaResources').style.display=(res.length||c.meta?.notes)?'inline-block':'none';

  $('btnDeleteCard').style.display = user?'inline-block':'none';
  $('btnEditCard').style.display = user?'inline-block':'none';

  $('btnStar').textContent = c.user_starred?'★ Unstar':'☆ Star';
  $('btnSuspend').textContent = c.author_suspended?'▶ Unsuspend':'⏸ Suspend';
}

/* --- Study actions + persistent grade --- */
$('btnPrev').onclick=()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } };
$('btnNext').onclick=()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } };
$('btnReveal').onclick=()=>{ $('ans').style.display='block'; $('gradeRow').style.display='flex'; };
$('gAgain').onclick=()=>grade('again');
$('gHard').onclick=()=>grade('hard');
$('gGood').onclick=()=>grade('good');
$('gEasy').onclick=()=>grade('easy');

async function grade(level){
  if(!currentCard) return;
  currentCard.user_grade=level;
  if(user){ await upsertGrade(user.id, currentCard.id, level); }
  renderCounts();
  $('btnNext').click();
}

/* --- Suspend --- */
$('btnSuspend').onclick=async()=>{
  if(!user||!currentCard) return;
  const newVal=!currentCard.author_suspended;
  const { error } = await setSuspend(currentCard.id, newVal);
  if(error){ alert(error.message); return; }
  currentCard.author_suspended=newVal; renderCard(); renderCounts();
};

/* --- (Editor & Import code: reuse your working functions or keep as in previous file) --- */

/* --- Boot --- */
window.addEventListener('DOMContentLoaded', async ()=>{
  await initAuth();
  await loadAll();
});
