// main.js — hardened boot + tabs + editor actions
import { supabase } from './supabaseClient.js';
import {
  fetchTaxonomy, fetchCards,
  fetchUserGrades, upsertGrade,
  saveCardMeta, unlinkResourcesForCard,
  ensureChapterByTitle, ensureTopicsByTitles, ensureTagsByNames,
  deleteCardRecord, listCardsByChapter, listCardsByTopic
} from './repo.js';

// ------- tiny helpers -------
const $ = (id) => document.getElementById(id);
const on = (id, evt, fn) => {
  const el = $(id);
  if (!el) { console.warn(`[bind] #${id} missing; skipped ${evt}`); return { ok:false }; }
  el.addEventListener(evt, fn);
  return { ok:true, el };
};
const setText = (id, s='') => { const el = $(id); if (el) el.textContent = s; };
const show = (id, yes) => { const el = $(id); if (el) el.style.display = yes ? '' : 'none'; };
const escapeHtml = (s='') => s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// ------- app state -------
let session=null,user=null;
let chapters=[], topics=[], tags=[], cards=[];
let grades=new Map();
let scope={chapter:null,topic:null,mix:false,diff:null,starred:false};
let order=[], idx=0, pool=[], currentCard=null;
let searchIds=[];

// ------- auth -------
function siteRedirect(){ return location.origin + location.pathname; }
async function initAuth(){
  const { data:{ session:s } } = await supabase.auth.getSession();
  session=s; user=s?.user??null; syncAuthUI();
  supabase.auth.onAuthStateChange((_evt,sess)=>{ session=sess; user=sess?.user??null; syncAuthUI(); if(user) initializeData(); });
}
function syncAuthUI(){
  show('btnLogin', !user);
  show('btnLogout', !!user);
  setText('whoami', user ? (user.email||'') : '');
  const metaEditor=$('metaEditor'); if(metaEditor) metaEditor.style.display = user?'inline-block':'none';
}
function bindAuthButtons(){
  on('btnLogin','click', async ()=>{
    const email=prompt('Enter email for magic link:'); if(!email) return;
    const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: siteRedirect() }});
    if(error) alert(error.message); else alert('Magic link sent.');
  });
  on('btnLogout','click', async ()=>{ await supabase.auth.signOut(); location.reload(); });
}

// ------- tabs (Study / Editor / Admin) -------
function bindTabs(){
  const tabsWrap = document.getElementById('headerTabs');
  if(!tabsWrap){ console.warn('[tabs] headerTabs not found'); return; }
  tabsWrap.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>{
      tabsWrap.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
      t.classList.add('on');
      const which=t.dataset.tab;
      ['study','editor','admin'].forEach(k=>{
        const sec=$('tab-'+k);
        if(sec) sec.style.display = (k===which)?'block':'none';
      });
    });
  });
}

// ------- data loads -------
async function initializeData(){
  const t = await fetchTaxonomy();
  chapters=t.chapters; topics=t.topics; tags=t.tags;

  cards = await fetchCards();

  grades = new Map();
  if(user) grades = await fetchUserGrades(user.id);
  cards.forEach(c=>{ c.user_grade = grades.get(c.id)||null; });

  buildScopePickers(); rebuildOrder(); renderCounts(); renderCard();
  buildEditorTablesSafe(); bindEditorActions(); bindAdminActions(); bindEditorSubTabs();
}

// ------- scope & counts -------
function visibleToLearner(c){ const pub=(c.status==='published'&&c.visibility==='public'&&!c.author_suspended); return pub||!!user; }
function chapMatch(c){ if(!scope.chapter) return true; if(scope.chapter==='__null__') return !c.chapter_id; return c.chapter_id===scope.chapter; }
function topicMatch(c){ if(!scope.topic) return true; if(scope.topic==='__none__') return (c.card_topics||[]).length===0; return (c.card_topics||[]).some(ct=>ct.topic_id===scope.topic); }
function inScope(c){ if(!visibleToLearner(c)) return false; if(!chapMatch(c)||!topicMatch(c)) return false; if(scope.diff){ const g=c.user_grade||'ungraded'; if(g!==scope.diff) return false; } if(scope.starred && !c.user_starred) return false; return true; }

function buildScopePickers(){
  const selC=$('selChapter'), selT=$('selTopic'); if(!selC||!selT) return;
  const vis=cards.filter(visibleToLearner);
  const byChap=new Map(), byTopic=new Map(); let uncat=0, noTopic=0;

  vis.forEach(c=>{
    if(!c.chapter_id) uncat++; else byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1);
    if((c.card_topics||[]).length===0) noTopic++;
    (c.card_topics||[]).forEach(ct=>byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1));
  });

  selC.innerHTML = `<option value="">All Chapters (${vis.length})</option>` +
    chapters.map(ch=>`<option value="${ch.id}">${escapeHtml(ch.title)} (${byChap.get(ch.id)||0})</option>`).join('') +
    `<option value="__null__">(Uncategorised) (${uncat})</option>`;

  const chapVal=selC.value || scope.chapter;
  let topicOpts=topics;
  if(chapVal && chapVal!=='__null__'){
    const tset=new Set();
    vis.filter(c=>c.chapter_id===chapVal).forEach(c=>(c.card_topics||[]).forEach(ct=>tset.add(ct.topic_id)));
    topicOpts = topics.filter(t=>tset.has(t.id));
    noTopic = vis.filter(c=>c.chapter_id===chapVal && (c.card_topics||[]).length===0).length;
  }

  selT.innerHTML = `<option value="">All Topics</option>` +
    topicOpts.map(tp=>`<option value="${tp.id}">${escapeHtml(tp.title)} (${byTopic.get(tp.id)||0})</option>`).join('') +
    `<option value="__none__">(No Topics) (${noTopic})</option>`;

  selC.onchange=()=>{ scope.chapter=selC.value||null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); buildScopePickers(); };
  selT.onchange=()=>{ scope.topic=selT.value||null; scope.mix=false; rebuildOrder(); renderCounts(); renderCard(); };

  const btnMix=$('btnMix'); if(btnMix) btnMix.onclick=()=>{ scope={chapter:null,topic:null,mix:true,diff:null,starred:false}; rebuildOrder(); renderCounts(); renderCard(); };

  bindDiffChips();
}
function bindDiffChips(){
  const wrap=$('diffChips'); if(!wrap) return;
  [...wrap.children].forEach(ch=>{
    ch.onclick=()=>{
      const d=ch.dataset.diff; if(d){ scope.diff=(scope.diff===d?null:d); }
      if(ch.id==='chip-star'){ scope.starred=!scope.starred; }
      [...wrap.children].forEach(x=>x.classList.remove('on'));
      if(scope.diff){ wrap.querySelector(`.chip[data-diff="${scope.diff}"]`)?.classList.add('on'); }
      if(scope.starred){ $('chip-star')?.classList.add('on'); }
      rebuildOrder(); renderCounts(); renderCard();
    };
  });
}
function renderCounts(){
  const poolX=cards.filter(c=>inScope(c));
  const counts={again:0,hard:0,good:0,easy:0,ungraded:0,star:0};
  poolX.forEach(c=>{ const g=c.user_grade||'ungraded'; if(counts[g]!==undefined) counts[g]++; if(c.user_starred) counts.star++; });
  setText('cnt-again', counts.again); setText('cnt-hard', counts.hard); setText('cnt-good', counts.good);
  setText('cnt-easy', counts.easy); setText('cnt-ungraded', counts.ungraded); setText('cnt-star', counts.star);
}
function rebuildOrder(){ pool=cards.filter(c=>inScope(c)); order=pool.map((_,i)=>i); idx=0; setText('metaIndex', `${order.length?1:0}/${order.length}`); }

function handleEditClick(){
  const c = currentCard;
  if(!c){ alert('No card selected.'); return; }

  const modal = document.getElementById('editModal');
  if(!modal){ alert('Edit modal not found.'); return; }
  modal.style.display = 'flex';

  // Fill fields (read-only for now; DB wiring next step)
  const edFront = document.getElementById('edFront');
  const edBack  = document.getElementById('edBack');
  const edTags  = document.getElementById('edTags');
  const edNotes = document.getElementById('edNotes');

  if(edFront) edFront.value = (c.front || '').replace(/<[^>]*>/g,'');
  if(edBack)  edBack.value  = (c.back  || '').replace(/<[^>]*>/g,'');
  if(edTags)  edTags.value  = (c.card_tags || []).map(t => t.name).join(', ');
  if(edNotes) edNotes.value = c.meta?.notes ? String(c.meta.notes) : '';

  // Chapter dropdown
  const edChapter = document.getElementById('edChapter');
  if(edChapter){
    const chs = window.chapters || [];
    edChapter.innerHTML = chs.map(ch => 
      `<option value="${ch.id}" ${c.chapter_id===ch.id?'selected':''}>${(ch.title||'').replace(/</g,'&lt;')}</option>`
    ).join('') + `<option value="" ${!c.chapter_id?'selected':''}>(Uncategorised)</option>`;
  }

  // Topics multi-select
  const edTopics = document.getElementById('edTopics');
  if(edTopics){
    const tps = window.topics || [];
    const on = new Set((c.card_topics||[]).map(x=>x.topic_id));
    edTopics.innerHTML = tps.map(tp => 
      `<option value="${tp.id}" ${on.has(tp.id)?'selected':''}>${(tp.title||'').replace(/</g,'&lt;')}</option>`
    ).join('');
  }

  // Close button (bind once)
  const closeBtn = document.getElementById('editClose');
  if(closeBtn && !closeBtn._bound){
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    closeBtn._bound = true;
  }
}

function handleDeleteClick(){
  const c = currentCard;
  if(!c){ alert('No card selected.'); return; }
  const ok = confirm('Delete this card permanently?');
  if(ok){
    alert('Confirmed delete');
  }
}

// ------- render -------
function renderCard(){
  setText('metaIndex', `${order.length?(idx+1):0}/${order.length}`);
  const qEl=$('q'), ansEl=$('ans'), gradeRow=$('gradeRow');
  if(!order.length){ if(qEl) qEl.innerHTML='No cards match.'; if(ansEl) ansEl.style.display='none'; if(gradeRow) gradeRow.style.display='none'; show('metaResources', false); return; }
  const c=pool[order[idx]]; 
  currentCard=c;
  window.currentCard = c; // debug-friendly
  const chapTitle=chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)';
  setText('metaChap', chapTitle);
  const tps=(c.card_topics||[]).map(x=>x.title).filter(Boolean);
  setText('metaTopics', tps.length? tps.join(' • '):'(No Topics)');
  setText('metaSection', c.meta?.Section || '—');
  setText('metaTags', (c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ')||'—');
  if(qEl) qEl.innerHTML=c.front||'—';
  if(ansEl){ ansEl.innerHTML=c.back||''; ansEl.style.display='none'; }
  if(gradeRow) gradeRow.style.display='none';
  const resources=c.meta?.resources||[]; const resCount=(c.meta?.notes?1:0)+resources.length;
  setText('resCount', String(resCount)); show('metaResources', !!resCount); renderResources(c);
  const del=$('btnDeleteCard'), edit=$('btnEditCard');
  if(del) del.style.display = user?'inline-block':'none';
  if(edit) edit.style.display = user?'inline-block':'none';
  const starBtn=$('btnStar'), suspBtn=$('btnSuspend');
  if(starBtn) starBtn.textContent = c.user_starred?'★ Unstar':'☆ Star';
  if(suspBtn) suspBtn.textContent = c.author_suspended?'▶ Unsuspend':'⏸ Suspend';

// --- bind: card action buttons (UI-only handlers) ---
(function bindCardActions(){
  const e = document.getElementById('btnEditCard');
  const d = document.getElementById('btnDeleteCard');
  if(e && !e._bound){ e._bound = true; e.addEventListener('click', handleEditClick); }
  if(d && !d._bound){ d._bound = true; d.addEventListener('click', handleDeleteClick); }
})();
  
}
function renderResources(c){
  const list=$('resList'); if(!list) return;
  list.innerHTML='';
  if(c.meta?.notes){ const d=document.createElement('div'); d.className='res'; d.innerHTML=`<span>📝</span><span>${escapeHtml(String(c.meta.notes).slice(0,180))}${String(c.meta.notes).length>180?'…':''}</span>`; list.appendChild(d); }
  (c.meta?.resources||[]).forEach(r=>{
    const d=document.createElement('div'); d.className='res';
    if(r.type==='image'){ d.innerHTML=`<img class="thumb" src="${r.url}" alt="image"/><a target="_blank" href="${r.url}">${escapeHtml(r.title||'Image')}</a>`; }
    else if(r.type==='pdf'){ d.innerHTML=`<span>📄</span><a target="_blank" href="${r.url}">${escapeHtml(r.title||'PDF')}</a>`; }
    else { d.innerHTML=`<span>🔗</span><a target="_blank" href="${r.url}">${escapeHtml(r.title||r.url)}</a>`; }
    list.appendChild(d);
  });
}

// ------- study actions -------
function bindStudyButtons(){
  on('btnPrev','click', ()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } });
  on('btnNext','click', ()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } });
  on('btnReveal','click', ()=>{ const ans=$('ans'), row=$('gradeRow'); if(ans) ans.style.display='block'; if(row) row.style.display='flex'; });
  on('gAgain','click', ()=>grade('again')); on('gHard','click', ()=>grade('hard')); on('gGood','click', ()=>grade('good')); on('gEasy','click', ()=>grade('easy'));
  on('btnStar','click', ()=>{ if(!currentCard) return; currentCard.user_starred=!currentCard.user_starred; renderCounts(); renderCard(); });
  on('btnSuspend','click', async ()=>{ if(!user||!currentCard) return; const newVal=!currentCard.author_suspended; const { error } = await supabase.from('cards').update({ author_suspended:newVal }).eq('id', currentCard.id); if(error){ alert(error.message); return; } currentCard.author_suspended=newVal; renderCard(); renderCounts(); });
}
async function grade(level){ if(!currentCard||!user){ renderCounts(); return; } currentCard.user_grade=level; grades.set(currentCard.id, level); await upsertGrade(user.id, currentCard.id, level); renderCounts(); $('btnNext')?.click(); }

// ------- search -------
function bindSearch(){
  const modal=$('searchModal'); if(!modal){ console.warn('[search] modal not found'); return; }
  on('btnSearch','click', ()=>{ modal.style.display='flex'; $('searchInput')?.focus(); });
  on('searchClose','click', ()=>{ modal.style.display='none'; });
  on('searchGo','click', runSearch);
  const inp=$('searchInput'); if(inp) inp.addEventListener('keydown', e=>{ if(e.key==='Enter') runSearch(); });
  on('searchReviewAll','click', ()=>{
    if(!searchIds.length) return;
    const idset=new Set(searchIds);
    pool=cards.filter(c=>idset.has(c.id)&&visibleToLearner(c));
    order=pool.map((_,i)=>i); idx=0; modal.style.display='none';
    scope={chapter:null,topic:null,mix:false,diff:null,starred:false}; renderCounts(); buildScopePickers(); renderCard();
  });
}
function runSearch(){
  const out=$('searchResults'); if(!out) return;
  const q=($('searchInput')?.value||'').trim();
  if(!q){ out.innerHTML=''; const btn=$('searchReviewAll'); if(btn) btn.disabled=true; searchIds=[]; return; }
  let res=cards.filter(visibleToLearner);
  if(q.startsWith('#')){ const tag=q.slice(1).toLowerCase(); res=res.filter(c=>(c.card_tags||[]).some(t=>(t.name||'').toLowerCase().includes(tag))); }
  else{ const s=q.toLowerCase(); res=res.filter(c=>(c.front||'').toLowerCase().includes(s)||(c.back||'').toLowerCase().includes(s)||(c.meta?.Section||'').toLowerCase().includes(s)); }
  searchIds=res.map(c=>c.id);
  out.innerHTML = res.map(c=>`
    <div style="padding:8px;border:1px solid #1b1b1b;border-radius:10px;margin:6px 0;background:#0b0b0b">
      <div class="small">${escapeHtml(chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)')} • ${(c.card_topics||[]).map(t=>escapeHtml(t.title)).join(', ')||'(No Topics)'}</div>
      <div style="margin:6px 0">${c.front}</div>
      <div class="small">${(c.card_tags||[]).map(t=>escapeHtml(t.name)).join(', ')}</div>
    </div>`).join('') || '<div class="small">No matches.</div>';
  const btn=$('searchReviewAll'); if(btn) btn.disabled=!res.length;
}

// ------- editor sub-tabs + actions -------
function bindEditorSubTabs(){
  const wrap = document.querySelector('.etabs'); if(!wrap) return;
  wrap.querySelectorAll('.etab').forEach(t=>{
    t.addEventListener('click', ()=>{
      wrap.querySelectorAll('.etab').forEach(x=>x.classList.remove('on'));
      t.classList.add('on');
      const which=t.dataset.etab;
      ['cards','chapters','topics','tags'].forEach(k=>{
        const sec=$('editor-'+k);
        if(sec) sec.style.display = (k===which)?'block':'none';
      });
    });
  });
}
function buildEditorTablesSafe(){
  const cardsTbl=$('tblCards'); if(!cardsTbl) return;
  const tb=cardsTbl.querySelector('tbody');
  tb.innerHTML = cards.slice(0,1000).map(c=>{
    const chap=chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)';
    const tps=(c.card_topics||[]).map(x=>x.title).filter(Boolean).join(', ');
    const tgs=(c.card_tags||[]).map(x=>x.name).filter(Boolean).join(', ');
    return `<tr>
      <td class="small">${c.front}</td>
      <td class="small">${escapeHtml(chap)}</td>
      <td class="small">${escapeHtml(tps||'(No Topics)')}</td>
      <td class="small">${escapeHtml(tgs||'—')}</td>
      <td class="small">
        <button class="ghost ed-act" data-act="edit" data-id="${c.id}">✎</button>
        <button class="danger ed-act" data-act="del" data-id="${c.id}">🗑</button>
      </td>
    </tr>`;
  }).join('');
  // Chapters table
  const tc=$('tblChapters')?.querySelector('tbody');
  if(tc){
    const byChap=new Map(); cards.forEach(c=>{ byChap.set(c.chapter_id,(byChap.get(c.chapter_id)||0)+1); });
    tc.innerHTML = chapters.map(ch=>{
      const n=byChap.get(ch.id)||0;
      return `<tr>
        <td>${escapeHtml(ch.title)}</td>
        <td>${n}</td>
        <td>
          <button class="ghost ch-act" data-act="ch-edit" data-id="${ch.id}">✎</button>
          <button class="danger ch-act" data-act="ch-del" data-id="${ch.id}" data-n="${n}">🗑</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No chapters.</td></tr>';
  }
  // Topics table
  const tt=$('tblTopics')?.querySelector('tbody');
  if(tt){
    const byTopic=new Map(); cards.forEach(c=>(c.card_topics||[]).forEach(ct=>byTopic.set(ct.topic_id,(byTopic.get(ct.topic_id)||0)+1)));
    tt.innerHTML = topics.map(tp=>{
      const n=byTopic.get(tp.id)||0;
      return `<tr>
        <td>${escapeHtml(tp.title)}</td>
        <td>${n}</td>
        <td>
          <button class="ghost tp-act" data-act="tp-edit" data-id="${tp.id}">✎</button>
          <button class="danger tp-act" data-act="tp-del" data-id="${tp.id}" data-n="${n}">🗑</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No topics.</td></tr>';
  }
  // Tags table
  const tg=$('tblTags')?.querySelector('tbody');
  if(tg){
    const byTag=new Map(); cards.forEach(c=>(c.card_tags||[]).forEach(t=>byTag.set(t.tag_id,(byTag.get(t.tag_id)||0)+1)));
    tg.innerHTML = tags.map(t=>{
      const n=byTag.get(t.id)||0;
      return `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${n}</td>
        <td>
          <button class="ghost g-act" data-act="tg-edit" data-id="${t.id}">✎</button>
          <button class="danger g-act" data-act="tg-del" data-id="${t.id}" data-n="${n}">🗑</button>
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="3" class="small">No tags.</td></tr>';
  }
}
function bindEditorActions(){
  // Cards table actions (delegate)
  const tbl=$('tblCards'); if(tbl){
    tbl.addEventListener('click', async (e)=>{
      const btn=e.target.closest('.ed-act'); if(!btn) return;
      const id=btn.dataset.id, act=btn.dataset.act;
      if(act==='edit'){ openEdit(id); }
      if(act==='del'){ await deleteCardById(id); }
    });
  }
  // Bulk delete modal
  on('btnBulkDelete','click', ()=>{ const m=$('bulkDeleteModal'); if(!m) return; m.style.display='flex'; setupBulkDeleteUI(); });
  on('bdClose','click', ()=>{ const m=$('bulkDeleteModal'); if(m) m.style.display='none'; });
}
async function deleteCardById(cardId){
  if(!confirm('Delete this card permanently?')) return;
  await deleteCardRecord(cardId);
  await initializeData();
  alert('Card deleted.');
}
function setupBulkDeleteUI(){
  const modeEl=$('bdMode'), pickEl=$('bdPicker'), cntEl=$('bdCount'), confirmEl=$('bdConfirm'), runEl=$('bdRun');
  async function buildPicker(){
    if(modeEl.value==='chapter'){
      pickEl.innerHTML = chapters.map(ch=>{
        const n = cards.filter(c=>c.chapter_id===ch.id).length;
        return `<option value="${ch.id}">${escapeHtml(ch.title)} (${n})</option>`;
      }).join('');
    }else{
      pickEl.innerHTML = topics.map(tp=>{
        const n = cards.filter(c=>(c.card_topics||[]).some(ct=>ct.topic_id===tp.id)).length;
        return `<option value="${tp.id}">${escapeHtml(tp.title)} (${n})</option>`;
      }).join('');
    }
    refreshPreview();
  }
  function refreshPreview(){
    let n=0;
    if(modeEl.value==='chapter'){ n = cards.filter(c=>c.chapter_id===pickEl.value).length; }
    else{ n = cards.filter(c=>(c.card_topics||[]).some(ct=>ct.topic_id===pickEl.value)).length; }
    cntEl.textContent=n; runEl.disabled = !(confirmEl.value.trim()==='DELETE' && n>0);
  }
  modeEl.onchange=buildPicker; pickEl.onchange=refreshPreview; confirmEl.oninput=refreshPreview; buildPicker();
  runEl.onclick=async()=>{
    let ids=[];
    if(modeEl.value==='chapter'){ ids = cards.filter(c=>c.chapter_id===pickEl.value).map(c=>c.id); }
    else { ids = cards.filter(c=>(c.card_topics||[]).some(ct=>ct.topic_id===pickEl.value)).map(c=>c.id); }
    if(!ids.length) return;
    for(const id of ids){ await deleteCardRecord(id); }
    $('bulkDeleteModal').style.display='none';
    await initializeData(); alert(`Deleted ${ids.length} card(s).`);
  };
}

// ------- admin actions (template & LLM prompt) -------
function bindAdminActions(){
  on('btnDownloadTemplate','click', ()=>{
    const template = { cards:[{ front:"Example Q?", back:"Example A.", chapter:"Chapter 1", topics:["Foundational Constructs"], tags:["Recall"], meta:{ Section:"Obj1", high_yield:true }, status:"published", visibility:"public", author_suspended:false }] };
    const blob=new Blob([JSON.stringify(template,null,2)],{type:'application/json'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download='cards-template.json'; a.click(); URL.revokeObjectURL(a.href);
  });
  on('btnOpenLLM','click', ()=>{ const m=$('llmModal'); if(!m) return; m.style.display='flex'; $('llmText').value='(your LLM instructions go here)'; });
  on('llmClose','click', ()=>{ const m=$('llmModal'); if(m) m.style.display='none'; });
  on('llmCopy','click', async ()=>{ try{ await navigator.clipboard.writeText($('llmText').value); alert('Copied.'); }catch(e){ alert('Copy failed: '+e.message); } });
  on('llmDownload','click', ()=>{
    const blob=new Blob([$('llmText').value],{type:'text/plain'}); const a=document.createElement('a');
    a.href=URL.createObjectURL(blob); a.download='LLM-instructions.txt'; a.click(); URL.revokeObjectURL(a.href);
  });
  // Import JSON
  on('btnImport','click', async ()=>{
    const f=$('fileImport')?.files?.[0]; if(!f){ alert('Pick a JSON file'); return; }
    const raw=await f.text();
    let cleaned=raw.replace(/\uFEFF/g,'').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\/\/.*$/mg,'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/,\s*([}\]])/g,'$1');
    let json; try{ json=JSON.parse(cleaned); }catch(e){ alert('Bad JSON: '+e.message); return; }
    const list = Array.isArray(json.cards)? json.cards : (Array.isArray(json)? json : []);
    if(!list.length){ alert('No cards found. Expect { "cards": [...] }.'); return; }
    alert(`Importing ${list.length} cards…`);

    for(const c of list){
      // ensure chapter/topics/tags and insert card & joins
      const chapId = await ensureChapterByTitle(c.chapter||null);
      const topicIds = await ensureTopicsByTitles(Array.isArray(c.topics)?c.topics:[]);
      const tagIds = await ensureTagsByNames(Array.isArray(c.tags)?c.tags:[]);
      const payload = { front:c.front, back:c.back, chapter_id:chapId, meta:c.meta||{}, status:c.status||'published', visibility:c.visibility||'public', author_suspended: !!c.author_suspended };
      const ins = await supabase.from('cards').insert(payload).select('id').single();
      if(ins.error){ console.error('Card insert', ins.error, c.front); continue; }
      const cardId = ins.data.id;
      if(topicIds.length) await supabase.from('card_topics').insert(topicIds.map(id=>({ card_id:cardId, topic_id:id })));
      if(tagIds.length)   await supabase.from('card_tags').insert(tagIds.map(id=>({ card_id:cardId, tag_id:id })));
    }
    await initializeData(); alert('Import complete.');
  });
}

// ------- boot -------
async function boot(){
  try{
    bindAuthButtons();
    bindTabs();
    bindStudyButtons();
    bindSearch();
    await initAuth();
    await initializeData();
  }catch(err){
    console.error('[boot] fatal', err);
    alert('App failed to initialize. See console for details.');
  }
}
window.addEventListener('DOMContentLoaded', boot);

// --- Inject Study Controls Accordion (non-destructive wrapper) ---
(function(){
  const tab = document.getElementById('tab-study');
  if(!tab) return;

  // find the existing elements
  const firstRow = tab.querySelector(':scope > .row');        // chapter/topic/mix/search row (first row inside #tab-study)
  const chips    = document.getElementById('diffChips');      // difficulty chips
  const card     = tab.querySelector(':scope > .card');       // main card section

  if(!firstRow || !chips || !card) return; // nothing to do

  // create accordion
  const acc = document.createElement('details');
  acc.className = 'accordion';
  acc.id = 'studyAccordion';

  // restore persisted state (default open once)
  const KEY = 'ui.studyAccordionOpen';
  const saved = localStorage.getItem(KEY);
  acc.open = saved === null ? true : saved === '1';
  acc.addEventListener('toggle', ()=> localStorage.setItem(KEY, acc.open ? '1':'0'));

  const sum = document.createElement('summary');
  sum.textContent = 'Study controls';
  acc.appendChild(sum);

  const controls = document.createElement('div');
  controls.className = 'controls';

  // move existing nodes into accordion
  controls.appendChild(firstRow);
  controls.appendChild(chips);
  acc.appendChild(controls);

  // insert accordion right before the card
  tab.insertBefore(acc, card);
})();
