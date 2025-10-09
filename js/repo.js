import { supabase } from './supabaseClient.js';

/* ---- Auth ---- */
export async function getSession(){ const { data:{ session } } = await supabase.auth.getSession(); return session; }
export function onAuth(cb){ supabase.auth.onAuthStateChange((_e, s)=>cb(s)); }
export async function sendMagicLink(email, redirect){
  return supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: redirect }});
}
export async function signOut(){ await supabase.auth.signOut(); }

/* ---- Taxonomy ---- */
export async function fetchTaxonomy(){
  const [ch, tp, tg] = await Promise.all([
    supabase.from('chapters').select('*').order('title'),
    supabase.from('topics').select('*').order('title'),
    supabase.from('tags').select('*').order('name')
  ]);
  return {
    chapters: ch.data||[],
    topics: tp.data||[],
    tags: tg.data||[]
  };
}

/* ---- Cards ---- */
export async function fetchCards(){
  const { data } = await supabase.from('cards')
    .select(`*, card_topics(topic_id, topics(id,title)), card_tags(tag_id, tags(id,name))`)
    .order('created_at',{ascending:true});
  const list=(data||[]).map(c=>{
    c.card_topics=(c.card_topics||[]).map(ct=>({topic_id:ct.topic_id,title:ct.topics?.title}));
    c.card_tags=(c.card_tags||[]).map(ct=>({tag_id:ct.tag_id,name:ct.tags?.name}));
    c.meta=c.meta||{};
    c.author_suspended = (typeof c.author_suspended==='boolean') ? c.author_suspended : (c.is_author_suspended||false);
    return c;
  });
  return list;
}

/* ---- Grades (persistent) ---- */
export async function fetchUserGrades(userId){
  if(!userId) return new Map();
  const { data } = await supabase.from('card_grades')
    .select('card_id, grade').eq('user_id', userId);
  const m=new Map(); (data||[]).forEach(r=>m.set(r.card_id,r.grade)); return m;
}
export async function upsertGrade(userId, cardId, grade){
  return supabase.from('card_grades')
    .upsert({ user_id:userId, card_id:cardId, grade }, { onConflict:'user_id,card_id' });
}

/* ---- Stars / Suspend ---- */
export async function setSuspend(cardId, suspended){
  return supabase.from('cards').update({ author_suspended:suspended }).eq('id', cardId);
}

/* ---- Import helpers (unchanged from your working version) ---- */
export async function ensureChapter(title){
  if(!title) return null;
  let { data: ex } = await supabase.from('chapters').select('id').eq('title', title).maybeSingle();
  if(!ex){ await supabase.from('chapters').insert({ title }); ({ data: ex } = await supabase.from('chapters').select('id').eq('title', title).maybeSingle()); }
  return ex.id;
}
export async function ensureTopic(title){
  let { data: ex } = await supabase.from('topics').select('id').eq('title', title).maybeSingle();
  if(!ex){ await supabase.from('topics').insert({ title }); ({ data: ex } = await supabase.from('topics').select('id').eq('title', title).maybeSingle()); }
  return ex.id;
}
export async function ensureTag(name){
  let { data: ex } = await supabase.from('tags').select('id').eq('name', name).maybeSingle();
  if(!ex){ await supabase.from('tags').insert({ name }); ({ data: ex } = await supabase.from('tags').select('id').eq('name', name).maybeSingle()); }
  return ex.id;
}
export async function insertCard(payload){ return supabase.from('cards').insert(payload).select('id').single(); }
export async function linkTopics(cardId, topicIds){
  await supabase.from('card_topics').delete().eq('card_id', cardId);
  if(topicIds.length) await supabase.from('card_topics').insert(topicIds.map(id=>({card_id:cardId,topic_id:id})));
}
export async function linkTags(cardId, tagIds){
  await supabase.from('card_tags').delete().eq('card_id', cardId);
  if(tagIds.length) await supabase.from('card_tags').insert(tagIds.map(id=>({card_id:cardId,tag_id:id})));
}
