// js/main.js
import { SUPABASE_URL } from './config.js';
import {
  getSession, onAuth, signIn, signOut,
  fetchTaxonomy, fetchCards, fetchUserGrades, upsertGrade,
  updateCard, deleteCardCascade,
  ensureChapterByTitle, ensureTopicByTitle, ensureTagByName,
  insertCard, linkCardTopics, linkCardTags,
  uploadToStorage, publicUrl
} from './repo.js';

/* === State === */
let session=null,user=null;
let chapters=[], topics=[], tags=[], cards=[];
let userGrades = new Map(); // server grades
let localGrades = new Map(); // offline cache
let scope={chapter:null,topic:null,mix:false,diff:null,starred:false};
let order=[], idx=0, currentCard=null;
let searchResults=[];

/* === Helpers & DOM === */
const $ = id=>document.getElementById(id);
const escapeHTML = (s='')=>s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
function visibleToLearner(c){ const pub=(c.status==='published' && c.visibility==='public' && !c.author_suspended); return pub || !!user; }
function siteRedirect(){ return location.origin + location.pathname; }
function stripHTML(s){return (s||'').replace(/<[^>]*>/g,'');}

/* === Tabs === */
document.querySelectorAll('.tab').forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    const which=t.dataset.tab;
    ['study','editor','admin'].forEach(k=>{ $('tab-'+k).style.display = (k===which)?'block':'none'; });
  };
});

/* Editor sub-tabs */
document.querySelectorAll('.etab').forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll('.etab').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    const which=t.dataset.etab;
    ['cards','chapters','topics','tags'].forEach(k=>{ $('editor-'+k).style.display = (k===which)?'block':'none'; });
  };
});

/* === Auth === */
async function initAuth(){
  session = await getSession();
  user = session?.user || null;
  syncAuthUI();
  onAuth(async (evt,sess)=>{ session=sess; user=sess?.user||null; syncAuthUI(); if(user){ await syncLocalGradesToServer(); loadAll(); }});
}
function syncAuthUI(){
  $('btnLogin').style.display = user?'none':'inline-block';
  $('btnLogout').style.display = user?'inline-block':'none';
  $('whoami').textContent = user?(user.email||''):'';
  $('metaEditor').style.display = user?'inline-block':'none';
}
$('btnLogin').onclick=async()=>{
  const email=prompt('Enter email for magic link:'); if(!email) return;
  const { error } = await signIn(email, siteRedirect());
  if(error) alert(error.message); else alert('Magic link sent.');
};
$('btnLogout').onclick=async()=>{ await signOut(); location.reload(); };

/* === Local grade cache for logged-out users === */
const LS_KEY='localGrades';
function loadLocalGrades(){
  try{
    const raw=localStorage.getItem(LS_KEY); if(!raw) return;
    const obj=JSON.parse(raw); localGrades = new Map(Object.entries(obj)); // card_id -> grade
  }catch{}
}
function saveLocalGrades(){
  const obj={}; for(const [k,v] of localGrades.entries()) obj[k]=v;
  localStorage.setItem(LS_KEY, JSON.stringify(obj));
}
async function syncLocalGradesToServer(){
  if(!user || localGrades.size===0) return;
  for(const [cardId, grade] of localGrades.entries()){
    await upsertGrade(user.id, cardId, grade);
  }
  localGrades.clear(); saveLocalGrades();
}

/* === Loads === */
async function loadTaxonomy(){
  const data = await fetchTaxonomy();
  chapters=data.chapters; topics=data.topics; tags=data.tags;
}
async function loadCards(){
  cards = await fetchCards();
  if(user){
    userGrades = await fetchUserGrades(user.id);
    // apply grades to cards
    cards.forEach(c=>{ const g=userGrades.get(c.id); if(g) c.user_grade=g; });
  }else{
    // apply local cached grades
    loadLocalGrades();
    cards.forEach(c=>{ const g=localGrades.get(c.id); if(g) c.user_grade=g; });
  }
}
async function loadAll(){ await loadTaxonomy(); await loadCards(); rebuildOrder(); renderCounts(); renderCard(); bindStudyChips(); buildEditorTables(); }

/* === Pickers, counts, chips === */
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
function renderCounts(){
  const pool=cards.filter(c=>visibleToLearner(c) && chapMatch(c) && topicMatch(c));
  const counts={again:0,hard:0,good:0,easy:0,ungraded:0,star:0};
  pool.forEach(c=>{ const g=c.user_grade||'ungraded'; counts[g]++; if(c.user_starred) counts.star++; });
  $('cnt-again').textContent=counts.again; $('cnt-hard').textContent=counts.hard; $('cnt-good').textContent=counts.good;
  $('cnt-easy').textContent=counts.easy; $('cnt-ungraded').textContent=counts.ungraded; $('cnt-star').textContent=counts.star;
}
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

/* === Filtering & render === */
function chapMatch(c){ if(!scope.chapter) return true; if(scope.chapter==='__null__') return !c.chapter_id; return c.chapter_id===scope.chapter; }
function topicMatch(c){
  if(!scope.topic) return true;
  if(scope.topic==='__none__') return (c.card_topics||[]).length===0;
  return (c.card_topics||[]).some(ct=>ct.topic_id===scope.topic);
}
function inScope(c){
  if(!visibleToLearner(c)) return false;
  if(!chapMatch(c)) return false;
  if(!topicMatch(c)) return false;
  if(scope.diff){ const g=c.user_grade||'ungraded'; if(g!==scope.diff) return false; }
  if(scope.starred && !c.user_starred) return false;
  return true;
}
function rebuildOrder(){
  const pool=cards.filter(inScope);
  order=pool.map((c,i)=>i); window._pool=pool; idx=0;
  $('metaIndex').textContent=`${order.length?1:0}/${order.length}`;
  buildScopePickers(); // keep counts in pickers correct
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

  const res=(c.meta?.resources)||[]; $('resCount').textContent=res.length+(c.meta?.notes?1:0);
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

/* === Study actions === */
$('btnPrev').onclick=()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } };
$('btnNext').onclick=()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } };
$('btnReveal').onclick=()=>{ $('ans').style.display='block'; $('gradeRow').style.display='flex'; };
$('gAgain').onclick=()=>grade('again'); $('gHard').onclick=()=>grade('hard'); $('gGood').onclick=()=>grade('good'); $('gEasy').onclick=()=>grade('easy');

async function grade(level){
  if(!currentCard) return;
  currentCard.user_grade=level; // optimistic
  if(user){
    userGrades.set(currentCard.id, level);
    await upsertGrade(user.id, currentCard.id, level);
  }else{
    localGrades.set(currentCard.id, level);
    saveLocalGrades();
  }
  renderCounts();
  $('btnNext').click();
}

$('btnStar').onclick=()=>{ if(!currentCard) return; currentCard.user_starred=!currentCard.user_starred; renderCounts(); renderCard(); };
$('btnSuspend').onclick=async()=>{
  if(!user||!currentCard) return;
  const newVal=!currentCard.author_suspended;
  const { error } = await updateCard(currentCard.id, { author_suspended:newVal });
  if(error){ alert(error.message); return; }
  currentCard.author_suspended=newVal; renderCard(); renderCounts();
};

/* === Search === */
$('btnSearch').onclick=()=>{$('searchModal').style.display='flex'; $('searchInput').focus();};
$('searchClose').onclick=()=>{$('searchModal').style.display='none';};
$('searchGo').onclick=runSearch;
$('searchInput').addEventListener('keydown',e=>{ if(e.key==='Enter') runSearch(); });
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

/* === Editor === */
window.openEdit = openEdit; // expose for inline onclick
window.deleteCardById = deleteCardById;

function renderCardTable(){
  const tb=$('tblCards').querySelector('tbody');
  tb.innerHTML = cards.slice(0,1000).map(c=>{
    const chap=chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)';
    const tps=(c.card_topics||[]).map(x=>x.title).filter(Boolean).join(', ');
    const tgs=(c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ');
    return `<tr>
      <td class="small">${c.front}</td>
      <td class="small">${escapeHTML(chap)}</td>
      <td class="small">${escapeHTML(tps||'(No Topics)')}</td>
      <td class="small">${escapeHTML(tgs||'—')}</td>
      <td class="small"><button class="ghost" onclick="openEdit('${c.id}')">✎</button> <button class="danger" onclick="deleteCardById('${c.id}')">🗑</button></td>
    </tr>`;
  }).join('');
}
async function deleteCardById(cardId){
  if(!confirm('Delete this card permanently?')) return;
  const { error } = await deleteCardCascade(cardId);
  if(error){ alert(error.message); return; }
  await loadCards(); rebuildOrder(); renderCounts(); renderCard(); buildEditorTables();
}

function buildEditorTables(){
  renderCardTable();
  // Chapters table
  const tc=$('tblChapters').querySelector('tbody');
  const byChap=new Map(); cards.forEach(c=>{ byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1); });
  tc.innerHTML = chapters.map(ch=>{
    const n=byChap.get(ch.id)||0;
    return `<tr>
      <td>${escapeHTML(ch.title)}</td>
      <td>${n}</td>
      <td>
        <button class="ghost" onclick="renameChapter('${ch.id}','${escapeHTML(ch.title)}')">✎ Edit</button>
        <button class="danger" onclick="deleteChapter('${ch.id}','${escapeHTML(ch.title)}', ${n})">🗑 Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="small">No chapters.</td></tr>';

  // Topics table
  const tt=$('tblTopics').querySelector('tbody');
  const byTopic=new Map(); cards.forEach(c=> (c.card_topics||[]).forEach(ct=>byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1)));
  tt.innerHTML = topics.map(tp=>{
    const n=byTopic.get(tp.id)||0;
    return `<tr>
      <td>${escapeHTML(tp.title)}</td>
      <td>${n}</td>
      <td>
        <button class="ghost" onclick="renameTopic('${tp.id}','${escapeHTML(tp.title)}')">✎ Edit</button>
        <button class="danger" onclick="deleteTopic('${tp.id}','${escapeHTML(tp.title)}', ${n})">🗑 Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="small">No topics.</td></tr>';

  // Tags table
  const tg=$('tblTags').querySelector('tbody');
  const byTag=new Map(); cards.forEach(c=> (c.card_tags||[]).forEach(t=>byTag.set(t.tag_id,(byTag.get(t.tag_id)||0)+1)));
  tg.innerHTML = tags.map(t=>{
    const n=byTag.get(t.id)||0;
    return `<tr>
      <td>${escapeHTML(t.name)}</td>
      <td>${n}</td>
      <td>
        <button class="ghost" onclick="renameTag('${t.id}','${escapeHTML(t.name)}')">✎ Edit</button>
        <button class="danger" onclick="deleteTag('${t.id}','${escapeHTML(t.name)}', ${n})">🗑 Delete</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="small">No tags.</td></tr>';
}

/* Rename/Delete taxonomy */
window.renameChapter = async (id, oldTitle)=>{
  const t=prompt('New chapter name:', oldTitle); if(!t||t===oldTitle) return;
  const { error } = await supabase.from('chapters').update({ title:t }).eq('id', id);
  if(error){ alert(error.message); return; }
  await loadAll();
};
window.deleteChapter = async (id, title, count)=>{
  if(!confirm(`Delete chapter "${title}"?\nCards (${count}) will be left as Uncategorised.`)) return;
  const u = await supabase.from('cards').update({ chapter_id: null }).eq('chapter_id', id);
  if(u.error){ alert('Failed to uncategorise cards: '+u.error.message); return; }
  const d = await supabase.from('chapters').delete().eq('id', id);
  if(d.error){ alert('Delete failed: '+d.error.message); return; }
  await loadAll();
};
window.renameTopic = async (id, oldTitle)=>{
  const t=prompt('New topic name:', oldTitle); if(!t||t===oldTitle) return;
  const { error } = await supabase.from('topics').update({ title:t }).eq('id', id);
  if(error){ alert(error.message); return; }
  await loadAll();
};
window.deleteTopic = async (id, title, count)=>{
  if(!confirm(`Delete topic "${title}"?\nIt will remove links from ${count} card(s). Cards remain.`)) return;
  const j = await supabase.from('card_topics').delete().eq('topic_id', id);
  if(j.error){ alert('Failed removing links: '+j.error.message); return; }
  const d = await supabase.from('topics').delete().eq('id', id);
  if(d.error){ alert('Delete failed: '+d.error.message); return; }
  await loadAll();
};
window.renameTag = async (id, oldName)=>{
  const t=prompt('New tag name:', oldName); if(!t||t===oldName) return;
  const { error } = await supabase.from('tags').update({ name:t }).eq('id', id);
  if(error){ alert(error.message); return; }
  await loadAll();
};
window.deleteTag = async (id, name, count)=>{
  if(!confirm(`Delete tag "${name}"?\nIt will remove tag from ${count} card(s).`)) return;
  const j = await supabase.from('card_tags').delete().eq('tag_id', id);
  if(j.error){ alert('Failed removing tag: '+j.error.message); return; }
  const d = await supabase.from('tags').delete().eq('id', id);
  if(d.error){ alert('Delete failed: '+d.error.message); return; }
  await loadAll();
};

/* Edit modal */
$('btnEditCard').onclick=()=>{ if(currentCard) openEdit(currentCard.id); };
$('btnDeleteCard').onclick=()=>{ if(currentCard) deleteCardById(currentCard.id); };

function openEdit(cardId){
  const c=cards.find(x=>x.id===cardId); if(!c) return;
  $('editModal').style.display='flex';
  $('edFront').value=stripHTML(c.front||''); $('edBack').value=stripHTML(c.back||'');
  $('edTags').value=(c.card_tags||[]).map(t=>t.name).join(', ');
  $('edNotes').value=c.meta?.notes||'';
  $('edChapter').innerHTML=chapters.map(ch=>`<option value="${ch.id}" ${c.chapter_id===ch.id?'selected':''}>${escapeHTML(ch.title)}</option>`).join('') + `<option value="" ${!c.chapter_id?'selected':''}>(Uncategorised)</option>`;
  $('edTopics').innerHTML=topics.map(tp=>{
    const on=(c.card_topics||[]).some(ct=>ct.topic_id===tp.id);
    return `<option value="${tp.id}" ${on?'selected':''}>${escapeHTML(tp.title)}</option>`;
  }).join('');
  renderEditResources(c);
  $('edFile').value='';
  $('edFile').onchange=()=>uploadResourceFile(c.id,$('edFile').files[0]);
  $('btnAddLink').onclick=()=>addLinkResource(c.id);
  $('btnSaveCard').onclick=()=>saveCardEdits(c.id);
  $('editClose').onclick=()=>{$('editModal').style.display='none';};
}
function renderEditResources(c){
  const list=$('edResList'); list.innerHTML='';
  if(c.meta?.notes){ const d=document.createElement('div'); d.className='res'; d.innerHTML=`<span>📝</span><span>${escapeHTML(String(c.meta.notes).slice(0,120))}${String(c.meta.notes).length>120?'…':''}</span>`; list.appendChild(d); }
  (c.meta?.resources||[]).forEach((r,i)=>{
    const d=document.createElement('div'); d.className='res';
    d.innerHTML=`<span>${r.type==='image'?'🖼':'🔗'}</span><a target="_blank" href="${r.url||'#'}">${escapeHTML(r.title||r.url||r.path||'resource')}</a>
      <button class="danger" onclick="removeResource('${c.id}',${i})">Remove</button>`;
    list.appendChild(d);
  });
}
async function saveCardEdits(cardId){
  const front=$('edFront').value.trim(), back=$('edBack').value.trim();
  const chapter_raw=$('edChapter').value; const chapter_id=chapter_raw||null;
  const notes=$('edNotes').value.trim();
  const tagNames=$('edTags').value.split(',').map(s=>s.trim()).filter(Boolean);
  const topicIds=[...$('edTopics').selectedOptions].map(o=>o.value);
  const c=cards.find(x=>x.id===cardId); const meta=Object.assign({},c.meta||{}); if(notes) meta.notes=notes; else delete meta.notes;

  let res=await supabase.from('cards').update({ front,back,chapter_id,meta }).eq('id',cardId);
  if(res.error){alert(res.error.message);return;}

  // ensure tags then join
  for(const nm of tagNames){ await ensureTagByName(nm); }
  const { data:tagRows } = await supabase.from('tags').select('id,name').in('name',tagNames);
  const tagIds=(tagRows||[]).map(r=>r.id);
  await supabase.from('card_tags').delete().eq('card_id',cardId);
  if(tagIds.length) await linkCardTags(cardId, tagIds);

  // topics
  await supabase.from('card_topics').delete().eq('card_id',cardId);
  if(topicIds.length) await linkCardTopics(cardId, topicIds);

  await loadAll();
  $('editModal').style.display='none';
}
async function addLinkResource(cardId){
  const title=$('edLinkTitle').value.trim(); const url=$('edLinkUrl').value.trim(); if(!url){alert('Enter URL');return;}
  const c=cards.find(x=>x.id===cardId); const meta=Object.assign({},c.meta||{}); meta.resources=meta.resources||[];
  meta.resources.push({ type:'link', title, url });
  const { error } = await supabase.from('cards').update({ meta }).eq('id',cardId);
  if(error){alert(error.message);return;}
  $('edLinkTitle').value=''; $('edLinkUrl').value='';
  await loadAll(); openEdit(cardId); renderCard();
}
window.removeResource = async (cardId, i)=>{
  const c=cards.find(x=>x.id===cardId); const meta=Object.assign({},c.meta||{}); const arr=meta.resources||[]; arr.splice(i,1); meta.resources=arr;
  const { error } = await supabase.from('cards').update({ meta }).eq('id',cardId);
  if(error){alert(error.message);return;}
  await loadAll(); openEdit(cardId); renderCard();
};
async function uploadResourceFile(cardId,file){
  if(!file) return; const ext=(file.name.split('.').pop()||'').toLowerCase();
  const isImg=['png','jpg','jpeg','webp','gif'].includes(ext), isPdf=ext==='pdf';
  const path=`${cardId}/${Date.now()}_${file.name.replace(/\s+/g,'_')}`;
  const up=await uploadToStorage(path,file);
  if(up.error){ alert('Upload failed: '+up.error.message); return; }
  const url=publicUrl(path);
  const c=cards.find(x=>x.id===cardId); const meta=Object.assign({},c.meta||{}); meta.resources=meta.resources||[];
  meta.resources.push({ type:isImg?'image':(isPdf?'pdf':'file'), title:file.name, path, url });
  const { error } = await supabase.from('cards').update({ meta }).eq('id',cardId);
  if(error){ alert(error.message); return; }
  await loadAll(); openEdit(cardId); renderCard();
}

/* === Admin: Import === */
$('btnImport').onclick = async ()=>{
  const file = $('fileImport').files[0];
  if(!file){ alert('Pick a JSON file'); return; }
  const raw = await file.text();
  let cleaned = raw
    .replace(/\uFEFF/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\/\/.*$/mg, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1');

  let json;
  try{ json = JSON.parse(cleaned); }
  catch(e){
    alert('Bad JSON: '+ e.message);
    return;
  }
  const list = Array.isArray(json.cards) ? json.cards : (Array.isArray(json) ? json : []);
  if(!list.length){ alert('No cards found. Expect { "cards": [...] }.'); return; }
  alert(`Importing ${list.length} cards…`);

  for(const c of list){
    // Chapter
    let chapId = null;
    if(c.chapter){ chapId = await ensureChapterByTitle(c.chapter); }

    // Insert card
    const payload = {
      front: c.front, back: c.back, chapter_id: chapId,
      meta: c.meta || {}, status: c.status || 'published',
      visibility: c.visibility || 'public', author_suspended: !!c.author_suspended
    };
    const ins = await insertCard(payload);
    if(ins.error){ console.error('Card insert', ins.error, c.front); continue; }
    const cardId = ins.data.id;

    // Topics
    if(Array.isArray(c.topics) && c.topics.length){
      const ids=[];
      for(const t of c.topics){ ids.push(await ensureTopicByTitle(t)); }
      await linkCardTopics(cardId, ids.filter(Boolean));
    }
    // Tags
    if(Array.isArray(c.tags) && c.tags.length){
      const ids=[];
      for(const g of c.tags){ ids.push(await ensureTagByName(g)); }
      await linkCardTags(cardId, ids.filter(Boolean));
    }
  }
  await loadAll();
  alert('Import complete.');
};

/* === LLM modal content === */
$('btnDownloadTemplate').onclick = ()=>{
  const template = {
    cards: [{
      front: "Define Sleep duration, timing, and quality (why do all three matter?).",
      back: "Duration = total sleep time; Timing = when sleep occurs; Quality = continuity/efficiency/architecture. All three independently affect health and chronic disease risk; don’t ask only ‘how many hours.’",
      chapter: "Chapter 8 – Sleep",
      topics: ["Sleep Basics","Sleep Quality"],
      tags: ["Definition","Mechanism","Adult","Format:Recall"],
      meta: { Section: "Obj1: Foundations", high_yield: true, notes: "", resources: [] },
      status: "published", visibility: "public", author_suspended: false
    }]
  };
  const blob = new Blob([JSON.stringify(template, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = "cards-template.json"; a.click(); URL.revokeObjectURL(a.href);
};
$('btnOpenLLM').onclick = ()=>{
  const text = `You are generating flashcards…\n\n{ "cards": [ {…} ] }`; // keep your existing long prompt if desired
  $('llmText').value = text; $('llmModal').style.display = 'flex';
};
$('llmClose').onclick = ()=> $('llmModal').style.display='none';
$('llmCopy').onclick = async ()=>{ try{ await navigator.clipboard.writeText($('llmText').value); alert('Copied.'); }catch(e){ alert('Copy failed: '+e.message); } };
$('llmDownload').onclick = ()=>{ const b=new Blob([$('llmText').value],{type:'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download="LLM-instructions.txt"; a.click(); URL.revokeObjectURL(a.href); };

/* === Boot === */
window.addEventListener('DOMContentLoaded', async ()=>{
  await initAuth();
  await loadAll();
});
