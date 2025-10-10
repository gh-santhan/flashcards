// repo.js — Supabase data access layer
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

/* ---------------- Cards ---------------- */

export async function fetchCards(){
  const { data, error } = await supabase
    .from('cards')
    .select(`*, card_topics(topic_id, topics(id,title)), card_tags(tag_id, tags(id,name))`)
    .order('created_at', { ascending: true });
  if (error) { console.error('[fetchCards]', error); return []; }

  // normalize nested joins and meta
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
  // convenience: wipe resources array in meta (keeps other meta fields)
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

/* ---------------- Editor helpers (optional) ---------------- */

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

// --- Editor update helpers ---

// 1) Update core card fields
export async function updateCard(cardId, fields){
  // fields may include: { front, back, chapter_id, meta, status, visibility, author_suspended }
  const { error } = await supabase
    .from('cards')
    .update(fields)
    .eq('id', cardId);
  if (error) console.error('[updateCard]', error);
  return { error };
}

// 2) Replace topics (wipe old joins, then insert)
export async function replaceCardTopics(cardId, topicIds){
  const del = await supabase.from('card_topics').delete().eq('card_id', cardId);
  if (del.error) { console.error('[replaceCardTopics/delete]', del.error); return { error: del.error }; }

  if (!Array.isArray(topicIds) || !topicIds.length) return { error: null };
  const rows = topicIds.map(id => ({ card_id: cardId, topic_id: id }));
  const ins = await supabase.from('card_topics').insert(rows);
  if (ins.error) console.error('[replaceCardTopics/insert]', ins.error);
  return { error: ins.error || null };
}

// 3) Replace tags by names (ensure existence, wipe, insert)
export async function replaceCardTags(cardId, tagNames){
  const del = await supabase.from('card_tags').delete().eq('card_id', cardId);
  if (del.error) { console.error('[replaceCardTags/delete]', del.error); return { error: del.error }; }

  if (!Array.isArray(tagNames) || !tagNames.length) return { error: null };

  // ensure tags exist, collect ids
  const ids = [];
  for (const name of tagNames){
    let { data: ex, error: selErr } = await supabase.from('tags').select('id').eq('name', name).maybeSingle();
    if (selErr) { console.error('[replaceCardTags/select]', selErr); continue; }
    if (!ex){
      const ins = await supabase.from('tags').insert({ name }).select('id').maybeSingle();
      if (ins.error) { console.error('[replaceCardTags/ensure/insert]', ins.error); continue; }
      ex = ins.data;
    }
    ids.push(ex.id);
  }

  if (!ids.length) return { error: null };
  const rows = ids.map(id => ({ card_id: cardId, tag_id: id }));
  const insJoin = await supabase.from('card_tags').insert(rows);
  if (insJoin.error) console.error('[replaceCardTags/insertJoin]', insJoin.error);
  return { error: insJoin.error || null };
}


// --- add below existing exports in repo.js ---

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
