// repo.js — Supabase data access layer (deduplicated + aligned with main.js)
import { supabase } from './supabaseClient.js';

/* ---------------- Taxonomy ---------------- */

export async function fetchTaxonomy(){
  const [{ data: ch }, { data: tp }, { data: tg }] = await Promise.all([
    supabase.from('chapters').select('*').order('title'),
    supabase.from('topics').select('*').order('title'),
    supabase.from('tags').select('*').order('name')
  ]);
  return { chapters: ch || [], topics: tp || [], tags: tg || [] };
}

/* ---------------- Cards (read) ---------------- */

export async function fetchCards(){
  const { data, error } = await supabase
    .from('cards')
    .select(`*, card_topics(topic_id, topics(id,title)), card_tags(tag_id, tags(id,name))`)
    .order('created_at', { ascending: true });
  if (error) { console.error('[fetchCards]', error); return []; }

  return (data || []).map(c => {
    c.card_topics = (c.card_topics || []).map(ct => ({
      topic_id: ct.topic_id,
      title: ct.topics?.title
    }));
    c.card_tags = (c.card_tags || []).map(ct => ({
      tag_id: ct.tag_id,
      name: ct.tags?.name
    }));
    c.meta = c.meta || {};
    c.author_suspended = (typeof c.author_suspended === 'boolean')
      ? c.author_suspended
      : (c.is_author_suspended || false);
    return c;
  });
}

// --- Admin helper ---
export async function checkIsAdmin(){
  const { data, error } = await supabase.rpc('is_admin');
  if (error) { console.warn('[is_admin]', error); return false; }
  return !!data;
}

/* ---------------- Grades (per user) ---------------- */

export async function fetchUserGrades(userId){
  if(!userId) return new Map();
  const { data, error } = await supabase
    .from('card_grades')
    .select('card_id, grade')
    .eq('user_id', userId);
  if (error) { console.error('[fetchUserGrades]', error); return new Map(); }
  const m = new Map();
  (data || []).forEach(r => m.set(r.card_id, r.grade));
  return m;
}

export async function upsertGrade(userId, cardId, grade){
  const payload = { user_id:userId, card_id:cardId, grade };
  const { error } = await supabase
    .from('card_grades')
    .upsert(payload, { onConflict: 'user_id,card_id' });
  if (error) console.error('[upsertGrade]', error);
  return { error };
}

/* ---------------- Card meta/resources helpers ---------------- */

export async function saveCardMeta(cardId, meta){
  const { error } = await supabase.from('cards').update({ meta }).eq('id', cardId);
  if (error) console.error('[saveCardMeta]', error);
  return { error };
}

export async function unlinkResourcesForCard(cardId){
  // wipe resources array in meta (keep other meta fields)
  const { data, error: e1 } = await supabase.from('cards').select('meta').eq('id', cardId).maybeSingle();
  if (e1) { console.error('[unlinkResourcesForCard/select]', e1); return { error: e1 }; }
  const meta = Object.assign({}, data?.meta || {});
  meta.resources = [];
  const { error } = await supabase.from('cards').update({ meta }).eq('id', cardId);
  if (error) console.error('[unlinkResourcesForCard/update]', error);
  return { error };
}

/* ---------------- Ensure/lookup helpers ---------------- */

export async function ensureChapterByTitle(title){
  if(!title) return null;
  let { data: ex } = await supabase.from('chapters').select('id').eq('title', title).maybeSingle();
  if(!ex){
    const ins = await supabase.from('chapters').insert({ title }).select('id').maybeSingle();
    if (ins.error) { console.error('[ensureChapterByTitle]', ins.error); return null; }
    ex = ins.data;
  }
  return ex?.id || null;
}

export async function ensureTopicsByTitles(titles){
  if(!Array.isArray(titles) || !titles.length) return [];
  const out = [];
  for(const t of titles){
    let { data: ex } = await supabase.from('topics').select('id').eq('title', t).maybeSingle();
    if(!ex){
      const ins = await supabase.from('topics').insert({ title: t }).select('id').maybeSingle();
      if (ins.error) { console.error('[ensureTopicsByTitles]', ins.error); continue; }
      ex = ins.data;
    }
    out.push(ex.id);
  }
  return out;
}

export async function ensureTagsByNames(names){
  if(!Array.isArray(names) || !names.length) return [];
  const out = [];
  for(const g of names){
    let { data: ex } = await supabase.from('tags').select('id').eq('name', g).maybeSingle();
    if(!ex){
      const ins = await supabase.from('tags').insert({ name: g }).select('id').maybeSingle();
      if (ins.error) { console.error('[ensureTagsByNames]', ins.error); continue; }
      ex = ins.data;
    }
    out.push(ex.id);
  }
  return out;
}

/* ---------------- Editor helpers ---------------- */

export async function deleteCardRecord(cardId){
  // remove joins first, then card
  await supabase.from('card_topics').delete().eq('card_id', cardId);
  await supabase.from('card_tags').delete().eq('card_id', cardId);
  try { await supabase.from('card_grades').delete().eq('card_id', cardId); } catch(e){}
  const { error } = await supabase.from('cards').delete().eq('id', cardId);
  if (error) console.error('[deleteCardRecord]', error);
  return { error };
}

export async function listCardsByChapter(chapterId){
  const { data, error } = await supabase.from('cards').select('id').eq('chapter_id', chapterId);
  if (error) { console.error('[listCardsByChapter]', error); return []; }
  return (data||[]).map(r=>r.id);
}

export async function listCardsByTopic(topicId){
  const { data, error } = await supabase
    .from('card_topics')
    .select('card_id')
    .eq('topic_id', topicId);
  if (error) { console.error('[listCardsByTopic]', error); return []; }
  return (data||[]).map(r=>r.card_id);
}

/* ---------------- Card updates (used by Edit modal) ---------------- */

export async function updateCard(cardId, fields){
  // Allowed fields: front, back, chapter_id, meta, status, visibility, author_suspended
  const payload = {};
  for (const k of ['front','back','chapter_id','meta','status','visibility','author_suspended']){
    if (k in fields) payload[k] = fields[k];
  }
  const { error } = await supabase.from('cards').update(payload).eq('id', cardId);
  if (error) console.error('[updateCard]', error);
  return { error };
}

export async function replaceCardTopics(cardId, topicIds){
  // wipe and re-add joins
  const del = await supabase.from('card_topics').delete().eq('card_id', cardId);
  if (del.error){ console.error('[replaceCardTopics/delete]', del.error); return { error: del.error }; }
  if (Array.isArray(topicIds) && topicIds.length){
    const rows = topicIds.map(id => ({ card_id: cardId, topic_id: id }));
    const ins = await supabase.from('card_topics').insert(rows);
    if (ins.error){ console.error('[replaceCardTopics/insert]', ins.error); return { error: ins.error }; }
  }
  return { error: null };
}

export async function replaceCardTags(cardId, tagNames){
  // ensure tags exist, then replace joins
  const names = (Array.isArray(tagNames) ? tagNames : []).filter(Boolean);
  const ids = [];
  for (const name of names){
    let { data: ex } = await supabase.from('tags').select('id').eq('name', name).maybeSingle();
    if(!ex){
      const ins = await supabase.from('tags').insert({ name }).select('id').maybeSingle();
      if (ins.error){ console.error('[replaceCardTags/ensure]', ins.error); continue; }
      ex = ins.data;
    }
    ids.push(ex.id);
  }
  const del = await supabase.from('card_tags').delete().eq('card_id', cardId);
  if (del.error){ console.error('[replaceCardTags/delete]', del.error); return { error: del.error }; }
  if (ids.length){
    const rows = ids.map(id => ({ card_id: cardId, tag_id: id }));
    const ins = await supabase.from('card_tags').insert(rows);
    if (ins.error){ console.error('[replaceCardTags/insert]', ins.error); return { error: ins.error }; }
  }
  return { error: null };
}

// Save a feedback row (RLS requires user_id == auth.uid())
export async function saveFeedback({ cardId, userId, userEmail, comment }) {
  if (!cardId || !userId || !comment?.trim()) {
    return { error: new Error('Missing cardId/userId/comment') };
  }
  const payload = {
    card_id: cardId,
    user_id: userId,
    user_email: userEmail || null, // <-- store email
    comment: comment.trim(),
    status: 'open'
  };
  const { data, error } = await supabase
    .from('card_feedback')
    .insert(payload)
    .select('id')
    .single();
  return { data, error };
}

// --- Admin helpers: feedback count ---
export async function fetchFeedbackOpenCount(){
  const { count, error } = await supabase
    .from('card_feedback')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open');

  if (error) {
    console.error('[repo.fetchFeedbackOpenCount]', error);
    return 0;
  }
  return typeof count === 'number' ? count : 0;
}

/* ---------------- Feedback (admin) ---------------- */

export async function fetchAllFeedback(){
  // newest first; keep it simple and join card/question text in UI using the in-memory cards[]
  const { data, error } = await supabase
    .from('card_feedback')
    .select('id, card_id, user_id, body, created_at, status')
    .order('created_at', { ascending: false });
  if (error) { console.error('[fetchAllFeedback]', error); return []; }
  return data || [];
}

export async function fetchFeedbackForCard(cardId){
  const { data, error } = await supabase
    .from('card_feedback')
    .select('id, card_id, user_id, body, created_at, status')
    .eq('card_id', cardId)
    .order('created_at', { ascending: false });
  if (error) { console.error('[fetchFeedbackForCard]', error); return []; }
  return data || [];
}

/* ---------------- Admin: feedback queries ---------------- */

/** Pending feedback rows with a small card preview */
export async function getFeedbackPending(){
  const { data, error } = await supabase
    .from('card_feedback')
    .select('id, card_id, user_id, message, created_at, reviewed, cards!inner(id,front)')
    .eq('reviewed', false)
    .order('created_at', { ascending: false });

  if (error){ console.error('[getFeedbackPending]', error); return []; }

  // normalize shape
  return (data||[]).map(r => ({
    id: r.id,
    card_id: r.card_id,
    user_id: r.user_id,
    message: r.message,
    created_at: r.created_at,
    reviewed: r.reviewed,
    front: r.cards?.front || ''
  }));
}

/** Simple summary: total pending count (for the header badge) */
export async function getFeedbackSummary(){
  const { count, error } = await supabase
    .from('card_feedback')
    .select('id', { count: 'exact', head: true })
    .eq('reviewed', false);

  if (error){ console.error('[getFeedbackSummary]', error); return { pendingCount: 0 }; }
  return { pendingCount: count || 0 };
}

/** Mark one feedback row reviewed/unreviewed */
export async function markFeedbackReviewed(feedbackId, reviewed=true){
  const { error } = await supabase
    .from('card_feedback')
    .update({ reviewed })
    .eq('id', feedbackId);
  if (error){ console.error('[markFeedbackReviewed]', error); }
  return { error };
}

/* ---------------- Feedback (admin) ---------------- */

// Admin: list all feedback rows (project fields used by Admin UI)
export async function listFeedback(){
  const { data, error } = await supabase
    .from('card_feedback')
    .select('id, created_at, status, comment, user_email, card_id')
    .order('created_at', { ascending: false });

  if (error){
    console.error('[repo.listFeedback]', error);
    return [];
  }
  return data || [];
}

  // normalize (room to enrich later with joins)
  return (data || []).map(r => ({
    id: r.id,
    created_at: r.created_at,
    status: r.status || 'open',
    comment: r.comment || '',
    user_email: null,     // optional: fill later if you add a profiles join
    card_id: r.card_id,
    card_front: ''        // optional: fill via a join to cards.front later
  }));
}

// Update a feedback row’s fields (e.g., status)
export async function updateFeedback(id, fields){
  const { error } = await supabase
    .from('card_feedback')
    .update(fields)
    .eq('id', id);
  if (error) console.error('[repo.updateFeedback]', error);
  return { error };
}


