/* app.js — application logic */
// A pristine, never-mutated snapshot of the built-in recipes exactly as hardcoded, keyed by
// their original name — used to restore a recipe after editing without needing a page reload.
const PRISTINE_RECIPES_BY_NAME = {};
RECIPES.forEach(r=>{ PRISTINE_RECIPES_BY_NAME[r.name] = JSON.parse(JSON.stringify(r)); });

// Recipes imported by the user via Settings → Import (persisted separately, merged in).
// Drop any custom entry whose name is already in the permanent RECIPES list (e.g. after
// a permanent bake-in of a previously-exported recipe) so it doesn't appear twice.
let customRecipes = JSON.parse(localStorage.getItem('custom_recipes')||'[]');
const BUILTIN_RECIPE_NAMES = new Set(RECIPES.map(r=>r.name));
(function pruneCustomRecipesAgainstBuiltins(){
  const builtinNames = BUILTIN_RECIPE_NAMES;
  const before = customRecipes.length;
  customRecipes = customRecipes.filter(r=>!builtinNames.has(r.name));
  if(customRecipes.length !== before) localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
})();
RECIPES.push(...customRecipes);

// Edits to built-in recipes, keyed by the recipe's ORIGINAL (hardcoded) name so edits keep
// applying correctly across reloads even after a rename — RECIPES itself always starts fresh
// from the hardcoded list on every load, so overrides are re-applied on top each time.
let recipeOverrides = JSON.parse(localStorage.getItem('recipe_overrides')||'{}');
function applyRecipeOverrides(){
  Object.entries(recipeOverrides).forEach(([originalName, data])=>{
    const idx = RECIPES.findIndex(r=>r.name===originalName || r.name===data.name);
    if(idx>-1) RECIPES[idx] = {...RECIPES[idx], ...data};
  });
}
applyRecipeOverrides();

function norm(s){ return s.trim().replace(/\s+/g,' '); }

const MEAT_INGREDIENTS = ["עוף","בשר טחון","טונה","סלמון","נקניקיות"];
function isVegetarian(r){ return !recipeIngNames(r).some(i=>MEAT_INGREDIENTS.includes(i)); }
function minutesOf(r){ const m = r.time.match(/\d+/); return m? parseInt(m[0]) : 999; }

let fridge = new Set(JSON.parse(localStorage.getItem('fridge_items')||'[]'));
let fridgeExpiry = JSON.parse(localStorage.getItem('fridge_expiry')||'{}'); // {itemName: 'YYYY-MM-DD'}
function setExpiry(item, dateStr){
  if(dateStr) fridgeExpiry[item] = dateStr; else delete fridgeExpiry[item];
  localStorage.setItem('fridge_expiry', JSON.stringify(fridgeExpiry));
  scheduleAppStatePush();
}
function daysUntil(dateStr){
  if(!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}
function expiryStatus(item){
  const d = daysUntil(fridgeExpiry[item]);
  if(d === null) return null;
  if(d < 0) return 'expired';
  if(d <= 2) return 'soon';
  return 'ok';
}
let cookedSet = new Set(JSON.parse(localStorage.getItem('cooked_recipes')||'[]'));
let cookHistory = JSON.parse(localStorage.getItem('cook_history')||'{}'); // {name: [iso dates]}
let shoppingLists = JSON.parse(localStorage.getItem('shopping_lists')||'null');
if(!shoppingLists){
  // Migrate from the old single-list storage format
  shoppingLists = {
    main: {
      name: 'רשימה ראשית',
      items: JSON.parse(localStorage.getItem('shopping_list')||'[]'),
      bought: JSON.parse(localStorage.getItem('bought_items')||'[]'),
      syncCode: localStorage.getItem('sync_code') || null
    }
  };
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
}
let activeListId = 'main';   // the app always opens on the main list; other lists are one tap away
if(!shoppingLists[activeListId]) activeListId = Object.keys(shoppingLists)[0];
function getActiveList(){
  const list = shoppingLists[activeListId];
  if(list && !list.quantities) list.quantities = {};
  return list;
}
function setItemQuantity(item, qty){
  const list = getActiveList();
  if(qty) list.quantities[item] = qty; else delete list.quantities[item];
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
  pushSync();
  scheduleShoppingPush();
}
function qtyOfShopItem(item){ return (getActiveList().quantities||{})[item] || ''; }
let shoppingList = new Set(getActiveList().items||[]);
let boughtItems = new Set(getActiveList().bought||[]);
let favorites = new Set(JSON.parse(localStorage.getItem('favorites')||'[]'));
let filters = { search:'', diet:'all', maxTime:0, readyNow:false, almostReady:false, hideCooked:false, favoritesOnly:false, cuisine:'all', difficulty:'all' };
// When the fridge has items, default to "ready now" until the user changes filters.
let readyNowAutoApplied = false;
let isDark = localStorage.getItem('theme') === 'dark';
let showCheckedShop = false;
let smHideChecked = localStorage.getItem('sm_hide_checked') !== '0'; // default: hide checked in supermarket mode
// ---- Display layout: which tabs show, where Settings lives, which recipe sections show ----
// (replaces the old on/off "simple mode"; someone who had simple mode on keeps the same layout)
const CONTENT_TABS = ['shopping', 'recipes', 'fridge'];
function defaultTabPrefs(){ return { shopping:true, recipes:true, fridge:true, settingsAs:'tab', weekPlan:true, daily:true }; }
function normalizeTabPrefs(p){
  const d = defaultTabPrefs();
  const out = Object.assign({}, d, (p && typeof p === 'object') ? p : {});
  CONTENT_TABS.forEach(t=>{ out[t] = out[t] !== false; });
  out.weekPlan = out.weekPlan !== false; out.daily = out.daily !== false;
  if(out.settingsAs !== 'icon') out.settingsAs = 'tab';
  if(!CONTENT_TABS.some(t=>out[t])) out.shopping = true;        // never hide everything
  return out;
}
let tabPrefs = (()=>{
  try{ const saved = JSON.parse(localStorage.getItem('tab_prefs') || 'null'); if(saved) return normalizeTabPrefs(saved); }catch(e){}
  const p = defaultTabPrefs();
  if(localStorage.getItem('simple_mode') === '1'){ p.fridge = false; p.weekPlan = false; p.daily = false; }
  return p;
})();
function visibleContentTabs(){ return CONTENT_TABS.filter(t=>tabPrefs[t]); }
function saveTabPrefs(){
  localStorage.setItem('tab_prefs', JSON.stringify(tabPrefs));
  localStorage.setItem('simple_mode', tabPrefs.fridge ? '0' : '1');   // keeps older app versions roughly in step
}
let tonightOffset = 0;
const SUPABASE_URL = 'https://pznpibrlcbjpcoxagxns.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6bnBpYnJsY2JqcGNveGFneG5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjEzMjUsImV4cCI6MjEwMjUzNzMyNX0.dvfKlGyI1U_E7G5POQJkLn28gky7cTyJbQqT3Mie_YU';

// ——— Account system (Supabase Auth) — email/password login, cross-device sync, and sharing with other accounts ———
const sbClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
let currentUser = null;
let activeShoppingRowId = localStorage.getItem('active_shopping_row') || null;
let activeRecipesRowId = localStorage.getItem('active_recipes_row') || null;
let activeStateRowId = localStorage.getItem('active_state_row') || null;
let activeCategorySettingsRowId = localStorage.getItem('active_category_settings_row') || null;
let accountShoppingRows = [];
let accountRecipeRows = [];
let accountStateRows = [];
let accountCategorySettingsRows = [];
let appStatePushTimer = null;
let categorySettingsPushTimer = null;

function collectAppState(){
  return {
    fridge: [...fridge],
    fridgeExpiry,
    cookedSet: [...cookedSet],
    cookHistory,
    favorites: [...favorites],
    weeklyPlan,
    itemUsage,
    learnedLabels,
    learnedBarcodes,
    autoResetEnabled,
    protectedCategories,
    recipeOverrides
  };
}
function applyAppStateRow(row){
  activeStateRowId = row.id;
  localStorage.setItem('active_state_row', row.id);
  const p = row.payload || {};
  fridge = new Set(p.fridge || []);
  fridgeExpiry = p.fridgeExpiry || {};
  cookedSet = new Set(p.cookedSet || []);
  cookHistory = p.cookHistory || {};
  favorites = new Set(p.favorites || []);
  weeklyPlan = p.weeklyPlan || {};
  itemUsage = p.itemUsage || {};
  learnedLabels = p.learnedLabels || {};
  learnedBarcodes = p.learnedBarcodes || {};
  autoResetEnabled = !!p.autoResetEnabled;
  protectedCategories = p.protectedCategories || ["מזווה","תיבול ואפייה"];
  recipeOverrides = p.recipeOverrides || {};
  Object.keys(weeklyPlan).forEach(day=>{ if(typeof weeklyPlan[day] === 'string') weeklyPlan[day] = weeklyPlan[day] ? [weeklyPlan[day]] : []; });
  localStorage.setItem('fridge_items', JSON.stringify([...fridge]));
  localStorage.setItem('fridge_expiry', JSON.stringify(fridgeExpiry));
  localStorage.setItem('cooked_recipes', JSON.stringify([...cookedSet]));
  localStorage.setItem('cook_history', JSON.stringify(cookHistory));
  localStorage.setItem('favorites', JSON.stringify([...favorites]));
  localStorage.setItem('weekly_plan', JSON.stringify(weeklyPlan));
  localStorage.setItem('item_usage', JSON.stringify(itemUsage));
  localStorage.setItem('learned_labels', JSON.stringify(learnedLabels));
  localStorage.setItem('learned_barcodes', JSON.stringify(learnedBarcodes));
  localStorage.setItem('auto_reset_enabled', autoResetEnabled ? '1' : '0');
  localStorage.setItem('protected_categories', JSON.stringify(protectedCategories));
  localStorage.setItem('recipe_overrides', JSON.stringify(recipeOverrides));
  applyRecipeOverrides();
  migrateRenamedRecipes();
}
async function pushAppState(){
  if(!currentUser || !activeStateRowId || !sbClient) return;
  try{
    await sbClient.from('user_data').update({payload: collectAppState(), updated_at: new Date().toISOString()}).eq('id', activeStateRowId);
  }catch(e){ /* offline — local copy is already saved */ }
}

// Categorization (category/icon overrides, custom categories, hidden catalog items) is kept as
// its own shareable unit — separate from personal app state (fridge contents, favorites, history)
// — so two people can share a consistent shopping-list layout without merging their fridges too.
function collectCategorySettings(){
  return { categoryOverrides, iconOverrides, customCategories, removedCatalogItems, categoryIcons };
}
function applyCategorySettingsRow(row){
  activeCategorySettingsRowId = row.id;
  localStorage.setItem('active_category_settings_row', row.id);
  const p = row.payload || {};
  categoryOverrides = p.categoryOverrides || {};
  iconOverrides = p.iconOverrides || {};
  customCategories = p.customCategories || [];
  removedCatalogItems = p.removedCatalogItems || [];
  categoryIcons = p.categoryIcons || {};
  localStorage.setItem('category_icons', JSON.stringify(categoryIcons));
  const wasPruned = pruneCustomCategoriesAgainstCatalog();
  localStorage.setItem('category_overrides', JSON.stringify(categoryOverrides));
  localStorage.setItem('icon_overrides', JSON.stringify(iconOverrides));
  localStorage.setItem('custom_categories', JSON.stringify(customCategories));
  localStorage.setItem('removed_catalog_items', JSON.stringify(removedCatalogItems));
  if(wasPruned) scheduleCategorySettingsPush();
}
async function pushCategorySettings(){
  if(!currentUser || !activeCategorySettingsRowId || !sbClient) return;
  try{
    await sbClient.from('user_data').update({payload: collectCategorySettings(), updated_at: new Date().toISOString()}).eq('id', activeCategorySettingsRowId);
  }catch(e){ /* offline — local copy is already saved */ }
}
function scheduleCategorySettingsPush(){
  if(!currentUser || !activeCategorySettingsRowId) return;
  clearTimeout(categorySettingsPushTimer);
  categorySettingsPushTimer = setTimeout(pushCategorySettings, 1200);
}
function scheduleAppStatePush(){
  if(!currentUser || !activeStateRowId) return;
  clearTimeout(appStatePushTimer);
  appStatePushTimer = setTimeout(pushAppState, 1200);
}

async function fetchUserDataRows(kind){
  if(!sbClient) return [];
  const { data, error } = await sbClient.from('user_data').select('*').eq('kind', kind);
  if(error){ console.error(error); return []; }
  return data || [];
}
let shoppingRealtimeChannel = null;
// updated_at of the newest server copy of the shopping row we know about (server-confirmed only).
// Compared numerically — server and client format timestamps differently, so string compare is unsafe.
let lastShoppingUpdatedAt = null;
// "Base" = the last server copy our local data was built on. With it, a 3-way merge can tell what *we*
// changed from what *others* changed, so edits made on two phones at once are combined instead of one
// overwriting the other.
let shoppingBase = null;
function cloneJSON(o){ return JSON.parse(JSON.stringify(o == null ? {} : o)); }
function tsOf(v){ const t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }
// Always strictly later than the copy we merged onto, even if this phone's clock runs behind.
function nextStamp(prev){ return new Date(Math.max(Date.now(), tsOf(prev) + 1)).toISOString(); }
function setShoppingBase(obj, rowId){
  shoppingBase = cloneJSON(obj);
  try{ localStorage.setItem('shopping_base_' + (rowId || activeShoppingRowId), JSON.stringify(shoppingBase)); }catch(e){}
}
function mergeArr(b, l, s){
  const B = new Set(b || []), L = new Set(l || []);
  const removed = new Set((b || []).filter(x=>!L.has(x)));
  const res = (s || []).filter(x=>!removed.has(x));
  (l || []).forEach(x=>{ if(!B.has(x) && !res.includes(x)) res.push(x); });
  return res;
}
function mergeMap(b, l, s){
  b = b || {}; l = l || {};
  const res = Object.assign({}, s || {});
  new Set([...Object.keys(b), ...Object.keys(l)]).forEach(k=>{
    if(JSON.stringify(l[k]) !== JSON.stringify(b[k])){
      if(l[k] === undefined) delete res[k]; else res[k] = l[k];
    }
  });
  return res;
}
function mergeOneList(b, l, s){
  const res = cloneJSON(s);
  Object.keys(l).forEach(k=>{
    if(['items','bought','quantities','notes','addedBy'].includes(k)) return;
    if(JSON.stringify(l[k]) !== JSON.stringify(b[k])) res[k] = cloneJSON(l[k]);
  });
  res.items = mergeArr(b.items, l.items, s.items);
  const inList = new Set(res.items);
  res.bought = mergeArr(b.bought, l.bought, s.bought).filter(i=>inList.has(i));
  ['quantities','notes','addedBy'].forEach(m=>{
    if(!l[m] && !s[m] && !b[m]) return;
    const merged = mergeMap(b[m], l[m], s[m]);
    Object.keys(merged).forEach(k=>{ if(!inList.has(k)) delete merged[k]; });
    res[m] = merged;
  });
  return res;
}
// base = common ancestor, local = this device, server = latest stored copy
function mergeShoppingLists(base, local, server){
  base = base || {}; local = local || {}; server = server || {};
  const out = {};
  new Set([...Object.keys(server), ...Object.keys(local)]).forEach(id=>{
    const b = base[id], l = local[id], sv = server[id];
    if(!l){ if(!b) out[id] = cloneJSON(sv); return; }          // missing here: new elsewhere → keep; was here before → we deleted it
    if(!sv){ if(!b) out[id] = cloneJSON(l); return; }          // missing on server: new here → keep; existed before → deleted elsewhere
    out[id] = mergeOneList(b || {}, l, sv);
  });
  if(!Object.keys(out).length) out.main = { name:'רשימה ראשית', items:[], bought:[] };
  return out;
}
// Copy the live Sets (what the UI edits) back into the lists object before merging.
function syncLiveSetsIntoList(){
  const l = shoppingLists[activeListId];
  if(l){ l.items = [...shoppingList]; l.bought = [...boughtItems]; }
}
function adoptShoppingLists(next){
  shoppingLists = (next && Object.keys(next).length) ? next : { main:{ name:'רשימה ראשית', items:[], bought:[], syncCode:null } };
  if(!shoppingLists[activeListId]) activeListId = shoppingLists.main ? 'main' : Object.keys(shoppingLists)[0];
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
  localStorage.setItem('active_shopping_list', activeListId);
  shoppingList = new Set(getActiveList().items||[]);
  boughtItems = new Set(getActiveList().bought||[]);
  syncCode = getActiveList().syncCode || null;
}
// ---- Shopping list version history (kept on each device) ----
// Before anything removes items or un-checks them (a change from another phone, an app update, a restore),
// the previous list is saved here, so it can be brought back from Settings → ניהול רשימת קניות.
const SHOP_HISTORY_MAX = 30;
function shopHistoryKey(rowId){ return 'shopping_history_' + (rowId || activeShoppingRowId || 'local'); }
function readShopHistory(rowId){ try{ return JSON.parse(localStorage.getItem(shopHistoryKey(rowId)) || '[]'); }catch(e){ return []; } }
function listsSignature(lists){
  return JSON.stringify(Object.keys(lists || {}).sort().map(id=>[id, (lists[id].items||[]).slice().sort(), (lists[id].bought||[]).slice().sort()]));
}
// true if going from `before` to `after` loses an item, a whole list, or a check mark
function shoppingChangeLosesSomething(before, after){
  before = before || {}; after = after || {};
  return Object.keys(before).some(id=>{
    const b = before[id] || {}, a = after[id];
    if(!a) return (b.items||[]).length > 0;
    const aItems = new Set(a.items || []), aBought = new Set(a.bought || []);
    return (b.items||[]).some(i=>!aItems.has(i)) || (b.bought||[]).some(i=>aItems.has(i) && !aBought.has(i));
  });
}
function snapshotShopping(lists, why, rowId){
  if(!lists || !Object.keys(lists).some(id=>(lists[id].items||[]).length)) return;
  const h = readShopHistory(rowId);
  const sig = listsSignature(lists);
  if(h.length && h[0].sig === sig) return;
  h.unshift({ t: new Date().toISOString(), why, sig, lists: cloneJSON(lists) });
  const key = shopHistoryKey(rowId);
  try{ localStorage.setItem(key, JSON.stringify(h.slice(0, SHOP_HISTORY_MAX))); }
  catch(e){ try{ localStorage.setItem(key, JSON.stringify(h.slice(0, 8))); }catch(e2){} }
}
function restoreShoppingSnapshot(entry){
  syncLiveSetsIntoList();
  snapshotShopping(shoppingLists, 'לפני שחזור');
  const keepActive = activeListId;
  adoptShoppingLists(cloneJSON(entry.lists));
  if(entry.lists[keepActive]){ activeListId = keepActive; adoptShoppingLists(shoppingLists); }
  scheduleShoppingPush();
  pushSync();
  refreshShoppingViews();
}
function openShopHistorySheet(){
  syncLiveSetsIntoList();
  const h = readShopHistory();
  const fmt = (iso)=> new Date(iso).toLocaleString('he-IL', { day:'numeric', month:'numeric', hour:'2-digit', minute:'2-digit' });
  const diffText = (snap)=>{
    const now = new Set(Object.values(shoppingLists).flatMap(l=>l.items||[]));
    const then = new Set(Object.values(snap).flatMap(l=>l.items||[]));
    const back = [...then].filter(i=>!now.has(i)), gone = [...now].filter(i=>!then.has(i));
    const cut = (arr)=> arr.slice(0,6).map(escHtml).join(', ') + (arr.length>6 ? ` ועוד ${arr.length-6}` : '');
    if(!back.length && !gone.length) return '<div class="hist-diff">אותם פריטים כמו עכשיו (ייתכן שהסימונים שונים)</div>';
    return (back.length ? `<div class="hist-diff hist-back">יחזרו (${back.length}): ${cut(back)}</div>` : '')
         + (gone.length ? `<div class="hist-diff hist-gone">יוסרו (${gone.length}): ${cut(gone)}</div>` : '');
  };
  const rows = h.map((e, i)=>{
    const total = Object.values(e.lists).reduce((n,l)=>n + (l.items||[]).length, 0);
    return `<div class="hist-row">
      <div class="hist-main">
        <div class="hist-title">${escHtml(fmt(e.t))} · ${escHtml(e.why)}</div>
        <div class="hist-sub">${total} פריטים</div>
        ${diffText(e.lists)}
      </div>
      <button type="button" class="hist-restore" data-i="${i}">שחזרו</button>
    </div>`;
  }).join('');
  const ov = openSheet('shopHistorySheet', `
    <div class="sheet-head"><h3>גרסאות קודמות של הרשימה</h3><button type="button" class="sheet-x" id="hsClose" aria-label="סגירה">×</button></div>
    <p class="settings-hint" style="margin:0 0 10px;">נשמרות במכשיר הזה בכל פעם שפריטים נמחקים או מסומנים מחדש. שחזור מעדכן את הרשימה בכל המכשירים.</p>
    ${rows || '<p class="custom-empty">עדיין אין גרסאות שמורות במכשיר הזה.</p>'}`, 'tall');
  ov.querySelector('#hsClose').onclick = ()=> ov.remove();
  ov.querySelectorAll('.hist-restore').forEach(btn=>{
    btn.onclick = ()=>{
      const e = h[+btn.dataset.i];
      showConfirmModal(`לשחזר את הרשימה כפי שהייתה ב-${fmt(e.t)}? הגרסה הנוכחית תישמר כאן ואפשר יהיה לחזור אליה.`, ()=>{
        restoreShoppingSnapshot(e);
        ov.remove();
      });
    };
  });
}
function subscribeShoppingRealtime(rowId){
  if(shoppingRealtimeChannel){ sbClient.removeChannel(shoppingRealtimeChannel); shoppingRealtimeChannel = null; }
  if(!rowId || !sbClient) return;
  shoppingRealtimeChannel = sbClient
    .channel('shopping_row_' + rowId)
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'user_data', filter:`id=eq.${rowId}` }, (payload)=>{
      const newRow = payload.new;
      if(!newRow || rowId !== activeShoppingRowId) return;
      if(newRow.updated_at && lastShoppingUpdatedAt && tsOf(newRow.updated_at) <= tsOf(lastShoppingUpdatedAt)) return;   // older / already-seen copy
      if(newRow.updated_at) lastShoppingUpdatedAt = newRow.updated_at;
      const remote = (newRow.payload && Object.keys(newRow.payload).length) ? newRow.payload : null;
      if(!remote) return;
      const listsBefore = cloneJSON(shoppingLists);
      syncLiveSetsIntoList();
      const busy = shoppingPushPending || shoppingPushInFlight;
      // Unsent local edits are kept on top of the incoming copy instead of being thrown away.
      const next = busy ? mergeShoppingLists(shoppingBase || remote, shoppingLists, remote) : cloneJSON(remote);
      setShoppingBase(remote, rowId);
      if(shoppingChangeLosesSomething(listsBefore, next)) snapshotShopping(listsBefore, 'לפני שינוי ממכשיר אחר', rowId);
      noticeAddedByOthers(listsBefore, next);
      adoptShoppingLists(next);
      renderShoppingPanel();
      renderTabBadges();
      if(shoppingModeActive) renderShoppingModeList();
    })
    .subscribe();
}
function applyShoppingRow(row){
  const prevRowId = localStorage.getItem('active_shopping_row');
  const server = (row.payload && Object.keys(row.payload).length) ? row.payload : {main:{name:'רשימה ראשית', items:[], bought:[], syncCode:null}};
  // Edits made on this phone while offline (or right before closing the app) are still in localStorage.
  // If they were built on a known copy of THIS row, merge them in rather than discarding them.
  let next = cloneJSON(server);
  let hadOfflineEdits = false;
  let localBefore = null;
  if(prevRowId === row.id){
    try{
      const savedBase = localStorage.getItem('shopping_base_' + row.id);
      const localNow = localStorage.getItem('shopping_lists');
      if(localNow) localBefore = JSON.parse(localNow);
      if(savedBase && localNow && savedBase !== localNow){
        next = mergeShoppingLists(JSON.parse(savedBase), JSON.parse(localNow), server);
        hadOfflineEdits = JSON.stringify(next) !== JSON.stringify(server);
      }
    }catch(e){}
  }
  activeShoppingRowId = row.id;
  lastShoppingUpdatedAt = row.updated_at || null;
  if(localBefore && shoppingChangeLosesSomething(localBefore, next)){
    const firstRun = !localStorage.getItem('shopping_base_' + row.id);
    snapshotShopping(localBefore, firstRun ? 'לפני עדכון האפליקציה' : 'לפני סנכרון בפתיחה', row.id);
  }
  localStorage.setItem('active_shopping_row', row.id);
  setShoppingBase(server, row.id);
  adoptShoppingLists(next);
  subscribeShoppingRealtime(row.id);
  if(hadOfflineEdits) scheduleShoppingPush();
}
function applyRecipesRow(row){
  activeRecipesRowId = row.id;
  localStorage.setItem('active_recipes_row', row.id);
  customRecipes.forEach(r=>{ if(BUILTIN_RECIPE_NAMES.has(r.name)) return; const idx = RECIPES.findIndex(x=>x.name===r.name); if(idx>-1) RECIPES.splice(idx,1); });
  const incoming = Array.isArray(row.payload) ? row.payload : [];
  // Recipes that are now part of the app's built-in list are dropped from the personal copy,
  // so they don't appear twice (and the account copy is cleaned up on the next save).
  customRecipes = incoming.filter(r=>r && !BUILTIN_RECIPE_NAMES.has(r.name));
  localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
  RECIPES.push(...customRecipes);
  if(customRecipes.length !== incoming.length && currentUser) setTimeout(()=>{ try{ pushRecipesRow(); }catch(e){} }, 0);
}
// ---- Household ("משק בית") ----
// A household is a group of users that share ALL four data rows (shopping, recipes, fridge/app state, categories)
// through one invitation. Household rows are ordinary user_data rows with household_id set.
let householdSupported = null;   // null = unknown, false = SQL migration not applied yet
let myHousehold = null;          // {id, name, role}
let householdMembers = [];       // [{user_id, email, role}]
const HOUSEHOLD_KINDS = ['shopping_lists','custom_recipes','app_state','category_settings'];
function rowLabel(r){
  if(myHousehold && r.household_id && r.household_id === myHousehold.id) return 'משק הבית';
  return r.owner_id === currentUser.id ? 'שלי' : r.owner_email;
}
async function loadHousehold(){
  if(!sbClient || !currentUser){ myHousehold = null; householdMembers = []; return; }
  try{
    const { data: mem, error } = await sbClient.from('household_members').select('household_id, role').eq('user_id', currentUser.id).maybeSingle();
    if(error){
      if(/relation|does not exist|schema cache|PGRST205|42P01/i.test((error.message||'') + (error.code||''))){ householdSupported = false; myHousehold = null; householdMembers = []; }
      return;
    }
    householdSupported = true;
    if(!mem){ myHousehold = null; householdMembers = []; return; }
    // the household's name and its members are fetched together (one wait instead of two)
    const [hRes, mRes] = await Promise.all([
      sbClient.from('households').select('id, name').eq('id', mem.household_id).maybeSingle(),
      sbClient.rpc('get_household_members', { hid: mem.household_id })
    ]);
    const h = hRes && hRes.data;
    myHousehold = { id: mem.household_id, role: mem.role, name: (h && h.name) || 'משק הבית' };
    householdMembers = (mRes && mRes.data) || [];
  }catch(e){ /* offline or not available — keep what we had */ }
}
function householdMissingKinds(){
  if(!myHousehold) return [];
  const byKind = { shopping_lists: accountShoppingRows, custom_recipes: accountRecipeRows, app_state: accountStateRows, category_settings: accountCategorySettingsRows };
  return HOUSEHOLD_KINDS.filter(k => !(byKind[k]||[]).some(r => r.household_id === myHousehold.id));
}

async function loadAccountData(){
  // everything is requested at once — one round-trip of waiting instead of six in a row
  const [, ...prefetched] = await Promise.all([loadHousehold(), ...HOUSEHOLD_KINDS.map(k=>fetchUserDataRows(k))]);
  const prefetchedByKind = {};
  HOUSEHOLD_KINDS.forEach((k,i)=>{ prefetchedByKind[k] = prefetched[i]; });
  const hid = myHousehold ? myHousehold.id : null;
  const appliedKey = hid ? 'household_applied_' + hid : null;
  let foundHouseholdRow = false;

  const cfgs = [
    { kind:'shopping_lists',    set:(r)=>{ accountShoppingRows = r; },          rows:()=>accountShoppingRows,          active:()=>activeShoppingRowId,          payload:()=>shoppingLists,           apply:applyShoppingRow },
    { kind:'custom_recipes',    set:(r)=>{ accountRecipeRows = r; },            rows:()=>accountRecipeRows,            active:()=>activeRecipesRowId,           payload:()=>customRecipes,           apply:applyRecipesRow },
    { kind:'app_state',         set:(r)=>{ accountStateRows = r; },             rows:()=>accountStateRows,             active:()=>activeStateRowId,             payload:()=>collectAppState(),       apply:applyAppStateRow },
    { kind:'category_settings', set:(r)=>{ accountCategorySettingsRows = r; },  rows:()=>accountCategorySettingsRows,  active:()=>activeCategorySettingsRowId, payload:()=>collectCategorySettings(), apply:applyCategorySettingsRow }
  ];
  for(const cfg of cfgs){
    cfg.set(prefetchedByKind[cfg.kind] || await fetchUserDataRows(cfg.kind));
    const rows = cfg.rows();
    const own = rows.filter(r=>r.owner_id === currentUser.id);
    let mine = own.find(r=>!r.household_id && (cfg.kind !== 'shopping_lists' || (r.payload && r.payload.main))) || own.find(r=>!r.household_id) || own[0];
    const hrow = hid ? rows.find(r=>r.household_id === hid) : null;
    if(!mine && !hrow){
      const { data } = await sbClient.from('user_data').insert({
        owner_id: currentUser.id, owner_email: currentUser.email, kind: cfg.kind, payload: cfg.payload()
      }).select().single();
      if(data){ mine = data; rows.push(mine); }
    }
    let pick = null;
    if(hrow){ foundHouseholdRow = true; }
    const stored = cfg.active();
    if(hrow && localStorage.getItem(appliedKey) !== '1') pick = hrow;                 // first time in a household: switch to its data
    else if(stored && rows.find(r=>r.id === stored)) pick = rows.find(r=>r.id === stored);
    else pick = hrow || mine;
    if(pick) cfg.apply(pick);
  }
  if(appliedKey && foundHouseholdRow) localStorage.setItem(appliedKey, '1');
  renderAll();
  saveListsOverviewCache();
  prefetchShareEmails();
  refreshPushRegistration();
}
// ---- quick start: the lists page is shown from the last known copy while the fresh data loads ----
function listsOverviewCacheKey(){ return currentUser ? 'lists_overview_cache_' + currentUser.id : null; }
function saveListsOverviewCache(){
  const key = listsOverviewCacheKey();
  if(!key) return;
  try{
    const emails = {};
    Object.keys(sharedEmailsCache).forEach(id=>{ const c = sharedEmailsCache[id]; if(c && !c.error) emails[id] = c.emails; });
    localStorage.setItem(key, JSON.stringify({
      rows: accountShoppingRows.map(r=>({ id:r.id, owner_id:r.owner_id, owner_email:r.owner_email, household_id:r.household_id||null, kind:r.kind, payload:r.payload, updated_at:r.updated_at })),
      household: myHousehold, members: householdMembers, emails
    }));
  }catch(e){}
}
function restoreListsOverviewCache(){
  const key = listsOverviewCacheKey();
  if(!key || accountShoppingRows.length) return false;
  try{
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if(!c || !Array.isArray(c.rows) || !c.rows.length) return false;
    if(activeShoppingRowId && !c.rows.some(r=>r.id === activeShoppingRowId)) return false;
    accountShoppingRows = c.rows;
    if(!myHousehold && c.household){ myHousehold = c.household; householdMembers = c.members || []; }
    Object.keys(c.emails || {}).forEach(id=>{ if(!sharedEmailsCache[id]) sharedEmailsCache[id] = { error:false, emails:c.emails[id] }; });
    return true;
  }catch(e){ return false; }
}
// who each own list is shared with — asked for all lists at once, in the background
function prefetchShareEmails(){
  if(!sbClient || !currentUser) return;
  const own = accountShoppingRows.filter(r=>rowShareKind(r) === 'own');
  if(!own.length) return;
  Promise.all(own.map(r=>fetchSharedEmails(r.id, true).catch(()=>{}))).then(()=>{
    saveListsOverviewCache();
    if(activeTab === 'shopping' && showingShopOverview()) renderShoppingPanel();
  });
}
let shoppingPushTimer = null;
let shoppingPushPending = false;    // local edits not yet sent — a refresh must not overwrite them
let shoppingPushInFlight = false;
let shoppingPushAgain = false;
// Read the latest server copy → 3-way merge with our edits → write back only if nobody wrote in between
// (compare-and-swap on updated_at). If someone did, start over from their newer copy.
async function pushShoppingRow(){
  if(!currentUser || !activeShoppingRowId || !sbClient) return;
  clearTimeout(shoppingPushTimer);
  if(shoppingPushInFlight){ shoppingPushAgain = true; return; }
  shoppingPushInFlight = true;
  const rowId = activeShoppingRowId;
  let ok = false;
  try{
    for(let attempt = 0; attempt < 4 && !ok; attempt++){
      shoppingPushPending = false;
      syncLiveSetsIntoList();
      const sent = cloneJSON(shoppingLists);
      const sentBase = shoppingBase ? cloneJSON(shoppingBase) : null;   // the base must be captured together with the snapshot
      const { data: srv, error } = await sbClient.from('user_data').select('payload, updated_at').eq('id', rowId).single();
      if(error || !srv) throw (error || new Error('row not found'));
      if(rowId !== activeShoppingRowId) return;
      const serverLists = (srv.payload && Object.keys(srv.payload).length) ? srv.payload : {};
      const merged = mergeShoppingLists(sentBase || serverLists, sent, serverLists);
      const stamp = nextStamp(srv.updated_at);
      let q = sbClient.from('user_data').update({ payload: merged, updated_at: stamp }).eq('id', rowId);
      q = srv.updated_at ? q.eq('updated_at', srv.updated_at) : q.is('updated_at', null);
      let { data: upd, error: e2 } = await q.select('updated_at');
      if(e2) throw e2;
      if(!upd || !upd.length){
        // Nothing updated: either someone else wrote first (retry from their copy), or the timestamp
        // filter didn't match for a technical reason. If the row is unchanged, write without the filter.
        const { data: again } = await sbClient.from('user_data').select('updated_at').eq('id', rowId).single();
        if(again && again.updated_at === srv.updated_at){
          const r2 = await sbClient.from('user_data').update({ payload: merged, updated_at: stamp }).eq('id', rowId).select('updated_at');
          if(r2.error) throw r2.error;
          upd = r2.data;
        }
      }
      if(rowId !== activeShoppingRowId) return;
      if(upd && upd.length){
        ok = true;
        lastShoppingUpdatedAt = upd[0].updated_at || stamp;
        setShoppingBase(merged, rowId);
        syncLiveSetsIntoList();
        const before = JSON.stringify(shoppingLists);
        // keep anything edited while the request was travelling
        const next = mergeShoppingLists(sent, shoppingLists, merged);
        adoptShoppingLists(next);
        if(JSON.stringify(shoppingLists) !== before){
          renderShoppingPanel(); renderTabBadges();
          if(shoppingModeActive) renderShoppingModeList();
        }
      }
    }
    if(!ok) shoppingPushPending = true;
  }catch(e){
    shoppingPushPending = true;   // offline — local copy is saved; we'll retry on the next edit / when the app regains focus
  }finally{
    shoppingPushInFlight = false;
    if(shoppingPushAgain || (ok && shoppingPushPending)){ shoppingPushAgain = false; scheduleShoppingPush(); }
  }
}
function scheduleShoppingPush(){
  if(!currentUser || !activeShoppingRowId) return;
  shoppingPushPending = true;
  clearTimeout(shoppingPushTimer);
  shoppingPushTimer = setTimeout(pushShoppingRow, 500);
}
async function refreshShoppingRowFromAccount(){
  if(!currentUser || !activeShoppingRowId || !sbClient) return;
  if(shoppingPushPending || shoppingPushInFlight){ pushShoppingRow(); return; }   // the push itself merges in the latest server copy
  const rowId = activeShoppingRowId;
  try{
    const { data, error } = await sbClient.from('user_data').select('*').eq('id', rowId).single();
    if(error || !data || rowId !== activeShoppingRowId) return;
    if(shoppingPushPending || shoppingPushInFlight) return;                       // an edit happened while we were fetching
    if(data.updated_at && lastShoppingUpdatedAt && tsOf(data.updated_at) < tsOf(lastShoppingUpdatedAt)) return;
    lastShoppingUpdatedAt = data.updated_at || lastShoppingUpdatedAt;
    const remote = (data.payload && Object.keys(data.payload).length) ? data.payload : null;
    if(!remote) return;
    setShoppingBase(remote, rowId);
    syncLiveSetsIntoList();
    if(shoppingChangeLosesSomething(shoppingLists, remote)) snapshotShopping(cloneJSON(shoppingLists), 'לפני שינוי ממכשיר אחר', rowId);
    adoptShoppingLists(cloneJSON(remote));
    renderShoppingPanel();
    renderTabBadges();
    if(shoppingModeActive) renderShoppingModeList();
  }catch(e){ /* offline — keep showing local copy */ }
}
async function pushRecipesRow(){
  if(!currentUser || !activeRecipesRowId || !sbClient) return;
  try{
    await sbClient.from('user_data').update({payload: customRecipes, updated_at: new Date().toISOString()}).eq('id', activeRecipesRowId);
  }catch(e){ /* offline — local copy is already saved */ }
}

function householdErrorText(code){
  const map = {
    'user not found': 'המשתמש/ת לא רשום/ה באפליקציה — צריך קודם להירשם (עם אותו אימייל).',
    'already a member': 'כבר חבר/ה במשק הבית.',
    'user is in another household': 'כבר שייך/ת למשק בית אחר.',
    'not an admin': 'רק מנהל/ת משק הבית יכול/ה לעשות את זה.',
    'not a member': 'המשתמש/ת לא חבר/ה במשק הבית.',
    'admin cannot leave while other members remain': 'מנהל/ת משק הבית לא יכול/ה לעזוב כל עוד יש חברים נוספים — קודם מסירים אותם.',
    'already in a household': 'אתם כבר חלק ממשק בית.'
  };
  return map[code] || code;
}
async function householdMoveMyData(){
  const { error } = await sbClient.rpc('move_my_rows_to_household', { hid: myHousehold.id });
  if(error) throw error;
  const specs = [['shopping_lists',()=>shoppingLists],['custom_recipes',()=>customRecipes],['app_state',collectAppState],['category_settings',collectCategorySettings]];
  for(const [kind, payloadFn] of specs){
    const rows = await fetchUserDataRows(kind);
    if(!rows.some(r=>r.household_id === myHousehold.id)){
      await sbClient.from('user_data').insert({ owner_id: currentUser.id, owner_email: currentUser.email, kind, payload: payloadFn(), household_id: myHousehold.id });
    }
  }
  localStorage.removeItem('household_applied_' + myHousehold.id);
  await loadAccountData();
}
function renderHouseholdBox(){
  const el = document.getElementById('householdBox');
  if(!el) return;
  if(householdSupported === false){
    el.innerHTML = `<div class="household-card"><div class="household-title">משק בית</div>
      <p class="settings-hint" style="margin:6px 0 0;">התכונה הזו דורשת עדכון חד-פעמי של בסיס הנתונים (SQL). עד אז אפשר להשתמש בשיתוף הנפרד שמתחת.</p></div>`;
    return;
  }
  if(householdSupported === null){ el.innerHTML = ''; return; }
  if(!myHousehold){
    el.innerHTML = `
      <div class="household-card">
        <div class="household-title">משק בית</div>
        <p class="settings-hint" style="margin:6px 0 10px;">שיתוף אחד לכל המידע — רשימות קניות, מתכונים, מקרר וסיווגים — עם בני המשפחה, בלי לשתף ארבע פעמים בנפרד. המידע שלכם עובר למשק הבית ולא נמחק.</p>
        <div class="add-row">
          <input type="text" id="householdNameInput" placeholder="שם משק הבית (למשל: משפחת שחף)">
          <button id="householdCreateBtn">צרו</button>
        </div>
        <div class="cam-status" id="householdStatus"></div>
      </div>`;
    document.getElementById('householdCreateBtn').onclick = async ()=>{
      const status = document.getElementById('householdStatus');
      status.textContent = 'יוצרים...';
      try{
        const { error } = await sbClient.rpc('create_household', { h_name: norm(document.getElementById('householdNameInput').value) });
        if(error) throw error;
        await loadHousehold();
        await householdMoveMyData();
        renderAccountBox();
      }catch(e){ status.textContent = 'שגיאה: ' + householdErrorText(e.message||''); }
    };
    return;
  }
  const isAdmin = myHousehold.role === 'admin';
  const missing = householdMissingKinds();
  el.innerHTML = `
    <div class="household-card">
      <div class="household-title">משק בית: ${escHtml(myHousehold.name)}</div>
      <div class="household-members">
        ${householdMembers.map(m=>`
          <div class="household-member">
            <span dir="ltr">${escHtml(m.email)}</span>
            <span class="household-role">${m.role==='admin'?'מנהל/ת':''}</span>
            ${(isAdmin && m.user_id !== currentUser.id) || (m.user_id === currentUser.id && !(isAdmin && householdMembers.length>1))
              ? `<button type="button" class="unshare-btn household-remove" data-email="${escAttr(m.email)}" data-self="${m.user_id===currentUser.id?'1':''}" aria-label="${m.user_id===currentUser.id?'עזיבת משק הבית':'הסרה ממשק הבית'}">×</button>` : ''}
          </div>`).join('')}
      </div>
      ${isAdmin ? `
        <div class="add-row" style="margin-top:10px;">
          <input type="email" id="householdInviteEmail" placeholder="אימייל של בן/בת משפחה (רשום/ה באפליקציה)">
          <button id="householdInviteBtn">הזמינו</button>
        </div>` : ''}
      ${missing.length && isAdmin ? `
        <button type="button" class="import-btn secondary" id="householdMoveBtn" style="margin-top:10px;">העבירו את המידע שלי למשק הבית</button>` : ''}
      <div class="cam-status" id="householdStatus"></div>
    </div>`;
  const status = document.getElementById('householdStatus');
  const inviteBtn = document.getElementById('householdInviteBtn');
  if(inviteBtn) inviteBtn.onclick = async ()=>{
    const email = norm(document.getElementById('householdInviteEmail').value);
    if(!email) return;
    status.textContent = 'מזמינים...';
    try{
      const { data, error } = await sbClient.rpc('invite_to_household', { hid: myHousehold.id, target_email: email });
      if(error) throw error;
      if(data !== 'ok'){ status.textContent = householdErrorText(data); return; }
      await loadHousehold();
      renderAccountBox();
      const st = document.getElementById('householdStatus'); if(st) st.textContent = '✓ נוסף/ה למשק הבית — בכניסה הבאה יראו את המידע המשותף';
    }catch(e){ status.textContent = 'שגיאה: ' + householdErrorText(e.message||''); }
  };
  const moveBtn = document.getElementById('householdMoveBtn');
  if(moveBtn) moveBtn.onclick = async ()=>{
    status.textContent = 'מעבירים...';
    try{ await householdMoveMyData(); renderAccountBox(); }
    catch(e){ status.textContent = 'שגיאה: ' + householdErrorText(e.message||''); }
  };
  el.querySelectorAll('.household-remove').forEach(btn=>{
    btn.onclick = ()=>{
      const self = btn.dataset.self === '1';
      showConfirmModal(self ? 'לעזוב את משק הבית? המידע האישי שלכם יישאר אצלכם.' : `להסיר את ${btn.dataset.email} ממשק הבית?`, async ()=>{
        try{
          const { data, error } = await sbClient.rpc('remove_from_household', { hid: myHousehold.id, target_email: btn.dataset.email });
          if(error) throw error;
          if(data !== 'ok'){ alert(householdErrorText(data)); return; }
          if(self){ localStorage.removeItem('household_applied_' + myHousehold.id); await loadAccountData(); }
          else { await loadHousehold(); }
          renderAccountBox();
        }catch(e){ alert('שגיאה: ' + householdErrorText(e.message||'')); }
      });
    };
  });
}

async function shareRow(rowId, email){
  const { data, error } = await sbClient.rpc('share_data_with_email', {row_id: rowId, target_email: email});
  if(error) throw error;
  return data;
}

// "Who have I shared this with?" — emails resolved server-side (get_shared_emails RPC, owner-only),
// cached per row so re-renders don't hit the network every time.
const sharedEmailsCache = {};
const sharedEmailsPending = {};
function ownerOfRow(rowId){
  const all = [].concat(accountShoppingRows, accountRecipeRows, accountStateRows, accountCategorySettingsRows);
  return all.find(r=>r.id===rowId) || null;
}
function paintSharedList(containerId, rowId){
  const el = document.getElementById(containerId);
  if(!el) return;
  const row = ownerOfRow(rowId);
  if(row && currentUser && row.owner_id !== currentUser.id){
    el.innerHTML = `<div class="shared-list-note">זה מידע ששותף איתכם על ידי ${escHtml(row.owner_email)} — רק הבעלים רואה עם מי הוא משותף.</div>`;
    return;
  }
  const c = sharedEmailsCache[rowId];
  if(!c){ el.innerHTML = '<div class="shared-list-note">טוענים...</div>'; return; }
  if(c.error){ el.innerHTML = '<div class="shared-list-note">לא ניתן לטעון כרגע את רשימת השיתוף.</div>'; return; }
  if(c.emails.length===0){ el.innerHTML = '<div class="shared-list-note">עדיין לא שיתפתם עם אף אחד.</div>'; return; }
  el.innerHTML = `
    <div class="shared-list-title">משותף עם (${c.emails.length}):</div>
    <div class="shared-list">${c.emails.map(e=>`
      <div class="shared-list-row">
        <span dir="ltr">${escHtml(e)}</span>
        <button type="button" class="unshare-btn" data-email="${escAttr(e)}" aria-label="ביטול שיתוף עם ${escAttr(e)}">×</button>
      </div>`).join('')}</div>`;
  el.querySelectorAll('.unshare-btn').forEach(btn=>{
    btn.onclick = ()=>{
      const email = btn.dataset.email;
      showConfirmModal(`לבטל את השיתוף עם ${email}? הוא/היא לא יראו יותר את המידע הזה.`, async ()=>{
        try{
          const { data, error } = await sbClient.rpc('unshare_data_with_email', {row_id: rowId, target_email: email});
          if(error) throw error;
          if(data !== 'ok') throw new Error(data);
        }catch(e){
          alert('ביטול השיתוף נכשל: ' + (e.message || '') + '\n(ודאו שהרצתם את ה-SQL החדש ב-Supabase)');
          return;
        }
        renderSharedList(containerId, rowId, true);
      });
    };
  });
}
async function renderSharedList(containerId, rowId, force){
  if(!rowId || !sbClient || !currentUser) return;
  paintSharedList(containerId, rowId);
  const row = ownerOfRow(rowId);
  if(row && row.owner_id !== currentUser.id) return;
  if(sharedEmailsCache[rowId] && !force) return;
  if(sharedEmailsPending[rowId]) return;
  sharedEmailsPending[rowId] = true;
  try{
    const { data, error } = await sbClient.rpc('get_shared_emails', {row_id: rowId});
    sharedEmailsCache[rowId] = error ? {error:true, emails:[]} : {error:false, emails:(Array.isArray(data) ? data : [])};
  }catch(e){
    sharedEmailsCache[rowId] = {error:true, emails:[]};
  }
  delete sharedEmailsPending[rowId];
  paintSharedList(containerId, rowId);
}
async function doLogout(){
  try{ await disablePush(); }catch(e){}
  await sbClient.auth.signOut();
  subscribeShoppingRealtime(null);
  currentUser = null;
  shoppingBase = null; lastShoppingUpdatedAt = null; shoppingPushPending = false;
  activeShoppingRowId = null;
  activeRecipesRowId = null;
  activeStateRowId = null;
  activeCategorySettingsRowId = null;
  Object.keys(sharedEmailsCache).forEach(k=>delete sharedEmailsCache[k]);
  myHousehold = null; householdMembers = [];
  accountShoppingRows = [];
  try{ Object.keys(localStorage).filter(k=>k.startsWith('lists_overview_cache_')).forEach(k=>localStorage.removeItem(k)); }catch(e){}
  localStorage.removeItem('active_shopping_row');
  localStorage.removeItem('active_recipes_row');
  localStorage.removeItem('active_state_row');
  localStorage.removeItem('active_category_settings_row');
  renderAccountBox();
}
// ---- Google sign-in (Supabase OAuth) ----
const GOOGLE_ICON_SVG = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
// Where Google sends you back after signing in: this same page, without any #/?query.
// This address must be listed in Supabase → Authentication → URL Configuration → Redirect URLs.
function oauthReturnUrl(){ return location.origin + location.pathname; }
async function signInWithGoogle(statusEl){
  if(!sbClient) return;
  if(statusEl) statusEl.textContent = 'עוברים לגוגל...';
  try{ sessionStorage.setItem('oauth_pending', '1'); }catch(e){}
  // push anything not yet saved before leaving the page
  try{ if(shoppingPushPending) await pushShoppingRow(); }catch(e){}
  const { error } = await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: oauthReturnUrl(), queryParams: { prompt: 'select_account' } }
  });
  if(error && statusEl) statusEl.textContent = 'שגיאה: ' + (error.message || 'הכניסה עם גוגל נכשלה');
}
// Reads an error Google/Supabase sent back in the address (e.g. provider not enabled, address not allowed).
function takeOAuthError(){
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(location.search);
  const msg = h.get('error_description') || q.get('error_description') || h.get('error') || q.get('error');
  if(msg) history.replaceState(null, '', location.pathname);
  return msg ? decodeURIComponent(String(msg).replace(/\+/g, ' ')) : '';
}
let pendingOAuthError = '';

function renderAccountBox(){
  const el = document.getElementById('accountBox');
  if(!el) return;
  if(!sbClient){
    el.innerHTML = '<p class="custom-empty">טעינת מודול ההתחברות נכשלה — בדקו חיבור לאינטרנט ורעננו את הדף.</p>';
    return;
  }
  if(!currentUser){
    el.innerHTML = `
      <div class="sync-box">
        <button type="button" class="google-btn" id="acctGoogleBtn">${GOOGLE_ICON_SVG}<span>כניסה עם חשבון Google</span></button>
        <div class="cam-status" id="acctGoogleStatus">${escHtml(pendingOAuthError ? 'הכניסה עם גוגל נכשלה: ' + pendingOAuthError : '')}</div>
        <p class="settings-hint" style="margin:8px 0 0;">יש לכם כבר חשבון עם אימייל וסיסמה? אם זו אותה כתובת Gmail, הכניסה עם גוגל תפתח את אותו החשבון עם כל הנתונים.</p>
      </div>
      <div class="acct-or"><span>או עם אימייל וסיסמה</span></div>
      <form class="sync-box" id="acctForm" autocomplete="on">
        <input type="email" id="acctEmail" name="username" autocomplete="username" placeholder="אימייל" class="acct-input">
        <input type="password" id="acctPassword" name="password" autocomplete="current-password" placeholder="סיסמה (לפחות 6 תווים)" class="acct-input">
        <div class="acct-btn-row">
          <button type="button" id="acctLoginBtn">התחברות</button>
          <button type="button" id="acctSignupBtn">הרשמה</button>
          <button type="button" id="acctForgotBtn" class="secondary">שכחתי סיסמה</button>
        </div>
        <div class="cam-status" id="acctStatus"></div>
      </form>`;
    document.getElementById('acctGoogleBtn').onclick = ()=> signInWithGoogle(document.getElementById('acctGoogleStatus'));
    document.getElementById('acctForm').addEventListener('submit', (e)=>{ e.preventDefault(); document.getElementById('acctLoginBtn').click(); });
    document.getElementById('acctLoginBtn').onclick = async ()=>{
      const email = norm(document.getElementById('acctEmail').value);
      const password = document.getElementById('acctPassword').value;
      const status = document.getElementById('acctStatus');
      status.textContent = 'מתחברים...';
      try{
        const { error } = await sbClient.auth.signInWithPassword({email, password});
        if(error) throw error;
        currentUser = (await sbClient.auth.getUser()).data.user;
        applyDisplayPrefsFromUser(currentUser);
        status.textContent = '';
        await loadAccountData();
        renderAccountBox();
      }catch(e){ status.textContent = 'שגיאה: ' + (e.message||'התחברות נכשלה'); }
    };
    document.getElementById('acctSignupBtn').onclick = async ()=>{
      const email = norm(document.getElementById('acctEmail').value);
      const password = document.getElementById('acctPassword').value;
      const status = document.getElementById('acctStatus');
      status.textContent = 'נרשמים...';
      try{
        const { error } = await sbClient.auth.signUp({email, password});
        if(error) throw error;
        status.textContent = 'נרשמתם! אם נדרש אימות אימייל, בדקו את תיבת הדואר ואז התחברו.';
      }catch(e){ status.textContent = 'שגיאה: ' + (e.message||'הרשמה נכשלה'); }
    };
    document.getElementById('acctForgotBtn').onclick = async ()=>{
      const email = norm(document.getElementById('acctEmail').value);
      const status = document.getElementById('acctStatus');
      if(!email){ status.textContent = 'הזינו קודם את כתובת האימייל'; return; }
      try{
        const { error } = await sbClient.auth.resetPasswordForEmail(email);
        if(error) throw error;
        status.textContent = 'נשלח מייל לאיפוס סיסמה';
      }catch(e){ status.textContent = 'שגיאה: ' + (e.message||''); }
    };
    return;
  }

  const shopPicker = accountShoppingRows.length>1 ? `
    <div class="acct-picker">
      <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">איזו רשימת קניות להציג:</div>
      <select id="shopRowPicker" class="week-select">
        ${accountShoppingRows.map(r=>`<option value="${r.id}" ${r.id===activeShoppingRowId?'selected':''}>${escHtml(rowLabel(r))}</option>`).join('')}
      </select>
    </div>` : '';
  const recPicker = accountRecipeRows.length>1 ? `
    <div class="acct-picker">
      <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">אילו מתכונים להציג:</div>
      <select id="recRowPicker" class="week-select">
        ${accountRecipeRows.map(r=>`<option value="${r.id}" ${r.id===activeRecipesRowId?'selected':''}>${escHtml(rowLabel(r))}</option>`).join('')}
      </select>
    </div>` : '';
  const statePicker = accountStateRows.length>1 ? `
    <div class="acct-picker">
      <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">איזה מקרר ונתונים נוספים להציג:</div>
      <select id="stateRowPicker" class="week-select">
        ${accountStateRows.map(r=>`<option value="${r.id}" ${r.id===activeStateRowId?'selected':''}>${escHtml(rowLabel(r))}</option>`).join('')}
      </select>
    </div>` : '';
  el.innerHTML = `
    <div class="sync-box">
      <div class="sync-row">
        <span class="sync-status">✓ מחוברים כ-<b>${escHtml(currentUser.email)}</b></span>
        <button id="acctLogoutBtn">התנתקות</button>
      </div>
      <div id="householdBox"></div>
      ${recPicker}${statePicker}
      <div class="settings-hint" style="margin:14px 0 6px;font-weight:700;">שיתוף נפרד לפי סוג מידע (מתקדם)</div>
      <div class="acct-picker">
        <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">רשימות קניות</div>
        <p class="settings-hint" style="margin:0;">כל רשימה משותפת בנפרד: בלשונית הקניות לוחצים ⋮ ליד הרשימה ← "עם מי הרשימה משותפת".</p>
      </div>
      <div class="acct-picker">
        <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">שתפו את המתכונים שלכם עם:</div>
        <div class="add-row">
          <input type="email" id="shareRecipesEmail" placeholder="אימייל של השותף/ה">
          <button id="shareRecipesBtn">שתפו</button>
        </div>
        <div id="sharedListRecipes"></div>
      </div>
      <div class="acct-picker">
        <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">שתפו את המקרר ושאר הנתונים (מועדפים, היסטוריה, תוכנית שבועית...) עם:</div>
        <div class="add-row">
          <input type="email" id="shareStateEmail" placeholder="אימייל של השותף/ה">
          <button id="shareStateBtn">שתפו</button>
        </div>
        <div id="sharedListState"></div>
      </div>
      <div class="cam-status" id="acctStatus"></div>
    </div>`;
  document.getElementById('acctLogoutBtn').onclick = doLogout;
  const shopPickerEl = document.getElementById('shopRowPicker');
  if(shopPickerEl) shopPickerEl.onchange = ()=>{
    const row = accountShoppingRows.find(r=>r.id===shopPickerEl.value);
    if(row){ applyShoppingRow(row); renderAll(); }
  };
  const recPickerEl = document.getElementById('recRowPicker');
  if(recPickerEl) recPickerEl.onchange = ()=>{
    const row = accountRecipeRows.find(r=>r.id===recPickerEl.value);
    if(row){ applyRecipesRow(row); renderAll(); }
  };
  const statePickerEl = document.getElementById('stateRowPicker');
  if(statePickerEl) statePickerEl.onchange = ()=>{
    const row = accountStateRows.find(r=>r.id===statePickerEl.value);
    if(row){ applyAppStateRow(row); renderAll(); }
  };
  renderHouseholdBox();
  const status = document.getElementById('acctStatus');
  if(document.getElementById('sharedListShopping')) renderSharedList('sharedListShopping', activeShoppingRowId);
  renderSharedList('sharedListRecipes', activeRecipesRowId);
  renderSharedList('sharedListState', activeStateRowId);
  if(document.getElementById('shareShoppingBtn')) document.getElementById('shareShoppingBtn').onclick = async ()=>{
    const email = norm(document.getElementById('shareShoppingEmail').value);
    if(!email) return;
    status.textContent = 'משתפים...';
    try{
      const result = await shareRow(activeShoppingRowId, email);
      status.textContent = result === 'ok' ? '✓ שותף בהצלחה' : 'שגיאה: ' + result;
      if(result === 'ok') renderSharedList('sharedListShopping', activeShoppingRowId, true);
    }catch(e){ status.textContent = 'שגיאה: ' + (e.message||''); }
  };
  document.getElementById('shareRecipesBtn').onclick = async ()=>{
    const email = norm(document.getElementById('shareRecipesEmail').value);
    if(!email) return;
    status.textContent = 'משתפים...';
    try{
      const result = await shareRow(activeRecipesRowId, email);
      status.textContent = result === 'ok' ? '✓ שותף בהצלחה' : 'שגיאה: ' + result;
      if(result === 'ok') renderSharedList('sharedListRecipes', activeRecipesRowId, true);
    }catch(e){ status.textContent = 'שגיאה: ' + (e.message||''); }
  };
  document.getElementById('shareStateBtn').onclick = async ()=>{
    const email = norm(document.getElementById('shareStateEmail').value);
    if(!email) return;
    status.textContent = 'משתפים...';
    try{
      const result = await shareRow(activeStateRowId, email);
      status.textContent = result === 'ok' ? '✓ שותף בהצלחה' : 'שגיאה: ' + result;
      if(result === 'ok') renderSharedList('sharedListState', activeStateRowId, true);
    }catch(e){ status.textContent = 'שגיאה: ' + (e.message||''); }
  };
}
// ---- Display settings (simple mode, dark mode) follow the signed-in user to every device ----
// Stored on the user's own account (not in the shared household data), so each family member keeps their own.
// ---- Cook mode text: font + size (chosen inside cook mode, synced with the other display settings) ----
const COOK_FONTS = [
  { id:'classic', label:'קלאסי',  family:"'Frank Ruhl Libre', serif" },
  { id:'clean',   label:'נקי',    family:"'Assistant', sans-serif" },
  { id:'round',   label:'עגול',   family:"'Varela Round', 'Assistant', sans-serif" },
  { id:'modern',  label:'מודרני', family:"'Rubik', 'Assistant', sans-serif" },
  { id:'bold',    label:'בולט',   family:"'Heebo', 'Assistant', sans-serif", weight:500 },
];
const COOK_SCALES = [0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
let cookFont = localStorage.getItem('cook_font') || 'classic';
if(!COOK_FONTS.some(f=>f.id === cookFont)) cookFont = 'classic';
let cookScale = parseFloat(localStorage.getItem('cook_scale')) || 1;
if(!COOK_SCALES.includes(cookScale)) cookScale = 1;
function applyCookTypography(){
  const ov = document.getElementById('cookOverlay');
  if(!ov) return;
  const f = COOK_FONTS.find(x=>x.id === cookFont) || COOK_FONTS[0];
  ov.style.setProperty('--cook-font', f.family);
  ov.style.setProperty('--cook-weight', String(f.weight || 400));
  ov.style.setProperty('--cook-scale', String(cookScale));
  document.querySelectorAll('#cookFontPanel .cook-font-opt').forEach(b=> b.classList.toggle('active', b.dataset.font === cookFont));
  const i = COOK_SCALES.indexOf(cookScale);
  const minus = document.getElementById('cookSizeMinus'), plus = document.getElementById('cookSizePlus');
  if(minus) minus.disabled = i <= 0;
  if(plus) plus.disabled = i >= COOK_SCALES.length - 1;
  const lbl = document.getElementById('cookSizeLabel');
  if(lbl) lbl.textContent = Math.round(cookScale * 100) + '%';
}
function saveCookTypography(){
  localStorage.setItem('cook_font', cookFont);
  localStorage.setItem('cook_scale', String(cookScale));
  applyCookTypography();
  clearTimeout(saveCookTypography._t);
  saveCookTypography._t = setTimeout(saveDisplayPrefs, 800);   // several quick taps → one save
}

function applyDisplayPrefs(prefs){
  if(!prefs || typeof prefs !== 'object') return;
  let changed = false;
  if(typeof prefs.cookFont === 'string' && COOK_FONTS.some(f=>f.id === prefs.cookFont) && prefs.cookFont !== cookFont){ cookFont = prefs.cookFont; localStorage.setItem('cook_font', cookFont); applyCookTypography(); }
  if(typeof prefs.cookScale === 'number' && COOK_SCALES.includes(prefs.cookScale) && prefs.cookScale !== cookScale){ cookScale = prefs.cookScale; localStorage.setItem('cook_scale', String(cookScale)); applyCookTypography(); }
  if(prefs.tabs && typeof prefs.tabs === 'object'){
    const next = normalizeTabPrefs(prefs.tabs);
    if(JSON.stringify(next) !== JSON.stringify(tabPrefs)){ tabPrefs = next; saveTabPrefs(); changed = true; }
  } else if(typeof prefs.simple === 'boolean'){
    // saved by an older version that only knew "simple mode"
    const next = normalizeTabPrefs(Object.assign({}, tabPrefs, { fridge: !prefs.simple, weekPlan: !prefs.simple, daily: !prefs.simple }));
    if(JSON.stringify(next) !== JSON.stringify(tabPrefs)){ tabPrefs = next; saveTabPrefs(); changed = true; }
  }
  if(typeof prefs.dark === 'boolean' && prefs.dark !== isDark){ isDark = prefs.dark; saveTheme(); changed = true; }
  if(changed){ applyTheme(); applySimpleMode(); }
}
function applyDisplayPrefsFromUser(user){
  applyDisplayPrefs(user && user.user_metadata && user.user_metadata.display_prefs);
}
async function saveDisplayPrefs(){
  if(!currentUser || !sbClient) return;
  try{
    const { data, error } = await sbClient.auth.updateUser({ data: { display_prefs: { tabs: tabPrefs, simple: !tabPrefs.fridge, dark: isDark, cookFont, cookScale } } });
    if(!error && data && data.user) currentUser = data.user;
  }catch(e){ /* offline — this device keeps its setting; it will be sent next time it changes */ }
}
async function refreshDisplayPrefs(){
  if(!currentUser || !sbClient) return;
  try{
    const { data } = await sbClient.auth.getUser();        // fresh from the server (getSession may be cached)
    if(data && data.user){ currentUser = data.user; applyDisplayPrefsFromUser(data.user); }
  }catch(e){}
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') refreshDisplayPrefs(); });

async function initAccount(){
  if(!sbClient) return;
  pendingOAuthError = takeOAuthError();
  // getSession() also finishes a Google sign-in: it reads the login details Google sent back in the address.
  const { data:{ session } } = await sbClient.auth.getSession();
  currentUser = session ? session.user : null;
  let cameFromGoogle = false;
  try{ cameFromGoogle = sessionStorage.getItem('oauth_pending') === '1'; sessionStorage.removeItem('oauth_pending'); }catch(e){}
  if(currentUser){
    applyDisplayPrefsFromUser(currentUser); refreshDisplayPrefs();
    if(restoreListsOverviewCache() && activeTab === 'shopping') renderShoppingPanel();
    await loadAccountData();
  }
  renderAccountBox();
  if(cameFromGoogle && (currentUser || pendingOAuthError)){
    if(currentUser) showAddedToast(`✓ מחוברים כ-${currentUser.email}`);
    else { switchTab('settings'); openSettingsTopic('accountBox'); }
  }
}
function openSettingsTopic(innerId){
  const inner = document.getElementById(innerId);
  const topic = inner && inner.closest('.settings-topic');
  if(!topic || topic.classList.contains('open')) return;
  const head = topic.querySelector('.topic-head');
  if(head) head.click();
}
let syncCode = getActiveList().syncCode || null;
let ranOutMode = false;
const WEEK_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
let weeklyPlan = JSON.parse(localStorage.getItem('weekly_plan')||'{}');
Object.keys(weeklyPlan).forEach(day=>{
  if(typeof weeklyPlan[day] === 'string'){ weeklyPlan[day] = weeklyPlan[day] ? [weeklyPlan[day]] : []; }
});
let weekOpen = localStorage.getItem('week_open') === '1';
let itemUsage = JSON.parse(localStorage.getItem('item_usage')||'{}');

function recordUsage(name){
  itemUsage[name] = (itemUsage[name]||0) + 1;
  localStorage.setItem('item_usage', JSON.stringify(itemUsage));
  scheduleAppStatePush();
}
function getAllKnownItems(){
  const map = new Map();
  Object.values(CATALOG).flat().forEach(i=>{ if(!map.has(i)) map.set(i, 0); });
  Object.keys(itemUsage).forEach(i=> map.set(i, itemUsage[i]));
  return [...map.entries()].map(([name,freq])=>({name,freq}));
}
function getSuggestions(query){
  const q = norm(query);
  if(!q) return [];
  return getAllKnownItems()
    .filter(it=> it.name.startsWith(q) && it.name !== q)
    .sort((a,b)=> b.freq - a.freq || a.name.localeCompare(b.name,'he'))
    .slice(0,6);
}
// listItems (optional): names already in the list being added to — shown first, alphabetically,
// marked as "already there" so duplicates are obvious before you add them again.
function renderAutocomplete(containerId, query, onPick, listItems){
  const el = document.getElementById(containerId);
  if(!el) return;
  const q = norm(query);
  if(!q){ el.innerHTML=''; return; }
  const already = (listItems||[])
    .filter(n=> n.startsWith(q))
    .sort((a,b)=>a.localeCompare(b,'he'))
    .map(name=>({name, already:true}));
  const alreadyNames = new Set(already.map(i=>i.name));
  const rest = getSuggestions(q).filter(s=>!alreadyNames.has(s.name)).map(s=>({name:s.name, already:false}));
  const sugg = [...already, ...rest].slice(0,8);
  if(sugg.length===0){ el.innerHTML=''; return; }
  el.innerHTML = sugg.map(s=>`<button type="button" class="ac-chip${s.already?' ac-already':''}" data-name="${escAttr(s.name)}">${s.already?'✓ ':''}${escHtml(s.name)}</button>`).join('');
  el.querySelectorAll('.ac-chip').forEach(chip=>{
    chip.onclick = ()=> onPick(chip.dataset.name);
  });
}

function saveFridge(){ localStorage.setItem('fridge_items', JSON.stringify([...fridge])); scheduleAppStatePush(); }
function saveCooked(){ localStorage.setItem('cooked_recipes', JSON.stringify([...cookedSet])); scheduleAppStatePush(); }
function saveCookHistory(){ localStorage.setItem('cook_history', JSON.stringify(cookHistory)); scheduleAppStatePush(); }
function myDisplayName(){
  if(!currentUser) return '';
  const meta = currentUser.user_metadata || {};
  return (meta.display_name || (currentUser.email||'').split('@')[0] || '').trim();
}
function saveShoppingList(){
  const list = getActiveList();
  if(currentUser){
    const prev = new Set(list.items || []);
    if(!list.addedBy) list.addedBy = {};
    shoppingList.forEach(item=>{
      if(!prev.has(item)) list.addedBy[item] = { n: myDisplayName(), e: currentUser.email };
    });
    Object.keys(list.addedBy).forEach(k=>{ if(!shoppingList.has(k)) delete list.addedBy[k]; });
  }
  list.notes = list.notes || {};
  ['notes','quantities'].forEach(m=>{ if(list[m]) Object.keys(list[m]).forEach(k=>{ if(!shoppingList.has(k)) delete list[m][k]; }); });
  list.items = [...shoppingList];
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
  pushSync();
  scheduleShoppingPush();
}
function saveBought(){
  getActiveList().bought = [...boughtItems];
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
  pushSync();
  scheduleShoppingPush();
}
function switchShoppingList(id){
  if(!shoppingLists[id] || id === activeListId) return;
  // persist current list's live state before switching away
  getActiveList().items = [...shoppingList];
  getActiveList().bought = [...boughtItems];
  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));

  activeListId = id;
  localStorage.setItem('active_shopping_list', id);
  shoppingList = new Set(getActiveList().items||[]);
  boughtItems = new Set(getActiveList().bought||[]);
  syncCode = getActiveList().syncCode || null;
  scheduleShoppingPush();
  renderShoppingPanel();
  renderTabBadges();
}
// ——— Generic in-app modal (replaces native confirm/prompt, which can be unreliable inside installed PWAs) ———
function closeAppModal(){
  document.getElementById('appModalOverlay').classList.remove('active');
}
function showConfirmModal(message, onYes){
  const overlay = document.getElementById('appModalOverlay');
  document.getElementById('appModalMessage').textContent = message;
  document.getElementById('appModalInput').style.display = 'none';
  document.getElementById('appModalTextarea').style.display = 'none';
  overlay.classList.add('active');
  document.getElementById('appModalOk').onclick = ()=>{ closeAppModal(); onYes(); };
  document.getElementById('appModalCancel').onclick = closeAppModal;
}
function showPromptModal(message, onSubmit, defaultValue, onClear){
  const overlay = document.getElementById('appModalOverlay');
  document.getElementById('appModalMessage').textContent = message;
  document.getElementById('appModalTextarea').style.display = 'none';
  const input = document.getElementById('appModalInput');
  input.type = 'text';
  input.style.display = 'block';
  input.value = defaultValue || '';
  overlay.classList.add('active');
  setTimeout(()=>input.focus(), 50);
  const cancelBtn = document.getElementById('appModalCancel');
  const submit = ()=>{
    const val = norm(input.value||'');
    if(!val) return;
    closeAppModal();
    cancelBtn.textContent = 'ביטול';
    onSubmit(val);
  };
  document.getElementById('appModalOk').onclick = submit;
  cancelBtn.textContent = onClear ? 'נקו' : 'ביטול';
  cancelBtn.onclick = ()=>{
    closeAppModal();
    cancelBtn.textContent = 'ביטול';
    if(onClear) onClear();
  };
  input.onkeydown = (e)=>{ if(e.key==='Enter') submit(); };
}
function showTextareaModal(message, onSubmit, defaultValue){
  const overlay = document.getElementById('appModalOverlay');
  document.getElementById('appModalMessage').textContent = message;
  document.getElementById('appModalInput').style.display = 'none';
  const ta = document.getElementById('appModalTextarea');
  ta.style.display = 'block';
  ta.value = defaultValue || '';
  overlay.classList.add('active');
  setTimeout(()=>ta.focus(), 50);
  const submit = ()=>{
    const val = (ta.value||'').trim();
    if(!val) return;
    closeAppModal();
    onSubmit(val);
  };
  document.getElementById('appModalOk').onclick = submit;
  document.getElementById('appModalCancel').onclick = closeAppModal;
}
function showDateModal(message, onSubmit, defaultValue, onClear){
  const overlay = document.getElementById('appModalOverlay');
  document.getElementById('appModalMessage').textContent = message;
  document.getElementById('appModalTextarea').style.display = 'none';
  const input = document.getElementById('appModalInput');
  input.type = 'date';
  input.style.display = 'block';
  input.value = defaultValue || '';
  overlay.classList.add('active');
  const okBtn = document.getElementById('appModalOk');
  const cancelBtn = document.getElementById('appModalCancel');
  const submit = ()=>{
    if(!input.value) return;
    closeAppModal();
    input.type = 'text';
    onSubmit(input.value);
  };
  okBtn.onclick = submit;
  cancelBtn.textContent = onClear ? 'נקו תאריך' : 'ביטול';
  cancelBtn.onclick = ()=>{
    closeAppModal();
    input.type = 'text';
    cancelBtn.textContent = 'ביטול';
    if(onClear) onClear();
  };
}

function createShoppingList(){
  showPromptModal('שם הרשימה החדשה:', async (name)=>{
    const prim = currentUser ? primaryShoppingRow() : null;
    if(prim && prim.id !== activeShoppingRowId){
      const firstId = Object.keys(rowListsPayload(prim))[0] || 'main';
      await activateListRef(prim.id, firstId);
    }
    const id = 'list_' + Date.now();
    shoppingLists[id] = {name, items: [], bought: [], syncCode: null};
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    closeSheet('listsSheet');
    switchShoppingList(id);
    if(shopOverviewEnabled()){ shopView = 'list'; renderShoppingPanel(); }
  });
}
function deleteListRow(rowId, listId){
  const l = shoppingLists[listId];
  if(!l) return;
  showConfirmModal(`למחוק את הרשימה "${l.name}"? היא תימחק גם אצל מי שהיא משותפת איתו. הפעולה לא הפיכה.`, async ()=>{
    clearTimeout(shoppingPushTimer); shoppingPushPending = false;
    let ok = false;
    try{
      const { error } = await sbClient.from('user_data').delete().eq('id', rowId);
      ok = !error;
    }catch(e){}
    if(!ok){ try{ await sbClient.from('user_data').update({ payload:{}, updated_at: new Date().toISOString() }).eq('id', rowId); ok = true; }catch(e){} }
    accountShoppingRows = accountShoppingRows.filter(r=>r.id !== rowId);
    const prim = primaryShoppingRow();
    const target = allListRefs().find(r=>r.rowId !== rowId) || null;
    if(prim){ subscribeShoppingRealtime(null); activeShoppingRowId = null; await activateListRef(prim.id, (prim.payload && prim.payload.main) ? 'main' : (target ? target.listId : 'main')); }
    if(showingShopOverview() || shopOverviewEnabled()){ shopView = 'overview'; }
    refreshShoppingViews();
  });
}
function deleteShoppingList(id){
  if(id === 'main' || !shoppingLists[id]) return;
  showConfirmModal(`למחוק את הרשימה "${shoppingLists[id].name}"? הפעולה לא הפיכה.`, ()=>{
    delete shoppingLists[id];
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    if(activeListId === id){
      // the open list is gone: move to the main list WITHOUT trying to save the deleted list's state first
      activeListId = shoppingLists.main ? 'main' : Object.keys(shoppingLists)[0];
      localStorage.setItem('active_shopping_list', activeListId);
      shoppingList = new Set(getActiveList().items||[]);
      boughtItems = new Set(getActiveList().bought||[]);
      syncCode = getActiveList().syncCode || null;
    }
    scheduleShoppingPush();
    refreshShoppingViews();
    if(document.getElementById('listsSheet')) openListsSheet();
  });
}
function listStats(id){
  const l = shoppingLists[id] || {};
  const live = id === activeListId;
  const items = live ? [...shoppingList] : (l.items || []);
  const bought = live ? boughtItems : new Set(l.bought || []);
  return { total: items.length, done: items.filter(i=>bought.has(i)).length };
}
function renderListSwitcher(){
  const cards = allListRefs().map(ref=>{
    const id = ref.listId, list = ref.list;
    const { total, done } = refStats(ref);
    const pct = total ? Math.round(done/total*100) : 0;
    const isActive = id === activeListId && (ref.rowId || null) === (activeShoppingRowId || null);
    return `
      <button type="button" class="list-card${isActive?' active':''}" data-id="${escAttr(id)}" data-row="${escAttr(ref.rowId||'')}">
        <span class="list-card-name">${escHtml(list.name)}</span>
        <span class="list-card-count">${total ? `${done}/${total}` : 'ריקה'}</span>
        <span class="list-card-bar"><i style="width:${pct}%"></i></span>
      </button>`;
  }).join('');
  return `
    <div class="lists-strip">
      <button type="button" class="lists-all-btn" id="openListsBtn" aria-label="כל הרשימות"><span>☰</span><small>כל הרשימות</small></button>
      <div class="lists-scroller">
        ${cards}
        <button type="button" class="list-card list-card-add" id="addListBtn"><span class="list-card-plus">＋</span><span>רשימה חדשה</span></button>
      </div>
    </div>`;
}
function wireListSwitcher(){
  const back = document.getElementById('ovBackBtn');
  if(back) back.onclick = ()=>{ if(history.state && history.state.shopList){ history.back(); } else backToShopOverview(); };
  document.querySelectorAll('.list-card[data-id]').forEach(btn=>{
    btn.onclick = ()=> activateListRef(btn.dataset.row || activeShoppingRowId, btn.dataset.id);
  });
  const addBtn = document.getElementById('addListBtn');
  if(addBtn) addBtn.onclick = createShoppingList;
  const allBtn = document.getElementById('openListsBtn');
  if(allBtn) allBtn.onclick = openListsSheet;
  const active = document.querySelector('.lists-scroller .list-card.active');
  if(active && active.scrollIntoView) active.scrollIntoView({ block:'nearest', inline:'center' });
}

// ---- bottom sheets (item editor, category picker, all-lists) ----
function escHtml(v){ return String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(v){ return escHtml(v); }
function closeSheet(id){ const el = document.getElementById(id); if(el) el.remove(); }
function openSheet(id, innerHtml, cls){
  closeSheet(id);
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'sheet-overlay' + (cls ? ' ' + cls : '');
  overlay.innerHTML = `<div class="sheet-box" role="dialog" aria-modal="true"><div class="sheet-handle"></div>${innerHtml}</div>`;
  overlay.addEventListener('click', e=>{ if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}
function refreshShoppingViews(){
  renderShoppingPanel();
  renderTabBadges();
  if(shoppingModeActive) renderShoppingModeList();
}
function stepQtyText(txt, delta){
  txt = (txt || '').trim();
  if(!txt) return delta > 0 ? '1' : '';
  const m = txt.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if(!m) return txt;
  const n = parseFloat(m[1].replace(',', '.')) + delta;
  return n <= 0 ? '' : `${n}${m[2]}`;
}
// Applies name / quantity / note / icon edits to one shopping item in one go.
function applyItemEdits(item, e){
  const list = getActiveList();
  list.quantities = list.quantities || {}; list.notes = list.notes || {};
  let name = item;
  if(e.name && e.name !== item){
    if(shoppingList.has(e.name)) return { ok:false, reason:'exists' };
    const moveKey = (obj)=>{ if(Object.prototype.hasOwnProperty.call(obj, item)){ obj[e.name] = obj[item]; delete obj[item]; } };
    shoppingList.delete(item); shoppingList.add(e.name);
    if(boughtItems.has(item)){ boughtItems.delete(item); boughtItems.add(e.name); }
    moveKey(list.quantities); moveKey(list.notes);
    if(categoryOverrides[item] && !categoryOverrides[e.name]) setCategoryOverride(e.name, categoryOverrides[item]);
    if(iconOverrides[item] && !iconOverrides[e.name]) setIconOverride(e.name, iconOverrides[item]);
    name = e.name;
  }
  if(e.qty) list.quantities[name] = e.qty; else delete list.quantities[name];
  if(e.note) list.notes[name] = e.note; else delete list.notes[name];
  if(e.icon) setIconOverride(name, e.icon); else if(iconOverrides[name]) setIconOverride(name, null);
  saveShoppingList();
  saveBought();
  return { ok:true, name };
}
function deleteShopItem(item){
  const list = getActiveList();
  shoppingList.delete(item);
  boughtItems.delete(item);
  if(list.quantities) delete list.quantities[item];
  if(list.notes) delete list.notes[item];
  saveShoppingList();
  saveBought();
}
function openItemSheet(item){
  const list = getActiveList();
  const note0 = (list.notes || {})[item] || '';
  const ov = openSheet('itemSheet', `
    <div class="sheet-head"><h3>עריכת פריט</h3><button type="button" class="sheet-x" id="isClose" aria-label="סגירה">×</button></div>
    <div class="is-name-row">
      <button type="button" class="is-icon-btn" id="isIconBtn" aria-label="שינוי קטגוריה">${escHtml(iconOf(item))}</button>
      <input id="isName" type="text" value="${escAttr(item)}" aria-label="שם הפריט">
    </div>
    <div class="is-label">כמות</div>
    <div class="is-qty-row">
      <button type="button" id="isPlus" aria-label="הוסיפו אחד">＋</button>
      <button type="button" id="isMinus" aria-label="הורידו אחד">－</button>
      <input id="isQty" type="text" value="${escAttr(qtyOfShopItem(item))}" placeholder="למשל: 2 ק״ג" aria-label="כמות">
    </div>
    <div class="is-label">הערה</div>
    <textarea id="isNote" rows="2" placeholder="למשל: בלי סוכר, או מה שבמבצע" aria-label="הערה">${escHtml(note0)}</textarea>
    <div class="is-label">קטגוריה</div>
    <button type="button" class="is-cat-btn" id="isCat"><span id="isCatLabel"></span><span class="is-cat-arrow">‹</span></button>
    <div class="is-label">אייקון משלכם (אימוג׳י, לא חובה)</div>
    <input id="isIconInput" type="text" maxlength="4" value="${escAttr(iconOverrides[item] || '')}" placeholder="🙂" aria-label="אייקון">
    <div class="is-error" id="isError"></div>
    <div class="is-actions">
      <button type="button" class="is-done" id="isDone">שמרו</button>
      <button type="button" class="is-del" id="isDel" aria-label="מחיקת הפריט">🗑</button>
    </div>`);
  const $ = (id)=> ov.querySelector('#' + id);
  const paintCat = ()=>{ const c = catOf(item); $('isCatLabel').textContent = `${categoryIconOf(c)}  ${c}`; };
  paintCat();
  $('isClose').onclick = ()=> ov.remove();
  const qtyInput = $('isQty');
  $('isPlus').onclick = ()=>{ qtyInput.value = stepQtyText(qtyInput.value, 1); };
  $('isMinus').onclick = ()=>{ qtyInput.value = stepQtyText(qtyInput.value, -1); };
  const openCats = ()=> openCategoryPicker(item, ()=>{ paintCat(); });
  $('isCat').onclick = openCats;
  $('isIconBtn').onclick = openCats;
  $('isDel').onclick = ()=>{ deleteShopItem(item); ov.remove(); refreshShoppingViews(); };
  $('isDone').onclick = ()=>{
    const name = norm($('isName').value);
    if(!name){ $('isError').textContent = 'אי אפשר להשאיר שם ריק.'; return; }
    const res = applyItemEdits(item, { name, qty: norm(qtyInput.value), note: norm($('isNote').value), icon: norm($('isIconInput').value) });
    if(!res.ok){ $('isError').textContent = 'פריט בשם הזה כבר קיים ברשימה.'; return; }
    ov.remove();
    refreshShoppingViews();
    renderItemGrid();
  };
}
function openCategoryPicker(item, onPicked){
  const current = catOf(item);
  const fixed = [...new Set(Object.keys(CATALOG).concat(['אחר']))];
  const row = (c)=>`
    <button type="button" class="cp-row${c===current?' current':''}" data-cat="${escAttr(c)}">
      <span class="cp-icon">${escHtml(categoryIconOf(c))}</span><span class="cp-name">${escHtml(c)}</span>${c===current?'<span class="cp-check">✓</span>':''}
    </button>`;
  const ov = openSheet('catPickerSheet', `
    <div class="sheet-head"><h3>שינוי קטגוריה</h3><button type="button" class="sheet-x" id="cpClose" aria-label="סגירה">×</button></div>
    <div class="cp-item">${escHtml(iconOf(item))} ${escHtml(item)}</div>
    <div class="cp-scroll">
      <div class="is-label">קטגוריות קבועות</div>
      ${fixed.map(row).join('')}
      ${customCategories.length ? `<div class="is-label">הקטגוריות שלי</div>${customCategories.map(row).join('')}` : ''}
    </div>
    <div class="cp-foot">
      <button type="button" class="cp-new-btn" id="cpNew">＋ צרו קטגוריה חדשה</button>
      <div class="cp-new-form" id="cpForm" style="display:none;">
        <div class="add-row">
          <input id="cpName" type="text" placeholder="שם הקטגוריה" aria-label="שם הקטגוריה">
          <input id="cpEmoji" type="text" maxlength="4" placeholder="🏷️" style="flex:0 1 70px; text-align:center;" aria-label="אימוג׳י">
          <button type="button" id="cpCreate">צרו</button>
        </div>
        <div class="is-error" id="cpError"></div>
      </div>
    </div>`, 'top');
  const pick = (cat)=>{
    const nativeCat = ING_TO_CAT[item] || 'אחר';
    if(cat === nativeCat) setCategoryOverride(item, null); else setCategoryOverride(item, cat);
    ov.remove();
    refreshShoppingViews();
    renderItemGrid();
    if(onPicked) onPicked(cat);
  };
  ov.querySelector('#cpClose').onclick = ()=> ov.remove();
  ov.querySelectorAll('.cp-row').forEach(b=>{ b.onclick = ()=> pick(b.dataset.cat); });
  ov.querySelector('#cpNew').onclick = ()=>{ ov.querySelector('#cpForm').style.display = 'block'; ov.querySelector('#cpNew').style.display = 'none'; ov.querySelector('#cpName').focus(); };
  ov.querySelector('#cpCreate').onclick = ()=>{
    const name = norm(ov.querySelector('#cpName').value);
    const err = ov.querySelector('#cpError');
    if(!name){ err.textContent = 'כתבו שם לקטגוריה.'; return; }
    if(!addCustomCategory(name)){ err.textContent = 'קטגוריה בשם הזה כבר קיימת.'; return; }
    const em = norm(ov.querySelector('#cpEmoji').value);
    if(em) setCategoryIcon(name, em);
    renderCatTabs();
    pick(name);
  };
}
function clearBoughtInList(id){
  const l = shoppingLists[id];
  if(!l) return;
  syncLiveSetsIntoList(); snapshotShopping(shoppingLists, 'לפני ניקוי מסומנים');
  if(id === activeListId){
    [...boughtItems].forEach(i=>{ shoppingList.delete(i); });
    boughtItems.clear();
    saveShoppingList(); saveBought();
  } else {
    const bought = new Set(l.bought || []);
    l.items = (l.items || []).filter(i=>!bought.has(i));
    l.bought = [];
    ['quantities','notes','addedBy'].forEach(m=>{ if(l[m]) Object.keys(l[m]).forEach(k=>{ if(!l.items.includes(k)) delete l[m][k]; }); });
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    scheduleShoppingPush();
  }
}
function renameShoppingList(id){
  const l = shoppingLists[id];
  if(!l) return;
  showPromptModal('שם חדש לרשימה:', (name)=>{
    l.name = name;
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    scheduleShoppingPush();
    refreshShoppingViews();
    if(document.getElementById('listsSheet')) openListsSheet();
  }, l.name);
}
async function openListMenu(id, rowId){
  if(rowId && rowId !== activeShoppingRowId){
    const ok = await activateListRef(rowId, id);
    if(!ok) return;
    if(showingShopOverview()) renderShoppingPanel();
  }
  const l = shoppingLists[id];
  if(!l) return;
  const thisRow = rowById(activeShoppingRowId);
  const prim = primaryShoppingRow();
  const ownSingleListRow = thisRow && thisRow !== prim && rowShareKind(thisRow) === 'own' && Object.keys(shoppingLists).length === 1;
  const canDelete = ownSingleListRow || id !== 'main';
  const foreign = thisRow && rowShareKind(thisRow) === 'foreign';
  const { done, total } = listStats(id);
  const ov = openSheet('listMenuSheet', `
    <div class="sheet-head"><h3>${escHtml(l.name)}</h3><button type="button" class="sheet-x" id="lmClose" aria-label="סגירה">×</button></div>
    <button type="button" class="lm-row" id="lmShare">👥  עם מי הרשימה משותפת</button>
    <button type="button" class="lm-row" id="lmRename">✏️  שינוי שם</button>
    ${id!=='main' && total && shoppingLists.main ? '<button type="button" class="lm-row" id="lmTransfer">➡️  בחרו פריטים לרשימה הראשית</button>' : ''}
    <button type="button" class="lm-row" id="lmClear" ${done?'':'disabled'}>🧹  מחקו פריטים שסומנו (${done})</button>
    ${canDelete && !foreign ? '<button type="button" class="lm-row danger" id="lmDelete">🗑  מחיקת הרשימה</button>' : ''}`, 'top');
  ov.querySelector('#lmClose').onclick = ()=> ov.remove();
  ov.querySelector('#lmShare').onclick = ()=>{ ov.remove(); openListShareSheet(activeShoppingRowId, id); };
  ov.querySelector('#lmRename').onclick = ()=>{ ov.remove(); renameShoppingList(id); };
  const tr = ov.querySelector('#lmTransfer');
  if(tr) tr.onclick = ()=>{ ov.remove(); openTransferToMainSheet(id); };
  ov.querySelector('#lmClear').onclick = ()=>{
    ov.remove();
    showConfirmModal(`למחוק את ${done} הפריטים שסומנו ב"${l.name}"?`, ()=>{
      clearBoughtInList(id);
      refreshShoppingViews();
      if(document.getElementById('listsSheet')) openListsSheet();
    });
  };
  const del = ov.querySelector('#lmDelete');
  if(del) del.onclick = ()=>{ ov.remove(); if(ownSingleListRow) deleteListRow(activeShoppingRowId, id); else deleteShoppingList(id); };
}

/** Pick items from a saved/secondary list and merge them into the main shopping list. */
function openTransferToMainSheet(sourceId){
  if(!sourceId || sourceId === 'main' || !shoppingLists[sourceId]) return;
  if(!shoppingLists.main){
    shoppingLists.main = { name:'רשימה ראשית', items:[], bought:[], quantities:{}, notes:{} };
  }
  const src = shoppingLists[sourceId];
  const items = [...(src.items || [])].sort((a,b)=>a.localeCompare(b,'he'));
  if(!items.length){
    alert('הרשימה ריקה — אין פריטים להעברה');
    return;
  }
  const selected = new Set(items); // start with all selected — easy to uncheck
  const ov = openSheet('transferSheet', `
    <div class="sheet-head">
      <h3>העברה לרשימה הראשית</h3>
      <button type="button" class="sheet-x" id="trClose" aria-label="סגירה">×</button>
    </div>
    <p class="settings-hint" style="margin:0 0 10px;">מ־«${escHtml(src.name)}» · לחצו על פריט כדי לבחור / לבטל</p>
    <div class="tr-actions">
      <button type="button" class="sm-tool-btn" id="trAll">סמנו הכול</button>
      <button type="button" class="sm-tool-btn" id="trNone">נקו בחירה</button>
    </div>
    <div class="tr-list" id="trList"></div>
    <div class="tr-foot">
      <label class="clearcat-item" style="margin-bottom:10px;">
        <input type="checkbox" id="trRemoveSrc" checked> הסירו מהרשימה השמורה אחרי ההעברה
      </label>
      <button type="button" class="import-btn" id="trGo">הוסיפו לרשימה הראשית (<span id="trCount">${selected.size}</span>)</button>
    </div>`, 'tall');

  function paint(){
    const listEl = ov.querySelector('#trList');
    listEl.innerHTML = items.map(name=>{
      const on = selected.has(name);
      const qty = (src.quantities||{})[name];
      return `<button type="button" class="tr-row${on?' on':''}" data-name="${escAttr(name)}">
        <span class="tr-check">${on?'✓':''}</span>
        <span class="tr-name">${escHtml(name)}${qty?` <span class="shop-item-qty">(${escHtml(qty)})</span>`:''}</span>
      </button>`;
    }).join('');
    ov.querySelector('#trCount').textContent = selected.size;
    listEl.querySelectorAll('.tr-row').forEach(row=>{
      row.onclick = ()=>{
        const n = row.dataset.name;
        if(selected.has(n)) selected.delete(n); else selected.add(n);
        paint();
      };
    });
  }
  paint();
  ov.querySelector('#trClose').onclick = ()=> ov.remove();
  ov.querySelector('#trAll').onclick = ()=>{ items.forEach(i=>selected.add(i)); paint(); };
  ov.querySelector('#trNone').onclick = ()=>{ selected.clear(); paint(); };
  ov.querySelector('#trGo').onclick = ()=>{
    if(selected.size === 0){ alert('לא נבחרו פריטים'); return; }
    const removeSrc = ov.querySelector('#trRemoveSrc').checked;
    transferItemsToMain(sourceId, [...selected], removeSrc);
    ov.remove();
    // switch to main so the user sees the result
    if(activeListId !== 'main') switchShoppingList('main');
    else refreshShoppingViews();
    alert(`✓ ${selected.size} פריטים נוספו לרשימה הראשית`);
  };
}

function transferItemsToMain(sourceId, names, removeFromSource){
  if(!shoppingLists.main) shoppingLists.main = { name:'רשימה ראשית', items:[], bought:[], quantities:{}, notes:{} };
  const main = shoppingLists.main;
  const src = shoppingLists[sourceId];
  if(!main.items) main.items = [];
  if(!main.bought) main.bought = [];
  if(!main.quantities) main.quantities = {};
  if(!main.notes) main.notes = {};
  const srcQty = (src && src.quantities) || {};
  const srcNotes = (src && src.notes) || {};

  names.forEach(name=>{
    if(!main.items.includes(name)) main.items.push(name);
    // unmark bought on main so it shows as needed
    main.bought = main.bought.filter(i=>i!==name);
    if(srcQty[name] && !main.quantities[name]) main.quantities[name] = srcQty[name];
    if(srcNotes[name] && !main.notes[name]) main.notes[name] = srcNotes[name];
  });

  if(removeFromSource && src){
    const drop = new Set(names);
    src.items = (src.items || []).filter(i=>!drop.has(i));
    src.bought = (src.bought || []).filter(i=>!drop.has(i));
    names.forEach(n=>{
      if(src.quantities) delete src.quantities[n];
      if(src.notes) delete src.notes[n];
      if(src.addedBy) delete src.addedBy[n];
    });
  }

  // keep live Sets in sync if main or source is currently active
  if(activeListId === 'main'){
    names.forEach(n=>{ shoppingList.add(n); boughtItems.delete(n); });
  }
  if(activeListId === sourceId && removeFromSource){
    names.forEach(n=>{ shoppingList.delete(n); boughtItems.delete(n); });
  }

  localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
  scheduleShoppingPush();
  pushSync();
}
function openListsSheet(){
  const card = (ref)=>{
    const id = ref.listId, l = ref.list;
    const { total, done } = refStats(ref);
    const pct = total ? Math.round(done/total*100) : 0;
    const isActive = id === activeListId && (ref.rowId || null) === (activeShoppingRowId || null);
    const share = ref.row ? shareInfoForRow(ref.row) : null;
    return `
      <div class="lb-card${isActive?' active':''}">
        <button type="button" class="lb-main" data-id="${escAttr(id)}" data-row="${escAttr(ref.rowId||'')}">
          <span class="lb-name">${escHtml(l.name)}</span>
          <span class="lb-row"><span class="lb-count">${total ? `${done}/${total}` : 'ריקה'}</span><span class="lb-bar"><i style="width:${pct}%"></i></span></span>
          ${share && share.text ? `<span class="ov-share${share.shared?' shared':''}">${share.shared?'👥':'🔒'} ${escHtml(share.text)}</span>` : ''}
        </button>
        <button type="button" class="lb-menu" data-id="${escAttr(id)}" data-row="${escAttr(ref.rowId||'')}" aria-label="אפשרויות הרשימה">⋮</button>
      </div>`;
  };
  const ov = openSheet('listsSheet', `
    <div class="sheet-head"><h3>הרשימות שלי</h3><button type="button" class="sheet-x" id="lbClose" aria-label="סגירה">×</button></div>
    <div class="lb-list">${allListRefs().map(card).join('')}</div>
    <div class="lb-foot"><button type="button" id="lbNew">＋ רשימה חדשה</button></div>`, 'tall');
  ov.querySelector('#lbClose').onclick = ()=> ov.remove();
  ov.querySelectorAll('.lb-main').forEach(b=>{ b.onclick = ()=>{ ov.remove(); activateListRef(b.dataset.row || activeShoppingRowId, b.dataset.id); }; });
  ov.querySelectorAll('.lb-menu').forEach(b=>{ b.onclick = ()=> openListMenu(b.dataset.id, b.dataset.row || null); });
  ov.querySelector('#lbNew').onclick = createShoppingList;
}
function saveFavorites(){ localStorage.setItem('favorites', JSON.stringify([...favorites])); scheduleAppStatePush(); }

// ——— Cross-device shopping list sync (via your Supabase project) ———
function supaHeaders(extra){
  return Object.assign({
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  }, extra||{});
}
async function createSyncBucket(){
  const code = Math.random().toString(36).slice(2,8).toUpperCase();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/shopping_sync`, {
    method:'POST',
    headers: supaHeaders({'Prefer':'resolution=merge-duplicates,return=minimal'}),
    body: JSON.stringify([{code, items:[], bought:[], updated_at:new Date().toISOString()}])
  });
  if(!res.ok) throw new Error('create failed: ' + res.status);
  return code;
}
// The old 6-character code sync (shopping_sync table) is only for people WITHOUT an account. Once there is a login
// (or a saved login that is still being restored at startup), the account copy is the single source of truth —
// reading the old table in that window is what made stale items flash back after a refresh.
function accountSessionLikely(){
  if(currentUser) return true;
  try{ return Object.keys(localStorage).some(k=>/^sb-.+-auth-token$/.test(k)); }catch(e){ return false; }
}
async function pushSync(){
  if(!syncCode || accountSessionLikely()) return;
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/shopping_sync?on_conflict=code`, {
      method:'POST',
      headers: supaHeaders({'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body: JSON.stringify([{code:syncCode, items:[...shoppingList], bought:[...boughtItems], updated_at:new Date().toISOString()}])
    });
  }catch(e){ /* offline, or sync service unreachable — will retry on next change */ }
}
async function pullSync(){
  if(!syncCode || accountSessionLikely()) return;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/shopping_sync?code=eq.${syncCode}&select=items,bought`, {
      headers: supaHeaders()
    });
    if(!res.ok) return;
    const rows = await res.json();
    if(!rows.length) return;
    if(accountSessionLikely()) return;   // a login appeared while we were fetching — don't overwrite the account copy
    shoppingList = new Set(rows[0].items||[]);
    boughtItems = new Set(rows[0].bought||[]);
    getActiveList().items = [...shoppingList];
    getActiveList().bought = [...boughtItems];
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    renderShoppingPanel();
    renderTabBadges();
  }catch(e){ /* offline, or sync service unreachable */ }
}

// ——— Cross-device recipe sync (imported/custom recipes, via the same Supabase project) ———
let recipeSyncCode = localStorage.getItem('recipe_sync_code') || null;
async function createRecipeSyncBucket(){
  const code = Math.random().toString(36).slice(2,8).toUpperCase();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/recipe_sync`, {
    method:'POST',
    headers: supaHeaders({'Prefer':'resolution=merge-duplicates,return=minimal'}),
    body: JSON.stringify([{code, recipes: customRecipes, updated_at:new Date().toISOString()}])
  });
  if(!res.ok) throw new Error('create failed: ' + res.status);
  return code;
}
async function pushRecipeSync(){
  if(!recipeSyncCode) return;
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/recipe_sync?on_conflict=code`, {
      method:'POST',
      headers: supaHeaders({'Prefer':'resolution=merge-duplicates,return=minimal'}),
      body: JSON.stringify([{code:recipeSyncCode, recipes: customRecipes, updated_at:new Date().toISOString()}])
    });
  }catch(e){ /* offline, or sync service unreachable — will retry on next change */ }
}
async function pullRecipeSync(){
  if(!recipeSyncCode) return;
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/recipe_sync?code=eq.${recipeSyncCode}&select=recipes`, {
      headers: supaHeaders()
    });
    if(!res.ok) return;
    const rows = await res.json();
    if(!rows.length) return;
    customRecipes.forEach(r=>{
      if(BUILTIN_RECIPE_NAMES.has(r.name)) return;
      const idx = RECIPES.findIndex(x=>x.name===r.name);
      if(idx>-1) RECIPES.splice(idx,1);
    });
    customRecipes = (rows[0].recipes || []).filter(r=>r && !BUILTIN_RECIPE_NAMES.has(r.name));
    localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
    RECIPES.push(...customRecipes);
    renderAll();
  }catch(e){ /* offline, or sync service unreachable */ }
}
function renderRecipeSyncBoxHTML(){
  if(recipeSyncCode){
    return `
      <div class="sync-box">
        <div class="sync-row">
          <span class="sync-status">🔄 מסונכרן · קוד: <b>${recipeSyncCode}</b></span>
          <div class="sync-actions">
            <button id="recSyncCopyBtn">העתקה</button>
            <button id="recSyncWhatsappBtn">💬 וואטסאפ</button>
            <button id="recSyncRefreshBtn">רענון</button>
            <button id="recSyncStopBtn">ניתוק</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="sync-box">
      <div class="sync-row"><span class="sync-status">📵 המתכונים שלכם לא מסונכרנים בין מכשירים</span></div>
      <div class="sync-setup">
        <button id="recSyncCreateBtn">צרו סנכרון חדש</button>
        <input type="text" id="recSyncJoinInput" placeholder="הדביקו קוד ממכשיר אחר...">
        <button id="recSyncJoinBtn">הצטרפו</button>
      </div>
    </div>`;
}
function wireRecipeSyncBox(){
  const createBtn = document.getElementById('recSyncCreateBtn');
  if(createBtn) createBtn.onclick = async ()=>{
    createBtn.disabled = true; createBtn.textContent = 'יוצר...';
    try{
      const code = await createRecipeSyncBucket();
      recipeSyncCode = code;
      localStorage.setItem('recipe_sync_code', code);
      await pushRecipeSync();
    }catch(e){ alert('לא הצלחנו ליצור סנכרון כרגע (' + e.message + '). ודאו חיבור לאינטרנט ונסו שוב.'); }
    renderRecipeSyncSection();
  };
  const joinBtn = document.getElementById('recSyncJoinBtn');
  if(joinBtn) joinBtn.onclick = async ()=>{
    const input = document.getElementById('recSyncJoinInput');
    const code = extractSyncCode(input.value.toUpperCase());
    if(!code) return;
    joinBtn.disabled = true; joinBtn.textContent = 'בודק...';
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/recipe_sync?code=eq.${code}&select=code`, {headers: supaHeaders()});
      const rows = await res.json();
      if(!res.ok || rows.length===0){
        alert('קוד לא נמצא. ודאו שהעתקתם אותו נכון מהמכשיר השני.');
        joinBtn.disabled = false; joinBtn.textContent = 'הצטרפו';
        return;
      }
    }catch(e){
      alert('שגיאה בבדיקת הקוד. ודאו חיבור לאינטרנט ונסו שוב.');
      joinBtn.disabled = false; joinBtn.textContent = 'הצטרפו';
      return;
    }
    recipeSyncCode = code;
    localStorage.setItem('recipe_sync_code', code);
    await pullRecipeSync();
    renderRecipeSyncSection();
  };
  const copyBtn = document.getElementById('recSyncCopyBtn');
  if(copyBtn) copyBtn.onclick = ()=>{
    if(navigator.clipboard) navigator.clipboard.writeText(recipeSyncCode).then(()=>alert('הקוד הועתק')).catch(()=>{});
  };
  const waBtn = document.getElementById('recSyncWhatsappBtn');
  if(waBtn) waBtn.onclick = ()=>{
    const text = `בואו נסנכרן את המתכונים שיצרתי באפליקציה 📖\nפתחו את האפליקציה ← "הגדרות" ← "הצטרפו", ותדביקו את הקוד הזה:\n\n${recipeSyncCode}`;
    if(navigator.clipboard) navigator.clipboard.writeText(recipeSyncCode).catch(()=>{});
    window.open('https://wa.me/?text='+encodeURIComponent(text), '_blank');
  };
  const refreshBtn = document.getElementById('recSyncRefreshBtn');
  if(refreshBtn) refreshBtn.onclick = ()=> pullRecipeSync();
  const stopBtn = document.getElementById('recSyncStopBtn');
  if(stopBtn) stopBtn.onclick = ()=>{
    showConfirmModal('להפסיק את סנכרון המתכונים במכשיר הזה? (המתכונים יישארו מקומית)', ()=>{
      recipeSyncCode = null;
      localStorage.removeItem('recipe_sync_code');
      renderRecipeSyncSection();
    });
  };
}
function renderRecipeSyncSection(){
  const el = document.getElementById('recipeSyncBox');
  if(!el) return;
  el.innerHTML = renderRecipeSyncBoxHTML();
  wireRecipeSyncBox();
}
function renderSyncBoxHTML(){
  if(syncCode){
    return `
      <div class="sync-box">
        <div class="sync-row">
          <span class="sync-status">🔄 מסונכרן · קוד: <b>${syncCode}</b></span>
          <div class="sync-actions">
            <button id="syncCopyBtn">העתקה</button>
            <button id="syncWhatsappBtn">💬 וואטסאפ</button>
            <button id="syncRefreshBtn">רענון</button>
            <button id="syncStopBtn">ניתוק</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="sync-box">
      <div class="sync-row"><span class="sync-status">📵 לא מסונכרן בין מכשירים</span></div>
      <div class="sync-setup">
        <button id="syncCreateBtn">צרו סנכרון חדש</button>
        <input type="text" id="syncJoinInput" placeholder="הדביקו קוד, או את כל הודעת הוואטסאפ...">
        <button id="syncJoinBtn">הצטרפו</button>
      </div>
    </div>`;
}
function extractSyncCode(text){
  const match = text.match(/\b[0-9A-Z]{6}\b/);
  return match ? match[0] : norm(text).toUpperCase();
}

function wireSyncBox(){
  const createBtn = document.getElementById('syncCreateBtn');
  if(createBtn) createBtn.onclick = async ()=>{
    createBtn.disabled = true; createBtn.textContent = 'יוצר...';
    try{
      const code = await createSyncBucket();
      syncCode = code;
      getActiveList().syncCode = code;
      localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
      await pushSync();
    }catch(e){ alert('לא הצלחנו ליצור סנכרון כרגע (' + e.message + '). ודאו חיבור לאינטרנט ונסו שוב, או השתמשו בינתיים ב"קוד שיתוף" הידני למטה.'); }
    renderShoppingPanel();
  };
  const joinBtn = document.getElementById('syncJoinBtn');
  if(joinBtn) joinBtn.onclick = async ()=>{
    const input = document.getElementById('syncJoinInput');
    const code = extractSyncCode(input.value.toUpperCase());
    if(!code) return;
    joinBtn.disabled = true; joinBtn.textContent = 'בודק...';
    try{
      const res = await fetch(`${SUPABASE_URL}/rest/v1/shopping_sync?code=eq.${code}&select=code`, {headers: supaHeaders()});
      const rows = await res.json();
      if(!res.ok || rows.length===0){
        alert('קוד לא נמצא. ודאו שהעתקתם אותו נכון מהמכשיר השני.');
        joinBtn.disabled = false; joinBtn.textContent = 'הצטרפו';
        return;
      }
    }catch(e){
      alert('שגיאה בבדיקת הקוד. ודאו חיבור לאינטרנט ונסו שוב.');
      joinBtn.disabled = false; joinBtn.textContent = 'הצטרפו';
      return;
    }
    syncCode = code;
    getActiveList().syncCode = code;
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    await pullSync();
    renderShoppingPanel();
  };
  const copyBtn = document.getElementById('syncCopyBtn');
  if(copyBtn) copyBtn.onclick = ()=>{
    if(navigator.clipboard) navigator.clipboard.writeText(syncCode).then(()=>alert('הקוד הועתק — שלחו אותו לטלפון או למחשב השני, ושם הדביקו אותו ב״הצטרפו״')).catch(()=>{});
  };
  const waBtn = document.getElementById('syncWhatsappBtn');
  if(waBtn) waBtn.onclick = ()=>{
    const text = `בואו נסנכרן את רשימת הקניות "${getActiveList().name}" 🛒\nפתחו את האפליקציה ← "קניות" ← "הצטרפו", ותדביקו את הקוד הזה:\n\n${syncCode}`;
    if(navigator.clipboard) navigator.clipboard.writeText(syncCode).catch(()=>{});
    window.open('https://wa.me/?text='+encodeURIComponent(text), '_blank');
  };
  const refreshBtn = document.getElementById('syncRefreshBtn');
  if(refreshBtn) refreshBtn.onclick = ()=> pullSync();
  const stopBtn = document.getElementById('syncStopBtn');
  if(stopBtn) stopBtn.onclick = ()=>{
    showConfirmModal('להפסיק את הסנכרון במכשיר הזה? (הרשימה תישאר מקומית)', ()=>{
      syncCode = null;
      getActiveList().syncCode = null;
      localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
      renderShoppingPanel();
    });
  };
}
function saveTheme(){ localStorage.setItem('theme', isDark ? 'dark' : 'light'); }

function markCooked(name){
  cookedSet.add(name);
  if(!cookHistory[name]) cookHistory[name] = [];
  cookHistory[name].push(new Date().toISOString());
  // keep last 20
  if(cookHistory[name].length > 20) cookHistory[name] = cookHistory[name].slice(-20);
  saveCooked();
  saveCookHistory();
}
function formatHistory(name){
  const arr = cookHistory[name];
  if(!arr || !arr.length) return '';
  const last = new Date(arr[arr.length-1]);
  const d = last.toLocaleDateString('he-IL', {day:'numeric', month:'short', year:'numeric'});
  const count = arr.length;
  return count === 1 ? `בושל לאחרונה ב־${d}` : `בושל ${count} פעמים · לאחרונה ${d}`;
}

// Samsung Internet / Chrome "dark mode for websites" repaints light pages dark on its own.
// Declaring the colour scheme the app is actually showing stops that ("only light" = never auto-darken).
function applyColorSchemeHint(){
  const v = isDark ? 'dark' : 'only light';
  let m = document.querySelector('meta[name="color-scheme"]');
  if(!m){ m = document.createElement('meta'); m.name = 'color-scheme'; document.head.appendChild(m); }
  m.content = v;
  document.documentElement.style.colorScheme = v;
}
function applyTheme(){
  applyColorSchemeHint();
  document.body.classList.toggle('dark', isDark);
  document.getElementById('themeBtn').textContent = isDark ? '☀️' : '🌙';
  document.querySelector('meta[name="theme-color"]').content = isDark ? '#1A1916' : '#F6F3EA';
  if(typeof updateShopBodyClasses === 'function' && typeof activeTab !== 'undefined') updateShopBodyClasses();
}

let fridgeExpanded = false;
let clearByCatOpen = false;

function renderFridgeStrip(){
  const wrap = document.getElementById('fridgeSummaryWrap');
  const catCheckboxes = [...new Set(allCategoryNames().concat(['אחר']))].map(cat=>`
    <label class="clearcat-item"><input type="checkbox" value="${escAttr(cat)}"> ${escHtml(cat)}</label>
  `).join('');
  const clearCatPanel = `
    <div class="clearcat-panel${clearByCatOpen?' open':''}" id="clearCatPanel">
      <div class="clearcat-grid">${catCheckboxes}</div>
      <button id="clearCatGoBtn">נקו את הקטגוריות שנבחרו</button>
    </div>`;

  if(fridge.size === 0){
    wrap.innerHTML = '<div class="fridge-empty">המקרר עדיין ריק — התחילו לסמן למטה</div>';
    return;
  }

  const expiredItems = [...fridge].filter(i=>expiryStatus(i)==='expired');
  const soonItems = [...fridge].filter(i=>expiryStatus(i)==='soon');
  let expiryAlert = '';
  if(expiredItems.length || soonItems.length){
    const parts = [];
    if(expiredItems.length) parts.push(`<b>${expiredItems.length} פגו:</b> ${expiredItems.map(escHtml).join(', ')}`);
    if(soonItems.length) parts.push(`<b>${soonItems.length} עומדים לפוג:</b> ${soonItems.map(escHtml).join(', ')}`);
    expiryAlert = `<div class="expiry-alert${expiredItems.length?' has-expired':''}">${parts.join(' · ')}</div>`;
  }

  wrap.innerHTML = `
    ${expiryAlert}
    <div class="fridge-summary">
      <span class="fridge-count">יש לכם <b>${fridge.size}</b> מצרכים</span>
      <div class="fridge-actions">
        <button id="toggleFridgeBtn">${fridgeExpanded?'הסתר':'הצג'}</button>
        <button id="clearByCatBtn">נקו לפי קטגוריה</button>
        <button class="clear-btn" id="clearFridgeBtn">נקה הכל</button>
      </div>
    </div>
    <div class="fridge-panel${fridgeExpanded?' open':''}" id="fridgePanel">
      <div class="fridge-panel-inner" id="fridgePanelInner"></div>
    </div>
    ${clearCatPanel}
  `;
  const inner = document.getElementById('fridgePanelInner');
  [...fridge].forEach(item=>{
    const status = expiryStatus(item);
    const chip = document.createElement('span');
    chip.className = 'chip' + (status==='expired' ? ' exp-expired' : status==='soon' ? ' exp-soon' : '');
    const d = fridgeExpiry[item] ? daysUntil(fridgeExpiry[item]) : null;
    const dateLabel = d===null ? '' : d<0 ? ` (פג לפני ${-d} ימים)` : d===0 ? ' (פג היום)' : ` (עוד ${d} ימים)`;
    chip.innerHTML = `<button class="chip-cal" aria-label="תאריך תפוגה">📅</button>${escHtml(item)}${dateLabel} <button aria-label="הסרה">×</button>`;
    chip.querySelector('.chip-cal').onclick = (e)=>{
      e.stopPropagation();
      showDateModal(`תאריך תפוגה עבור "${item}":`, (dateStr)=>{
        setExpiry(item, dateStr);
        renderAll();
      }, fridgeExpiry[item] || '', ()=>{
        setExpiry(item, null);
        renderAll();
      });
    };
    chip.querySelector('button[aria-label="הסרה"]').onclick = ()=>{
      if(ranOutMode){
        fridge.delete(item);
        shoppingList.add(item);
        boughtItems.delete(item);
        recordUsage(item);
        saveFridge();
        saveShoppingList();
        saveBought();
      } else {
        fridge.delete(item);
        setExpiry(item, null);
        saveFridge();
      }
      renderAll();
    };
    inner.appendChild(chip);
  });
  document.getElementById('toggleFridgeBtn').onclick = ()=>{
    fridgeExpanded = !fridgeExpanded;
    renderFridgeStrip();
  };
  document.getElementById('clearFridgeBtn').onclick = ()=>{
    fridge.clear();
    saveFridge();
    renderAll();
  };
  document.getElementById('clearByCatBtn').onclick = ()=>{
    clearByCatOpen = !clearByCatOpen;
    renderFridgeStrip();
  };
  const goBtn = document.getElementById('clearCatGoBtn');
  if(goBtn){
    goBtn.onclick = ()=>{
      const checked = [...document.querySelectorAll('#clearCatPanel input:checked')].map(cb=>cb.value);
      if(checked.length===0) return;
      [...fridge].forEach(item=>{ if(checked.includes(catOf(item))) fridge.delete(item); });
      saveFridge();
      clearByCatOpen = false;
      renderAll();
    };
  }
}

let activeCat = Object.keys(CATALOG)[0];

let removedCatalogItems = JSON.parse(localStorage.getItem('removed_catalog_items')||'[]');
function removeCatalogItem(item){
  if(!removedCatalogItems.includes(item)){
    removedCatalogItems.push(item);
    localStorage.setItem('removed_catalog_items', JSON.stringify(removedCatalogItems));
    scheduleCategorySettingsPush();
  }
}
function restoreCatalogItem(item){
  removedCatalogItems = removedCatalogItems.filter(i=>i!==item);
  localStorage.setItem('removed_catalog_items', JSON.stringify(removedCatalogItems));
  scheduleCategorySettingsPush();
}

function getCategoryItems(cat){
  const nativeItems = (CATALOG[cat]||[]).filter(item=>{
    if(removedCatalogItems.includes(item)) return false;
    const ov = categoryOverrides[item];
    if(ov && ov !== cat) return false; // reassigned to a different category
    return true;
  });
  const addedItems = Object.keys(categoryOverrides).filter(item=>
    categoryOverrides[item] === cat && !(CATALOG[cat]||[]).includes(item)
  );
  return [...new Set([...nativeItems, ...addedItems])].sort((a,b)=>a.localeCompare(b,'he'));
}

// Removing an item from a category means: if it's only here via an override, clear the override;
// if it's a native catalog member with no override, hide it (reversible from Settings).
function removeItemFromCategory(item, cat){
  const ov = categoryOverrides[item];
  if(ov === cat){
    setCategoryOverride(item, null);
  } else if((CATALOG[cat]||[]).includes(item)){
    removeCatalogItem(item);
  }
  renderAll();
}

function renderCatTabs(){
  const el = document.getElementById('catTabs');
  el.innerHTML='';
  Object.keys(CATALOG).concat(customCategories).forEach(cat=>{
    const b = document.createElement('button');
    b.className = 'cat-tab' + (cat===activeCat?' active':'');
    b.textContent = cat;
    b.onclick = ()=>{ activeCat = cat; renderCatTabs(); renderItemGrid(); };
    el.appendChild(b);
  });
}

function renderItemGrid(){
  const el = document.getElementById('itemGrid');
  el.innerHTML='';

  const addRow = document.createElement('div');
  addRow.className = 'cat-add-row';
  addRow.innerHTML = `
    <input type="text" placeholder="הוסיפו מצרך חדש ל-${escAttr(activeCat)}...">
    <button>+</button>
  `;
  const input = addRow.querySelector('input');
  const addNew = ()=>{
    const val = norm(input.value);
    if(!val) return;
    setCategoryOverride(val, activeCat);
    fridge.add(val);
    saveFridge();
    input.value = '';
    renderAll();
  };
  addRow.querySelector('button').onclick = addNew;
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') addNew(); });
  el.appendChild(addRow);

  const items = getCategoryItems(activeCat);
  if(items.length===0){
    const empty = document.createElement('p');
    empty.className = 'custom-empty';
    empty.textContent = 'עדיין אין מצרכים בקטגוריה הזו — הוסיפו אחד למעלה';
    el.appendChild(empty);
  }
  items.forEach(item=>{
    const wrap = document.createElement('span');
    wrap.className = 'item-btn-wrap';

    const b = document.createElement('button');
    b.className = 'item-btn' + (fridge.has(item)?' selected':'');
    b.textContent = item;
    b.dataset.icon = iconOf(item);
    b.onclick = ()=>{
      if(ranOutMode){
        if(fridge.has(item)) fridge.delete(item);
        shoppingList.add(item);
        boughtItems.delete(item);
        recordUsage(item);
        saveFridge();
        saveShoppingList();
        saveBought();
      } else {
        if(fridge.has(item)) fridge.delete(item); else fridge.add(item);
        saveFridge();
      }
      renderAll();
    };
    wrap.appendChild(b);

    const del = document.createElement('button');
    del.className = 'item-del';
    del.setAttribute('aria-label', 'הסרה מהקטגוריה');
    del.textContent = '×';
    del.onclick = (e)=>{
      e.stopPropagation();
      removeItemFromCategory(item, activeCat);
    };
    wrap.appendChild(del);

    el.appendChild(wrap);
  });
}

function renderRanoutUI(){
  const btn = document.getElementById('ranoutToggleBtn');
  const banner = document.getElementById('ranoutBanner');
  if(!btn || !banner) return;
  btn.classList.toggle('active', ranOutMode);
  banner.style.display = ranOutMode ? 'flex' : 'none';
}

function wireCardActions(card, r, missing){
  const cookBtn = card.querySelector('.cook-btn');
  if(cookBtn){
    cookBtn.onclick = (e)=>{
      e.stopPropagation();
      if(cookedSet.has(r.name)){
        cookedSet.delete(r.name);
        saveCooked();
      } else {
        markCooked(r.name);
      }
      renderAll();
    };
  }
  const shopBtn = card.querySelector('.shop-btn');
  if(shopBtn){
    shopBtn.onclick = (e)=>{
      e.stopPropagation();
      missing.forEach(i=>shoppingList.add(i));
      saveShoppingList();
      renderAll();
    };
  }
  const favBtn = card.querySelector('.fav-btn');
  if(favBtn){
    favBtn.onclick = (e)=>{
      e.stopPropagation();
      if(favorites.has(r.name)) favorites.delete(r.name); else favorites.add(r.name);
      saveFavorites();
      renderAll();
    };
  }
  const modeBtn = card.querySelector('.cook-mode-btn');
  if(modeBtn){
    modeBtn.onclick = (e)=>{
      e.stopPropagation();
      openCookMode(r);
    };
  }
  const shareBtn = card.querySelector('.share-btn');
  if(shareBtn){
    shareBtn.onclick = (e)=>{
      e.stopPropagation();
      const text = `${r.name}\nזמן: ${r.time}\n\nמצרכים:\n${r.ingredients.map(i=>{ const n=ingName(i), q=ingQty(i); return '• '+(q?q+' ':'')+n; }).join('\n')}\n\nהכנה:\n${r.steps.map((s,i)=>(i+1)+'. '+s).join('\n')}`;
      if(navigator.share){
        navigator.share({title:r.name, text}).catch(()=>{});
      } else if(navigator.clipboard){
        navigator.clipboard.writeText(text).then(()=>alert('המתכון הועתק ללוח')).catch(()=>{});
      }
    };
  }
  const altBtn = card.querySelector('.alt-btn');
  if(altBtn){
    altBtn.onclick = (e)=>{
      e.stopPropagation();
      suggestAlternative(r);
    };
  }
  const editBtn = card.querySelector('.edit-recipe-card-btn');
  if(editBtn){
    editBtn.onclick = (e)=>{
      e.stopPropagation();
      editRecipeInSheet(r.name);
    };
  }
}

function suggestAlternative(base){
  // find recipes with better match ratio, same cuisine preferred, not the same
  let candidates = RECIPES.filter(r => r.name !== base.name).map(r=>{
    const names = recipeIngNames(r);
    const have = names.filter(i=>fridge.has(i)).length;
    const total = names.length;
    return {...r, score: total ? have/total : 0, have, _names: names};
  }).filter(r => r.have > 0);
  candidates.sort((a,b)=>{
    // prefer same cuisine, then higher score
    const cA = a.cuisine === base.cuisine ? 1 : 0;
    const cB = b.cuisine === base.cuisine ? 1 : 0;
    return (cB - cA) || (b.score - a.score) || (b.have - a.have);
  });
  if(candidates.length === 0){
    alert('לא נמצא מתכון אלטרנטיבי מתאים יותר כרגע. נסו להוסיף מצרכים למקרר.');
    return;
  }
  const best = candidates[0];
  const missing = best._names.filter(i=>!fridge.has(i));
  const msg = `הצעה: «${best.name}»\nהתאמה: ${best.have}/${best._names.length} מצרכים\nזמן: ${best.time}` +
    (missing.length ? `\nחסר: ${missing.join(', ')}` : '\nיש לכם הכל!');
  showConfirmModal(msg + '\n\nלפתוח את המתכון?', ()=>{
    filters.search = best.name;
    document.getElementById('searchInput').value = best.name;
    renderRecipes();
    // try open the card
    setTimeout(()=>{
      const cards = document.querySelectorAll('.recipe-card');
      cards.forEach(c=>{
        if(c.querySelector('h3') && c.querySelector('h3').textContent.includes(best.name)){
          c.classList.add('open');
          c.scrollIntoView({behavior:'smooth', block:'center'});
        }
      });
    }, 100);
  });
}

function cardActionsHTML(r, missing){
  const cooked = cookedSet.has(r.name);
  const isFav = favorites.has(r.name);
  return `
    <div class="card-actions">
      <button class="action-btn cook-mode-btn">👨‍🍳 מצב בישול</button>
      <button class="action-btn cook-btn ${cooked?'cooked':''}">${cooked? '✓ בישלתם — לבטל' : 'סמנו שבישלתם'}</button>
      <button class="action-btn fav-btn ${isFav?'fav-active':''}">${isFav? '★ במועדפים' : '☆ הוסיפו למועדפים'}</button>
      ${missing.length>0 ? `<button class="action-btn shop-btn">➕ הוסיפו ${missing.length} חסרים לקניות</button>` : ''}
      <button class="action-btn share-btn">📤 שתפו</button>
      <button class="action-btn edit-recipe-card-btn">✎ ערכו מתכון</button>
    </div>
  `;
}

function renderFilterRow(){
  const el = document.getElementById('filterRow');
  el.innerHTML = `
    <button class="filter-chip ${filters.diet==='veg'?'active':''}" id="vegChip">🌱 צמחוני</button>
    <button class="filter-chip ${filters.diet==='nonveg'?'active':''}" id="nonvegChip">🍗 עם בשר</button>
    <select class="time-select" id="timeSelect">
      <option value="0">כל זמן</option>
      <option value="15">עד 15 דק׳</option>
      <option value="30">עד 30 דק׳</option>
      <option value="45">עד 45 דק׳</option>
    </select>
    <select class="cuisine-select" id="cuisineSelect">
      <option value="all">כל המטבחים</option>
      <option value="ישראלי">ישראלי</option>
      <option value="איטלקי">איטלקי</option>
      <option value="אסייתי">אסייתי</option>
      <option value="ים-תיכוני">ים-תיכוני</option>
      <option value="בריא">בריא</option>
      <option value="כללי">כללי</option>
      <option value="אמריקאי">אמריקאי</option>
      <option value="צרפתי">צרפתי</option>
      <option value="הודי">הודי</option>
    </select>
    <select class="diff-select" id="diffSelect">
      <option value="all">כל רמות הקושי</option>
      <option value="קל">קל</option>
      <option value="בינוני">בינוני</option>
    </select>
    <button class="filter-chip ${filters.readyNow?'active':''}" id="readyNowChip">✓ מוכן עכשיו</button>
    <button class="filter-chip ${filters.almostReady?'active':''}" id="almostChip">כמעט מוכן</button>
    <button class="filter-chip ${filters.hideCooked?'active':''}" id="hideCookedChip">הסתירו מבושלים</button>
    <button class="filter-chip ${filters.favoritesOnly?'active':''}" id="favChip">★ מועדפים בלבד</button>
  `;
  document.getElementById('timeSelect').value = String(filters.maxTime);
  document.getElementById('cuisineSelect').value = filters.cuisine;
  document.getElementById('diffSelect').value = filters.difficulty;

  document.getElementById('vegChip').onclick = ()=>{
    filters.diet = filters.diet==='veg' ? 'all' : 'veg';
    renderFilterRow(); renderRecipes();
  };
  document.getElementById('nonvegChip').onclick = ()=>{
    filters.diet = filters.diet==='nonveg' ? 'all' : 'nonveg';
    renderFilterRow(); renderRecipes();
  };
  document.getElementById('timeSelect').onchange = (e)=>{
    filters.maxTime = parseInt(e.target.value);
    renderRecipes();
  };
  document.getElementById('cuisineSelect').onchange = (e)=>{
    filters.cuisine = e.target.value;
    renderRecipes();
  };
  document.getElementById('diffSelect').onchange = (e)=>{
    filters.difficulty = e.target.value;
    renderRecipes();
  };
  document.getElementById('readyNowChip').onclick = ()=>{
    filters.readyNow = !filters.readyNow;
    if(filters.readyNow) filters.almostReady = false;
    renderFilterRow(); renderRecipes();
  };
  document.getElementById('almostChip').onclick = ()=>{
    filters.almostReady = !filters.almostReady;
    if(filters.almostReady) filters.readyNow = false;
    renderFilterRow(); renderRecipes();
  };
  document.getElementById('hideCookedChip').onclick = ()=>{
    filters.hideCooked = !filters.hideCooked;
    renderFilterRow(); renderRecipes();
  };
  document.getElementById('favChip').onclick = ()=>{
    filters.favoritesOnly = !filters.favoritesOnly;
    renderFilterRow(); renderRecipes();
  };
}

// 'fridge' = recipes that match what's in the fridge (default) · 'all' = every recipe, A–Z, as one long list
let recipesView = localStorage.getItem('recipes_view') === 'all' ? 'all' : 'fridge';
function setRecipesView(view){
  recipesView = view === 'all' ? 'all' : 'fridge';
  localStorage.setItem('recipes_view', recipesView);
  if(recipesView === 'all'){
    // the "ready now / almost ready" shortcuts belong to the fridge view
    filters.readyNow = false; filters.almostReady = false; readyNowAutoApplied = true;
  } else {
    readyNowAutoApplied = false;
  }
  renderFilterRow();
  renderRecipes();
  window.scrollTo(0, 0);
}
function paintRecipeViewToggle(){
  document.querySelectorAll('#recipeViewToggle button').forEach(b=>{
    const on = b.dataset.view === recipesView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    if(b.dataset.view === 'all') b.textContent = `📖 כל המתכונים (${RECIPES.length})`;
  });
  // In the full-list view the suggestion blocks are hidden, so the A–Z list starts right under the filters
  document.body.classList.toggle('recipes-all', recipesView === 'all');
}
document.querySelectorAll('#recipeViewToggle button').forEach(b=>{
  b.onclick = ()=>{ if(b.dataset.view !== recipesView) setRecipesView(b.dataset.view); };
});

function renderRecipes(){
  const el = document.getElementById('recipeResults');
  const searching = filters.search.trim().length>0;
  const showAll = recipesView === 'all';
  paintRecipeViewToggle();

  // Default: when fridge has items, prefer recipes you can make right now
  if(!showAll && fridge.size > 0 && !readyNowAutoApplied && !searching && !filters.favoritesOnly){
    filters.readyNow = true;
    readyNowAutoApplied = true;
    renderFilterRow();
  }
  if(fridge.size === 0){
    filters.readyNow = false;
    readyNowAutoApplied = false;
  }

  if(!showAll && fridge.size===0 && !searching && !filters.favoritesOnly){
    el.innerHTML = '<p class="empty-state">סמנו מצרכים במקרר — או חפשו מתכון לפי שם. אפשר גם להוסיף מצרכים חסרים ישר לרשימת הקניות מכל מתכון.</p><button type="button" class="clear-filters-btn" id="showAllRecipesBtn">הציגו את כל המתכונים</button>';
    document.getElementById('showAllRecipesBtn').onclick = ()=> setRecipesView('all');
    return;
  }

  let list = RECIPES.map(r=>{
    const names = recipeIngNames(r);
    const have = names.filter(i=>fridge.has(i));
    const missing = names.filter(i=>!fridge.has(i));
    return {...r, haveCount: have.length, total: names.length, have, missing, _names: names};
  });

  if(searching){
    const q = filters.search.trim();
    list = list.filter(r=>r.name.includes(q));
  } else if(!filters.favoritesOnly && !showAll){
    list = list.filter(r=>r.haveCount>0);
  }

  if(filters.diet==='veg') list = list.filter(isVegetarian);
  if(filters.diet==='nonveg') list = list.filter(r=>!isVegetarian(r));
  if(filters.maxTime>0) list = list.filter(r=>minutesOf(r)<=filters.maxTime);
  if(filters.readyNow) list = list.filter(r=>r.total>0 && r.missing.length===0);
  if(filters.almostReady) list = list.filter(r=>r.haveCount>0 && r.missing.length<=1);
  if(filters.hideCooked) list = list.filter(r=>!cookedSet.has(r.name));
  if(filters.favoritesOnly) list = list.filter(r=>favorites.has(r.name));
  if(filters.cuisine!=='all') list = list.filter(r=>r.cuisine===filters.cuisine);
  if(filters.difficulty!=='all') list = list.filter(r=>r.difficulty===filters.difficulty);

  if(fridge.size>0 && !showAll){
    list.sort((a,b)=> (b.haveCount/b.total) - (a.haveCount/a.total) || b.haveCount - a.haveCount
      || minutesOf(a) - minutesOf(b) || a.name.localeCompare(b.name,'he'));
  } else {
    list.sort((a,b)=> a.name.localeCompare(b.name,'he'));
  }

  if(list.length===0){
    const readyEmpty = filters.readyNow && fridge.size>0;
    el.innerHTML = readyEmpty
      ? '<p class="empty-state">אין מתכון שאפשר להכין עכשיו עם מה שיש במקרר. כבו את «מוכן עכשיו» כדי לראות מתכונים כמעט מוכנים, או הוסיפו מצרכים חסרים לרשימת הקניות.</p><button type="button" class="clear-filters-btn" id="clearFiltersBtn">הציגו גם מתכונים חלקיים</button>'
      : recipeFiltersActive()
        ? '<p class="empty-state">לא נמצאו מתכונים לפי הסינון שבחרתם.</p><button type="button" class="clear-filters-btn" id="clearFiltersBtn">נקו את כל הסינונים</button>'
        : '<p class="empty-state">אין עדיין מתכונים להצגה — סמנו כמה מצרכים במקרר.</p>';
    const cf = document.getElementById('clearFiltersBtn');
    if(cf) cf.onclick = ()=>{
      if(readyEmpty){ filters.readyNow = false; renderFilterRow(); renderRecipes(); }
      else clearAllRecipeFilters();
    };
    return;
  }

  el.innerHTML='';
  if(showAll){
    const count = document.createElement('div');
    count.className = 'recipe-count';
    count.textContent = list.length === RECIPES.length ? `${list.length} מתכונים, לפי סדר האלף-בית` : `${list.length} מתוך ${RECIPES.length} מתכונים`;
    el.appendChild(count);
  }
  let lastLetter = '';
  list.forEach(r=>{
    if(showAll){
      const letter = (r.name || '').trim().charAt(0);
      if(letter && letter !== lastLetter){
        lastLetter = letter;
        const hd = document.createElement('div');
        hd.className = 'recipe-letter';
        hd.textContent = letter;
        el.appendChild(hd);
      }
    }
    const card = document.createElement('div');
    card.className = 'recipe-card' + (showAll ? ' compact' : '');
    const isFull = r.total>0 && r.missing.length===0;
    const cooked = cookedSet.has(r.name);
    const isFav = favorites.has(r.name);
    const usesExpiring = r.have.some(i=>{ const s = expiryStatus(i); return s==='soon' || s==='expired'; });
    card.innerHTML = `
      <div class="recipe-head">
        <h3>${isFav?'★ ':''}${escHtml(r.name)}</h3>
        ${fridge.size>0 ? `<span class="match-frac ${isFull?'match-full':'match-partial'}">${r.haveCount}/${r.total} מצרכים</span>` : ''}
      </div>
      <div class="recipe-meta">${escHtml(r.time)}${isFull? ' · יש לכם הכל' : ''}${cooked? ' · <span class="cooked-badge">✓ בישלתם</span>' : ''}${usesExpiring? ' · <span class="expiring-badge">♻️ מנצל מה שעומד לפוג</span>' : ''}</div>
      <div class="recipe-tags">
        <span class="tag">${escHtml(r.cuisine||'כללי')}</span>
        <span class="tag">${escHtml(r.difficulty||'קל')}</span>
        ${r.healthy?'<span class="tag">בריא</span>':''}
      </div>
      ${formatHistory(r.name) ? `<div class="history-line">${formatHistory(r.name)}</div>` : ''}
      ${!isFull && r.missing.length>0 ? `<div class="missing-line">חסר: ${r.missing.map(m=>{
        const subs = (SUBSTITUTES[m]||[]).filter(s=>fridge.has(s));
        return subs.length ? `${escHtml(m)} <span class="sub-hint">(אפשר: ${subs.map(escHtml).join('/')})</span>` : escHtml(m);
      }).join(', ')}</div>` : ''}
      <div class="recipe-body">
        <h4>מצרכים</h4>
        <div class="ing-list">
          ${r.ingredients.map(i=>{
            const name = ingName(i);
            const have = fridge.has(name);
            let extra = '';
            if(!have && SUBSTITUTES[name]){
              const avail = SUBSTITUTES[name].filter(s=>fridge.has(s));
              if(avail.length) extra = ` → ${escHtml(avail[0])}`;
            }
            const qty = ingQty(i);
            return `<span class="ing-pill ${have?'have':'miss'}">${escHtml(name)}${qty?` <span class="ing-qty">(${escHtml(qty)})</span>`:''}${extra}</span>`;
          }).join('')}
        </div>
        <h4>הוראות הכנה</h4>
        <ol class="steps">${r.steps.map(s=>`<li>${escHtml(s)}</li>`).join('')}</ol>
        ${cardActionsHTML(r, r.missing)}
        ${!isFull && r.missing.length>0 ? `<button class="action-btn alt-btn" data-alt="${escAttr(r.name)}">💡 הצעו מתכון אלטרנטיבי דומה</button>` : ''}
      </div>
    `;
    card.onclick = ()=> card.classList.toggle('open');
    wireCardActions(card, r, r.missing);
    el.appendChild(card);
  });
}

function dayOfYear(){
  const d = new Date();
  const start = new Date(d.getFullYear(),0,0);
  return Math.floor((d - start)/86400000);
}

function renderWeekPlan(){
  const btn = document.getElementById('weekToggleBtn');
  const panel = document.getElementById('weekPlan');
  if(!panel) return;
  panel.style.display = weekOpen ? 'block' : 'none';
  if(btn) btn.textContent = weekOpen ? '▴' : '▾';
  if(!weekOpen) return;

  const options = RECIPES.map(r=>r.name).sort((a,b)=>a.localeCompare(b,'he'));
  let html = '';
  WEEK_DAYS.forEach(day=>{
    const chosen = weeklyPlan[day] || [];
    const chips = chosen.map(name=>`
      <span class="week-chip">${escHtml(name)}<button type="button" class="week-chip-x" data-day="${day}" data-name="${escAttr(name)}">×</button></span>
    `).join('');
    const remaining = options.filter(n=>!chosen.includes(n));
    html += `
      <div class="week-row-multi">
        <div class="week-day">יום ${day}</div>
        <div class="week-chips">${chips || '<span class="week-empty">— אין מתכון —</span>'}</div>
        <select class="week-select" data-day="${day}">
          <option value="">+ הוסיפו מתכון ליום זה</option>
          ${remaining.map(name=>`<option value="${escAttr(name)}">${escHtml(name)}</option>`).join('')}
        </select>
      </div>`;
  });
  html += `
    <div class="week-actions">
      <button id="weekShopBtn">🛒 הוסיפו את כל החוסר לרשימת קניות</button>
      <button class="secondary" id="weekClearBtn">נקו תוכנית</button>
    </div>`;
  panel.innerHTML = html;

  panel.querySelectorAll('.week-select').forEach(sel=>{
    sel.onchange = (e)=>{
      const day = e.target.dataset.day;
      const val = e.target.value;
      if(val){
        if(!weeklyPlan[day]) weeklyPlan[day] = [];
        if(!weeklyPlan[day].includes(val)) weeklyPlan[day].push(val);
        localStorage.setItem('weekly_plan', JSON.stringify(weeklyPlan));
        scheduleAppStatePush();
        renderWeekPlan();
      }
    };
  });
  panel.querySelectorAll('.week-chip-x').forEach(x=>{
    x.onclick = ()=>{
      const day = x.dataset.day;
      const name = x.dataset.name;
      weeklyPlan[day] = (weeklyPlan[day]||[]).filter(n=>n!==name);
      localStorage.setItem('weekly_plan', JSON.stringify(weeklyPlan));
      scheduleAppStatePush();
      renderWeekPlan();
    };
  });
  document.getElementById('weekShopBtn').onclick = openWeekShopPreview;
  document.getElementById('weekClearBtn').onclick = ()=>{
    showConfirmModal('לנקות את כל תוכנית השבוע?', ()=>{
      weeklyPlan = {};
      localStorage.setItem('weekly_plan', JSON.stringify(weeklyPlan));
      scheduleAppStatePush();
      renderWeekPlan();
    });
  };
}


// ---- Weekly plan -> shopping list preview ----
// Aggregates every ingredient of the planned meals, subtracts what is in the fridge, shows how many
// planned meals need each item, lets the user untick things, then adds the rest with quantities.
function buildWeekShopEntries(){
  const map = new Map();
  let meals = 0;
  Object.values(weeklyPlan).flat().filter(Boolean).forEach(name=>{
    const r = RECIPES.find(rc=>rc.name===name);
    if(!r) return;
    meals++;
    r.ingredients.forEach(raw=>{
      const ing = ingName(raw);
      if(!ing) return;
      if(!map.has(ing)) map.set(ing, {ing, n:0, recipes:[], qtyHint: ingQty(raw)});
      const e = map.get(ing);
      e.n++;
      if(!e.recipes.includes(name)) e.recipes.push(name);
      if(!e.qtyHint) e.qtyHint = ingQty(raw);
    });
  });
  const entries = [...map.values()].map(e=>({
    ...e,
    inFridge: fridge.has(e.ing),
    inList: shoppingList.has(e.ing),
    cat: catOf(e.ing),
    qty: (()=>{ const base = e.qtyHint || qtyOf(e.ing); return e.n>1 ? (base ? `${base} ×${e.n}` : `×${e.n}`) : base; })()
  }));
  return { meals, entries };
}
function openWeekShopPreview(){
  const { meals, entries } = buildWeekShopEntries();
  if(meals===0){ alert('בחרו קודם מתכונים לימי השבוע'); return; }
  const missing = entries.filter(e=>!e.inFridge);
  const haveAll = entries.filter(e=>e.inFridge).map(e=>e.ing);
  if(missing.length===0){ alert('כל המצרכים לשבוע כבר נמצאים במקרר 🎉'); return; }

  const protectedSet = new Set(protectedCategories);
  const checked = new Set(missing.filter(e=>!e.inList && !protectedSet.has(e.cat)).map(e=>e.ing));

  const old = document.getElementById('weekShopOverlay');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'weekShopOverlay';
  overlay.className = 'week-shop-overlay';
  document.body.appendChild(overlay);

  const render = ()=>{
    const order = [...new Set(allCategoryNames().concat(['אחר']))];
    const groups = {};
    missing.forEach(e=>{ (groups[e.cat] = groups[e.cat] || []).push(e); });
    const groupHtml = order.filter(c=>groups[c]).map(c=>`
      <div class="wsp-group">
        <div class="wsp-group-title">${escHtml(c)}${protectedSet.has(c)?' <span class="wsp-note">(מזווה — לא מסומן כברירת מחדל)</span>':''}</div>
        ${groups[c].sort((a,b)=>a.ing.localeCompare(b.ing,'he')).map(e=>`
          <label class="wsp-row${e.inList?' wsp-inlist':''}">
            <input type="checkbox" data-ing="${escAttr(e.ing)}" ${e.inList?'disabled checked':(checked.has(e.ing)?'checked':'')}>
            <span class="wsp-icon">${escHtml(iconOf(e.ing))}</span>
            <span class="wsp-main">
              <span class="wsp-name">${escHtml(e.ing)}${e.qty?` <span class="wsp-qty">(${escHtml(e.qty)})</span>`:''}${e.inList?' <span class="wsp-note">✓ כבר ברשימה</span>':''}</span>
              <span class="wsp-recipes">${e.recipes.map(escHtml).join(' · ')}</span>
            </span>
          </label>`).join('')}
      </div>`).join('');
    const addCount = [...checked].length;
    overlay.innerHTML = `
      <div class="week-shop-box">
        <div class="wsp-head">
          <h3>רשימת קניות לשבוע</h3>
          <div class="wsp-sub">${meals} ארוחות מתוכננות · חסרים ${missing.length} מצרכים${haveAll.length?` · ${haveAll.length} כבר במקרר`:''}</div>
        </div>
        <div class="wsp-body">${groupHtml}</div>
        <div class="wsp-foot">
          <button type="button" class="wsp-add" id="wspAdd" ${addCount?'':'disabled'}>הוסיפו ${addCount} לרשימה</button>
          <button type="button" class="wsp-sec" id="wspAll">סמנו הכל</button>
          <button type="button" class="wsp-sec" id="wspCancel">ביטול</button>
        </div>
      </div>`;
    overlay.querySelectorAll('input[data-ing]').forEach(cb=>{
      cb.onchange = ()=>{ if(cb.checked) checked.add(cb.dataset.ing); else checked.delete(cb.dataset.ing); const b = document.getElementById('wspAdd'); b.textContent = `הוסיפו ${checked.size} לרשימה`; b.disabled = checked.size===0; };
    });
    document.getElementById('wspCancel').onclick = ()=> overlay.remove();
    document.getElementById('wspAll').onclick = ()=>{ missing.filter(e=>!e.inList).forEach(e=>checked.add(e.ing)); render(); };
    document.getElementById('wspAdd').onclick = ()=>{
      const list = getActiveList();
      let added = 0;
      missing.forEach(e=>{
        if(!checked.has(e.ing) || e.inList) return;
        shoppingList.add(e.ing);
        boughtItems.delete(e.ing);
        if(e.qty && !list.quantities[e.ing]) list.quantities[e.ing] = e.qty;
        recordUsage(e.ing);
        added++;
      });
      saveShoppingList();
      saveBought();
      overlay.remove();
      renderAll();
      switchTab('shopping');
    };
  };
  overlay.onclick = (ev)=>{ if(ev.target === overlay) overlay.remove(); };
  render();
}


// ---- "ההצעה המובילה" — best fridge match (kept for compatibility) ----
let topSuggestionOffset = 0;
function topSuggestionCandidates(){
  if(fridge.size === 0) return [];
  return RECIPES
    .map(r=>{
      const names = recipeIngNames(r);
      const have = names.filter(i=>fridge.has(i));
      return { r, have, missing: names.filter(i=>!fridge.has(i)), total: names.length };
    })
    .filter(x=>x.have.length > 0 && x.total > 0)
    .sort((a,b)=> (b.have.length/b.total) - (a.have.length/a.total) || b.have.length - a.have.length
                  || (cookedSet.has(a.r.name) - cookedSet.has(b.r.name)) || a.r.name.localeCompare(b.r.name,'he'))
    .slice(0, 6);
}

/** "מה לבשל הערב?" — 3 suggestions from favorites, quick meals, and fridge match. */
function tonightCandidates(){
  const scored = RECIPES.map(r=>{
    const names = recipeIngNames(r);
    const have = names.filter(i=>fridge.has(i));
    const missing = names.filter(i=>!fridge.has(i));
    const mins = minutesOf(r);
    let score = 0;
    if(favorites.has(r.name)) score += 40;
    if(mins <= 20) score += 25;
    else if(mins <= 35) score += 12;
    if(fridge.size > 0 && names.length){
      score += Math.round((have.length / names.length) * 35);
      if(missing.length === 0) score += 20;
    }
    if(cookedSet.has(r.name)) score -= 15;
    if(r.healthy) score += 5;
    return { r, have, missing, total: names.length, mins, score };
  });
  scored.sort((a,b)=> b.score - a.score || a.mins - b.mins || a.r.name.localeCompare(b.r.name,'he'));
  // rotate window so refresh cycles through options
  const start = tonightOffset % Math.max(1, scored.length);
  const rotated = scored.slice(start).concat(scored.slice(0, start));
  return rotated.slice(0, 3);
}
function renderTonightSuggestions(){
  const el = document.getElementById('tonightSuggestions');
  if(!el) return;
  const cands = tonightCandidates();
  if(!cands.length){
    el.innerHTML = '<p class="tonight-empty">אין עדיין מתכונים להצעה.</p>';
    return;
  }
  el.innerHTML = `<div class="tonight-grid">${cands.map(({r, have, missing, mins})=>{
    const full = missing.length === 0 && have.length > 0;
    const isFav = favorites.has(r.name);
    return `<div class="tonight-card" data-name="${escAttr(r.name)}">
      <div class="tc-title">${isFav?'★ ':''}${escHtml(r.name)}</div>
      <div class="tc-meta">${escHtml(r.time||'')}${r.cuisine? ' · '+escHtml(r.cuisine):''}</div>
      <div class="tc-tags">
        ${mins<=25?'<span class="tonight-tag">מהיר</span>':''}
        ${isFav?'<span class="tonight-tag fav">מועדף</span>':''}
        ${fridge.size>0?(full
          ?'<span class="tonight-tag">יש הכול ✓</span>'
          :`<span class="tonight-tag miss">${missing.length} חסרים</span>`):''}
      </div>
    </div>`;
  }).join('')}</div>`;
  el.querySelectorAll('.tonight-card').forEach(card=>{
    card.onclick = ()=> openRecipeCardByName(card.dataset.name);
  });
}
function renderHeaderSub(){
  const el = document.getElementById('headerSub');
  if(!el) return;
  const unbought = typeof shoppingList !== 'undefined' ? [...shoppingList].filter(i=>!boughtItems.has(i)).length : 0;
  if(unbought > 0) el.textContent = `רשימת קניות · ${unbought} פריטים פתוחים`;
  else if(fridge.size > 0) el.textContent = `${fridge.size} מצרכים במקרר · מחפשים מה לבשל`;
  else el.textContent = 'רשימת קניות ומתכונים לפי מה שיש בבית';
}
function renderTopSuggestion(){
  const section = document.getElementById('topSuggestionSection');
  const el = document.getElementById('topSuggestion');
  if(!section || !el) return;
  const cands = topSuggestionCandidates();
  if(cands.length === 0){ section.style.display = 'none'; el.innerHTML = ''; return; }
  const idx = topSuggestionOffset % cands.length;
  const { r, have, missing } = cands[idx];
  const full = missing.length === 0;
  const quick = minutesOf(r) <= 20;
  const usesExpiring = have.some(i=>{ const st = expiryStatus(i); return st === 'soon' || st === 'expired'; });
  const shownHave = have.slice(0, 3).join(', ') + (have.length > 3 ? ' ועוד' : '');
  section.style.display = '';
  el.innerHTML = `
    <div class="top-suggestion">
      <div class="ts-label">${idx === 0 ? 'ההצעה המובילה' : 'הצעה נוספת'}</div>
      <div class="ts-title">${escHtml(r.name)}</div>
      <div class="ts-sub">${escHtml(shownHave)} — ${escHtml(r.time)}</div>
      <div class="ts-tags">
        <span class="ts-tag ${full?'ts-ok':'ts-miss'}">${full ? 'יש לכם הכול ✓' : `${missing.length} מצרכים חסרים`}</span>
        ${quick ? '<span class="ts-tag ts-quick">ארוחה מהירה</span>' : ''}
        ${r.healthy ? '<span class="ts-tag ts-healthy">בריא</span>' : ''}
        ${usesExpiring ? '<span class="ts-tag ts-expiring">♻️ מנצל מה שעומד לפוג</span>' : ''}
      </div>
      <button type="button" class="ts-cta" id="tsOpen">למתכון המלא</button>
      ${cands.length > 1 ? '<button type="button" class="ts-other" id="tsOther">↻ הצעה אחרת</button>' : ''}
    </div>`;
  document.getElementById('tsOpen').onclick = ()=> openRecipeCardByName(r.name);
  const other = document.getElementById('tsOther');
  if(other) other.onclick = ()=>{ topSuggestionOffset++; renderTopSuggestion(); };
}
// Opens the matching card in the results list (clearing filters first if they would hide it) and scrolls to it.
function openRecipeCardByName(name){
  const find = ()=> [...document.querySelectorAll('#recipeResults .recipe-card')].find(c=>{
    const h = c.querySelector('h3');
    return h && h.textContent.replace(/^★\s*/, '').trim() === name;
  });
  let card = find();
  if(!card){ clearAllRecipeFilters(); card = find(); }
  if(!card) return;
  card.classList.add('open');
  if(card.scrollIntoView) card.scrollIntoView({ behavior:'smooth', block:'start' });
}

function renderDailyRecipe(){
  const el = document.getElementById('dailyRecipe');
  const pool = RECIPES.filter(r=>r.healthy);
  const r = pool[dayOfYear() % pool.length];
  const names = recipeIngNames(r);
  const have = names.filter(i=>fridge.has(i));
  const missing = names.filter(i=>!fridge.has(i));
  const cooked = cookedSet.has(r.name);
  const isFav = favorites.has(r.name);
  const card = document.createElement('div');
  card.className='daily-card recipe-card';
  card.innerHTML = `
    <div class="daily-label">המלצה טעימה ובריאה להיום</div>
    <h3>${isFav?'★ ':''}${escHtml(r.name)}</h3>
    <div class="recipe-meta">${escHtml(r.time)}${fridge.size? ` · ${have.length}/${names.length} כבר יש לכם` : ''}${cooked? ' · <span class="cooked-badge">✓ בישלתם</span>' : ''}</div>
    <div class="recipe-tags">
      <span class="tag">${escHtml(r.cuisine||'כללי')}</span>
      <span class="tag">${escHtml(r.difficulty||'קל')}</span>
    </div>
    ${formatHistory(r.name) ? `<div class="history-line">${formatHistory(r.name)}</div>` : ''}
    <div class="recipe-body">
      <h4>מצרכים</h4>
      <div class="ing-list">
        ${r.ingredients.map(i=>{
          const name = ingName(i);
          const qty = ingQty(i);
          return `<span class="ing-pill ${fridge.has(name)?'have':'miss'}">${escHtml(name)}${qty?` <span class="ing-qty">(${escHtml(qty)})</span>`:''}</span>`;
        }).join('')}
      </div>
      <h4>הוראות הכנה</h4>
      <ol class="steps">${r.steps.map(s=>`<li>${escHtml(s)}</li>`).join('')}</ol>
      ${cardActionsHTML(r, missing)}
    </div>
  `;
  card.onclick = ()=> card.classList.toggle('open');
  wireCardActions(card, r, missing);
  el.innerHTML='';
  el.appendChild(card);
}

// ---- Per-list sharing ----
// Lists are stored in user_data rows (kind 'shopping_lists'); sharing works per row. A list that should be shared
// with its own people is moved into a row of its own, and that row is shared. The lists of every shopping row the
// account can see are shown together; opening a list makes its row the "active" (synced, realtime) row.
function rowById(rowId){ return accountShoppingRows.find(r=>r.id===rowId) || null; }
function primaryShoppingRow(){
  const hid = myHousehold ? myHousehold.id : null;
  return (hid && accountShoppingRows.find(r=>r.household_id === hid))
    || accountShoppingRows.find(r=>currentUser && r.owner_id === currentUser.id && !r.household_id && r.payload && r.payload.main)
    || accountShoppingRows.find(r=>currentUser && r.owner_id === currentUser.id && !r.household_id)
    || null;
}
function rowListsPayload(row){
  if(!row || row.id === activeShoppingRowId){ syncLiveSetsIntoList(); return shoppingLists; }
  return (row.payload && typeof row.payload === 'object') ? row.payload : {};
}
function allListRefs(){
  if(!currentUser || !activeShoppingRowId || !accountShoppingRows.length){
    return Object.keys(shoppingLists).map(id=>({ rowId: activeShoppingRowId, listId:id, list: shoppingLists[id], row:null }));
  }
  const prim = primaryShoppingRow();
  const rank = (r)=> r === prim ? 0 : (r.owner_id === currentUser.id ? 1 : 2);
  const rows = [...accountShoppingRows].sort((a,b)=> rank(a) - rank(b));
  const refs = [];
  rows.forEach(row=>{
    const p = rowListsPayload(row);
    Object.keys(p).forEach(id=>{ if(p[id]) refs.push({ rowId: row.id, listId: id, list: p[id], row }); });
  });
  return refs;
}
function refStats(ref){
  if(ref.rowId === activeShoppingRowId) return listStats(ref.listId);
  const items = ref.list.items || [], b = new Set(ref.list.bought || []);
  return { total: items.length, done: items.filter(i=>b.has(i)).length };
}
function rowShareKind(row){
  if(!currentUser || !row) return 'local';
  if(myHousehold && row.household_id && row.household_id === myHousehold.id) return 'household';
  if(row.owner_id !== currentUser.id) return 'foreign';
  return 'own';
}
async function fetchSharedEmails(rowId, force){
  if(!force && sharedEmailsCache[rowId] && !sharedEmailsCache[rowId].error) return sharedEmailsCache[rowId].emails;
  const { data, error } = await sbClient.rpc('get_shared_emails', { row_id: rowId });
  sharedEmailsCache[rowId] = error ? { error:true, emails:[] } : { error:false, emails:(Array.isArray(data) ? data : []) };
  if(error) throw error;
  return sharedEmailsCache[rowId].emails;
}
// e-mails a row is currently shared with (not including me)
async function currentShareEmails(row){
  const kind = rowShareKind(row);
  const me = (currentUser.email || '').toLowerCase();
  if(kind === 'household') return householdMembers.map(m=>(m.email||'').toLowerCase()).filter(e=>e && e !== me);
  if(kind === 'own') return (await fetchSharedEmails(row.id, true)).map(e=>String(e).toLowerCase()).filter(e=>e !== me);
  return [];
}
// sync text for a row, for the list cards
function shareInfoForRow(row){
  const kind = rowShareKind(row);
  if(kind === 'local') return { text:'נשמרת רק במכשיר הזה', shared:false };
  if(kind === 'foreign') return { text:'שותפה איתכם על ידי ' + shortName(row.owner_email), shared:true };
  if(kind === 'household'){
    const others = householdMembers.filter(m=>m.user_id !== currentUser.id).map(m=>shortName(m.email));
    return others.length ? { text:'משותפת עם ' + others.join(', '), shared:true } : { text:'רק אתם', shared:false };
  }
  const c = sharedEmailsCache[row.id];
  if(!c){
    if(!shareInfoForRow._loading[row.id] && sbClient){
      shareInfoForRow._loading[row.id] = true;
      fetchSharedEmails(row.id).catch(()=>{}).finally(()=>{ delete shareInfoForRow._loading[row.id]; refreshListPickers(); });
    }
    return { text:'', shared:false };
  }
  if(c.error || !c.emails.length) return { text:'רק אתם', shared:false };
  return { text:'משותפת עם ' + c.emails.map(shortName).join(', '), shared:true };
}
shareInfoForRow._loading = {};
function refreshListPickers(){
  clearTimeout(refreshListPickers._t); refreshListPickers._t = setTimeout(saveListsOverviewCache, 1500);
  if(document.getElementById('shoppingPanel') && activeTab === 'shopping') renderShoppingPanel();
  if(document.getElementById('listsSheet')) openListsSheet();
}
// keep the cached copies of the other (non-active) rows reasonably fresh for counts on the cards
let shoppingRowsRefreshedAt = 0;
async function refreshShoppingRowsCache(force){
  if(!currentUser || !sbClient) return;
  if(!force && Date.now() - shoppingRowsRefreshedAt < 20000) return;
  shoppingRowsRefreshedAt = Date.now();
  try{
    const rows = await fetchUserDataRows('shopping_lists');
    if(!rows.length) return;
    const before = JSON.stringify(accountShoppingRows.map(r=>[r.id, r.id===activeShoppingRowId ? null : r.payload]));
    accountShoppingRows = rows;
    const after = JSON.stringify(accountShoppingRows.map(r=>[r.id, r.id===activeShoppingRowId ? null : r.payload]));
    if(before !== after) refreshListPickers();
  }catch(e){}
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') refreshShoppingRowsCache(true); });

// Make (rowId, listId) the open list — switching the synced row when the list lives in another row.
async function activateListRef(rowId, listId){
  if(!currentUser || !rowId || rowId === activeShoppingRowId){
    if(listId !== activeListId) switchShoppingList(listId);
    return true;
  }
  if(shoppingPushPending || shoppingPushInFlight){ try{ await pushShoppingRow(); }catch(e){} }
  const leaving = rowById(activeShoppingRowId);
  if(leaving){ syncLiveSetsIntoList(); leaving.payload = cloneJSON(shoppingLists); }
  let row = rowById(rowId);
  try{
    const { data } = await sbClient.from('user_data').select('*').eq('id', rowId).single();
    if(data){ row = data; const i = accountShoppingRows.findIndex(r=>r.id===rowId); if(i>-1) accountShoppingRows[i] = data; else accountShoppingRows.push(data); }
  }catch(e){}
  if(!row) return false;
  try{ localStorage.setItem('active_shopping_list', listId); }catch(e){}
  activeListId = listId;
  applyShoppingRow(row);
  if(shoppingLists[listId] && activeListId !== listId){ activeListId = listId; adoptShoppingLists(shoppingLists); }
  renderShoppingPanel();
  renderTabBadges();
  return true;
}

// Move one list out of a row that holds other lists (or the household row) into a new row of its own.
async function detachListToOwnRow(rowId, listId){
  if(rowId === activeShoppingRowId && (shoppingPushPending || shoppingPushInFlight)) await pushShoppingRow();
  const { data: src, error: e1 } = await sbClient.from('user_data').select('payload, updated_at').eq('id', rowId).single();
  if(e1 || !src) throw (e1 || new Error('row not found'));
  const list = (src.payload || {})[listId];
  if(!list) throw new Error('הרשימה לא נמצאה');
  // 1) copy into a new row first — if anything fails later, nothing is lost
  const { data: created, error: e2 } = await sbClient.from('user_data').insert({
    owner_id: currentUser.id, owner_email: currentUser.email, kind:'shopping_lists', payload: { [listId]: cloneJSON(list) }
  }).select().single();
  if(e2 || !created) throw (e2 || new Error('יצירת הרשימה נכשלה'));
  accountShoppingRows.push(created);
  // 2) remove it from the source row (compare-and-swap, retried on concurrent edits)
  let fresh = src, done = false, rest = null, stamp = null;
  for(let attempt = 0; attempt < 4 && !done; attempt++){
    if(attempt){ const r = await sbClient.from('user_data').select('payload, updated_at').eq('id', rowId).single(); if(r.error) throw r.error; fresh = r.data; }
    rest = cloneJSON(fresh.payload || {}); delete rest[listId];
    stamp = nextStamp(fresh.updated_at);
    let q = sbClient.from('user_data').update({ payload: rest, updated_at: stamp }).eq('id', rowId);
    q = fresh.updated_at ? q.eq('updated_at', fresh.updated_at) : q.is('updated_at', null);
    const { data: upd, error: e3 } = await q.select('updated_at');
    if(e3) throw e3;
    done = !!(upd && upd.length);
  }
  if(!done) throw new Error('הרשימה נערכה במקביל — נסו שוב');
  const srcRow = rowById(rowId);
  if(srcRow){ srcRow.payload = rest; srcRow.updated_at = stamp; }
  if(rowId === activeShoppingRowId){
    syncLiveSetsIntoList();
    const wasOpen = activeListId === listId;
    delete shoppingLists[listId];
    lastShoppingUpdatedAt = stamp;
    setShoppingBase(rest, rowId);
    adoptShoppingLists(shoppingLists);
    if(wasOpen) await activateListRef(created.id, listId);
  }
  return created;
}

// Add and/or remove one person on a list. Returns the row the list now lives in.
async function changeListSharing(rowId, listId, addEmail, removeEmail){
  let row = rowById(rowId);
  if(!row) throw new Error('הרשימה לא נמצאה');
  const kind = rowShareKind(row);
  if(kind === 'foreign' || kind === 'local') throw new Error('אי אפשר לשנות את השיתוף של הרשימה הזו');
  const current = await currentShareEmails(row);
  const desired = new Set(current);
  if(addEmail) desired.add(addEmail.toLowerCase());
  if(removeEmail) desired.delete(removeEmail.toLowerCase());
  if(desired.size === current.length && current.every(e=>desired.has(e))) return row;
  let cur = new Set(current);
  if(kind === 'household' || Object.keys(rowListsPayload(row)).length > 1){
    row = await detachListToOwnRow(rowId, listId);
    cur = new Set();
  }
  for(const e of desired){
    if(cur.has(e)) continue;
    const r = await shareRow(row.id, e);
    if(r !== 'ok') throw new Error(r === 'user not found' ? `${e} עדיין לא רשום/ה באפליקציה — צריך קודם להתחבר אליה פעם אחת` : r);
  }
  for(const e of cur){
    if(desired.has(e)) continue;
    const { data, error } = await sbClient.rpc('unshare_data_with_email', { row_id: row.id, target_email: e });
    if(error) throw error;
    if(data !== 'ok') throw new Error(data);
  }
  delete sharedEmailsCache[row.id];
  try{ await fetchSharedEmails(row.id, true); }catch(e){}
  return row;
}

function openListShareSheet(rowId, listId){
  const draw = async (statusText)=>{
    const row = rowById(rowId);
    const ref = allListRefs().find(r=>r.rowId === rowId && r.listId === listId);
    const name = ref ? ref.list.name : '';
    const kind = rowShareKind(row);
    let body = '';
    if(kind === 'local'){
      body = `<p class="settings-hint">כדי לשתף רשימה צריך להתחבר לחשבון (הגדרות ← חשבון ושיתוף).</p>`;
    } else if(kind === 'foreign'){
      body = `<p class="settings-hint">הרשימה שותפה איתכם על ידי <b dir="ltr">${escHtml(row.owner_email)}</b>. רק הוא/היא יכול/ה לשנות עם מי היא משותפת.</p>`;
    } else {
      let people = [];
      try{ people = await currentShareEmails(row); }catch(e){ statusText = 'לא ניתן לטעון כרגע עם מי הרשימה משותפת'; }
      const me = (currentUser.email||'').toLowerCase();
      const suggestions = householdMembers.map(m=>(m.email||'').toLowerCase()).filter(e=>e && e !== me && !people.includes(e));
      const multi = Object.keys(rowListsPayload(row)).length > 1;
      const note = kind === 'household'
        ? 'כרגע הרשימה משותפת עם כל משק הבית. שינוי כאן יחול רק על הרשימה הזו — שאר הרשימות יישארו משותפות כרגיל.'
        : (multi ? 'שינוי כאן יחול רק על הרשימה הזו.' : '');
      body = `
        ${note ? `<p class="settings-hint" style="margin:0 0 10px;">${note}</p>` : ''}
        <div class="sh-title">משותפת עם</div>
        ${people.length ? people.map(e=>`
          <div class="sh-row"><span class="sh-avatar">${escHtml(shortName(e).charAt(0).toUpperCase())}</span>
            <span class="sh-email" dir="ltr">${escHtml(e)}</span>
            <button type="button" class="sh-remove" data-email="${escAttr(e)}" aria-label="הסרת ${escAttr(e)}">הסירו</button></div>`).join('')
          : '<p class="custom-empty" style="margin:4px 0 8px;">רק אתם — הרשימה לא משותפת עם אף אחד.</p>'}
        ${suggestions.length ? `<div class="sh-title" style="margin-top:14px;">הוסיפו מבני הבית</div>
          <div class="sh-sugg">${suggestions.map(e=>`<button type="button" class="sh-add-chip" data-email="${escAttr(e)}">＋ ${escHtml(shortName(e))}</button>`).join('')}</div>` : ''}
        <div class="sh-title" style="margin-top:14px;">הוסיפו לפי אימייל</div>
        <div class="add-row" style="margin-bottom:4px;">
          <input type="email" id="shEmail" placeholder="אימייל של מי שרשום/ה באפליקציה" dir="ltr">
          <button type="button" id="shAddBtn">הוסיפו</button>
        </div>`;
    }
    const ov = openSheet('listShareSheet', `
      <div class="sheet-head"><h3>שיתוף · ${escHtml(name)}</h3><button type="button" class="sheet-x" id="shClose" aria-label="סגירה">×</button></div>
      ${body}
      <div class="cam-status" id="shStatus">${escHtml(statusText || '')}</div>`, 'top');
    ov.querySelector('#shClose').onclick = ()=> ov.remove();
    const run = async (add, remove)=>{
      const st = ov.querySelector('#shStatus');
      if(add && add.toLowerCase() === (currentUser.email||'').toLowerCase()){ st.textContent = 'זה האימייל שלכם 🙂'; return; }
      ov.querySelectorAll('button').forEach(b=>{ if(b.id !== 'shClose') b.disabled = true; });
      st.textContent = 'מעדכנים...';
      try{
        const newRow = await changeListSharing(rowId, listId, add, remove);
        rowId = newRow.id;
        refreshListPickers();
        draw(add ? `✓ ${shortName(add)} נוסף/ה` : `✓ ${shortName(remove)} הוסר/ה`);
      }catch(e){
        draw('שגיאה: ' + (e.message || 'השינוי נכשל'));
      }
    };
    ov.querySelectorAll('.sh-remove').forEach(b=>{
      b.onclick = ()=> showConfirmModal(`להפסיק לשתף את "${name}" עם ${b.dataset.email}?`, ()=> run(null, b.dataset.email));
    });
    ov.querySelectorAll('.sh-add-chip').forEach(b=>{ b.onclick = ()=> run(b.dataset.email, null); });
    const addBtn = ov.querySelector('#shAddBtn');
    if(addBtn){
      const go = ()=>{ const v = norm(ov.querySelector('#shEmail').value); if(v) run(v, null); };
      addBtn.onclick = go;
      ov.querySelector('#shEmail').addEventListener('keydown', e=>{ if(e.key === 'Enter') go(); });
    }
  };
  draw('');
}

// ---- Lists overview: when Shopping is the only tab, the app opens on a page of all lists ----
let shopView = 'overview';        // 'overview' | 'list' — only used while overview mode is on
function shopOverviewEnabled(){ return true; }   // the shopping tab always opens on the page of all lists
// page-level colours/layout for the lists page and the list page — only while the shopping tab is on screen
function updateShopBodyClasses(){
  const onShop = activeTab === 'shopping';
  document.body.classList.toggle('shop-overview', onShop && showingShopOverview());
  document.body.classList.toggle('shop-listview', onShop && !showingShopOverview());
  const tc = document.querySelector('meta[name="theme-color"]');
  if(tc) tc.content = onShop ? (isDark ? (showingShopOverview() ? '#161616' : '#1E1E1E') : (showingShopOverview() ? '#F2F2F2' : '#FFFFFF')) : (isDark ? '#1A1916' : '#F6F3EA');
}
function showingShopOverview(){ return shopOverviewEnabled() && shopView === 'overview'; }
function shortName(email){ return String(email || '').split('@')[0]; }
// "who is this shared with" — all lists live in one synced row, so they share the same people
function shoppingShareInfo(){
  if(!currentUser) return { text:'נשמרת רק במכשיר הזה', shared:false };
  const row = activeShoppingRowId ? ownerOfRow(activeShoppingRowId) : null;
  if(myHousehold && row && row.household_id){
    const others = householdMembers.filter(m=>m.user_id !== currentUser.id).map(m=>shortName(m.email));
    return others.length ? { text:'משותפת עם ' + others.join(', '), shared:true } : { text:'משק בית ' + (myHousehold.name||'') + ' · רק אתם עדיין', shared:false };
  }
  if(row && row.owner_id !== currentUser.id) return { text:'שותפה איתכם על ידי ' + shortName(row.owner_email), shared:true };
  const c = activeShoppingRowId ? sharedEmailsCache[activeShoppingRowId] : null;
  if(!c){
    if(activeShoppingRowId && sbClient && !shoppingShareInfo._loading){
      shoppingShareInfo._loading = true;
      sbClient.rpc('get_shared_emails', { row_id: activeShoppingRowId }).then(({ data, error })=>{
        sharedEmailsCache[activeShoppingRowId] = error ? { error:true, emails:[] } : { error:false, emails:(Array.isArray(data) ? data : []) };
      }).catch(()=>{}).finally(()=>{ shoppingShareInfo._loading = false; if(showingShopOverview()) renderShoppingPanel(); });
    }
    return { text:'', shared:false };
  }
  if(c.error || !c.emails.length) return { text:'רק אתם', shared:false };
  return { text:'משותפת עם ' + c.emails.map(shortName).join(', '), shared:true };
}
async function openShoppingListFromOverview(id, rowId){
  await activateListRef(rowId || activeShoppingRowId, id);
  shopView = 'list';
  try{ history.pushState({ shopList:true }, ''); }catch(e){}
  renderShoppingPanel();
  window.scrollTo(0, 0);
}
function backToShopOverview(){
  shopView = 'overview';
  closeShopAddBar();
  renderShoppingPanel();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', ()=>{ if(shopOverviewEnabled() && shopView === 'list') backToShopOverview(); });
// e-mails of the people a list's row is shared with (not including me) — for the avatars on the cards
function sharePeopleForRow(row){
  const kind = rowShareKind(row);
  if(kind === 'household') return householdMembers.filter(m=>m.user_id !== currentUser.id).map(m=>m.email).filter(Boolean);
  if(kind === 'foreign') return row.owner_email ? [row.owner_email] : [];
  if(kind === 'own'){
    shareInfoForRow(row);                       // loads the e-mails in the background the first time
    const c = sharedEmailsCache[row.id];
    return c && !c.error ? c.emails : [];
  }
  return [];
}
const OV_AVATAR_COLORS = [['#C9C6EC','#3B3870'], ['#BFE3C8','#24533A'], ['#F5D2B8','#6B3A1C'], ['#BFDDF2','#1F4866'], ['#F2C4D3','#6A2440']];
function ovAvatarColor(email){
  let h = 0; for(const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OV_AVATAR_COLORS[h % OV_AVATAR_COLORS.length];
}
function renderShoppingOverview(el){
  syncLiveSetsIntoList();
  refreshShoppingRowsCache();
  const cards = allListRefs().map(ref=>{
    const id = ref.listId, l = ref.list;
    const { total, done } = refStats(ref);
    const pct = total ? Math.round(done/total*100) : 0;
    const people = ref.row ? sharePeopleForRow(ref.row) : [];
    const shown = people.slice(0, 2);
    const peopleHtml = shown.map(e=>{
      const [bg, fg] = ovAvatarColor(e);
      return `<div class="ov-person"><span class="ov-avatar" style="background:${bg};color:${fg}">${escHtml(String(e).charAt(0).toUpperCase())}</span><span class="ov-email" dir="ltr">${escHtml(e)}</span></div>`;
    }).join('') + (people.length > 2 ? `<div class="ov-more">ועוד ${people.length - 2} משתתפים</div>` : '');
    return `
      <div class="ov-card" data-id="${escAttr(id)}" data-row="${escAttr(ref.rowId||'')}" role="button" tabindex="0">
        <div class="ov-head">
          <span class="ov-name">${escHtml(l.name)}</span>
          <button type="button" class="ov-menu" data-id="${escAttr(id)}" data-row="${escAttr(ref.rowId||'')}" aria-label="אפשרויות הרשימה">⋮</button>
        </div>
        <div class="ov-progress"><span class="ov-bar"><i style="width:${pct}%"></i></span><span class="ov-frac" dir="ltr">${done}/${total}</span></div>
        ${peopleHtml ? `<div class="ov-people">${peopleHtml}</div>` : ''}
      </div>`;
  }).join('');
  el.innerHTML = `
    <div class="ov-list">${cards}</div>
    <button type="button" class="ov-fab" id="ovNewBtn" aria-label="רשימה חדשה">+</button>`;
  el.querySelectorAll('.ov-card').forEach(c=>{
    const open = ()=> openShoppingListFromOverview(c.dataset.id, c.dataset.row || null);
    c.onclick = open;
    c.onkeydown = (e)=>{ if(e.key === 'Enter') open(); };
  });
  el.querySelectorAll('.ov-menu').forEach(b=>{ b.onclick = (e)=>{ e.stopPropagation(); openListMenu(b.dataset.id, b.dataset.row || null); }; });
  el.querySelector('#ovNewBtn').onclick = createShoppingList;
  renderShopManageBox();
}

function renderShoppingPanel(){
  const el = document.getElementById('shoppingPanel');
  updateShopBodyClasses();
  const titleEl = document.getElementById('shoppingTitle');
  if(titleEl) titleEl.textContent = showingShopOverview() ? 'הרשימות שלי' : 'רשימת קניות';
  if(showingShopOverview()){ renderShoppingOverview(el); return; }

  // List page: a top bar (back · name · share · menu), a thin progress line, the items, and an "Add" button
  const list = getActiveList();
  const totalN = shoppingList.size;
  const checkedCount = [...shoppingList].filter(i=>boughtItems.has(i)).length;
  const pct = totalN ? Math.round(checkedCount/totalN*100) : 0;
  let html = `
    <div class="sl-top">
      <button type="button" class="sl-icon sl-back" id="ovBackBtn" aria-label="חזרה לכל הרשימות"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M20 12H5M11 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="sl-title">${escHtml(list.name || '')}</span>
      <button type="button" class="sl-icon" id="slShareBtn" aria-label="עם מי הרשימה משותפת"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="9" cy="8" r="4" fill="currentColor"/><path d="M1.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5z" fill="currentColor"/><path d="M19.5 8v6M16.5 11h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      <button type="button" class="sl-icon sl-dots" id="slMenuBtn" aria-label="אפשרויות הרשימה">⋮</button>
      <div class="sl-prog" aria-label="${checkedCount} מתוך ${totalN} נקנו"><i style="width:${pct}%"></i></div>
    </div>`;

  const freqHtml = (items)=> items.length ? `<div class="shop-freq-section">
        <div class="shop-freq-title">בשימוש תדיר — לחצו להוספה</div>
        <div class="shop-freq-grid">${items.map(it=>
          `<button type="button" class="shop-freq-chip" data-name="${escAttr(it.name)}">${escHtml(it.name)}</button>`
        ).join('')}</div>
      </div>` : '';
  const wireFreq = ()=> el.querySelectorAll('.shop-freq-chip').forEach(chip=>{
    chip.onclick = ()=>{
      const name = chip.dataset.name;
      shoppingList.add(name);
      boughtItems.delete(name);
      recordUsage(name);
      saveShoppingList();
      saveBought();
      renderShoppingPanel();
      renderTabBadges();
    };
  });

  if(shoppingList.size===0){
    html += '<p class="shopping-empty">הרשימה ריקה — לחצו על "הוספה" או הוסיפו מצרכים חסרים ממתכון</p>';
    html += freqHtml(getAllKnownItems()
      .filter(it => it.freq > 0)
      .sort((a,b)=> b.freq - a.freq || a.name.localeCompare(b.name,'he'))
      .slice(0, 12));
    html += shopAddFabHtml();
    el.innerHTML = html;
    wireListPageChrome();
    renderShopManageBox();
    wireFreq();
    return;
  }

  // Group by category; the unchecked items first, the checked ones folded away below
  const catOrder = [...new Set(allCategoryNames().concat(['אחר']))];
  const itemRow = (item)=>{
    const bought = boughtItems.has(item);
    const emoji = iconOf(item);
    const qty = qtyOfShopItem(item);
    const note = ((list.notes)||{})[item] || '';
    const sub = [qty, note].filter(Boolean).join(' · ');
    return `
        <div class="shop-item sl-row ${bought?'bought':''}" data-item="${escAttr(item)}">
          <button type="button" class="shop-check" aria-label="${bought?'ביטול סימון':'סימון כנקנה'}">${bought?'✓':''}</button>
          <div class="shop-item-name"><span class="sl-name">${escHtml(item)}</span>${sub?`<div class="shop-item-note">${escHtml(sub)}</div>`:''}</div>
          <button type="button" class="shop-item-icon" aria-label="שינוי קטגוריה">${escHtml(emoji)}</button>
        </div>`;
  };
  const groupsHtml = (items)=>{
    const groups = {};
    items.forEach(item=>{ const cat = catOf(item); (groups[cat] = groups[cat] || []).push(item); });
    const nonEmpty = catOrder.filter(c=>groups[c] && groups[c].length);
    return nonEmpty.map(cat=>`
      ${nonEmpty.length > 1 ? `<div class="sl-cat">${escHtml(cat)}</div>` : ''}
      <div class="sl-block">${groups[cat].sort((a,b)=>a.localeCompare(b,'he')).map(itemRow).join('')}</div>`).join('');
  };
  const openItems = [...shoppingList].filter(i=>!boughtItems.has(i));
  const doneItems = [...shoppingList].filter(i=>boughtItems.has(i));
  html += openItems.length ? groupsHtml(openItems) : '<p class="shopping-empty">✓ הכול נקנה!</p>';

  if(checkedCount > 0){
    html += `<button class="shop-checked-toggle" id="toggleCheckedBtn" aria-expanded="${showCheckedShop?'true':'false'}">
      <span class="sl-chev${showCheckedShop?' up':''}">⌄</span> ${showCheckedShop ? 'הסתרת פריטים שסומנו' : `הצגת פריטים שסומנו (${checkedCount})`}
    </button>`;
    if(showCheckedShop) html += `<div class="sl-block sl-done">${doneItems.sort((a,b)=>a.localeCompare(b,'he')).map(itemRow).join('')}</div>`;
  }

  // Frequent items (history) not already on the list
  html += freqHtml(getAllKnownItems()
    .filter(it => it.freq > 0 && !shoppingList.has(it.name))
    .sort((a,b)=> b.freq - a.freq || a.name.localeCompare(b.name,'he'))
    .slice(0, 12));

  html += shopAddFabHtml();
  el.innerHTML = html;
  wireListPageChrome();
  renderShopManageBox();

  el.querySelectorAll('.shop-item').forEach(row=>{
    const item = row.dataset.item;
    // the circle marks bought; the emoji opens the category picker; the rest of the row opens the item editor
    row.querySelector('.shop-check').onclick = (e)=>{
      e.stopPropagation();
      if(boughtItems.has(item)) boughtItems.delete(item);
      else boughtItems.add(item);
      saveBought();
      renderShoppingPanel();
    };
    row.querySelector('.shop-item-icon').onclick = (e)=>{ e.stopPropagation(); openCategoryPicker(item); };
    row.onclick = ()=> openItemSheet(item);
  });

  const toggleBtn = document.getElementById('toggleCheckedBtn');
  if(toggleBtn){
    toggleBtn.onclick = ()=>{
      showCheckedShop = !showCheckedShop;
      renderShoppingPanel();
    };
  }
  el.querySelectorAll('.shop-freq-chip').forEach(chip=>{
    chip.onclick = ()=>{
      const name = chip.dataset.name;
      shoppingList.add(name);
      boughtItems.delete(name);
      recordUsage(name);
      saveShoppingList();
      saveBought();
      renderShoppingPanel();
      renderTabBadges();
    };
  });
}

// ---- list page chrome: top bar buttons, the "Add" pill, the bottom add bar, the ⌄ actions menu ----
function shopAddFabHtml(){
  return `<div class="sl-fab">
      <button type="button" class="sl-fab-more" id="slMoreBtn" aria-label="פעולות נוספות"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button type="button" class="sl-fab-add" id="slAddBtn">+ הוספה</button>
    </div>`;
}
function wireListPageChrome(){
  const back = document.getElementById('ovBackBtn');
  if(back) back.onclick = ()=>{ if(history.state && history.state.shopList){ history.back(); } else backToShopOverview(); };
  const share = document.getElementById('slShareBtn');
  if(share) share.onclick = ()=>{
    if(!currentUser){ alert('כדי לשתף רשימה צריך להתחבר לחשבון (בהגדרות)'); return; }
    openListShareSheet(activeShoppingRowId, activeListId);
  };
  const menu = document.getElementById('slMenuBtn');
  if(menu) menu.onclick = ()=> openListMenu(activeListId, activeShoppingRowId);
  const add = document.getElementById('slAddBtn');
  if(add) add.onclick = openShopAddBar;
  const more = document.getElementById('slMoreBtn');
  if(more) more.onclick = openListActionsSheet;
}
function openShopAddBar(){
  let bar = document.getElementById('slAddBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'slAddBar';
    bar.className = 'sl-addbar';
    bar.innerHTML = `
      <div class="autocomplete-row" id="shopAutocomplete"></div>
      <div class="shop-toolbar">
        <input type="text" id="shopAddInput" placeholder="מה להוסיף?" autocomplete="off" enterkeyhint="done">
        <input type="text" id="shopAddQty" placeholder="כמות" class="shop-qty-input" autocomplete="off">
        <button type="button" id="shopAddBtn">הוספה</button>
        <button type="button" class="sl-addbar-x" id="slAddClose" aria-label="סגירה">×</button>
      </div>`;
    document.body.appendChild(bar);
    wireShopToolbar();
    bar.querySelector('#slAddClose').onclick = closeShopAddBar;
  }
  document.body.classList.add('sl-adding');
  const inp = document.getElementById('shopAddInput');
  if(inp) inp.focus();
}
function closeShopAddBar(){
  const bar = document.getElementById('slAddBar');
  if(bar) bar.remove();
  document.body.classList.remove('sl-adding');
}
function openListActionsSheet(){
  const checkedCount = [...shoppingList].filter(i=>boughtItems.has(i)).length;
  const ov = openSheet('listActionsSheet', `
    <div class="sheet-head"><h3>${escHtml(getActiveList().name || '')}</h3><button type="button" class="sheet-x" id="laClose" aria-label="סגירה">×</button></div>
    <button type="button" class="lm-row" id="laShopMode">🔆  מצב קניות (מסך גדול בסופר)</button>
    <button type="button" class="lm-row" id="laClear" ${checkedCount?'':'disabled'}>🧹  נקו פריטים שסומנו${checkedCount?` (${checkedCount})`:''}</button>
    ${activeListId !== 'main' && shoppingList.size && shoppingLists.main ? '<button type="button" class="lm-row" id="laTransfer">➡️  העבירו פריטים לרשימה הראשית</button>' : ''}
    <button type="button" class="lm-row" id="laSave" ${shoppingList.size?'':'disabled'}>💾  שמרו עותק של הרשימה לשימוש בהמשך</button>`, 'top');
  ov.querySelector('#laClose').onclick = ()=> ov.remove();
  ov.querySelector('#laShopMode').onclick = ()=>{ ov.remove(); openShoppingMode(); };
  ov.querySelector('#laClear').onclick = ()=>{
    ov.remove();
    if(boughtItems.size === 0) return;
    showConfirmModal(`להסיר מהרשימה ${boughtItems.size} פריטים שסומנו כנקנו?`, ()=>{
      clearBoughtInList(activeListId);
      renderShoppingPanel();
      renderTabBadges();
    });
  };
  const tr = ov.querySelector('#laTransfer');
  if(tr) tr.onclick = ()=>{ ov.remove(); openTransferToMainSheet(activeListId); };
  ov.querySelector('#laSave').onclick = ()=>{ ov.remove(); saveShoppingListForLater(); };
}

/** Snapshot the current shopping list as a new named list (ready to reuse later). */
function saveShoppingListForLater(){
  if(shoppingList.size === 0){
    alert('הרשימה ריקה — אין מה לשמור');
    return;
  }
  const active = getActiveList();
  const defaultName = (active.name || 'רשימה') + ' — שמורה';
  showPromptModal('שם לרשימה השמורה (אפשר לחזור אליה מאוחר יותר):', (name)=>{
    const id = 'saved_' + Date.now().toString(36);
    const quantities = {};
    const notes = {};
    const srcQty = active.quantities || {};
    const srcNotes = active.notes || {};
    [...shoppingList].forEach(item=>{
      if(srcQty[item]) quantities[item] = srcQty[item];
      if(srcNotes[item]) notes[item] = srcNotes[item];
    });
    shoppingLists[id] = {
      name,
      items: [...shoppingList],
      bought: [], // fresh list — nothing marked bought
      quantities,
      notes,
      syncCode: null
    };
    localStorage.setItem('shopping_lists', JSON.stringify(shoppingLists));
    scheduleShoppingPush();
    renderShoppingPanel();
    renderTabBadges();
    alert(`✓ נשמרה הרשימה «${name}»\nהיא מופיעה במסך כל הרשימות.`);
  }, defaultName);
}

function renderShopManageBox(){
  const el = document.getElementById('shoppingManageBox');
  if(!el) return;
  const catOrder = [...new Set(allCategoryNames().concat(['אחר']))];
  el.innerHTML = `
    <div class="settings-hint" style="margin-bottom:12px;">הפעולות כאן חלות על הרשימה הפעילה: <b>${escHtml(getActiveList().name)}</b></div>
    ${renderSyncBoxHTML()}
    <div class="shop-footer">
      <button class="primary" id="copyShoppingBtn">📋 העתקה</button>
      <button id="whatsappShareBtn">💬 וואטסאפ</button>
      <button id="importShopBtn">📥 ייבוא</button>
      <button id="shareCodeBtn">🔗 קוד שיתוף</button>
      <button id="clearBoughtBtn">נקו מסומנים</button>
      <button id="clearShoppingBtn">נקו הכל</button>
    </div>
    <button type="button" class="import-btn secondary" id="shopHistoryBtn" style="margin-top:12px;">🕘 גרסאות קודמות של הרשימה</button>
  `;
  document.getElementById('shopHistoryBtn').onclick = openShopHistorySheet;
  wireSyncBox();

  document.getElementById('copyShoppingBtn').onclick = ()=>{
    const lines = ['רשימת קניות:'];
    catOrder.forEach(cat=>{
      const items = [...shoppingList].filter(i=>catOf(i)===cat);
      if(!items.length) return;
      lines.push('', cat + ':');
      items.sort((a,b)=>a.localeCompare(b,'he')).forEach(i=>{
        const q = qtyOfShopItem(i);
        lines.push((boughtItems.has(i)?'✓ ':'☐ ')+i+(q?` (${q})`:''));
      });
    });
    const text = lines.join('\n');
    if(navigator.clipboard) navigator.clipboard.writeText(text).then(()=>alert('הרשימה הועתקה')).catch(()=>{});
  };

  document.getElementById('whatsappShareBtn').onclick = ()=>{
    const lines = ['רשימת קניות:'];
    catOrder.forEach(cat=>{
      const items = [...shoppingList].filter(i=>catOf(i)===cat && !boughtItems.has(i));
      if(!items.length) return;
      lines.push('', '*'+cat+'*');
      items.forEach(i=>{
        const q = qtyOfShopItem(i);
        lines.push('• '+i+(q?` (${q})`:''));
      });
    });
    window.open('https://wa.me/?text='+encodeURIComponent(lines.join('\n')), '_blank');
  };

  document.getElementById('importShopBtn').onclick = importShoppingList;
  document.getElementById('shareCodeBtn').onclick = shareShoppingCode;

  document.getElementById('clearBoughtBtn').onclick = ()=>{
    syncLiveSetsIntoList(); snapshotShopping(shoppingLists, 'לפני ניקוי מסומנים');
    boughtItems.forEach(i=>shoppingList.delete(i));
    boughtItems.clear();
    saveShoppingList();
    saveBought();
    renderShoppingPanel();
  };
  document.getElementById('clearShoppingBtn').onclick = ()=>{
    showConfirmModal('למחוק את כל רשימת הקניות?', ()=>{
      syncLiveSetsIntoList(); snapshotShopping(shoppingLists, 'לפני מחיקת הרשימה');
      shoppingList.clear();
      boughtItems.clear();
      saveShoppingList();
      saveBought();
      renderShoppingPanel();
    });
  };
}

function wireShopToolbar(){
  const add = ()=>{
    const input = document.getElementById('shopAddInput');
    const qtyInput = document.getElementById('shopAddQty');
    const val = norm(input.value);
    if(val){
      shoppingList.add(val);
      boughtItems.delete(val);
      recordUsage(val);
      saveShoppingList();
      saveBought();
      const qty = norm(qtyInput ? qtyInput.value : '');
      if(qty) setItemQuantity(val, qty);
      input.value = '';
      if(qtyInput) qtyInput.value = '';
      document.getElementById('shopAutocomplete').innerHTML = '';
      renderShoppingPanel();
    }
  };
  const btn = document.getElementById('shopAddBtn');
  if(btn) btn.onclick = ()=>{ add(); const i = document.getElementById('shopAddInput'); if(i) i.focus(); };
  const input = document.getElementById('shopAddInput');
  if(input && input.dataset.wired) return;
  if(input) input.dataset.wired = '1';
  if(input){
    input.addEventListener('keydown', e=>{ if(e.key==='Enter') add(); });
    input.addEventListener('input', e=>{
      renderAutocomplete('shopAutocomplete', e.target.value, (name)=>{
        input.value = name;
        add();
      }, [...shoppingList]);
    });
  }
  const qtyInput = document.getElementById('shopAddQty');
  if(qtyInput) qtyInput.addEventListener('keydown', e=>{ if(e.key==='Enter') add(); });
}

function importShoppingList(){
  showTextareaModal('הדביקו כאן רשימת קניות (שורה לכל פריט, או קוד שיתוף):', (raw)=>{
    try{
      // try base64 share code
      if(raw.trim().startsWith('SHOP:')){
        const decoded = JSON.parse(decodeURIComponent(atob(raw.trim().slice(5))));
        if(Array.isArray(decoded)){
          decoded.forEach(i=>{ shoppingList.add(norm(i)); boughtItems.delete(norm(i)); });
          saveShoppingList(); saveBought();
          renderShoppingPanel();
          alert('יובאו '+decoded.length+' פריטים');
          return;
        }
      }
    }catch(e){}
    const lines = raw.split(/[\n,،]+/).map(s=>norm(s.replace(/^[☐✓•\-\*\d\.\s]+/,''))).filter(Boolean);
    lines.forEach(i=>{ shoppingList.add(i); boughtItems.delete(i); });
    saveShoppingList(); saveBought();
    renderShoppingPanel();
    alert('יובאו '+lines.length+' פריטים');
  });
}

function shareShoppingCode(){
  const arr = [...shoppingList];
  if(!arr.length){ alert('הרשימה ריקה'); return; }
  const code = 'SHOP:' + btoa(encodeURIComponent(JSON.stringify(arr)));
  if(navigator.clipboard){
    navigator.clipboard.writeText(code).then(()=>alert('קוד השיתוף הועתק!\nמישהו אחר יכול להדביק אותו ב״ייבוא רשימה״')).catch(()=>{
      prompt('העתיקו את הקוד:', code);
    });
  } else {
    prompt('העתיקו את הקוד:', code);
  }
}

// ——— Cooking Mode ———
let cookState = { recipe:null, step:0, timerSec:0, timerInterval:null, running:false, usedIngredients:new Set(), timerPanelOpen:false };
let cookViewMode = localStorage.getItem('cook_view_mode') || 'pages'; // 'pages' | 'list'
let wakeLockRef = null;
let shoppingModeActive = false;
let smSearchQuery = '';

async function acquireWakeLock(){
  try{
    if('wakeLock' in navigator){
      wakeLockRef = await navigator.wakeLock.request('screen');
    }
  }catch(e){ /* wake lock not available or denied — screen may just dim on its own */ }
}
function releaseWakeLock(){
  if(wakeLockRef){
    wakeLockRef.release().catch(()=>{});
    wakeLockRef = null;
  }
}
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && (cookState.recipe || shoppingModeActive)) acquireWakeLock();
});

function playTimerBeep(){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const beep = (freq, start, dur)=>{
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(start); o.stop(start + dur + 0.02);
    };
    const t0 = ctx.currentTime;
    beep(880, t0, 0.22);
    beep(880, t0 + 0.32, 0.22);
    beep(1175, t0 + 0.64, 0.35);
    setTimeout(()=>{ try{ ctx.close(); }catch(e){} }, 1500);
  }catch(e){}
}

function renderShoppingModeList(){
  const el = document.getElementById('smList');
  const prog = document.getElementById('smProgress');
  const total = shoppingList.size;
  const done = [...shoppingList].filter(i=>boughtItems.has(i)).length;
  if(prog){
    const pct = total ? Math.round((done/total)*100) : 0;
    prog.innerHTML = total
      ? `<div>${done}/${total} נקנו</div><div class="sm-progress-bar"><i style="width:${pct}%"></i></div>`
      : '';
  }
  const hideBtn = document.getElementById('smHideCheckedBtn');
  if(hideBtn){
    hideBtn.textContent = smHideChecked ? 'הציגו מסומנים' : 'הסתירו מסומנים';
    hideBtn.classList.toggle('active', smHideChecked);
  }

  const q = norm(smSearchQuery).toLowerCase();
  let items = [...shoppingList];
  if(smHideChecked) items = items.filter(i => !boughtItems.has(i));
  if(q) items = items.filter(i => i.toLowerCase().includes(q));
  if(shoppingList.size===0){
    el.innerHTML = '<div class="sm-empty">הרשימה ריקה</div>';
    return;
  }
  if(items.length===0){
    el.innerHTML = '<div class="sm-empty">'+(q?'לא נמצאו פריטים תואמים':(smHideChecked?'הכול סומן ✓ — כל הכבוד!':'אין פריטים'))+'</div>';
    return;
  }
  // Aisle order ≈ category order (produce → dairy → pantry…)
  const catOrder = [...new Set(allCategoryNames().concat(['אחר']))];
  const groups = {};
  items.forEach(item=>{
    const cat = catOf(item);
    if(!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  });
  let html = '';
  catOrder.forEach(cat=>{
    if(!groups[cat] || groups[cat].length===0) return;
    const sorted = groups[cat].sort((a,b)=> (boughtItems.has(a)?1:0) - (boughtItems.has(b)?1:0) || a.localeCompare(b,'he'));
    html += `<div class="sm-group-title">${escHtml(cat)}</div>`;
    html += sorted.map(name=>{
      const bought = boughtItems.has(name);
      const qty = qtyOfShopItem(name);
      return `
        <div class="sm-row${bought?' bought':''}" data-item="${escAttr(name)}">
          <span class="sm-check">${bought?'✓':''}</span>
          <span class="sm-icon">${escHtml(iconOf(name))}</span>
          <span class="sm-name">${escHtml(name)}${qty?` <span class="shop-item-qty">(${escHtml(qty)})</span>`:''}</span>
        </div>`;
    }).join('');
  });
  el.innerHTML = html;
  el.querySelectorAll('.sm-row').forEach(row=>{
    row.onclick = ()=>{
      const name = row.dataset.item;
      if(boughtItems.has(name)) boughtItems.delete(name); else boughtItems.add(name);
      saveBought();
      renderShoppingModeList();
      renderShoppingPanel();
    };
  });
}
function openShoppingMode(){
  shoppingModeActive = true;
  smSearchQuery = '';
  const searchInput = document.getElementById('smSearchInput');
  if(searchInput) searchInput.value = '';
  document.getElementById('shoppingModeOverlay').classList.add('active');
  acquireWakeLock();
  renderShoppingModeList();
  // Don't auto-focus search — keeps the list fully visible in the supermarket
}
function closeShoppingMode(){
  shoppingModeActive = false;
  smSearchQuery = '';
  document.getElementById('shoppingModeOverlay').classList.remove('active');
  releaseWakeLock();
}
document.getElementById('openShoppingModeBtn').onclick = openShoppingMode;
document.getElementById('smCloseBtn').onclick = closeShoppingMode;
document.getElementById('smSearchInput').addEventListener('input', (e)=>{
  smSearchQuery = e.target.value;
  renderShoppingModeList();
});
const smHideBtn = document.getElementById('smHideCheckedBtn');
if(smHideBtn){
  smHideBtn.onclick = ()=>{
    smHideChecked = !smHideChecked;
    localStorage.setItem('sm_hide_checked', smHideChecked ? '1' : '0');
    renderShoppingModeList();
  };
}
const smClearBtn = document.getElementById('smClearBoughtBtn');
if(smClearBtn){
  smClearBtn.onclick = ()=>{
    if(boughtItems.size === 0) return;
    showConfirmModal(`להסיר מהרשימה ${boughtItems.size} פריטים שסומנו?`, ()=>{
      clearBoughtInList(activeListId);
      renderShoppingModeList();
      renderShoppingPanel();
      renderTabBadges();
    });
  };
}

function stopSpeaking(){
  if('speechSynthesis' in window) window.speechSynthesis.cancel();
  const btn = document.getElementById('cookSpeakBtn');
  if(btn){ btn.classList.remove('speaking'); btn.textContent = '🔊 הקריאו'; }
}
function toggleSpeak(){
  if(!('speechSynthesis' in window)){
    alert('הקראה קולית לא נתמכת בדפדפן הזה');
    return;
  }
  const btn = document.getElementById('cookSpeakBtn');
  if(window.speechSynthesis.speaking){
    stopSpeaking();
    return;
  }
  const r = cookState.recipe;
  let text;
  if(cookViewMode === 'list'){
    text = 'מצרכים: ' + r.ingredients.map(i=>{ const q=ingQty(i); return (q?q+' ':'')+ingName(i); }).join(', ') + '. הוראות: ' + r.steps.join('. ');
  } else {
    const idx = cookState.step;
    text = idx === 0
      ? 'מצרכים: ' + r.ingredients.map(i=>{ const q=ingQty(i); return (q?q+' ':'')+ingName(i); }).join(', ')
      : r.steps[idx-1];
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'he-IL';
  utter.onend = stopSpeaking;
  utter.onerror = stopSpeaking;
  window.speechSynthesis.speak(utter);
  btn.classList.add('speaking');
  btn.textContent = '⏹ עצירה';
}
document.getElementById('cookSpeakBtn').onclick = toggleSpeak;

function applyCookViewMode(){
  const overlay = document.getElementById('cookOverlay');
  overlay.classList.toggle('cook-list-mode', cookViewMode === 'list');
  document.querySelectorAll('#cookViewToggle button').forEach(b=>{
    b.classList.toggle('active', b.dataset.mode === cookViewMode);
  });
}
document.querySelectorAll('#cookViewToggle button').forEach(btn=>{
  btn.onclick = ()=>{
    cookViewMode = btn.dataset.mode;
    localStorage.setItem('cook_view_mode', cookViewMode);
    applyCookViewMode();
    renderCookStep();
  };
});

(function setupCookFontPanel(){
  const panel = document.getElementById('cookFontPanel');
  const btn = document.getElementById('cookFontBtn');
  if(!panel || !btn) return;
  panel.querySelector('.cook-font-opts').innerHTML = COOK_FONTS.map(f=>
    `<button type="button" class="cook-font-opt" data-font="${f.id}" style="font-family:${f.family}; font-weight:${f.weight||400}">אבג ${f.label}</button>`).join('');
  panel.querySelectorAll('.cook-font-opt').forEach(b=>{ b.onclick = ()=>{ cookFont = b.dataset.font; saveCookTypography(); }; });
  const step = (d)=>{ const i = COOK_SCALES.indexOf(cookScale); const n = Math.min(COOK_SCALES.length-1, Math.max(0, i + d)); cookScale = COOK_SCALES[n]; saveCookTypography(); };
  document.getElementById('cookSizeMinus').onclick = ()=> step(-1);
  document.getElementById('cookSizePlus').onclick = ()=> step(1);
  btn.onclick = (e)=>{ e.stopPropagation(); const open = panel.classList.toggle('open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  // tapping anywhere else in cook mode closes the panel
  document.getElementById('cookOverlay').addEventListener('click', (e)=>{
    if(panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn){ panel.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }
  });
  applyCookTypography();
})();

function openCookMode(r){
  cookState.recipe = r;
  cookState.step = 0;
  cookState.usedIngredients = new Set();
  cookState.timerPanelOpen = false;
  resetTimer();
  document.getElementById('cookTimerPanel').classList.remove('open');
  document.getElementById('cookOverlay').classList.add('active');
  applyCookViewMode();
  acquireWakeLock();
  renderCookStep();
}

function closeCookMode(){
  document.getElementById('cookOverlay').classList.remove('active');
  document.getElementById('cookTimerPanel').classList.remove('open');
  document.getElementById('cookFontPanel').classList.remove('open');
  cookState.timerPanelOpen = false;
  stopTimer();
  stopSpeaking();
  releaseWakeLock();
  cookState.recipe = null;
}

function cookIngredientsHTML(r){
  return `<div class="cook-ing-list">${
    r.ingredients.map(i=>{
      const name = ingName(i);
      const have = fridge.has(name);
      const qty = ingQty(i);
      const used = cookState.usedIngredients.has(name);
      return `
        <div class="cook-ing-row${used?' used':''}" data-ing="${escAttr(name)}">
          <span class="cook-ing-check">${used?'✓':''}</span>
          <span class="cook-ing-dot ${have?'have':'miss'}"></span>
          <span class="cook-ing-text">${qty ? escHtml(qty)+' ' : ''}${escHtml(name)}</span>
        </div>`;
    }).join('')
  }</div>`;
}
function wireCookIngredientClicks(stepTextEl){
  stepTextEl.querySelectorAll('.cook-ing-row').forEach(row=>{
    row.onclick = ()=>{
      const ing = row.dataset.ing;
      if(cookState.usedIngredients.has(ing)) cookState.usedIngredients.delete(ing);
      else cookState.usedIngredients.add(ing);
      renderCookStep();
    };
  });
}

function renderCookStep(){
  const r = cookState.recipe;
  if(!r) return;
  stopSpeaking();
  const total = r.steps.length + 1;
  const idx = cookState.step;
  document.getElementById('cookTitle').textContent = r.name;
  document.getElementById('cookProgressBar').style.width = ((idx+1)/total*100)+'%';

  const stepTextEl = document.getElementById('cookStepText');
  if(cookViewMode === 'list'){
    document.getElementById('cookStepNum').textContent = 'כל המתכון';
    stepTextEl.innerHTML = `
      <div class="cook-list-ing-title">מצרכים</div>
      ${cookIngredientsHTML(r)}
      <div class="cook-list-steps-title">הוראות הכנה</div>
      <ol class="cook-list-steps">${r.steps.map(s=>`<li>${escHtml(s)}</li>`).join('')}</ol>`;
    wireCookIngredientClicks(stepTextEl);
  } else if(idx === 0){
    document.getElementById('cookStepNum').textContent = 'מצרכים';
    stepTextEl.innerHTML = cookIngredientsHTML(r);
    wireCookIngredientClicks(stepTextEl);
  } else {
    document.getElementById('cookStepNum').textContent = `שלב ${idx} מתוך ${r.steps.length}`;
    stepTextEl.textContent = r.steps[idx-1];
  }

  const prevBtn = document.getElementById('cookPrevBtn');
  const nextBtn = document.getElementById('cookNextBtn');
  prevBtn.disabled = idx===0;
  prevBtn.style.opacity = idx===0 ? .4 : 1;

  if(idx === total-1){
    nextBtn.textContent = 'סיימתי! ✓';
    nextBtn.className = 'done';
  } else {
    nextBtn.textContent = idx===0 ? 'בואו נתחיל' : 'הבא';
    nextBtn.className = 'next';
  }
  updateTimerDisplay();
}

function formatTimer(sec){
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function resetTimer(){
  stopTimer();
  cookState.timerSec = 0;
  updateTimerDisplay();
}
function stopTimer(){
  if(cookState.timerInterval) clearInterval(cookState.timerInterval);
  cookState.timerInterval = null;
  cookState.running = false;
  const startBtn = document.getElementById('timerStartBtn');
  if(startBtn) startBtn.textContent = 'התחל';
  updateTimerDisplay();
}
function updateTimerDisplay(){
  const text = formatTimer(cookState.timerSec);
  const display = document.getElementById('cookTimerDisplay');
  if(display) display.textContent = text;
  const fabBtn = document.getElementById('cookTimerFabBtn');
  if(!fabBtn) return;
  fabBtn.classList.toggle('running', cookState.running || cookState.timerSec > 0);
  if(cookState.running || cookState.timerSec > 0){
    fabBtn.innerHTML = `<span class="fab-count">${text}</span>`;
  } else {
    fabBtn.textContent = '🕐';
  }
}
function startTimer(){
  if(cookState.running){
    stopTimer();
    return;
  }
  if(cookState.timerSec <= 0) return;
  cookState.running = true;
  document.getElementById('timerStartBtn').textContent = 'עצור';
  // collapse panel so the user sees the recipe while the countdown runs
  cookState.timerPanelOpen = false;
  document.getElementById('cookTimerPanel').classList.remove('open');
  updateTimerDisplay();
  cookState.timerInterval = setInterval(()=>{
    if(cookState.timerSec <= 0){
      stopTimer();
      if(navigator.vibrate) navigator.vibrate([200,100,200,100,300]);
      playTimerBeep();
      return;
    }
    cookState.timerSec--;
    updateTimerDisplay();
  },1000);
}

document.getElementById('cookCloseBtn').onclick = closeCookMode;
document.getElementById('cookPrevBtn').onclick = ()=>{
  if(cookState.step>0){ cookState.step--; renderCookStep(); }
};
document.getElementById('cookNextBtn').onclick = ()=>{
  const r = cookState.recipe;
  const total = r.steps.length + 1;
  if(cookState.step < total-1){
    cookState.step++;
    renderCookStep();
  } else {
    markCooked(r.name);
    closeCookMode();
    renderAll();
  }
};
document.querySelectorAll('.cook-timer-btns button[data-min]').forEach(btn=>{
  btn.onclick = ()=>{
    cookState.timerSec += parseInt(btn.dataset.min)*60;
    updateTimerDisplay();
  };
});
document.getElementById('timerStartBtn').onclick = startTimer;
document.getElementById('timerResetBtn').onclick = resetTimer;
document.getElementById('cookTimerFabBtn').onclick = ()=>{
  cookState.timerPanelOpen = !cookState.timerPanelOpen;
  document.getElementById('cookTimerPanel').classList.toggle('open', cookState.timerPanelOpen);
};

function applySimpleMode(){   // name kept: called from several places; applies the whole display layout
  const b = document.body;
  CONTENT_TABS.forEach(t=> b.classList.toggle('hide-tab-' + t, !tabPrefs[t]));
  b.classList.toggle('settings-as-icon', tabPrefs.settingsAs === 'icon');
  b.classList.toggle('hide-weekplan', !tabPrefs.weekPlan);
  b.classList.toggle('hide-daily', !tabPrefs.daily);
  // Bottom bar with a single button is pointless — hide it (the ⚙️ icon still reaches Settings)
  const barButtons = visibleContentTabs().length + (tabPrefs.settingsAs === 'tab' ? 1 : 0);
  b.classList.toggle('no-tab-bar', barButtons <= 1);
  // reflect in the Settings controls
  document.querySelectorAll('#tabVisOpts input[data-tab]').forEach(i=>{ i.checked = !!tabPrefs[i.dataset.tab]; });
  document.querySelectorAll('input[name="settingsAs"]').forEach(i=>{ i.checked = i.value === tabPrefs.settingsAs; });
  document.querySelectorAll('#recipeSectionOpts input[data-sec]').forEach(i=>{ i.checked = !!tabPrefs[i.dataset.sec]; });
  const gear = document.getElementById('settingsIconBtn');
  if(gear) gear.classList.toggle('active', activeTab === 'settings');
  // the open tab was just hidden → move to the first visible one
  if(CONTENT_TABS.includes(activeTab) && !tabPrefs[activeTab]) switchTab(visibleContentTabs()[0]);
  if(document.getElementById('shoppingPanel') && document.body.classList.contains('shop-overview') !== showingShopOverview()) renderShoppingPanel();
}

function renderAll(){
  renderFridgeStrip();
  renderItemGrid();
  renderFilterRow();
  renderRecipes();
  renderTopSuggestion();
  renderTonightSuggestions();
  renderHeaderSub();
  renderDailyRecipe();
  renderShoppingPanel();
  renderTabBadges();
  renderRanoutUI();
  renderWeekPlan();
  renderRecipeSyncSection();
  renderCustomRecipesList();
  renderCategorySettingsSyncBox();
  renderCatOverridesUI();
  renderRemovedItemsList();
  renderAutoResetSettings();
  renderLearnedList();
  applySimpleMode();
  if(shoppingModeActive) renderShoppingModeList();
}

let activeTab = 'shopping'; // always open on the shopping list (or the first visible tab if it's hidden), regardless of which tab was last used

let lastContentTab = 'shopping';
function switchTab(name){
  if(CONTENT_TABS.includes(name) && !tabPrefs[name]) name = visibleContentTabs()[0] || 'shopping';
  if(CONTENT_TABS.includes(name)) lastContentTab = name;
  activeTab = name;
  const gear = document.getElementById('settingsIconBtn');
  if(gear) gear.classList.toggle('active', name === 'settings');
  localStorage.setItem('active_tab', name);
  document.querySelectorAll('.tab-content').forEach(el=>{
    el.classList.toggle('active', el.id === 'tab-'+name);
  });
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  window.scrollTo(0,0);
  updateShopBodyClasses();
  if(name !== 'shopping') closeShopAddBar();
  if(name === 'shopping'){ if(currentUser) refreshShoppingRowFromAccount(); else pullSync(); }
  if(name === 'settings' && !currentUser) pullRecipeSync();
}

function renderTabBadges(){
  const fridgeBtn = document.getElementById('tabBtnFridge');
  const shopBtn = document.getElementById('tabBtnShopping');
  let fridgeBadge = fridgeBtn.querySelector('.tab-badge');
  if(fridge.size > 0){
    if(!fridgeBadge){ fridgeBadge = document.createElement('span'); fridgeBadge.className='tab-badge'; fridgeBtn.appendChild(fridgeBadge); }
    fridgeBadge.textContent = fridge.size;
  } else if(fridgeBadge){ fridgeBadge.remove(); }

  let shopBadge = shopBtn.querySelector('.tab-badge');
  // Badge shows only the main list's open items — saved lists don't inflate the number
  let unbought = 0;
  if(activeListId === 'main'){
    unbought = [...shoppingList].filter(i=>!boughtItems.has(i)).length;
  } else {
    const main = shoppingLists.main || { items:[], bought:[] };
    const bought = new Set(main.bought || []);
    unbought = (main.items || []).filter(i=>!bought.has(i)).length;
  }
  if(unbought > 0){
    if(!shopBadge){ shopBadge = document.createElement('span'); shopBadge.className='tab-badge'; shopBtn.appendChild(shopBadge); }
    shopBadge.textContent = unbought;
  } else if(shopBadge){ shopBadge.remove(); }
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(btn.dataset.tab === 'shopping' && activeTab === 'shopping' && shopOverviewEnabled() && shopView === 'list'){ backToShopOverview(); return; }
    switchTab(btn.dataset.tab);
  });
});
switchTab(activeTab);
window.addEventListener('focus', ()=>{
  if(activeTab !== 'shopping') return;
  if(currentUser) refreshShoppingRowFromAccount(); else pullSync();
});

document.getElementById('ranoutToggleBtn').onclick = ()=>{
  ranOutMode = !ranOutMode;
  renderRanoutUI();
};
document.getElementById('ranoutExitBtn').onclick = ()=>{
  ranOutMode = false;
  renderRanoutUI();
};
document.getElementById('weekToggleBtn').onclick = ()=>{
  weekOpen = !weekOpen;
  localStorage.setItem('week_open', weekOpen ? '1' : '0');
  renderWeekPlan();
};

let importedRecipesOpen = localStorage.getItem('imported_recipes_open') === '1';
let addedItemsOpen = localStorage.getItem('added_items_open') === '1';
let removedItemsOpen = localStorage.getItem('removed_items_open') === '1';
function applyCollapsibleState(){
  const rWrap = document.getElementById('customRecipesListWrap');
  const rBtn = document.getElementById('toggleImportedRecipesBtn');
  if(rWrap){ rWrap.style.display = importedRecipesOpen ? 'block' : 'none'; }
  if(rBtn){ rBtn.textContent = importedRecipesOpen ? '▴' : '▾'; }
  const iWrap = document.getElementById('catOverridesListWrap');
  const iBtn = document.getElementById('toggleAddedItemsBtn');
  if(iWrap){ iWrap.style.display = addedItemsOpen ? 'block' : 'none'; }
  if(iBtn){ iBtn.textContent = addedItemsOpen ? '▴' : '▾'; }
  const remWrap = document.getElementById('removedItemsListWrap');
  const remBtn = document.getElementById('toggleRemovedItemsBtn');
  if(remWrap){ remWrap.style.display = removedItemsOpen ? 'block' : 'none'; }
  if(remBtn){ remBtn.textContent = removedItemsOpen ? '▴' : '▾'; }
}
document.getElementById('toggleImportedRecipesBtn').onclick = ()=>{
  importedRecipesOpen = !importedRecipesOpen;
  localStorage.setItem('imported_recipes_open', importedRecipesOpen ? '1' : '0');
  applyCollapsibleState();
};
document.getElementById('toggleAddedItemsBtn').onclick = ()=>{
  addedItemsOpen = !addedItemsOpen;
  localStorage.setItem('added_items_open', addedItemsOpen ? '1' : '0');
  applyCollapsibleState();
};
document.getElementById('toggleRemovedItemsBtn').onclick = ()=>{
  removedItemsOpen = !removedItemsOpen;
  localStorage.setItem('removed_items_open', removedItemsOpen ? '1' : '0');
  applyCollapsibleState();
};
applyCollapsibleState();

// Settings topics: each shows only a title + arrow; tapping opens/closes its settings
document.querySelectorAll('.topic-head').forEach(btn=>{
  btn.onclick = ()=>{
    const topic = btn.closest('.settings-topic');
    const open = topic.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
});

document.getElementById('themeBtn').onclick = ()=>{
  isDark = !isDark;
  saveTheme();
  applyTheme();
  saveDisplayPrefs();
};

document.getElementById('customAddBtn').onclick = ()=>{
  const input = document.getElementById('customInput');
  const val = norm(input.value);
  if(val){
    fridge.add(val);
    recordUsage(val);
    saveFridge();
    input.value='';
    document.getElementById('fridgeAutocomplete').innerHTML = '';
    renderAll();
  }
};
document.getElementById('customInput').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter'){ document.getElementById('customAddBtn').click(); }
});
document.getElementById('customInput').addEventListener('input', (e)=>{
  renderAutocomplete('fridgeAutocomplete', e.target.value, (name)=>{
    document.getElementById('customInput').value = name;
    document.getElementById('customAddBtn').click();
  });
});
// A recipe name never looks like an e-mail address — if the browser's autofill drops one in here, throw it away.
function looksLikeEmail(v){ return /^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(v || ''); }
function dropAutofilledEmailFromSearch(){
  const inp = document.getElementById('searchInput');
  if(inp && looksLikeEmail(inp.value)){ inp.value = ''; filters.search = ''; renderRecipes(); }
}
document.getElementById('searchInput').addEventListener('input', (e)=>{
  if(looksLikeEmail(e.target.value)){ dropAutofilledEmailFromSearch(); return; }
  filters.search = e.target.value;
  renderRecipes();
});
document.getElementById('searchInput').addEventListener('change', dropAutofilledEmailFromSearch);
[400, 1500, 4000].forEach(ms=> setTimeout(dropAutofilledEmailFromSearch, ms));   // autofill can land a moment after load

// Every other text box opts out of saved-credential autofill; only the two login fields (and the e-mail share boxes) are exempt by design.
function optOutOfAutofill(root){
  (root || document).querySelectorAll('input:not([autocomplete]), textarea:not([autocomplete])').forEach(el=>{
    if(el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return;
    el.setAttribute('autocomplete', 'off');
  });
}
optOutOfAutofill();
new MutationObserver(()=>optOutOfAutofill()).observe(document.body, { childList:true, subtree:true });

function recipeFiltersActive(){
  return !!(filters.search || filters.diet !== 'all' || filters.maxTime || filters.readyNow || filters.almostReady || filters.hideCooked ||
            filters.favoritesOnly || filters.cuisine !== 'all' || filters.difficulty !== 'all');
}
function clearAllRecipeFilters(){
  filters = { search:'', diet:'all', maxTime:0, readyNow:false, almostReady:false, hideCooked:false, favoritesOnly:false, cuisine:'all', difficulty:'all' };
  readyNowAutoApplied = true; // don't auto-reapply after user cleared
  const inp = document.getElementById('searchInput'); if(inp) inp.value = '';
  renderFilterRow();
  renderRecipes();
}

// ——— Import recipes from Word/PDF files ———
function renderLearnedList(){
  const el = document.getElementById('learnedList');
  if(!el) return;
  const labelEntries = Object.entries(learnedLabels).map(([label,name])=>({type:'label', key:label, name}));
  const barcodeEntries = Object.entries(learnedBarcodes).map(([code,name])=>({type:'barcode', key:code, name}));
  const all = [...labelEntries, ...barcodeEntries];
  if(all.length===0){
    el.innerHTML = '<p class="custom-empty">עדיין לא תיקנתם זיהוי כלשהו</p>';
    return;
  }
  el.innerHTML = all.map(e=>`
    <div class="custom-recipe-row">
      <span>${e.type==='barcode' ? '🔖 ברקוד ' + escHtml(e.key) : '📷 ' + escHtml(e.key)} ← ${escHtml(e.name)}</span>
      <button data-type="${e.type}" data-key="${escAttr(e.key)}" class="del-learned-btn">מחקו</button>
    </div>
  `).join('');
  el.querySelectorAll('.del-learned-btn').forEach(btn=>{
    btn.onclick = ()=>{
      if(btn.dataset.type==='label'){ delete learnedLabels[btn.dataset.key]; localStorage.setItem('learned_labels', JSON.stringify(learnedLabels)); }
      else { delete learnedBarcodes[btn.dataset.key]; localStorage.setItem('learned_barcodes', JSON.stringify(learnedBarcodes)); }
      scheduleAppStatePush();
      renderLearnedList();
    };
  });
}

function renderAutoResetSettings(){
  const toggle = document.getElementById('autoResetToggle');
  const grid = document.getElementById('protectedCatsGrid');
  if(!toggle || !grid) return;
  toggle.checked = autoResetEnabled;
  const cats = [...new Set(allCategoryNames().concat(['אחר']))];
  grid.innerHTML = cats.map(c=>`
    <label class="clearcat-item"><input type="checkbox" value="${escAttr(c)}" ${protectedCategories.includes(c)?'checked':''}> ${escHtml(c)}</label>
  `).join('');
  toggle.onchange = ()=>{
    autoResetEnabled = toggle.checked;
    localStorage.setItem('auto_reset_enabled', autoResetEnabled ? '1' : '0');
    scheduleAppStatePush();
  };
  grid.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.onchange = ()=>{
      protectedCategories = [...grid.querySelectorAll('input:checked')].map(c=>c.value);
      localStorage.setItem('protected_categories', JSON.stringify(protectedCategories));
      scheduleAppStatePush();
    };
  });
}

function renderRemovedItemsList(){
  const el = document.getElementById('removedItemsList');
  if(!el) return;
  if(removedCatalogItems.length===0){
    el.innerHTML = '<p class="custom-empty">לא הסרתם מצרכים קבועים מאף קטגוריה</p>';
    return;
  }
  el.innerHTML = removedCatalogItems.map(item=>`
    <div class="custom-recipe-row">
      <span>${escHtml(item)} (${escHtml(ING_TO_CAT[item]||'אחר')})</span>
      <button data-item="${escAttr(item)}" class="restore-item-btn">שחזרו</button>
    </div>
  `).join('');
  el.querySelectorAll('.restore-item-btn').forEach(btn=>{
    btn.onclick = ()=>{
      restoreCatalogItem(btn.dataset.item);
      renderRemovedItemsList();
      renderItemGrid();
    };
  });
}

function renderCategorySettingsSyncBox(){
  const el = document.getElementById('categorySettingsSyncBox');
  if(!el) return;
  if(!currentUser){
    el.innerHTML = '<p class="custom-empty">התחברו לחשבון (למעלה) כדי לשתף סיווגים</p>';
    return;
  }
  const picker = accountCategorySettingsRows.length>1 ? `
    <div class="acct-picker">
      <div class="settings-hint" style="font-weight:700;margin-bottom:4px;">אילו סיווגים להציג:</div>
      <select id="catSettingsRowPicker" class="week-select">
        ${accountCategorySettingsRows.map(r=>`<option value="${r.id}" ${r.id===activeCategorySettingsRowId?'selected':''}>${escHtml(rowLabel(r))}</option>`).join('')}
      </select>
    </div>` : '';
  el.innerHTML = `
    <div class="sync-box">
      ${picker}
      <div class="add-row" style="margin-top:${picker?'10px':'0'};">
        <input type="email" id="shareCategorySettingsEmail" placeholder="אימייל של השותף/ה">
        <button id="shareCategorySettingsBtn">שתפו</button>
      </div>
      <div id="sharedListCat"></div>
      <div class="cam-status" id="catSettingsStatus"></div>
    </div>`;
  renderSharedList('sharedListCat', activeCategorySettingsRowId);
  const pickerEl = document.getElementById('catSettingsRowPicker');
  if(pickerEl) pickerEl.onchange = ()=>{
    const row = accountCategorySettingsRows.find(r=>r.id===pickerEl.value);
    if(row){ applyCategorySettingsRow(row); renderAll(); }
  };
  document.getElementById('shareCategorySettingsBtn').onclick = async ()=>{
    const email = norm(document.getElementById('shareCategorySettingsEmail').value);
    if(!email) return;
    const status = document.getElementById('catSettingsStatus');
    status.textContent = 'משתפים...';
    try{
      const result = await shareRow(activeCategorySettingsRowId, email);
      status.textContent = result === 'ok' ? '✓ שותף בהצלחה' : 'שגיאה: ' + result;
      if(result === 'ok') renderSharedList('sharedListCat', activeCategorySettingsRowId, true);
    }catch(e){ status.textContent = 'שגיאה: ' + (e.message||''); }
  };
}

function renderCatOverridesUI(){
  const select = document.getElementById('catAssignSelect');
  if(!select) return;
  const cats = [...new Set(allCategoryNames().concat(['אחר']))];
  select.innerHTML = cats.map(c=>`<option value="${escAttr(c)}">${escHtml(c)}</option>`).join('');

  const listEl = document.getElementById('catOverridesList');
  const items = [...new Set([...Object.keys(categoryOverrides), ...Object.keys(iconOverrides)])];
  if(items.length===0){
    listEl.innerHTML = '<p class="custom-empty">עדיין לא הגדרתם סיווגים מותאמים אישית</p>';
  } else {
    listEl.innerHTML = items.map(item=>`
      <div class="custom-recipe-row">
        <span>${escHtml(iconOf(item))} ${escHtml(item)} ← ${escHtml(catOf(item))}</span>
        <span class="row-actions">
          <button data-item="${escAttr(item)}" class="edit-cat-btn">ערכו</button>
          <button data-item="${escAttr(item)}" class="del-cat-btn">מחקו</button>
        </span>
      </div>
    `).join('');
    listEl.querySelectorAll('.edit-cat-btn').forEach(btn=>{
      btn.onclick = ()=>{
        const item = btn.dataset.item;
        document.getElementById('catAssignInput').value = item;
        select.value = catOf(item);
        document.getElementById('catAssignIcon').value = iconOverrides[item] || '';
        document.getElementById('catAssignInput').scrollIntoView({behavior:'smooth', block:'center'});
        document.getElementById('catAssignInput').focus();
      };
    });
    listEl.querySelectorAll('.del-cat-btn').forEach(btn=>{
      btn.onclick = ()=>{
        setCategoryOverride(btn.dataset.item, null);
        setIconOverride(btn.dataset.item, null);
        renderCatOverridesUI();
        renderShoppingPanel();
      };
    });
  }

  const assignBtn = document.getElementById('catAssignBtn');
  if(assignBtn){
    assignBtn.onclick = ()=>{
      const item = norm(document.getElementById('catAssignInput').value);
      const cat = select.value;
      const icon = norm(document.getElementById('catAssignIcon').value);
      if(!item) return;
      setCategoryOverride(item, cat);
      if(icon) setIconOverride(item, icon);
      document.getElementById('catAssignInput').value = '';
      document.getElementById('catAssignIcon').value = '';
      renderCatOverridesUI();
      renderShoppingPanel();
    };
  }

  const catsListEl = document.getElementById('customCatsList');
  if(catsListEl){
    if(customCategories.length===0){
      catsListEl.innerHTML = '<p class="custom-empty">עדיין לא הוספתם קטגוריות משלכם</p>';
    } else {
      catsListEl.innerHTML = customCategories.map(c=>`
        <div class="custom-recipe-row">
          <span>${escHtml(c)}</span>
          <button data-cat="${escAttr(c)}" class="del-newcat-btn">מחקו</button>
        </div>
      `).join('');
      catsListEl.querySelectorAll('.del-newcat-btn').forEach(btn=>{
        btn.onclick = ()=>{
          showConfirmModal(`למחוק את הקטגוריה "${btn.dataset.cat}"? מצרכים ששויכו אליה יחזרו לסיווג הרגיל שלהם.`, ()=>{
            deleteCustomCategory(btn.dataset.cat);
            renderCatOverridesUI();
            renderShoppingPanel();
            renderAutoResetSettings();
          });
        };
      });
    }
  }
  const addCatBtn = document.getElementById('addCatBtn');
  if(addCatBtn){
    addCatBtn.onclick = ()=>{
      const input = document.getElementById('newCatInput');
      const name = norm(input.value);
      if(!name) return;
      if(!addCustomCategory(name)){
        alert('קטגוריה בשם הזה כבר קיימת');
        return;
      }
      input.value = '';
      renderCatOverridesUI();
    };
  }
}

function renderCustomRecipesList(){
  const el = document.getElementById('customRecipesList');
  if(!el) return;
  if(customRecipes.length===0){
    el.innerHTML = '<p class="custom-empty">עדיין לא יובאו מתכונים מקבצים</p>';
    return;
  }
  el.innerHTML = customRecipes.map(r=>`
    <div class="custom-recipe-row">
      <span>${escHtml(r.name)}</span>
      <span class="row-actions">
        <button data-name="${escAttr(r.name)}" class="edit-recipe-btn">ערכו</button>
        <button data-name="${escAttr(r.name)}" class="del-custom-btn">מחקו</button>
      </span>
    </div>
  `).join('');
  el.querySelectorAll('.edit-recipe-btn').forEach(btn=>{
    btn.onclick = ()=> editCustomRecipe(btn.dataset.name);
  });
  el.querySelectorAll('.del-custom-btn').forEach(btn=>{
    btn.onclick = ()=>{
      const name = btn.dataset.name;
      showConfirmModal(`למחוק את "${name}"?`, ()=>{
        customRecipes = customRecipes.filter(r=>r.name!==name);
        localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
        const idx = RECIPES.findIndex(r=>r.name===name);
        if(idx>-1) RECIPES.splice(idx,1);
        pushRecipeSync();
        pushRecipesRow();
        renderAll();
      });
    };
  });
}

// Word tables (and some PDFs) get extracted as one run-on line per cell, losing the breaks between
// ingredients and between numbered steps. Detect that and re-insert the line breaks.
function looksFlattened(text){
  const nonEmpty = text.split('\n').filter(l=>l.trim()).length;
  return text.length > 200 && nonEmpty < 8;
}
function deflattenText(text){
  let t = text;
  t = t.replace(/\s*(מצרכים|רכיבים|מה שצריך|מה צריך)\s*:?/g, '\n$1\n');
  t = t.replace(/\s*(אופן ה?הכנה|הוראות ה?הכנה|צעדי ה?הכנה|הוראות)\s*:?/g, '\n$1\n');
  // numbered steps: "1. text" (Hebrew letter must follow, so decimals like 2.5 are left alone)
  t = t.replace(/(\d+)\.\s+(?=[\u0590-\u05FF])/g, '\n$1. ');
  // servings/nutrition footer ("8 מנות, כל מנה 95 קלוריות") should not stay glued to the last step
  t = t.replace(/([.!])\s+(\d+\s*מנות)/g, '$1\n$2');

  // Within the ingredients block only: start a new line before each digit-led quantity
  const ingHeaderRe = /(מצרכים|רכיבים|מה שצריך|מה צריך)/;
  const stepHeaderRe = /(אופן ה?הכנה|הוראות ה?הכנה|צעדי ה?הכנה|הוראות)/;
  const ingMatch = ingHeaderRe.exec(t);
  if(ingMatch){
    const start = ingMatch.index + ingMatch[0].length;
    const stepMatch = stepHeaderRe.exec(t.slice(start));
    const end = stepMatch ? start + stepMatch.index : t.length;
    let seg = t.slice(start, end);
    seg = seg.replace(/([\u0590-\u05FF])\s+(\d+)/g, '$1\n$2');
    // common "to taste" seasoning line has no leading quantity, so split it off explicitly
    seg = seg.replace(/\s+((?:מלח ופלפל|מלח|פלפל שחור|פלפל)\s+לפי הטעם)/g, '\n$1');
    t = t.slice(0, start) + seg + t.slice(end);
  }
  return t;
}

function parseRecipeText(text, fallbackTitle){
  if(looksFlattened(text)) text = deflattenText(text);
  const JUNK_PATTERNS = [
    /^\d+\s*מנות/,
    /^שתפ(ו|י)/, /^שיתוף/, /^הדפיס(ו|י)/, /^הדפסה/, /^שמר(ו|י) מתכון/, /^דרג(ו|י)/, /^דירוג/,
    /^תגוב(ות|ה)/, /^כתב(ו|י) תגובה/, /^עקב(ו|י) אחרינו/, /^הירשמ(ו|י)/, /^לניוזלטר/,
    /^פרסומת/, /^מודעה/, /^קרדיט/, /^צילום[: ]/, /^כל הזכויות שמורות/, /^©/,
    /^עוד מתכונים/, /^מתכונים נוספים/, /^קרא(ו)? עוד/, /^המשך קריאה/,
    /^\d+\s*(תגובות|לייקים|שיתופים|צפיות)/, /^(פייסבוק|אינסטגרם|טוויטר|וואטסאפ|טיקטוק)$/,
    /^שלח(ו)? לחבר/, /^הצטרפ(ו|י)/, /^למתכון המלא/, /^לחצ(ו|י) כאן/, /^קישור/, /^מקור[: ]/,
    /^\[.*\]$/, /^advertisement$/i, /^cookies?/i
  ];
  const isJunk = (line)=> line.length<=1 || JUNK_PATTERNS.some(re=>re.test(line));

  const rawLines = text.split('\n').map(l=>l.trim()).filter(Boolean).filter(l=>!isJunk(l));
  const title = rawLines[0] || fallbackTitle || 'מתכון מיובא';

  const ING_HEADER = /^(מצרכים|רכיבים|מה שצריך|מה צריך)\s*:?\s*(\(.*\))?$/i;
  const ING_SUBHEADER = /^ל(בצק|מילוי|ציפוי|רוטב|תערובת|קישוט|טיגון|אפייה|מרינדה|ציפוי החיצוני)\s*:?\s*$/;
  const STEP_HEADER = /^(הכנה|אופן ה?הכנה|הוראות ה?הכנה|צעדי ה?הכנה|הוראות|אופן ביצוע|שלבי ה?הכנה|שלב \d+|steps|instructions|method)\s*:?\s*$/i;

  const cleanIngredient = (l)=> l.replace(/^[-•*)\s]+/, '').trim();
  const cleanStep = (l)=> l
    .replace(/^שלב\s*\d+\s*[:.]?\s*/,'')
    .replace(/^[-•*\d.)\s]+/, '')
    .trim();

  let rawIng = [];
  let rawSteps = [];
  let preHeader = [];
  let mode = 'none'; // 'none' | 'ing' | 'steps'

  for(let i=1; i<rawLines.length; i++){
    const line = rawLines[i];
    if(ING_HEADER.test(line)){ mode = 'ing'; continue; }
    if(STEP_HEADER.test(line)){ mode = 'steps'; continue; }
    if(ING_SUBHEADER.test(line)){
      mode = 'ing';
      rawIng.push('— ' + line.replace(/:$/,'') + ' —');
      continue;
    }
    if(mode === 'ing') rawIng.push(line);
    else if(mode === 'steps') rawSteps.push(line);
    else preHeader.push(line);
  }

  // --- Repair "run-on" blocks. Word tables (and some PDFs) come out with a whole section on ONE line,
  // even when the rest of the file has plenty of lines (e.g. website clutter above the recipe).
  // So we repair each section on its own instead of guessing from the whole file.
  const splitIngredientBlob = (line)=>{
    if(line.startsWith('—')) return [line];
    return line
      .replace(/([\u0590-\u05FF])\s+(\d+)/g, '$1\n$2')   // new quantity => new ingredient
      .replace(/\s+((?:מלח ופלפל|מלח|פלפל שחור|פלפל)\s+לפי הטעם)/g, '\n$1') // "to taste" line has no quantity
      .split('\n');
  };
  const splitStepBlob = (line)=>{
    return line
      .replace(/\s*\d+\s*מנות[^.]*קלוריות\.?\s*$/, '')    // "8 מנות, כל מנה 95 קלוריות" footer isn't a step
      .split(/\s+(?=\d+\.\s+[\u0590-\u05FF])/);            // "1. ... 2. ... 3. ..." => separate steps
  };
  // Only split ingredients when the section is clearly a run-on blob (1-2 very long lines).
  // Normally formatted lists (one ingredient per line, in any word order) are left exactly as they are.
  const ingLooksRunOn = rawIng.length <= 2 && rawIng.join(' ').length > 50;
  let ingredients = (ingLooksRunOn ? rawIng.flatMap(splitIngredientBlob) : rawIng).map(cleanIngredient).filter(Boolean);
  let steps = rawSteps.flatMap(splitStepBlob).map(cleanStep).filter(Boolean);

  // Prefill prep time from the website's info lines above the recipe ("בערך שעה", "30 דקות")
  let time = '';
  for(const l of preHeader){
    let m = l.match(/בערך\s+(שעה ו?חצי|שעה|שעתיים)/) || l.match(/(\d+)\s*דקות/);
    if(m){ time = m[0].replace(/^בערך\s+/,''); if(/^\d+\s*דקות/.test(time)) time = time.replace(/\s*דקות/, ' דק׳'); break; }
  }

  // Consolidate fragmented lines: only merge a line into the previous one when the previous line
  // looks unfinished (no terminal punctuation) AND is short, or the new line is a tiny leftover.
  // Short-but-complete sentences ("מערבבים הכל.") stay separate steps.
  function consolidate(arr){
    const out = [];
    arr.forEach(line=>{
      const prev = out[out.length-1];
      const prevUnfinished = prev && !/[.!?:׃]$/.test(prev);
      if(prev && prevUnfinished && !line.startsWith('—') && (prev.length < 25 || line.length < 10)){
        out[out.length-1] = prev + ' ' + line;
      } else {
        out.push(line);
      }
    });
    return out;
  }
  steps = consolidate(steps);

  if(mode === 'none'){
    // No recognizable section headers at all — leave ingredients empty, put the rest as steps for manual cleanup
    steps = consolidate(rawLines.slice(1).map(cleanStep).filter(Boolean));
  }
  return {title, ingredients, steps, time};
}

async function extractTextFromFile(file){
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if(ext === 'docx'){
    if(!window.mammoth) await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.7.0/mammoth.browser.min.js');
    const result = await window.mammoth.extractRawText({arrayBuffer: buf});
    return result.value;
  }
  if(ext === 'pdf'){
    if(!window.pdfjsLib) await loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({data: buf}).promise;
    let text = '';
    for(let i=1; i<=pdf.numPages; i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it=>it.str).join('\n') + '\n';
    }
    return text;
  }
  throw new Error('unsupported-format');
}

// editMeta (optional): {type:'builtin', originalName} for editing one of the built-in recipes.
// Editing a custom/imported recipe is signalled simply by passing its name as editingName with no editMeta.
function renderImportForm(parsed, editingName, editMeta, onDone){
  const el = document.getElementById('importForm');
  el.innerHTML = `
    <div class="import-form-box">
      <label>שם המתכון</label>
      <input type="text" id="impTitle" value="${escAttr(parsed.title)}">
      <label>מצרכים (שורה לכל מצרך)</label>
      <textarea id="impIngredients">${escHtml((parsed.ingredients||[]).map(i=>typeof i==='string'?i:(i.qty?`${i.name} — ${i.qty}`:ingName(i))).join('\n'))}</textarea>
      <label>הוראות הכנה (שורה לכל שלב)</label>
      <textarea id="impSteps">${escHtml(parsed.steps.join('\n'))}</textarea>
      <label>זמן הכנה (לא חובה)</label>
      <input type="text" id="impTime" placeholder="לדוגמה: 30 דק׳" value="${escAttr(parsed.time||'')}">
      <div class="import-form-actions">
        <button id="impSaveBtn">${editingName ? 'שמרו שינויים' : 'שמרו מתכון'}</button>
        <button class="secondary" id="impCancelBtn">ביטול</button>
        ${editMeta && editMeta.type==='builtin' ? '<button class="secondary" id="impRestoreBtn">שחזרו למקור</button>' : ''}
      </div>
    </div>
  `;
  document.getElementById('impSaveBtn').onclick = ()=>{
    const name = norm(document.getElementById('impTitle').value);
    const ingredients = document.getElementById('impIngredients').value.split('\n').map(parseIngredientLine).filter(Boolean)
      .map(p => p.qty ? {name: p.name, qty: p.qty} : p.name);
    const steps = document.getElementById('impSteps').value.split('\n').map(norm).filter(Boolean);
    const time = norm(document.getElementById('impTime').value) || 'לא צוין';
    if(!name || steps.length===0){
      alert('נא למלא לפחות שם מתכון ושלב הכנה אחד');
      return;
    }
    if(editMeta && editMeta.type==='builtin'){
      const idx = RECIPES.findIndex(r=>r.name===editingName);
      const base = idx>-1 ? RECIPES[idx] : {};
      const updated = {...base, name, time, ingredients, steps};
      recipeOverrides[editMeta.originalName] = updated;
      localStorage.setItem('recipe_overrides', JSON.stringify(recipeOverrides));
      if(idx>-1) RECIPES[idx] = updated; else RECIPES.push(updated);
      scheduleAppStatePush();
    } else if(editingName){
      const oldIdx = customRecipes.findIndex(r=>r.name===editingName);
      const oldRecipe = oldIdx>-1 ? customRecipes[oldIdx] : {};
      const updated = {...oldRecipe, name, time, ingredients, steps, difficulty: oldRecipe.difficulty||'', cuisine: oldRecipe.cuisine||'מיובא'};
      if(oldIdx>-1) customRecipes[oldIdx] = updated; else customRecipes.push(updated);
      localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
      const rIdx = RECIPES.findIndex(r=>r.name===editingName);
      if(rIdx>-1) RECIPES[rIdx] = updated; else RECIPES.push(updated);
      pushRecipeSync();
      pushRecipesRow();
    } else {
      const recipe = {name, time, ingredients, steps, difficulty:'', cuisine:'מיובא'};
      customRecipes.push(recipe);
      localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
      RECIPES.push(recipe);
      pushRecipeSync();
      pushRecipesRow();
    }
    el.innerHTML = '';
    if(onDone){ onDone(`✓ "${name}" נשמר`); renderAll(); return; }
    document.getElementById('importStatus').textContent = `✓ "${name}" נשמר בהצלחה`;
    setTimeout(()=>{ document.getElementById('importStatus').textContent=''; }, 4000);
    renderAll();
  };
  document.getElementById('impCancelBtn').onclick = ()=>{ el.innerHTML = ''; if(onDone) onDone(''); };
  const restoreBtn = document.getElementById('impRestoreBtn');
  if(restoreBtn){
    restoreBtn.onclick = ()=>{
      showConfirmModal('לשחזר את המתכון הזה לגרסה המקורית? כל השינויים שלכם יימחקו.', ()=>{
        delete recipeOverrides[editMeta.originalName];
        localStorage.setItem('recipe_overrides', JSON.stringify(recipeOverrides));
        scheduleAppStatePush();
        const pristine = PRISTINE_RECIPES_BY_NAME[editMeta.originalName];
        const idx = RECIPES.findIndex(r=>r.name===editingName);
        if(pristine && idx>-1) RECIPES[idx] = JSON.parse(JSON.stringify(pristine));
        el.innerHTML = '';
        if(onDone){ onDone('✓ המתכון שוחזר למקור'); renderAll(); return; }
        document.getElementById('importStatus').textContent = '✓ המתכון שוחזר למקור';
        setTimeout(()=>{ document.getElementById('importStatus').textContent=''; }, 4000);
        renderAll();
      });
    };
  }
}
function editCustomRecipe(name){
  const r = customRecipes.find(x=>x.name===name);
  if(!r) return;
  renderImportForm({title:r.name, ingredients:r.ingredients||[], steps:r.steps||[], time:r.time||''}, name);
  document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
}
// Opens the recipe editor in a sheet over the current screen (used by the "ערכו מתכון" button on recipe cards).
// The same form element used in Settings is borrowed into the sheet and put back when the sheet closes.
function editRecipeInSheet(name){
  const isCustom = !!customRecipes.find(r=>r.name===name);
  let meta = null;
  if(!isCustom){
    const overrideEntry = Object.entries(recipeOverrides).find(([orig, data])=> data.name === name);
    meta = { type:'builtin', originalName: overrideEntry ? overrideEntry[0] : name };
  }
  const r = isCustom ? customRecipes.find(x=>x.name===name) : RECIPES.find(x=>x.name===name);
  if(!r) return;
  const form = document.getElementById('importForm');
  const home = { parent: form.parentNode, next: form.nextSibling };
  const ov = openSheet('recipeEditSheet', `
    <div class="sheet-head"><h3>עריכת מתכון</h3><button type="button" class="sheet-x" id="resClose" aria-label="סגירה">×</button></div>
    <div id="resBody"></div>`, 'tall');
  ov.querySelector('#resBody').appendChild(form);
  let finished = false;
  const finish = (msg)=>{
    if(finished) return;
    finished = true;
    form.innerHTML = '';
    home.parent.insertBefore(form, home.next);     // put the form back in Settings
    ov.remove();
    if(msg) showAddedToast(msg);
  };
  ov.querySelector('#resClose').onclick = ()=> finish('');
  ov.addEventListener('click', e=>{ if(e.target === ov) finish(''); });
  renderImportForm({title:r.name, ingredients:r.ingredients||[], steps:r.steps||[], time:r.time||''}, name, meta, finish);
  const box = form.querySelector('.import-form-box');
  if(box) box.style.marginTop = '0';
}

function editAnyRecipe(name){
  if(customRecipes.find(r=>r.name===name)){
    // personal / imported recipe — make sure Settings → מתכונים is actually showing before editing there
    switchTab('settings');
    const head = [...document.querySelectorAll('.topic-head')].find(h=>h.querySelector('h2').textContent.includes('מתכונים'));
    if(head && !head.closest('.settings-topic').classList.contains('open')) head.click();
    editCustomRecipe(name);
    return;
  }
  // built-in recipe (possibly already overridden) — find its ORIGINAL name so re-edits keep
  // targeting the same override entry instead of creating a new one under the edited name.
  const overrideEntry = Object.entries(recipeOverrides).find(([orig, data])=> data.name === name);
  const originalName = overrideEntry ? overrideEntry[0] : name;
  const r = RECIPES.find(x=>x.name===name);
  if(!r) return;
  switchTab('settings');
  const recipesHead = [...document.querySelectorAll('.topic-head')].find(h=>h.querySelector('h2').textContent.includes('מתכונים'));
  if(recipesHead && !recipesHead.closest('.settings-topic').classList.contains('open')) recipesHead.click();
  renderImportForm({title:r.name, ingredients:r.ingredients||[], steps:r.steps||[], time:r.time||''}, name, {type:'builtin', originalName});
  document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
}

function exportCustomContent(){
  const data = {
    customRecipes,
    customCategories,
    categoryOverrides,
    iconOverrides
  };
  const text = JSON.stringify(data, null, 2);
  const done = ()=> alert('הועתק ללוח! הדביקו את זה בהודעה אליי בשיחה הבאה כדי שאשלב את זה בקביעות בקוד של האפליקציה.');
  if(navigator.clipboard){
    navigator.clipboard.writeText(text).then(done).catch(()=>{
      showTextareaModal('העתיקו את הטקסט הזה ושלחו לי אותו בשיחה הבאה:', ()=>{}, text);
    });
  } else {
    showTextareaModal('העתיקו את הטקסט הזה ושלחו לי אותו בשיחה הבאה:', ()=>{}, text);
  }
}
document.getElementById('exportCustomBtn').onclick = exportCustomContent;

document.getElementById('importFileBtn').onclick = ()=> document.getElementById('importFileInput').click();
document.getElementById('manualAddRecipeBtn').onclick = ()=>{
  renderImportForm({title:'', ingredients:[], steps:[], time:''});
  document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
};
const importTextBtn = document.getElementById('importTextBtn');
if(importTextBtn){
  importTextBtn.onclick = ()=>{
    showTextareaModal('הדביקו כאן את טקסט המתכון (מאתר, וואטסאפ או הערה):', (text)=>{
      const status = document.getElementById('importStatus');
      if(status) status.textContent = '';
      const parsed = parseRecipeText(text, 'מתכון מיובא');
      renderImportForm(parsed);
      document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
    });
  };
}
const importUrlBtn = document.getElementById('importUrlBtn');
if(importUrlBtn){
  importUrlBtn.onclick = ()=>{
    showPromptModal('הדביקו קישור למתכון:', async (url)=>{
      const status = document.getElementById('importStatus');
      if(status) status.textContent = 'טוענים את העמוד...';
      try{
        // Try direct fetch (works when the site allows CORS; many recipe sites don't)
        let text = '';
        try{
          const res = await fetch(url, { mode:'cors' });
          if(!res.ok) throw new Error('http '+res.status);
          const html = await res.text();
          // strip tags roughly for Hebrew recipe pages
          text = html
            .replace(/<script[\s\S]*?<\/script>/gi,' ')
            .replace(/<style[\s\S]*?<\/style>/gi,' ')
            .replace(/<[^>]+>/g,'\n')
            .replace(/&nbsp;/g,' ')
            .replace(/&amp;/g,'&')
            .replace(/&quot;/g,'"')
            .replace(/&#39;/g,"'")
            .replace(/\n{3,}/g,'\n\n');
        }catch(corsErr){
          if(status) status.textContent = '';
          showTextareaModal(
            'לא ניתן לקרוא את האתר ישירות (הגבלת אבטחה של הדפדפן).\nפתחו את הקישור, העתיקו את המתכון, והדביקו כאן:',
            (pasted)=>{
              const parsed = parseRecipeText(pasted, 'מתכון מקישור');
              renderImportForm(parsed);
              document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
            }
          );
          return;
        }
        if(status) status.textContent = '';
        const parsed = parseRecipeText(text, 'מתכון מקישור');
        renderImportForm(parsed);
        document.getElementById('importForm').scrollIntoView({behavior:'smooth', block:'start'});
      }catch(e){
        if(status) status.textContent = '';
        alert('טעינת הקישור נכשלה. נסו להעתיק את הטקסט מהאתר ולהדביק עם «הדביקו טקסט».');
      }
    }, 'https://');
  };
}
document.getElementById('importFileInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const status = document.getElementById('importStatus');
  status.textContent = 'קוראים את הקובץ...';
  try{
    const text = await extractTextFromFile(file);
    status.textContent = '';
    const parsed = parseRecipeText(text, file.name.replace(/\.(docx|pdf)$/i,''));
    renderImportForm(parsed);
  }catch(err){
    status.textContent = '';
    if(err.message === 'unsupported-format'){
      alert('פורמט לא נתמך. קבצי .doc ישנים לא נתמכים ישירות — שמרו כ-.docx דרך Word ונסו שוב, או השתמשו ב-PDF.');
    } else {
      alert('קריאת הקובץ נכשלה. נסו קובץ אחר, או בדקו שהוא לא פגום.');
    }
  }
  e.target.value = '';
});

// Display layout controls (Settings → מצב תצוגה)
function changeTabPrefs(patch){
  tabPrefs = normalizeTabPrefs(Object.assign({}, tabPrefs, patch));
  saveTabPrefs();
  applySimpleMode();
  saveDisplayPrefs();
}
document.querySelectorAll('#tabVisOpts input[data-tab]').forEach(inp=>{
  inp.onchange = ()=>{
    const t = inp.dataset.tab;
    const status = document.getElementById('tabVisStatus');
    if(!inp.checked && visibleContentTabs().length === 1 && tabPrefs[t]){
      inp.checked = true;
      if(status){ status.textContent = 'צריך להשאיר לפחות לשונית אחת'; setTimeout(()=>{ status.textContent = ''; }, 3000); }
      return;
    }
    if(status) status.textContent = '';
    changeTabPrefs({ [t]: inp.checked });
  };
});
document.querySelectorAll('input[name="settingsAs"]').forEach(inp=>{
  inp.onchange = ()=>{ if(inp.checked) changeTabPrefs({ settingsAs: inp.value }); };
});
document.querySelectorAll('#recipeSectionOpts input[data-sec]').forEach(inp=>{
  inp.onchange = ()=> changeTabPrefs({ [inp.dataset.sec]: inp.checked });
});
// ⚙️ in the header: opens Settings; pressed again, goes back to where you were
const settingsIconBtn = document.getElementById('settingsIconBtn');
if(settingsIconBtn){
  settingsIconBtn.onclick = ()=> switchTab(activeTab === 'settings' ? lastContentTab : 'settings');
}
const tonightRefreshBtn = document.getElementById('tonightRefreshBtn');
if(tonightRefreshBtn){
  tonightRefreshBtn.onclick = ()=>{
    tonightOffset += 3;
    renderTonightSuggestions();
  };
}

// Camera + Voice for fridge add row
const IMAGENET_TO_HEBREW = [
  [['banana'], 'בננה'],
  [['orange'], 'תפוז'],
  [['lemon'], 'לימון'],
  [['strawberry'], 'תותים'],
  [['mushroom', 'agaric'], 'פטריות'],
  [['corn', 'ear'], 'תירס'],
  [['cucumber'], 'מלפפונים'],
  [['bell pepper'], 'פלפל'],
  [['head cabbage'], 'כרוב'],
  [['broccoli'], 'ברוקולי'],
  [['cauliflower'], 'כרובית'],
  [['zucchini', 'courgette'], 'קישואים'],
  [['granny smith'], 'תפוח'],
  [['french loaf', 'bagel', 'pretzel'], 'לחם'],
  [['egg'], 'ביצים']
];
function guessHebrewFromLabel(label){
  const lower = label.toLowerCase();
  if(learnedLabels[lower]) return learnedLabels[lower];
  for(const [keys, heb] of IMAGENET_TO_HEBREW){
    if(keys.some(k=>lower.includes(k))) return heb;
  }
  return null;
}
let learnedLabels = JSON.parse(localStorage.getItem('learned_labels')||'{}');
function teachLabel(label, hebrewName){
  learnedLabels[label.toLowerCase()] = hebrewName;
  localStorage.setItem('learned_labels', JSON.stringify(learnedLabels));
  scheduleAppStatePush();
}
let learnedBarcodes = JSON.parse(localStorage.getItem('learned_barcodes')||'{}');
function teachBarcode(code, name){
  learnedBarcodes[code] = name;
  localStorage.setItem('learned_barcodes', JSON.stringify(learnedBarcodes));
  scheduleAppStatePush();
}
let mobilenetModel = null;
let mobilenetLoading = null;
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function loadMobilenet(){
  if(mobilenetModel) return mobilenetModel;
  if(!mobilenetLoading){
    mobilenetLoading = (async ()=>{
      if(!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js');
      if(!window.mobilenet) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js');
      mobilenetModel = await window.mobilenet.load();
      return mobilenetModel;
    })();
  }
  return mobilenetLoading;
}
function setCamStatus(text){
  const el = document.getElementById('camStatus');
  if(el) el.textContent = text || '';
}
async function classifyAndAdd(file){
  setCamStatus('טוענים מודל זיהוי תמונה... (פעם ראשונה עשויה לקחת כמה שניות)');
  try{
    const model = await loadMobilenet();
    setCamStatus('מזהים את התמונה...');
    const img = new Image();
    const url = URL.createObjectURL(file);
    await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=url; });
    const predictions = await model.classify(img);
    URL.revokeObjectURL(url);
    const topLabel = predictions[0] ? predictions[0].className.toLowerCase() : '';
    let matched = null;
    for(const p of predictions){
      matched = guessHebrewFromLabel(p.className);
      if(matched) break;
    }
    if(matched){
      fridge.add(matched);
      saveFridge();
      renderAll();
      const statusEl = document.getElementById('camStatus');
      statusEl.innerHTML = `✓ זיהינו ${escHtml(matched)} והוספנו למקרר · <a href="#" id="fixLabelLink">לא נכון? תקנו</a>`;
      document.getElementById('fixLabelLink').onclick = (e)=>{
        e.preventDefault();
        showPromptModal('מה זה באמת? (נלמד את זה לפעם הבאה)', (name)=>{
          fridge.delete(matched);
          fridge.add(name);
          saveFridge();
          teachLabel(topLabel, name);
          renderAll();
          setCamStatus(`✓ עודכן ל-${name} — נזכור בפעם הבאה`);
          setTimeout(()=>setCamStatus(''), 4000);
        }, matched);
      };
      return;
    }
    const guess = predictions[0] ? predictions[0].className.split(',')[0] : '';
    setCamStatus('');
    showPromptModal('לא זיהינו בוודאות מצרך מוכר (ניחוש המערכת: ' + guess + '). הקלידו את שם המצרך:', (name)=>{
      fridge.add(name);
      saveFridge();
      teachLabel(topLabel, name);
      renderAll();
      setCamStatus('✓ נשמר — נזכור את זה בפעם הבאה');
      setTimeout(()=>setCamStatus(''), 4000);
    });
  }catch(e){
    setCamStatus('');
    showPromptModal('זיהוי התמונה נכשל. הקלידו את שם המצרך שצולם:', (name)=>{
      fridge.add(name);
      saveFridge();
      renderAll();
    });
  }
}
(function enhanceAddRow(){
  const row = document.querySelector('.add-row');
  if(!row) return;

  const camBtn = document.createElement('button');
  camBtn.type = 'button';
  camBtn.textContent = '📷';
  camBtn.title = 'זיהוי מצרך מתמונה';
  camBtn.style.cssText = 'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:0 12px;font-size:18px;cursor:pointer;';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.capture = 'environment';
  fileInput.style.display = 'none';
  camBtn.onclick = ()=> fileInput.click();
  fileInput.onchange = ()=>{
    if(!fileInput.files || !fileInput.files[0]) return;
    classifyAndAdd(fileInput.files[0]);
    fileInput.value = '';
  };

  const barcodeBtn = document.createElement('button');
  barcodeBtn.type = 'button';
  barcodeBtn.textContent = '🔖';
  barcodeBtn.title = 'סריקת ברקוד';
  barcodeBtn.style.cssText = 'border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:0 12px;font-size:18px;cursor:pointer;';
  barcodeBtn.onclick = openBarcodeScanner;

  row.insertBefore(camBtn, row.lastElementChild);
  row.insertBefore(barcodeBtn, row.lastElementChild);
  row.appendChild(fileInput);
})();

// ——— Barcode scanning (native BarcodeDetector, with ZXing fallback) ———
let barcodeStream = null;
let barcodeRAF = null;
let zxingReader = null;

function stopBarcodeScanner(){
  const overlay = document.getElementById('barcodeOverlay');
  overlay.classList.remove('active');
  if(barcodeRAF){ cancelAnimationFrame(barcodeRAF); barcodeRAF = null; }
  if(barcodeStream){ barcodeStream.getTracks().forEach(t=>t.stop()); barcodeStream = null; }
  if(zxingReader){ try{ zxingReader.reset(); }catch(e){} zxingReader = null; }
}

async function lookupBarcode(code){
  const hint = document.getElementById('barcodeHint');

  if(learnedBarcodes[code]){
    fridge.add(learnedBarcodes[code]);
    recordUsage(learnedBarcodes[code]);
    saveFridge();
    renderAll();
    stopBarcodeScanner();
    return;
  }

  hint.textContent = 'מחפשים את המוצר...';
  try{
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json`);
    const data = await res.json();
    if(data.status === 1 && data.product){
      const name = data.product.product_name_he || data.product.product_name || data.product.generic_name || null;
      if(name){
        const cleanName = norm(name);
        fridge.add(cleanName);
        recordUsage(cleanName);
        saveFridge();
        renderAll();
        stopBarcodeScanner();
        const camEl = document.getElementById('camStatus');
        if(camEl) camEl.innerHTML = `✓ זיהינו ${escHtml(cleanName)} מברקוד והוספנו למקרר · <a href="#" id="fixBarcodeLink">לא נכון? תקנו</a>`;
        document.getElementById('fixBarcodeLink').onclick = (e)=>{
          e.preventDefault();
          showPromptModal('מה זה באמת? (נלמד את זה לפעם הבאה)', (fixedName)=>{
            fridge.delete(cleanName);
            fridge.add(fixedName);
            saveFridge();
            teachBarcode(code, fixedName);
            renderAll();
            setCamStatus(`✓ עודכן ל-${fixedName} — נזכור בפעם הבאה`);
            setTimeout(()=>setCamStatus(''), 4000);
          }, cleanName);
        };
        return;
      }
    }
    stopBarcodeScanner();
    showPromptModal(`לא מצאנו את המוצר במאגר (ברקוד ${code}). הקלידו את שם המוצר — נזכור אותו לפעם הבאה:`, (name)=>{
      fridge.add(name);
      recordUsage(name);
      saveFridge();
      teachBarcode(code, name);
      renderAll();
    });
  }catch(e){
    stopBarcodeScanner();
    showPromptModal(`שגיאה בחיפוש המוצר (ברקוד ${code}). הקלידו את שם המוצר — נזכור אותו לפעם הבאה:`, (name)=>{
      fridge.add(name);
      recordUsage(name);
      saveFridge();
      teachBarcode(code, name);
      renderAll();
    });
  }
}

async function openBarcodeScanner(){
  const overlay = document.getElementById('barcodeOverlay');
  const video = document.getElementById('barcodeVideo');
  const hint = document.getElementById('barcodeHint');
  overlay.classList.add('active');
  hint.textContent = 'כוונו את המצלמה לברקוד המוצר';
  try{
    barcodeStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
  }catch(e){
    stopBarcodeScanner();
    alert('לא ניתן לגשת למצלמה. ודאו שנתתם הרשאת מצלמה לאתר.');
    return;
  }
  video.srcObject = barcodeStream;
  await video.play();

  if('BarcodeDetector' in window){
    const detector = new window.BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128']});
    const loop = async ()=>{
      if(!barcodeStream) return;
      try{
        const codes = await detector.detect(video);
        if(codes.length){ const val = codes[0].rawValue; lookupBarcode(val); return; }
      }catch(e){}
      barcodeRAF = requestAnimationFrame(loop);
    };
    loop();
  } else {
    hint.textContent = 'טוענים סורק ברקוד...';
    try{
      if(!window.ZXingBrowser) await loadScript('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js');
      hint.textContent = 'כוונו את המצלמה לברקוד המוצר';
      zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader();
      zxingReader.decodeFromVideoElement(video, (result, err)=>{
        if(result){ lookupBarcode(result.getText()); }
      });
    }catch(e){
      stopBarcodeScanner();
      alert('לא הצלחנו לטעון את סורק הברקוד. בדקו חיבור לאינטרנט ונסו שוב.');
    }
  }
}
document.getElementById('barcodeCloseBtn').onclick = stopBarcodeScanner;

// Moves favorites / cook history / weekly plan entries from recipes merged away (RECIPE_RENAMES in data.js).
function migrateRenamedRecipes(){
  if(typeof RECIPE_RENAMES === 'undefined') return false;
  let changed = false;
  let recipesAdded = false;
  Object.entries(RECIPE_RENAMES).forEach(([from, to])=>{
    // You edited a recipe that has since been merged away: keep your version as a personal recipe instead of losing it.
    if(recipeOverrides[from]){
      const mine = Object.assign({}, recipeOverrides[from]);
      if(!mine.name) mine.name = from;
      if(!RECIPES.some(r=>r.name === mine.name)){
        customRecipes.push(mine);
        RECIPES.push(mine);
        recipesAdded = true;
      }
      delete recipeOverrides[from];
      changed = true;
    }
    if(RECIPES.some(r=>r.name === from)) return;   // the old name still exists (e.g. an imported recipe) — leave it alone
    if(favorites.has(from)){ favorites.delete(from); favorites.add(to); changed = true; }
    if(cookedSet.has(from)){ cookedSet.delete(from); cookedSet.add(to); changed = true; }
    if(cookHistory[from]){ cookHistory[to] = (cookHistory[to]||[]).concat(cookHistory[from]).sort().slice(-20); delete cookHistory[from]; changed = true; }
    Object.keys(weeklyPlan).forEach(day=>{
      const arr = weeklyPlan[day] || [];
      if(arr.includes(from)){ weeklyPlan[day] = [...new Set(arr.map(n=> n===from ? to : n))]; changed = true; }
    });
  });
  if(recipesAdded){
    localStorage.setItem('custom_recipes', JSON.stringify(customRecipes));
    pushRecipeSync();
    pushRecipesRow();
  }
  if(changed){
    localStorage.setItem('favorites', JSON.stringify([...favorites]));
    localStorage.setItem('cooked_recipes', JSON.stringify([...cookedSet]));
    localStorage.setItem('cook_history', JSON.stringify(cookHistory));
    localStorage.setItem('weekly_plan', JSON.stringify(weeklyPlan));
    localStorage.setItem('recipe_overrides', JSON.stringify(recipeOverrides));
    scheduleAppStatePush();
  }
  return changed;
}

applyTheme();
migrateRenamedRecipes();
checkDailyFridgeReset();
renderCatTabs();
renderAll();
initAccount();

// Handle the "quick add to shopping list" home-screen shortcut
(function handleShortcutParams(){
  const params = new URLSearchParams(location.search);
  if(params.get('action') === 'addToShopping'){
    switchTab('shopping');
    setTimeout(()=>{
      shopView = 'list';
      renderShoppingPanel();
      openShopAddBar();
    }, 300);
    history.replaceState(null, '', location.pathname);
  }
})();



// ---- "Someone added an item" notices ----
// Items carry an optional author (list.addedBy[item] = {n: display name, e: email}). When a realtime update brings
// items we did not have, from someone other than us, show a toast (app open) or a system notification (app in background,
// if the user enabled it on this device). Works only while the app/browser is alive — true push when closed needs a server.
let addedNoticeBuffer = {};
let addedNoticeTimer = null;
function noticeAddedByOthers(oldLists, newLists){
  if(!currentUser) return;
  Object.keys(newLists || {}).forEach(id=>{
    const nl = newLists[id] || {};
    const ol = (oldLists || {})[id];
    const oldItems = new Set((ol && ol.items) || []);
    (nl.items || []).forEach(item=>{
      if(oldItems.has(item)) return;
      const a = (nl.addedBy || {})[item];
      if(a && a.e === currentUser.email) return;      // our own change coming back
      const who = a ? (a.n || (a.e||'').split('@')[0] || 'מישהו') : 'מישהו';
      (addedNoticeBuffer[who] = addedNoticeBuffer[who] || []).push(item);
    });
  });
  if(Object.keys(addedNoticeBuffer).length){
    clearTimeout(addedNoticeTimer);
    addedNoticeTimer = setTimeout(flushAddedNotices, 1200);   // merge bursts into one message
  }
}
function flushAddedNotices(){
  const buf = addedNoticeBuffer; addedNoticeBuffer = {};
  const lines = Object.entries(buf).map(([who, items])=>`נוסף לרשימה על ידי ${who}: ${[...new Set(items)].slice(0,6).join(', ')}${items.length>6?' ועוד…':''}`);
  if(!lines.length) return;
  if(document.visibilityState === 'visible'){
    showAddedToast(lines.join('\n'));
  } else if(localStorage.getItem('push_enabled') !== '1' && localStorage.getItem('added_notify_system') === '1' && 'Notification' in window && Notification.permission === 'granted'){
    showSystemNotification('רשימת הקניות עודכנה', lines.join('\n'));
  }
}
function showAddedToast(text){
  let el = document.getElementById('addedToast');
  if(!el){
    el = document.createElement('div');
    el.id = 'addedToast';
    el.className = 'added-toast';
    el.setAttribute('role', 'status');
    el.onclick = ()=>{ el.classList.remove('show'); switchTab('shopping'); };
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showAddedToast._t);
  showAddedToast._t = setTimeout(()=>el.classList.remove('show'), 6000);
}
function wireAddedNoticeSettings(){
  const nameInput = document.getElementById('displayNameInput');
  const saveBtn = document.getElementById('displayNameSaveBtn');
  const sysCb = document.getElementById('addedNotifyToggle');
  const status = document.getElementById('addedNotifyStatus');
  if(!nameInput) return;
  if(currentUser) nameInput.value = (currentUser.user_metadata && currentUser.user_metadata.display_name) || '';
  nameInput.placeholder = currentUser ? (currentUser.email||'').split('@')[0] : 'התחברו כדי להגדיר שם';
  saveBtn.onclick = async ()=>{
    if(!currentUser || !sbClient){ status.textContent = 'התחברו קודם לחשבון.'; return; }
    const name = norm(nameInput.value);
    try{
      const { data, error } = await sbClient.auth.updateUser({ data: { display_name: name } });
      if(error) throw error;
      if(data && data.user) currentUser = data.user;
      status.textContent = name ? `✓ בני המשפחה יראו אותך כ"${name}"` : '✓ השם נמחק — יוצג חלק מהאימייל';
    }catch(e){ status.textContent = 'לא ניתן לשמור כרגע.'; }
  };
  const supported = 'Notification' in window;
  sysCb.checked = localStorage.getItem('added_notify_system') === '1' && supported && Notification.permission === 'granted';
  sysCb.onchange = async ()=>{
    if(!supported){ sysCb.checked = false; status.textContent = 'הדפדפן הזה לא תומך בהתראות.'; return; }
    if(sysCb.checked){
      let perm = Notification.permission;
      if(perm === 'default') perm = await Notification.requestPermission();
      if(perm !== 'granted'){ sysCb.checked = false; status.textContent = 'לא אושרה הרשאה להתראות.'; return; }
      localStorage.setItem('added_notify_system', '1');
      status.textContent = '✓ תקבלו התראת מערכת כשהאפליקציה פתוחה ברקע';
    } else {
      localStorage.setItem('added_notify_system', '0');
      status.textContent = 'התראות המערכת כובו (הודעה בתוך האפליקציה תמשיך להופיע).';
    }
  };
}
wireAddedNoticeSettings();


// ---- Web Push (works with the notify-shopping Edge Function; see push_setup.sql) ----
function urlB64ToUint8Array(b64){
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function uint8ToB64Url(buf){
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pushSupported(){ return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
async function getPushRegistration(){
  return Promise.race([navigator.serviceWorker.ready, new Promise(r=>setTimeout(()=>r(null), 4000))]);
}
function pushRegisterArgs(sub){
  const j = sub.toJSON();
  return { p_endpoint: sub.endpoint, p_p256dh: j.keys && j.keys.p256dh, p_auth: j.keys && j.keys.auth, p_user_agent: navigator.userAgent };
}
function pushServerErrorText(error){
  const status = error && error.context && error.context.status;
  if(status === 404) return 'פונקציית השרת עוד לא הוקמה ב-Supabase (ראו הוראות ההקמה).';
  if(status === 401) return 'צריך להתחבר מחדש לחשבון.';
  if(status === 500) return 'השרת לא מוכן — ודאו שהרצתם את push_setup.sql.';
  return 'לא ניתן להגיע לשרת ההתראות כרגע.';
}
async function enablePush(setStatus){
  if(!pushSupported()){ setStatus('הדפדפן הזה לא תומך בהתראות דחיפה.'); return false; }
  if(!currentUser || !sbClient){ setStatus('התחברו קודם לחשבון.'); return false; }
  let perm = Notification.permission;
  if(perm === 'default') perm = await Notification.requestPermission();
  if(perm !== 'granted'){ setStatus('לא אושרה הרשאה להתראות.'); return false; }
  const reg = await getPushRegistration();
  if(!reg){ setStatus('האפליקציה עוד לא מוכנה להתראות — פתחו אותה דרך הכתובת הרגילה ונסו שוב.'); return false; }
  const { data, error } = await sbClient.functions.invoke('notify-shopping', { body: { action: 'key' } });
  if(error || !data || !data.publicKey){ setStatus(pushServerErrorText(error)); return false; }
  let sub = await reg.pushManager.getSubscription();
  if(sub && sub.options && sub.options.applicationServerKey && uint8ToB64Url(sub.options.applicationServerKey) !== data.publicKey){
    await sub.unsubscribe(); sub = null;     // keys changed on the server — start fresh
  }
  if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(data.publicKey) });
  const { data: r, error: e2 } = await sbClient.rpc('register_push_subscription', pushRegisterArgs(sub));
  if(e2 || r !== 'ok'){ setStatus('לא הצלחנו לשמור את ההרשמה בשרת.'); return false; }
  localStorage.setItem('push_enabled', '1');
  return true;
}
async function disablePush(){
  localStorage.setItem('push_enabled', '0');
  try{
    const reg = await getPushRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub){
      if(currentUser && sbClient) await sbClient.rpc('unregister_push_subscription', { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  }catch(e){}
}
// Keeps this device's registration pointing at the signed-in user (and notices if the browser dropped it).
async function refreshPushRegistration(){
  if(localStorage.getItem('push_enabled') !== '1' || !pushSupported() || !currentUser || !sbClient) return;
  if(Notification.permission !== 'granted'){ localStorage.setItem('push_enabled', '0'); return; }
  try{
    const reg = await getPushRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if(sub) await sbClient.rpc('register_push_subscription', pushRegisterArgs(sub));
    else localStorage.setItem('push_enabled', '0');
  }catch(e){}
}
function wirePushSettings(){
  const cb = document.getElementById('pushToggle');
  const status = document.getElementById('pushStatus');
  const testBtn = document.getElementById('pushTestBtn');
  if(!cb) return;
  const setStatus = (t)=>{ status.textContent = t; };
  cb.checked = localStorage.getItem('push_enabled') === '1' && pushSupported() && Notification.permission === 'granted';
  if(!pushSupported()) setStatus('הדפדפן הזה לא תומך בהתראות דחיפה.');
  cb.onchange = async ()=>{
    if(cb.checked){
      setStatus('מפעילים...');
      const ok = await enablePush(setStatus);
      if(ok) setStatus('✓ התראות דחיפה פעילות במכשיר הזה');
      else cb.checked = false;
    } else {
      await disablePush();
      setStatus('התראות הדחיפה כובו במכשיר הזה.');
    }
  };
  testBtn.onclick = async ()=>{
    if(localStorage.getItem('push_enabled') !== '1'){ setStatus('קודם הפעילו התראות דחיפה.'); return; }
    setStatus('שולחים...');
    const { data, error } = await sbClient.functions.invoke('notify-shopping', { body: { action: 'test' } });
    if(error){ setStatus(pushServerErrorText(error)); return; }
    setStatus(data && data.devices ? `✓ נשלחה התראה ל-${data.sent} מתוך ${data.devices} מכשירים — אמורה להגיע בעוד רגע` : 'אין מכשיר רשום לחשבון הזה — כבו והפעילו מחדש.');
  };
}
wirePushSettings();

// ---- Expiry reminders (per-device; fires when the app is opened/returned to, at most once a day) ----
let expiryNotifyEnabled = localStorage.getItem('expiry_notify_enabled') === '1';
function expiringItemsList(){
  return Object.keys(fridgeExpiry)
    .filter(i=>fridge.has(i))
    .map(i=>({item:i, d:daysUntil(fridgeExpiry[i])}))
    .filter(x=>x.d!==null && x.d<=2)
    .sort((a,b)=>a.d-b.d);
}
function expiryNotificationText(items){
  const lines = items.slice(0,6).map(x=>
    x.d<0 ? `${x.item} — פג תוקף` : x.d===0 ? `${x.item} — היום` : x.d===1 ? `${x.item} — מחר` : `${x.item} — בעוד ${x.d} ימים`);
  if(items.length>6) lines.push(`ועוד ${items.length-6}…`);
  return { title: 'ניהול משק בית · פריטים שעומדים לפוג', body: lines.join('\n') };
}
async function showSystemNotification(title, body){
  try{
    if('serviceWorker' in navigator){
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r=>setTimeout(()=>r(null),1500))]);
      if(reg && reg.showNotification){
        await reg.showNotification(title, {body, icon:'icon-192.png', tag:'expiry-reminder', lang:'he', dir:'rtl'});
        return true;
      }
    }
  }catch(e){}
  try{ new Notification(title, {body}); return true; }catch(e){}
  return false;
}
async function maybeNotifyExpiring(force){
  if(!force && !expiryNotifyEnabled) return false;
  if(!('Notification' in window) || Notification.permission !== 'granted') return false;
  const items = expiringItemsList();
  const today = new Date().toISOString().slice(0,10);
  if(!force){
    if(items.length===0) return false;
    if(localStorage.getItem('expiry_notified_on') === today) return false;
  }
  if(items.length===0){
    return showSystemNotification('התזכורות פועלות ✓', 'כרגע אין פריטים שעומדים לפוג.');
  }
  const t = expiryNotificationText(items);
  localStorage.setItem('expiry_notified_on', today);
  return showSystemNotification(t.title, t.body);
}
function wireExpiryNotifySettings(){
  const cb = document.getElementById('expiryNotifyToggle');
  const status = document.getElementById('expiryNotifyStatus');
  const testBtn = document.getElementById('expiryNotifyTestBtn');
  if(!cb) return;
  const supported = 'Notification' in window;
  cb.checked = expiryNotifyEnabled && supported && Notification.permission === 'granted';
  if(!supported) status.textContent = 'הדפדפן הזה לא תומך בהתראות.';
  else if(Notification.permission === 'denied') status.textContent = 'ההתראות חסומות לאתר הזה — אפשר לאפשר אותן בהגדרות האתר בדפדפן.';
  cb.onchange = async ()=>{
    if(!supported){ cb.checked = false; return; }
    if(cb.checked){
      let perm = Notification.permission;
      if(perm === 'default') perm = await Notification.requestPermission();
      if(perm !== 'granted'){
        cb.checked = false;
        status.textContent = 'לא אושרה הרשאה להתראות.';
        return;
      }
      expiryNotifyEnabled = true;
      localStorage.setItem('expiry_notify_enabled', '1');
      status.textContent = '✓ התזכורות הופעלו במכשיר הזה';
      localStorage.removeItem('expiry_notified_on');
      maybeNotifyExpiring(false);
    } else {
      expiryNotifyEnabled = false;
      localStorage.setItem('expiry_notify_enabled', '0');
      status.textContent = 'התזכורות כובו';
    }
  };
  testBtn.onclick = async ()=>{
    if(!supported || Notification.permission !== 'granted'){ status.textContent = 'קודם הפעילו תזכורות ואשרו הרשאה.'; return; }
    const ok = await maybeNotifyExpiring(true);
    status.textContent = ok ? '✓ נשלחה התראת בדיקה' : 'לא הצלחנו להציג התראה.';
  };
}
wireExpiryNotifySettings();
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible') maybeNotifyExpiring(false);
});
setTimeout(()=>maybeNotifyExpiring(false), 3500);

// Register the service worker for offline support and real installability.
// Requires service-worker.js (and manifest.json + icons) to be hosted in the same folder as this file.
if('serviceWorker' in navigator){
  // When a new version is published, pages that are already open (e.g. a phone that left the app in the
  // background) reload themselves, so every device runs the same code. Unsent edits are pushed first.
  const hadController = !!navigator.serviceWorker.controller;
  let updateReloading = false;
  const reloadForUpdate = ()=>{
    if(updateReloading) return;
    if(cookState.recipe || shoppingModeActive){                // don't interrupt cooking / shopping — reload when hidden
      const onHide = ()=>{ if(document.visibilityState === 'hidden'){ document.removeEventListener('visibilitychange', onHide); reloadForUpdate(); } };
      document.addEventListener('visibilitychange', onHide);
      return;
    }
    updateReloading = true;
    const go = ()=> location.reload();
    if(shoppingPushPending || shoppingPushInFlight) pushShoppingRow().finally(()=>setTimeout(go, 300)); else go();
  };
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(hadController) reloadForUpdate(); });
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').then(reg=>{
      const check = ()=> reg.update().catch(()=>{});
      document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') check(); });
      setInterval(check, 15 * 60 * 1000);
    }).catch(()=>{
      // Missing file is fine — the app still works fully online, just without offline caching / install prompt.
    });
  });
}

