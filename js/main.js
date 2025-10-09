// /js/main.js
import { supabase } from './supabaseClient.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// -------- State --------
let session=null, user=null;
let chapters=[], topics=[], tags=[], cards=[];
let scope={ chapter:null, topic:null, mix:false, diff:null, starred:false };
let order=[], idx=0, currentCard=null;
let searchResults=[];

// -------- Helpers --------
const $ = (id)=>document.getElementById(id);
const escapeHTML = (s='') => s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
function visibleToLearner(c){
  const pub = (c.status==='published' && c.visibility==='public' && !c.author_suspended);
  return pub || !!user;
}

// ---------- Tabs ----------
function bindTabs(){
  document.querySelectorAll('.tab').forEach(t=>{
    t.onclick=()=>{
      document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
      t.classList.add('on');
      const which=t.dataset.tab;
      ['study','editor','admin'].forEach(k=>{
        $('tab-'+k).style.display = (k===which)?'block':'none';
      });
    };
  });
}
function bindEditorTabs(){
  document.querySelectorAll('.etab').forEach(t=>{
    t.onclick=()=>{
      document.querySelectorAll('.etab').forEach(x=>x.classList.remove('on'));
      t.classList.add('on');
      const which=t.dataset.etab;
      ['cards','chapters','topics','tags'].forEach(k=>{
        $('editor-'+k).style.display = (k===which)?'block':'none';
      });
    };
  });
}

// -------- Auth ----------
async function initAuth(){
  const { data:{ session:s } } = await supabase.auth.getSession();
  session=s; user=s?.user||null; syncAuthUI();

  // important: initial session + subsequent changes
  supabase.auth.onAuthStateChange((evt,sess)=>{
    session=sess; user=sess?.user||null; syncAuthUI();
    if(user){ loadAll(); }
  });
}
function siteRedirect(){ return location.origin + location.pathname; }
function syncAuthUI(){
  $('btnLogin').style.display = user ? 'none' : 'inline-block';
  $('btnLogout').style.display = user ? 'inline-block' : 'none';
  $('whoami').textContent = user ? (user.email||'') : '';
  $('metaEditor').style.display = user ? 'inline-block' : 'none';
}
function bindAuthButtons(){
  $('btnLogin').onclick = async ()=>{
    const email = prompt('Enter email for magic link:'); if(!email) return;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options:{ emailRedirectTo: siteRedirect() }
    });
    if(error) alert(error.message); else alert('Magic link sent.');
  };
  $('btnLogout').onclick = async ()=>{ await supabase.auth.signOut(); location.reload(); };
}

// -------- Data loads --------
async function loadTaxonomy(){
  const { data:ch } = await supabase.from('chapters').select('*').order('title');
  const { data:tp } = await supabase.from('topics').select('*').order('title');
  const { data:tg } = await supabase.from('tags').select('*').order('name');
  chapters=ch||[]; topics=tp||[]; tags=tg||[];
}
async function loadCards(){
  const { data: cs } = await supabase
    .from('cards')
    .select(`*, card_topics(topic_id, topics(id,title)), card_tags(tag_id, tags(id,name))`)
    .order('created_at',{ ascending:true });
  cards = (cs||[]).map(c=>{
    c.card_topics=(c.card_topics||[]).map(ct=>({topic_id:ct.topic_id,title:ct.topics?.title}));
    c.card_tags=(c.card_tags||[]).map(ct=>({tag_id:ct.tag_id,name:ct.tags?.name}));
    c.meta=c.meta||{};
    c.author_suspended = (typeof c.author_suspended==='boolean') ? c.author_suspended : (c.is_author_suspended||false);
    return c;
  });
}

// -------- Study scope + chips --------
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
function renderCounts(){
  const pool=cards.filter(c=>visibleToLearner(c) && chapMatch(c) && topicMatch(c));
  const counts={again:0,hard:0,good:0,easy:0,ungraded:0,star:0};
  pool.forEach(c=>{ const g=c.user_grade||'ungraded'; counts[g]++; if(c.user_starred) counts.star++; });
  $('cnt-again').textContent=counts.again;
  $('cnt-hard').textContent=counts.hard;
  $('cnt-good').textContent=counts.good;
  $('cnt-easy').textContent=counts.easy;
  $('cnt-ungraded').textContent=counts.ungraded;
  $('cnt-star').textContent=counts.star;
}
function bindDiffChips(){
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

// -------- Pickers --------
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
}

// -------- Ordering + render --------
function rebuildOrder(){
  const pool=cards.filter(inScope);
  order=pool.map((c,i)=>i); window._pool=pool; idx=0;
  $('metaIndex').textContent=`${order.length?1:0}/${order.length}`;
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
    if(r.type==='image'){
      d.innerHTML=`<img class="thumb" src="${r.url}" alt="image"/><a target="_blank" href="${r.url}">${escapeHTML(r.title||'Image')}</a>`;
    }else if(r.type==='pdf'){
      d.innerHTML=`<span>📄</span><a target="_blank" href="${r.url}">${escapeHTML(r.title||'PDF')}</a>`;
    }else{
      d.innerHTML=`<span>🔗</span><a target="_blank" href="${r.url}">${escapeHTML(r.title||r.url)}</a>`;
    }
    list.appendChild(d);
  });
}
function renderCard(){
  const pool=window._pool||[];
  $('metaIndex').textContent=`${order.length?(idx+1):0}/${order.length}`;
  if(!order.length){
    $('q').innerHTML='No cards match.'; $('ans').style.display='none'; $('gradeRow').style.display='none'; $('resWrap').style.display='none';
    return;
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

// -------- Study actions --------
function bindStudyActions(){
  $('btnPrev').onclick=()=>{ if(order.length){ idx=(idx-1+order.length)%order.length; renderCard(); } };
  $('btnNext').onclick=()=>{ if(order.length){ idx=(idx+1)%order.length; renderCard(); } };
  $('btnReveal').onclick=()=>{ $('ans').style.display='block'; $('gradeRow').style.display='flex'; };
  $('gAgain').onclick=()=>grade('again');
  $('gHard').onclick=()=>grade('hard');
  $('gGood').onclick=()=>grade('good');
  $('gEasy').onclick=()=>grade('easy');

  function grade(level){
    if(!currentCard) return;
    currentCard.user_grade=level; // local reflect
    renderCounts();
    $('btnNext').click();
  }

  $('btnStar').onclick=()=>{ if(!currentCard) return; currentCard.user_starred=!currentCard.user_starred; renderCounts(); renderCard(); };

  $('btnSuspend').onclick=async()=>{
    if(!user||!currentCard) return;
    const newVal=!currentCard.author_suspended;
    const { error } = await supabase.from('cards').update({ author_suspended:newVal }).eq('id', currentCard.id);
    if(error){ alert(error.message); return; }
    currentCard.author_suspended=newVal; renderCard(); renderCounts();
  };
}

// -------- Search modal --------
function bindSearch(){
  const btn = $('btnSearch');
  const modal = $('searchModal');
  const closeBtn = $('searchClose');
  const input = $('searchInput');
  const goBtn = $('searchGo');
  const reviewAll = $('searchReviewAll');
  const results = $('searchResults');

  // If Search UI isn't present in this build, just no-op so the app keeps running.
  if(!btn || !modal || !closeBtn || !input || !goBtn || !reviewAll || !results){
    console.warn('[bindSearch] Search UI not found in DOM — skipping wiring.');
    return;
  }

  btn.onclick = ()=>{
    modal.style.display='flex';
    input.focus();
  };
  closeBtn.onclick = ()=>{ modal.style.display='none'; };

  function runSearch(){
    const q = input.value.trim();
    if(!q){
      results.innerHTML='';
      reviewAll.disabled = true;
      return;
    }
    let res = cards.filter(visibleToLearner);
    if(q.startsWith('#')){
      const tag = q.slice(1).toLowerCase();
      res = res.filter(c => (c.card_tags||[]).some(t => (t.name||'').toLowerCase().includes(tag)));
    }else{
      const s = q.toLowerCase();
      res = res.filter(c =>
        (c.front||'').toLowerCase().includes(s) ||
        (c.back||'').toLowerCase().includes(s) ||
        (c.meta?.Section||'').toLowerCase().includes(s)
      );
    }
    searchResults = res.map(c => c.id);
    results.innerHTML = res.map(c => `
      <div style="padding:8px;border:1px solid #1b1b1b;border-radius:10px;margin:6px 0;background:#0b0b0b">
        <div class="small">
          ${escapeHTML(chapters.find(x=>x.id===c.chapter_id)?.title||'(Uncategorised)')} •
          ${(c.card_topics||[]).map(t=>escapeHTML(t.title)).join(', ')||'(No Topics)'}
        </div>
        <div style="margin:6px 0">${c.front}</div>
        <div class="small">${(c.card_tags||[]).map(t=>escapeHTML(t.name)).join(', ')}</div>
      </div>
    `).join('') || '<div class="small">No matches.</div>';
    reviewAll.disabled = !res.length;
  }

  goBtn.onclick = runSearch;
  input.addEventListener('keydown', e => { if(e.key==='Enter') runSearch(); });

  reviewAll.onclick = ()=>{
    if(!searchResults.length) return;
    const idset = new Set(searchResults);
    const pool = cards.filter(c => idset.has(c.id) && visibleToLearner(c));
    window._pool = pool;
    order = pool.map((c,i)=>i);
    idx = 0;
    modal.style.display = 'none';
    scope = {chapter:null, topic:null, mix:false, diff:null, starred:false};
    renderCounts(); buildScopePickers(); renderCard();
  };
}

  function runSearch(){
    const q=$('searchInput').value.trim();
    if(!q){ $('searchResults').innerHTML=''; $('searchReviewAll').disabled=true; return; }
    let res=cards.filter(visibleToLearner);
    if(q.startsWith('#')){
      const tag=q.slice(1).toLowerCase();
      res=res.filter(c=>(c.card_tags||[]).some(t=>(t.name||'').toLowerCase().includes(tag)));
    }else{
      const s=q.toLowerCase();
      res=res.filter(c=>(c.front||'').toLowerCase().includes(s)||(c.back||'').toLowerCase().includes(s)||(c.meta?.Section||'').toLowerCase().includes(s));
    }
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
    const idset=new Set(searchResults);
    const pool=cards.filter(c=>idset.has(c.id)&&visibleToLearner(c));
    window._pool=pool; order=pool.map((c,i)=>i); idx=0; $('searchModal').style.display='none';
    scope={chapter:null,topic:null,mix:false,diff:null,starred:false};
    renderCounts(); buildScopePickers(); renderCard();
  };
}

// -------- Editor TABLES (the missing function) --------
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

// NOTE: this version only rebuilds the three tables and counts;
// the edit/delete handlers are same as your working single-file build.
function buildEditorTables(){
  // cards
  renderCardTable();

  // chapters
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

  // topics
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

  // tags
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

// -------- Boot --------
async function loadAll(){
  await loadTaxonomy();
  await loadCards();
  buildScopePickers();
  rebuildOrder();
  renderCounts();
  renderCard();
  buildEditorTables();   // <- this was missing
  bindDiffChips();
}

window.addEventListener('DOMContentLoaded', async ()=>{
  bindTabs(); bindEditorTabs(); bindAuthButtons(); bindStudyActions(); bindSearch();
  await initAuth();
  await loadAll();
});

// --- expose a few handlers that Editor table buttons call
window.renameChapter = async (id, oldTitle)=>{
  const t=prompt('New chapter name:', oldTitle); if(!t||t===oldTitle) return;
  const { error } = await supabase.from('chapters').update({ title:t }).eq('id', id);
  if(error) return alert(error.message);
  await loadAll();
};
window.deleteChapter = async (id, title, count)=>{
  if(!confirm(`Delete chapter "${title}"?\nCards (${count}) will be left as Uncategorised.`)) return;
  const u = await supabase.from('cards').update({ chapter_id: null }).eq('chapter_id', id);
  if(u.error) return alert('Failed to uncategorise cards: '+u.error.message);
  const d = await supabase.from('chapters').delete().eq('id', id);
  if(d.error) return alert('Delete failed: '+d.error.message);
  await loadAll();
};
window.renameTopic = async (id, oldTitle)=>{
  const t=prompt('New topic name:', oldTitle); if(!t||t===oldTitle) return;
  const { error } = await supabase.from('topics').update({ title:t }).eq('id', id);
  if(error) return alert(error.message);
  await loadAll();
};
window.deleteTopic = async (id, title, count)=>{
  if(!confirm(`Delete topic "${title}"?\nIt will remove links from ${count} card(s). Cards remain.`)) return;
  const j = await supabase.from('card_topics').delete().eq('topic_id', id);
  if(j.error) return alert('Failed removing links: '+j.error.message);
  const d = await supabase.from('topics').delete().eq('id', id);
  if(d.error) return alert('Delete failed: '+d.error.message);
  await loadAll();
};
window.renameTag = async (id, oldName)=>{
  const t=prompt('New tag name:', oldName); if(!t||t===oldName) return;
  const { error } = await supabase.from('tags').update({ name:t }).eq('id', id);
  if(error) return alert(error.message);
  await loadAll();
};
window.deleteTag = async (id, name, count)=>{
  if(!confirm(`Delete tag "${name}"?\nIt will remove tag from ${count} card(s).`)) return;
  const j = await supabase.from('card_tags').delete().eq('tag_id', id);
  if(j.error) return alert('Failed removing tag: '+j.error.message);
  const d = await supabase.from('tags').delete().eq('id', id);
  if(d.error) return alert('Delete failed: '+d.error.message);
  await loadAll();
};
window.openEdit = (id)=> alert('Inline editor hook not yet wired in this split—study mode is working. (We can re-add the full modal next.)');
window.deleteCardById = async (id)=>{
  if(!confirm('Delete this card permanently?')) return;
  await supabase.from('card_topics').delete().eq('card_id', id);
  await supabase.from('card_tags').delete().eq('card_id', id);
  try{ await supabase.from('reviews').delete().eq('card_id', id); }catch(e){}
  const { error } = await supabase.from('cards').delete().eq('id', id);
  if(error) return alert(error.message);
  await loadAll();
};
