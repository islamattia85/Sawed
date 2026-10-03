import {
  HOURS_IN_YEAR, DAYS_IN_MONTH, DEG, LOCATION_BASE, dayOfYear, PSO_LEVY,
} from './engine/constants';
import {
  solarPosition, erbsDiffuse, buildHourlyGhi, buildPoa, buildPvGeneration,
} from './engine/solar';
import { npv20 as engineNpv20 } from './engine/npv';
import { buildReportData, renderReport } from './pdf/index.js';
import {
  isInWindow, bandAt, rateAt as engineRateAt, isFlatPlan, staticRateAt,
  simulateBaseline as engineSimulateBaseline, annualCost, sumF, WHOLESALE_CAP,
} from './engine/tariff-rules';
import { moneyBar, dayProfile, paybackCurve, yearRibbon, bandDonut } from './ui/charts.js';
import { createV7 } from './ui/v7.js';
import { checkSwitch, timingFit } from './engine/meter';
import { BRAND, CONTROLLER, MARK_PATHS, iconDataUri, wordmarkHtml } from './brand';

/* Peakless — application entry.
 * Extracted verbatim from the former single-file index.html.
 * Module split follows in later phases; this step only makes the
 * codebase buildable without changing a single line of behaviour.
 */

/* ============================================================
   SUPABASE AUTH — login, signup, profile management
   Set window.SUPABASE_URL and window.SUPABASE_ANON_KEY above.
   ============================================================ */
const SUPABASE_URL      = window.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';

let _sb = null;          // Supabase client
let _sbUser = null;      // Current user object (null = logged out)
let _sbProfile = null;   // User profile row from DB
let _authModalOpen = false;
let _authView = 'login'; // 'login' | 'signup' | 'profile'

async function sbInit(){
  if (_sb || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  if (window.__sbInitBlocked) return;   // tests: simulate an import that will not load
  try {
    // The client is bundled, not fetched from a CDN at click time.
    //
    // It used to be injected as a <script> from jsdelivr the moment someone
    // pressed a sign-in button. Any network that could not reach that host —
    // a corporate proxy, a strict content policy, a bad minute for the CDN —
    // meant authentication simply did not work, and the only signal was a
    // rejected promise this function swallows. Bundling makes signing in
    // depend on the app loading, which it already did.
    const { createClient } = await import('@supabase/supabase-js');
    // flowType matters, and the default is wrong for us.
    //
    // The client defaults to the implicit grant. Supabase sends a browser back
    // from Google with the authorisation code in the query string — `?code=…` —
    // and a client in implicit mode refuses to look at it: it throws "Not a
    // valid implicit grant flow url" inside its own initialisation, where
    // nothing surfaces it. The code is never exchanged, no session is created,
    // and the app boots signed out. Server-side the login is a success; the
    // Supabase auth log records it every time. On screen it is a button that
    // sends you to Google and brings you back with nothing, which is exactly
    // what it looked like.
    //
    // PKCE is the flow that reads `?code=`, and it is the correct one for a
    // public browser client regardless: the code is useless without the
    // verifier this device kept to itself.
    _sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
    const { data: { session } } = await _sb.auth.getSession();
    if (session) {
      _sbUser = session.user;
      await sbLoadProfile();
    }
    _sb.auth.onAuthStateChange(async (event, session) => {
      if ((session ? session.user.id : null) !== (_sbUser ? _sbUser.id : null)) _myLeads = null;
      _sbUser = session ? session.user : null;
      if (_sbUser) {
        window._authEmailOpen = false;
        await sbLoadProfile();
        if (!_sbProfile) await sbSaveProfile();
      } else {
        _sbProfile = null;
      }
      renderApp();
    });
  } catch(e){
    console.warn('Supabase init failed:', e);
  }
}

/* ---- The account copy of the household -----------------------------------
 * Signed in, every save on this phone is also written to the account a few
 * seconds later, so the same home opens on any device. Signing in on a phone
 * that already has a setup never silently throws one away: an empty account
 * takes the phone's setup, an empty phone takes the account's, the same home
 * on both is simply joined, and two different homes are put side by side for
 * the person to choose. Saved quotes from both are always kept. */

// What describes this screen rather than the household is never synced.
const NO_SYNC = ['_flow', '_flow_edit', '_eg', '_sg', 'current_screen', '_home_deep', '_solar_deep', '_solar_more', '_an_tab', '_an_from', '_an_pick', '_an_note', '_an_day_open', '_an_mon', '_sheet', '_sys_saving', '_fine_open', '_settings_open', '_return_to', '_lead_form',
  '_tariff_refreshing', '_expert_open', '_account_id', '_saved_at'];
let _sync = { status: 'idle', at: null };
let _syncTimer = null;
let _handover = null;          // { remote, remoteAt } while the person chooses
let _myLeads = null;           // the account's quote requests, once fetched

function cloudCopy(src){
  const o = {};
  for (const k in src) if (!NO_SYNC.includes(k)) o[k] = src[k];
  return o;
}
function setupKey(st){
  const keys = ['region', 'heating_type', 'usage_input_mode', 'annual_kwh', 'bimonthly_bill_eur', 'baseline',
    'has_solar', 'count_A', 'count_B', 'panel_w', 'battery_kwh', 'ev_active'];
  return JSON.stringify(keys.map((k) => st[k] ?? null));
}
function mergeQuotes(a, b){
  const out = [...(a || [])];
  for (const q of b || []) if (!out.some((x) => x.id === q.id)) out.push(q);
  return out;
}
function queueCloudSave(){
  if (!_sb || !_sbUser || _handover) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { sbSaveProfile(); }, 2500);
}
function takeRemote(remote){
  const keep = {};
  NO_SYNC.forEach((k) => { if (k in state) keep[k] = state[k]; });
  const quotes = mergeQuotes(state.solar_quotes, remote.solar_quotes);
  state = deepMerge(state, cloudCopy(remote));
  Object.assign(state, keep);
  state.solar_quotes = quotes;
  state._account_id = _sbUser.id;
  if (!state.onboarding_complete) state.current_screen = 'welcome';
  else if (['welcome', 'fastpath', 'onboarding', 'intro'].includes(state.current_screen)) state.current_screen = 'result';
  try { applyRegion(state.region || 'east'); } catch (e) {}
  invalidate();
  saveState();
}

async function sbLoadProfile(){
  if (!_sb || !_sbUser) return;
  try {
    const { data } = await _sb.from('profiles').select('*').eq('id', _sbUser.id).maybeSingle();
    _sbProfile = data;
    let remote = data && data.app_state;
    if (typeof remote === 'string') { try { remote = JSON.parse(remote); } catch (e) { remote = null; } }
    const here = !!state.onboarding_complete;
    const there = !!(remote && remote.onboarding_complete);
    if (!there){
      // A new account: this phone's setup becomes the account's.
      if (here){ await sbSaveProfile(); if (data) showToast('Your setup is now saved to your account', { type: 'accent', icon: ic('checkC', 16) }); }
      return;
    }
    if (!here || setupKey(state) === setupKey(remote)){ takeRemote(remote); return; }
    if (state._account_id === _sbUser.id){
      // This phone has synced with this account before: the newer copy wins.
      const remoteAt = Date.parse(data.updated_at || 0) || 0;
      if (remoteAt > (state._saved_at || 0)) takeRemote(remote); else await sbSaveProfile();
      return;
    }
    // Two different homes, and this phone has never synced with the account.
    _handover = { remote, remoteAt: data.updated_at };
    state._sheet = { kind: 'handover', id: null };
  } catch (e){}
}

async function sbSaveProfile(extraFields){
  if (!_sb || !_sbUser) return;
  _sync = { status: 'saving', at: _sync.at };
  try {
    const payload = {
      id: _sbUser.id,
      email: _sbUser.email,
      app_state: cloudCopy(state),
      updated_at: new Date().toISOString(),
      ...(extraFields || {}),
    };
    const { error } = await _sb.from('profiles').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    _sync = { status: 'saved', at: Date.now() };
    if (state._account_id !== _sbUser.id){
      state._account_id = _sbUser.id;
      try { localStorage.setItem('solarAppState_v2', JSON.stringify(state)); } catch (e) {}
    }
  } catch (e){
    _sync = { status: 'error', at: _sync.at };
  }
  const line = document.getElementById('me-sync');
  if (line) line.textContent = syncLine();
}

function syncLine(){
  if (_sync.status === 'saving') return 'Saving to your account…';
  if (_sync.status === 'error') return 'Not saved to your account yet. It will retry on your next change.';
  if (_sync.at){
    const m = Math.round((Date.now() - _sync.at) / 60000);
    return `Saved to your account ${m < 1 ? 'just now' : m === 1 ? 'a minute ago' : m + ' minutes ago'}`;
  }
  return 'Saved to your account';
}

/** Two different homes: keep one as the household, keep every quote. */
function handoverKeep(which){
  const h = _handover;
  _handover = null;
  state._sheet = null;
  if (!h) return renderApp();
  if (which === 'cloud') takeRemote(h.remote);
  else { state.solar_quotes = mergeQuotes(state.solar_quotes, h.remote.solar_quotes); saveState(); sbSaveProfile(); }
  showToast(which === 'cloud' ? 'Opened the setup saved in your account' : "This phone's setup is now saved to your account",
    { type: 'accent', icon: ic('checkC', 16) });
  renderApp();
}

function setupSummary(st){
  const kwh = Math.round(Object.values(st.bills || {}).reduce((a, b) => a + b, 0) || st.annual_kwh || 0);
  const region = IRISH_REGIONS[st.region || 'east'];
  const sys = st.has_solar && (st.count_A || 0) + (st.count_B || 0) > 0
    ? `${(st.count_A || 0) + (st.count_B || 0)} panels${st.battery_kwh > 0 ? ` · ${st.battery_kwh} kWh battery` : ''}` : 'no solar';
  return `${region ? region.name : ''} · ${st.heating_type || 'gas'} heating · ${kwh.toLocaleString('en-IE')} kWh a year · ${sys}${st.ev_active ? ' · EV' : ''}`;
}

function renderHandoverSheet(){
  const h = _handover;
  if (!h) return '';
  const when = h.remoteAt ? new Date(h.remoteAt).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `<div class="v7-sheet-head">
      <div class="v7-eyebrow">Signed in</div>
      <h2 class="v7-h">Which home should we keep?</h2>
    </div>
    <p class="me-p">This phone and your account each have a different setup. Pick the one that is your home. Saved quotes from both are kept either way.</p>
    <button class="me-choice" onclick="handoverKeep('local')">
      <span class="me-choice-tag">On this phone</span>
      <b>${esc(setupSummary(state))}</b>
      <small>Keep this one, and save it to your account</small>
    </button>
    <button class="me-choice" onclick="handoverKeep('cloud')">
      <span class="me-choice-tag">In your account${when ? ` · saved ${when}` : ''}</span>
      <b>${esc(setupSummary(h.remote))}</b>
      <small>Open this one on this phone</small>
    </button>`;
}

async function sbSignUp(email, password, displayName){
  const sb = await sbClient();
  if (!sb) return new Error('load failed');
  const { error } = await sb.auth.signUp({
    email, password,
    options: { data: { display_name: displayName } }
  });
  return error;
}

/**
 * The client, built on demand if it is not there yet.
 *
 * sbInitialized() only ever checked that the URL and key constants exist. The
 * sign-in sheet rendered on that basis, so a form appeared whenever the app had
 * keys — including when createClient() had never run, because the dynamic
 * import failed on a bad connection. Submitting then read .auth off null, threw
 * inside an un-caught await, and left the button disabled with no message and
 * nothing on screen. "Log in not working", exactly.
 *
 * Retrying the initialisation here also means a sign-in attempt after the
 * connection recovers now works, instead of needing a reload.
 */
async function sbClient(){
  if (_sb) return _sb;
  await sbInit();
  return _sb;
}

async function sbSignIn(email, password){
  const sb = await sbClient();
  if (!sb) return new Error('load failed');   // mapped to a connection message
  const { error } = await sb.auth.signInWithPassword({ email, password });
  return error;
}

async function sbSignOut(){
  if (_sb) await _sb.auth.signOut();
  _sbUser = null; _sbProfile = null;
  renderApp();
}

async function sbResetPassword(email){
  const sb = await sbClient();
  if (!sb) return new Error('load failed');
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href
  });
  return error;
}

function sbInitialized(){ return !!(SUPABASE_URL && SUPABASE_ANON_KEY); }

/**
 * Report an OAuth attempt that came back refused.
 *
 * "Continue with Google" hands the browser to Supabase, which hands it to
 * Google, which sends it back here. When any step declines, it returns to this
 * app with the reason in the URL — as query parameters, or in the hash for the
 * implicit flow. Nothing read either. The app booted as normal, showed the
 * reader signed out, and said nothing at all: tap the button, watch a browser
 * bounce, end up exactly where you started with no explanation.
 *
 * Every common cause lands here and is named precisely — the provider not
 * being enabled in Supabase, the app's URL missing from the redirect
 * allow-list, a mismatched client in the Google console, or simply declining
 * the consent screen. None of that is guessable from the outside, and all of
 * it arrives in this string.
 */
let _oauthReturn = null;

/**
 * Capture the OAuth result from the URL before anything can overwrite it.
 *
 * This has to run before the first render. The app routes screens through the
 * location hash, so renderApp() replaces it with '#result' — and the implicit
 * flow returns its error in exactly that hash. Reading it after the first paint
 * meant reading a hash the router had already thrown away.
 */
function captureOAuthReturn(){
  try {
    const q = new URLSearchParams(window.location.search);
    const h = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const err = q.get('error') || h.get('error');
    if (!err) return;
    _oauthReturn = {
      err,
      desc: (q.get('error_description') || h.get('error_description') || '').replace(/\+/g, ' '),
      code: q.get('error_code') || h.get('error_code') || '',
    };
    // Take the reason out of the address bar so a refresh does not replay it.
    try {
      window.history.replaceState({}, '', window.location.origin + window.location.pathname);
    } catch (e) { /* not fatal */ }
  } catch (e) { /* never block boot */ }
}

/**
 * We went to Google and came back with nothing to show for it.
 *
 * No session, no error in the URL: the far end neither signed us in nor said
 * why. In practice that is a provider that was never configured, a Supabase
 * project that is not answering, or a browser that refused to complete the
 * hand-off — and to the reader it is a button that does nothing, twice.
 *
 * Reported only when a sign-in was actually started from this device in the
 * last few minutes, so it can never fire on an ordinary visit.
 */
function reportOAuthSilence(){
  try {
    const started = +(sessionStorage.getItem('oauth_pending') || 0);
    if (!started) return false;
    sessionStorage.removeItem('oauth_pending');
    if (_sbUser) return false;                       // it worked
    if (Date.now() - started > 10 * 60 * 1000) return false;   // stale
    if (_oauthReturn) return false;                  // an error is being reported instead

    const friendly = 'Google sent you back without signing you in.';
    showToast(friendly, { type: 'amber', icon: ic('warn', 16), title: 'Sign-in failed' });
    _authModalOpen = true;
    window._authEmailOpen = true;
    renderApp();
    setTimeout(() => showAuthMsg(friendly, 'err',
      'no session and no reason given — usually the Google provider is not enabled in Supabase, '
      + 'or this address is missing from its redirect allow-list'), 60);
    return true;
  } catch (e) { return false; }
}

function reportOAuthReturn(){
  try {
    if (!_oauthReturn) return false;
    const { err, desc, code } = _oauthReturn;
    _oauthReturn = null;

    const friendly = /access_denied/i.test(err)
      ? 'Google sign-in was cancelled.'
      : /provider is not enabled|unsupported provider/i.test(desc + err)
        ? 'Google sign-in is not switched on for this app yet.'
        : /redirect|requested path is invalid/i.test(desc + err)
          ? 'This address is not on the sign-in allow-list, so Google sent you back.'
          : 'Google sign-in did not complete.';

    showToast(friendly, { type: 'amber', icon: ic('warn', 16), title: 'Sign-in failed' });
    // Open on the email form rather than the provider chooser: it is the only
    // view with somewhere to print the reason, and it offers the route that
    // still works while Google is refusing.
    _authModalOpen = true;
    window._authEmailOpen = true;
    renderApp();
    // Put the exact reason where it can be read and repeated.
    setTimeout(() => showAuthMsg(friendly, 'err', [code, err, desc].filter(Boolean).join(' · ')), 60);
    return true;
  } catch (e) { return false; }
}

// ---- Auth rendering ----

let _authEmailView = 'login'; // 'login' | 'signup' | 'forgot' — controls inline email form on welcome page

/* Google SVG logo (inline, no external resource) */
const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
  <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
  <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
</svg>`;

/* Auth section rendered inside the welcome page */
function renderAuthSection(){
  if (!sbInitialized()) return '';

  // Signed-in state
  if (_sbUser) {
    const name = (_sbProfile && _sbProfile.display_name) || _sbUser.email || 'there';
    const initials = name.slice(0,1).toUpperCase();
    return `
    <div class="auth-panel" style="margin-top:24px;border-color:var(--accent)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;flex-shrink:0">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
          <div style="font-size:12px;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_sbUser.email}</div>
        </div>
        <button onclick="doSignOut()" style="flex-shrink:0;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;font-family:var(--display);font-size:12px;font-weight:600;color:var(--ink-soft);cursor:pointer">Sign out</button>
      </div>
      <div id="auth-msg" class="auth-msg"></div>
    </div>`;
  }

  // Signed-out state — email form view
  const v = _authEmailView;
  const emailForm = v === 'forgot' ? `
    <div class="auth-input-row" style="margin-top:10px">
      <input class="auth-input-sm" id="auth-email" type="email" placeholder="your@email.com" autocomplete="email">
    </div>
    <div id="auth-msg" class="auth-msg"></div>
    <button class="auth-submit-btn" onclick="doForgotPassword()">Send reset link</button>
    <div class="auth-toggle" style="margin-top:8px"><a onclick="_authEmailView='login';renderApp()">← Back to sign in</a></div>
  ` : v === 'signup' ? `
    <div class="auth-input-row" style="margin-top:10px">
      <input class="auth-input-sm" id="auth-name" type="text" placeholder="Your name (optional)" autocomplete="name">
      <input class="auth-input-sm" id="auth-email" type="email" placeholder="your@email.com" autocomplete="email">
      <input class="auth-input-sm" id="auth-password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password">
    </div>
    <div id="auth-msg" class="auth-msg"></div>
    <button class="auth-submit-btn" id="auth-submit-btn" onclick="doSignUp()">Create free account</button>
    <div class="auth-toggle" style="margin-top:8px">Already have an account? <a onclick="_authEmailView='login';renderApp()">Sign in</a></div>
  ` : `
    <div class="auth-input-row" style="margin-top:10px">
      <input class="auth-input-sm" id="auth-email" type="email" placeholder="your@email.com" autocomplete="email">
      <input class="auth-input-sm" id="auth-password" type="password" placeholder="Password" autocomplete="current-password">
    </div>
    <div class="auth-forgot" onclick="_authEmailView='forgot';renderApp()">Forgot password?</div>
    <div id="auth-msg" class="auth-msg"></div>
    <button class="auth-submit-btn" id="auth-submit-btn" onclick="doSignIn()">Sign in</button>
    <div class="auth-toggle" style="margin-top:8px">New here? <a onclick="_authEmailView='signup';renderApp()">Create free account</a></div>
  `;

  // Show email form only when toggled open
  const emailOpen = window._authEmailOpen || false;

  return `
  <div class="auth-panel" style="margin-top:24px">
    <div style="font-size:12px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-dim);text-align:center;margin-bottom:12px;font-weight:600">Save your results across devices</div>
    <button class="auth-google-btn" onclick="doGoogleSignIn()">
      ${GOOGLE_SVG} Continue with Google
    </button>
    <div class="auth-divider" style="margin:10px 0">or email</div>
    ${emailOpen ? emailForm : `
      <button onclick="window._authEmailOpen=true;renderApp()" style="width:100%;padding:10px;border-radius:8px;border:1.5px solid var(--line);background:transparent;font-family:var(--display);font-size:13px;font-weight:600;color:var(--ink-soft);cursor:pointer">Continue with email</button>
      <!-- The Google button lives on THIS view, and until now this view had
           nowhere to print a message. showAuthMsg() bails out when the element
           is missing, so every Google failure — the client not loading, the
           provider not enabled, a rejected redirect — was reported into
           nothing. The button flicked back from "Connecting…" and the reader
           was told absolutely nothing. -->
      <div id="auth-msg" class="auth-msg"></div>
    `}
  </div>`;
}

/* Profile modal — opened from topbar avatar */
/**
 * Account sheet: sign in when signed out, profile when signed in.
 *
 * Signed out, this used to return an empty string, so the header control had
 * nowhere to go and sent the user to a hard-coded black intro screen instead —
 * whose "Continue with Email" set a flag and navigated to the welcome screen,
 * which returns from renderApp() before any modal is injected. The email form
 * therefore never rendered anywhere: renderAuthSection() had been written,
 * styled and left unreferenced by any call site in the app.
 */
function renderAuthModal(){
  if (!_authModalOpen) return '';
  if (!sbInitialized()) return '';
  if (!_sbUser){
    return `
    <div class="auth-modal-backdrop" onclick="if(event.target===this){_authModalOpen=false;renderApp()}">
      <div class="auth-modal" role="dialog" aria-modal="true" aria-label="Sign in">
        <button class="auth-modal-close" onclick="_authModalOpen=false;renderApp()" aria-label="Close">${ic('x',18)}</button>
        <h3 style="margin:0 0 4px;font-size:20px">Sign in</h3>
        <p style="margin:0 0 4px;font-size:13px;color:var(--ink-soft);line-height:1.5">Save your setup and pick it up on another device. Everything works without an account too.</p>
        ${renderAuthSection()}
      </div>
    </div>`;
  }
  const initials = (_sbProfile && _sbProfile.display_name
    ? _sbProfile.display_name : (_sbUser.email || '?')).slice(0, 1).toUpperCase();
  const displayName = (_sbProfile && _sbProfile.display_name) || '';
  return `
  <div class="auth-modal-backdrop" onclick="if(event.target===this){_authModalOpen=false;renderApp()}">
    <div class="auth-modal" role="dialog" aria-modal="true" aria-label="Your profile">
      <button class="auth-modal-close" onclick="_authModalOpen=false;renderApp()" aria-label="Close">${ic('x',18)}</button>
      <div class="profile-section">
        <div class="profile-avatar">${initials}</div>
        <div class="profile-email">${_sbUser.email}</div>
        <div class="profile-name">${displayName || ''}</div>
      </div>
      <div id="auth-error" class="auth-error"></div>
      <div id="auth-success" class="auth-success"></div>
      <div class="profile-field-row">
        <label>Display name</label>
        <input class="auth-input" id="profile-name-input" type="text" value="${displayName}" placeholder="Your name">
      </div>
      <button class="auth-btn" onclick="doUpdateProfile()">Save profile</button>
      <button class="auth-secondary-btn" onclick="doSyncState()">Sync my settings to cloud</button>
      <div style="height:1px;background:var(--line);margin:16px 0"></div>
      <button class="auth-secondary-btn" onclick="doSignOut()" style="color:#ff6b6b;border-color:#ff444440">Sign out</button>
      <button class="auth-secondary-btn" onclick="_authModalOpen=false;setScreen('privacy')" style="margin-top:8px">Delete my account…</button>
    </div>
  </div>`;
}

function renderProfileNavBtn(){
  if (!sbInitialized()) return '';
  if (_sbUser){
    const initials = (_sbProfile && _sbProfile.display_name
      ? _sbProfile.display_name : (_sbUser.email || '?')).slice(0,1).toUpperCase();
    const nAl = state.onboarding_complete ? unseenAlerts().length : 0;
    return `<button class="profile-nav-btn" onclick="setScreen('me')" aria-label="My ${BRAND.name}${nAl ? `, ${nAl} new alerts` : ''}">
      <div class="profile-nav-avatar">${initials}${nAl ? `<i class="nav-badge">${nAl}</i>` : ''}</div>
    </button>`;
  }
  if (!sbInitialized()) return '';
  return `<button class="profile-nav-btn" onclick="_authModalOpen=true;window._authEmailOpen=false;renderApp()" aria-label="Sign in" style="font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;gap:5px">
    ${ic('shield',15)} <span>Sign in</span>
  </button>`;
}

// ---- Auth actions (called from onclick) ----

async function doGoogleSignIn(){
  const btn = document.querySelector('.auth-google-btn, .intro-oauth-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if (btn){ btn.disabled = true; btn.innerHTML = '<span style="opacity:.6">Connecting…</span>'; }
  if (!_sb) await sbInit();
  if (!_sb){
    showAuthMsg('Could not reach the sign-in service. Check your connection and try again — everything in the app works without an account.', 'err');
    if (btn){ btn.disabled = false; btn.innerHTML = origHTML; }
    return;
  }
  /*
   * Get the URL back and navigate deliberately, rather than letting the client
   * hand the browser away on our behalf.
   *
   * By default signInWithOAuth() assigns window.location itself. The page is
   * unloaded the instant it is called, so anything the app wants to say about
   * a failure is said to a document that no longer exists — and if the far end
   * then errors without redirecting back, the reader is left somewhere else
   * entirely with no way to know what happened. That is "nothing at all".
   *
   * Holding the URL means a provider that is not configured is reported here,
   * on the page, with the button still under the reader's thumb.
   */
  const { data, error } = await _sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      skipBrowserRedirect: true,
    },
  });
  if (error || !data || !data.url){
    showAuthMsg(
      error ? authErrorText(error) : 'Google sign-in is not available for this app yet.',
      'err',
      error ? authErrorDetail(error) : 'the sign-in service returned no address to send you to');
    if (btn){ btn.disabled = false; btn.innerHTML = origHTML; }
    return;
  }

  // Remember that we left, so a return with neither a session nor an error can
  // still be reported instead of looking like nothing happened.
  try { sessionStorage.setItem('oauth_pending', String(Date.now())); } catch (e) {}
  window.location.assign(data.url);
}

/**
 * Turn an auth failure into something a person can act on.
 *
 * The raw strings the client returns are for developers: "Failed to fetch"
 * tells a user nothing about what went wrong or what to try.
 */
function authErrorText(err){
  const raw = String((err && err.message) || err || '').toLowerCase();
  if (!raw) return 'Something went wrong. Try again in a moment.';
  if (raw.includes('failed to fetch') || raw.includes('networkerror') || raw.includes('load failed')) {
    return 'Could not reach the sign-in service. Check your connection and try again — everything in the app works without an account.';
  }
  if (raw.includes('invalid login') || raw.includes('invalid credentials')) {
    return 'That email and password do not match an account.';
  }
  if (raw.includes('email not confirmed')) {
    return 'Check your inbox and confirm your email address first.';
  }
  if (raw.includes('already registered') || raw.includes('already been registered')) {
    return 'There is already an account with that email. Try signing in instead.';
  }
  if (raw.includes('rate limit') || raw.includes('too many')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return (err && err.message) || 'Something went wrong. Try again in a moment.';
}

async function doSignIn(){
  const email = (document.getElementById('auth-email') || {}).value || '';
  const pw    = (document.getElementById('auth-password') || {}).value || '';
  const btn   = document.getElementById('auth-submit-btn');
  if (!email || !pw){ showAuthMsg('Please enter your email and password.', 'err'); return; }
  if (btn) btn.disabled = true;
  let err;
  try { err = await sbSignIn(email, pw); }
  catch (e) { err = e; }
  if (err){ showAuthMsg(authErrorText(err), 'err', authErrorDetail(err)); if(btn) btn.disabled=false; return; }
  _authModalOpen = false;
  renderApp();
}

async function doSignUp(){
  const name  = (document.getElementById('auth-name') || {}).value || '';
  const email = (document.getElementById('auth-email') || {}).value || '';
  const pw    = (document.getElementById('auth-password') || {}).value || '';
  const btn   = document.getElementById('auth-submit-btn');
  if (!email){ showAuthMsg('Please enter your email.', 'err'); return; }
  if (!pw || pw.length < 8){ showAuthMsg('Password must be at least 8 characters.', 'err'); return; }
  if (btn) btn.disabled = true;
  let err;
  try { err = await sbSignUp(email, pw, name); }
  catch (e) { err = e; }
  if (err){ showAuthMsg(authErrorText(err), 'err', authErrorDetail(err)); if(btn) btn.disabled=false; return; }
  showAuthMsg('Account created! Check your email to confirm, then sign in.', 'ok');
}

async function doSignOut(){
  _authModalOpen = false;
  await sbSignOut();
}

async function doForgotPassword(){
  const email = (document.getElementById('auth-email') || {}).value || '';
  if (!email){ showAuthMsg('Enter your email address first.', 'err'); return; }
  let err;
  try { err = await sbResetPassword(email); }
  catch (e) { err = e; }
  if (err){ showAuthMsg(authErrorText(err), 'err', authErrorDetail(err)); return; }
  showAuthMsg('Reset link sent — check your inbox.', 'ok');
}

async function doUpdateProfile(){
  const name = (document.getElementById('profile-name-input') || {}).value || '';
  await sbSaveProfile({ display_name: name });
  if (_sbProfile) _sbProfile.display_name = name;
  showAuthError('');
  showAuthSuccess('Profile saved.');
  setTimeout(() => renderApp(), 1200);
}

async function doSyncState(){
  await sbSaveProfile();
  showAuthMsg('Settings synced to cloud.', 'ok');
  showAuthSuccess('Settings synced to cloud.');
}

/* Inline auth-msg for welcome page panel */
/**
 * The message, plus the reason underneath it when something failed.
 *
 * authErrorText() turns a raw error into a sentence a reader can act on, which
 * is right — but it also throws away the only detail that says WHICH failure
 * this was. "Log in not working" is not something anyone can act on from the
 * other side of a support conversation, and the friendly sentence alone does
 * not narrow it either: a paused project, a wrong key, a rejected password and
 * a blocked network all read as "could not reach" or "try again".
 *
 * So the reason is kept, small and grey, under the sentence. It costs a line
 * and turns an unreproducible report into a specific one.
 */
let _authMsg = null;   // survives the repaints; see paintAuthModal()

function showAuthMsg(msg, type, detail){
  _authMsg = msg ? { msg, type, detail } : null;
  const el = document.getElementById('auth-msg');
  if (!el) return;
  el.textContent = '';
  el.className = 'auth-msg ' + (type || 'err');
  el.style.display = msg ? 'block' : 'none';
  if (!msg) return;
  el.appendChild(document.createTextNode(msg));
  const raw = detail && String(detail).slice(0, 160);
  if (raw){
    const small = document.createElement('span');
    small.style.cssText = 'display:block;margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--ink-dim);word-break:break-word';
    small.textContent = raw;
    el.appendChild(small);
  }
}

/** The underlying reason, for the small grey line under the message. */
function authErrorDetail(err){
  if (!err) return '';
  const bits = [];
  if (err.status) bits.push('HTTP ' + err.status);
  if (err.name && err.name !== 'Error') bits.push(err.name);
  const m = (err.message || String(err)).trim();
  if (m) bits.push(m);
  return bits.join(' · ');
}

/* Profile modal error/success (legacy modal) */
function showAuthError(msg){
  const el = document.getElementById('auth-error');
  if (el){ el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}
function showAuthSuccess(msg){
  const el = document.getElementById('auth-success');
  if (el){ el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}

/* ============================================================
   0. ICON SYSTEM — custom stroke icons, 24-grid, no emoji.
   ic(name, size, extraStyle) → inline SVG, inherits currentColor
   ============================================================ */
const IC = {
  home:    '<path d="M4.2 11.2 12 4.8l7.8 6.4"/><path d="M6.4 9.9V18.6a1.6 1.6 0 0 0 1.6 1.6h8a1.6 1.6 0 0 0 1.6-1.6V9.9"/>',
  plans:   '<path d="M5.5 19.5V12" stroke-width="2.6"/><path d="M12 19.5V4.8" stroke-width="2.6"/><path d="M18.5 19.5v-4.4" stroke-width="2.6"/>',
  sun:     '<circle cx="12" cy="12" r="3.9"/><path d="M12 2.8v2.1M12 19.1v2.1M21.2 12h-2.1M4.9 12H2.8M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5M18.6 18.6l-1.5-1.5M6.9 6.9 5.4 5.4"/>',
  radar:   '<path d="M12 4.4a7.6 7.6 0 1 1-7.6 7.6"/><path d="M12 8.2a3.8 3.8 0 1 0 3.8 3.8"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  grid:    '<circle cx="7.2" cy="7.2" r="1.8" fill="currentColor" stroke="none"/><circle cx="16.8" cy="7.2" r="1.8" fill="currentColor" stroke="none"/><circle cx="7.2" cy="16.8" r="1.8" fill="currentColor" stroke="none"/><circle cx="16.8" cy="16.8" r="1.8" fill="currentColor" stroke="none"/>',
  chevL:   '<path d="M14.6 5.6 8.2 12l6.4 6.4"/>',
  chevU: '<path d="M5.6 14.6 12 8.2l6.4 6.4"/>',
  chevD: '<path d="M5.6 9.4 12 15.8l6.4-6.4"/>',
  euro: '<path d="M17.5 6.5A7 7 0 1 0 17.5 17.5"/><path d="M4.5 10.2h9M4.5 13.8h9"/>',
  user: '<circle cx="12" cy="8.4" r="3.8"/><path d="M4.8 20c.9-3.6 3.8-5.6 7.2-5.6s6.3 2 7.2 5.6"/>',
  chevR:   '<path d="M9.4 5.6l6.4 6.4-6.4 6.4"/>',
  tune:    '<path d="M4 7.3h16M4 12h16M4 16.7h16"/><circle cx="9" cy="7.3" r="2.1" style="fill:var(--knock)"/><circle cx="15.5" cy="12" r="2.1" style="fill:var(--knock)"/><circle cx="7.5" cy="16.7" r="2.1" style="fill:var(--knock)"/>',
  bolt:    '<path d="M13.2 2.8 5.6 13.4h4.9L10.8 21.2 18.4 10.6h-4.9z" fill="currentColor" stroke="none"/>',
  battery: '<rect x="3" y="8" width="15.2" height="8" rx="2"/><path d="M20.6 10.6v2.8" stroke-width="2.2"/><rect x="5.4" y="10.3" width="5.2" height="3.4" rx="1" fill="currentColor" stroke="none"/>',
  export:  '<path d="M12 14.5V4.6M7.8 8.4 12 4.2l4.2 4.2"/><path d="M4.5 15v2.9A2.1 2.1 0 0 0 6.6 20h10.8a2.1 2.1 0 0 0 2.1-2.1V15"/>',
  import:  '<path d="M12 4.2v9.9M7.8 10.3l4.2 4.2 4.2-4.2"/><path d="M4.5 15v2.9A2.1 2.1 0 0 0 6.6 20h10.8a2.1 2.1 0 0 0 2.1-2.1V15"/>',
  car:     '<path d="M4.6 16.2v-2.4c0-.9.6-1.7 1.5-1.9l1.6-.4 1.8-2.9c.4-.6 1-1 1.8-1h3.6c.7 0 1.4.4 1.7 1l1.6 2.9 1.7.4c.9.2 1.5 1 1.5 1.9v2.4"/><path d="M3.6 16.2h16.8"/><circle cx="7.8" cy="17.6" r="1.7"/><circle cx="16.2" cy="17.6" r="1.7"/>',
  scales:  '<path d="M12 4.6v14.8M7.2 19.4h9.6M6.3 6.6h11.4"/><path d="m6.3 6.6-2.2 4.9a2.5 2.5 0 0 0 4.4 0L6.3 6.6ZM17.7 6.6l-2.2 4.9a2.5 2.5 0 0 0 4.4 0l-2.2-4.9Z"/>',
  clip:    '<rect x="5.6" y="4.6" width="12.8" height="16" rx="2"/><rect x="8.8" y="2.9" width="6.4" height="3.4" rx="1.2" style="fill:var(--knock)"/><path d="m9.2 13.6 2 2 3.6-4.2"/>',
  chart:   '<rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2.2"/><path d="m7 14.6 2.9-3.1 2.5 2 4.4-4.8"/>',
  flask:   '<path d="M9.8 4h4.4M10.4 4v4.9L5.9 17.3a2.1 2.1 0 0 0 1.9 3h8.4a2.1 2.1 0 0 0 1.9-3L13.6 8.9V4"/><path d="M7.6 14.6h8.8"/>',
  shield:  '<path d="M12 3.4 5.2 5.9v5.3c0 4.4 2.9 7.3 6.8 8.9 3.9-1.6 6.8-4.5 6.8-8.9V5.9L12 3.4Z"/><path d="m9.1 11.8 2.1 2.1 3.7-4.3"/>',
  swap:    '<path d="M16.6 3.8 20 7.2l-3.4 3.4M20 7.2H5.6M7.4 20.2 4 16.8l3.4-3.4M4 16.8h14.4"/>',
  bell:    '<path d="M6.4 16.2v-5.4a5.6 5.6 0 1 1 11.2 0v5.4l1.5 2.3H4.9l1.5-2.3Z"/><path d="M10.2 20.7a1.9 1.9 0 0 0 3.6 0"/>',
  doc:     '<path d="M7 3.6h6.3L17.8 8v10.8a1.8 1.8 0 0 1-1.8 1.8H7a1.8 1.8 0 0 1-1.8-1.8V5.4A1.8 1.8 0 0 1 7 3.6Z"/><path d="M13.2 3.8V8h4.4M8.6 12.4h6.8M8.6 15.8h6.8"/>',
  phone:   '<path d="M8.4 4.2 6 4.6A2 2 0 0 0 4.4 6.8c.7 6.3 5.9 11.5 12.3 12.3a2 2 0 0 0 2.2-1.6l.4-2.4-3.6-1.7-1.6 1.6c-2.3-1-4.1-2.8-5.1-5.1l1.6-1.6-2.2-4.1Z"/>',
  globe:   '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.2 3.6 5 3.6 8.2s-1.2 6-3.6 8.2c-2.4-2.2-3.6-5-3.6-8.2s1.2-6 3.6-8.2Z"/>',
  clock:   '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 2.1"/>',
  pin:     '<path d="M12 21c-4-4-6.8-7-6.8-10.4a6.8 6.8 0 0 1 13.6 0C18.8 14 16 17 12 21Z"/><circle cx="12" cy="10.5" r="2.3"/>',
  flame:   '<path d="M12.3 3.2c.8 2.9-3.8 4.6-3.8 9.1a5.5 5.5 0 0 0 11 0c0-2-.9-3.6-2-4.6-.2 1.4-.9 2.1-1.8 2.4.7-2.5-.6-5.6-3.4-6.9Z" fill="currentColor" stroke="none" transform="translate(-1.7 1)"/>',
  waves:   '<path d="M4 8.2c2.7-2.3 5.3 2.3 8 0s5.3 2.3 8 0M4 13c2.7-2.3 5.3 2.3 8 0s5.3 2.3 8 0M4 17.8c2.7-2.3 5.3 2.3 8 0s5.3 2.3 8 0"/>',
  layers:  '<path d="m12 3.8 8.2 4.4L12 12.6 3.8 8.2 12 3.8ZM4.6 12.4 12 16.4l7.4-4M4.6 16.4 12 20.4l7.4-4"/>',
  target:  '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  rotate:  '<path d="M19.2 12A7.2 7.2 0 1 1 17 6.9"/><path d="M19.6 3.4v4h-4"/>',
  link:    '<path d="M9.4 14.6 14.6 9.4M8.2 12 6 14.2a3.5 3.5 0 0 0 5 5l2.1-2.2M15.8 12 18 9.8a3.5 3.5 0 0 0-5-5l-2.1 2.2"/>',
  eye:     '<path d="M3.6 12S6.6 6.2 12 6.2 20.4 12 20.4 12 17.4 17.8 12 17.8 3.6 12 3.6 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  plus:    '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  moon:    '<path d="M19.6 13.8A7.8 7.8 0 1 1 10.2 4.4a6.4 6.4 0 0 0 9.4 9.4Z"/>',
  leaf:    '<path d="M5.4 18.6C6.3 9.4 12.7 4.9 19.6 4.9c0 6.9-4.5 13.3-13.7 14.2"/><path d="M5.4 18.6C8.3 14.3 12 11 16.4 8.6"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  external: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7.5A1.5 1.5 0 0 1 5.5 6H10"/>',
  logo: MARK_PATHS,
  trendUp: '<path d="M4 16.5 9.5 11l3.5 3.5L20 7.5"/><path d="M14.5 7.5H20V13"/>',
  warn:    '<path d="M12 4.4 3.4 19h17.2L12 4.4Z"/><path d="M12 10.2v3.6"/><circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none"/>',
  info:    '<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
  checkC:  '<circle cx="12" cy="12" r="8.2"/><path d="m8.4 12.2 2.4 2.4 4.8-5.2"/>',
  check:   '<path d="m5 12.6 4.4 4.4L19 7.4"/>',
  x:       '<path d="m6 6 12 12M18 6 6 18"/>',
  spark:   '<path d="M12 3.2l1.9 6.3 6.3 1.9-6.3 1.9L12 19.6l-1.9-6.3-6.3-1.9 6.3-1.9L12 3.2Z" fill="currentColor" stroke="none"/>',
  sliders: '<path d="M4 7.3h16M4 12h16M4 16.7h16"/><circle cx="9" cy="7.3" r="2.1" style="fill:var(--knock)"/><circle cx="15.5" cy="12" r="2.1" style="fill:var(--knock)"/><circle cx="7.5" cy="16.7" r="2.1" style="fill:var(--knock)"/>',
  csv:     '<path d="M7 3.6h6.3L17.8 8v10.8a1.8 1.8 0 0 1-1.8 1.8H7a1.8 1.8 0 0 1-1.8-1.8V5.4A1.8 1.8 0 0 1 7 3.6Z"/><path d="M13.2 3.8V8h4.4"/><path d="M12 11v6M9.2 14.2 12 17l2.8-2.8"/>'
};
function ic(name, size, style){
  const p = IC[name] || IC.info;
  return `<svg class="ic" width="${size||18}" height="${size||18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${style ? ` style="${style}"` : ''} aria-hidden="true">${p}</svg>`;
}

/* ============================================================
   1. CORE CONSTANTS
   ============================================================ */

// Base location: Irish national average (Dublin lat/lon, PVGIS-aligned GHI)

// Irish regions with GHI multipliers calibrated to PVGIS county-level data.
// Variation across Ireland is real: south coast gets ~10-12% more sun than northwest.
// Ordered North → South so the selectable tiles read in the same direction as
// the map (North-West top, South Coast bottom).
const IRISH_REGIONS = {
  northwest: {
    name: 'North-West',
    counties: 'Donegal · Sligo · Leitrim · Cavan · Monaghan',
    ghi_multiplier: 0.94,
    lat: 54.6,
    temp_offset: -1.5,
    icon: ''
  },
  west: {
    name: 'West Coast',
    counties: 'Galway · Clare · Limerick · Mayo · Roscommon',
    ghi_multiplier: 0.96,
    lat: 53.2,
    temp_offset: -0.2,
    icon: ''
  },
  east: {
    name: 'East / Dublin',
    counties: 'Dublin · Kildare · Meath · Louth',
    ghi_multiplier: 1.00,
    lat: 53.35,
    temp_offset: 0,
    icon: ''
  },
  midlands: {
    name: 'Midlands',
    counties: 'Laois · Offaly · Westmeath · Longford',
    ghi_multiplier: 0.98,
    lat: 53.4,
    temp_offset: -0.4,
    icon: ''
  },
  southeast: {
    name: 'South-East',
    counties: 'Wicklow · Carlow · Kilkenny · Tipperary',
    ghi_multiplier: 1.03,
    lat: 52.6,
    temp_offset: 0.5,
    icon: ''
  },
  south: {
    name: 'South Coast',
    counties: 'Cork · Kerry · Waterford · Wexford',
    ghi_multiplier: 1.06,
    lat: 51.9,
    temp_offset: 1.2,
    icon: ic('sun',16)
  }
};

// LOCATION is mutated by applyRegion() whenever state.region changes.
// Engine functions (buildHourlyGHI, buildPOA, buildPVGeneration) read from this directly.
const LOCATION = {
  name: 'East / Dublin',
  lat: LOCATION_BASE.lat,
  lon: LOCATION_BASE.lon,
  ghi_kwh_m2_day: LOCATION_BASE.ghi_kwh_m2_day.slice(),
  kt: LOCATION_BASE.kt.slice(),
  temp_c: LOCATION_BASE.temp_c.slice()
};

/* ---------------------------------------------------------------
 * Adapters between the app's mutable globals and the pure engine.
 *
 * The engine functions take their inputs explicitly. These thin wrappers
 * supply the values the app happens to keep in `state`, `LOCATION` and
 * `CACHE`, so call sites are unchanged while the maths itself is testable.
 * They shrink as later phases introduce a real state boundary.
 * --------------------------------------------------------------- */

/** LOCATION mutated by applyRegion(), shaped for the engine. */
function currentLocation(){
  return { lat: LOCATION.lat, lon: LOCATION.lon,
           ghi_kwh_m2_day: LOCATION.ghi_kwh_m2_day, kt: LOCATION.kt, temp_c: LOCATION.temp_c };
}

function buildHourlyGHI(){
  const loc = currentLocation();
  // Scenario range (pessimist/optimist) overrides the regional multiplier.
  const o = state._ghi_override;
  if (o !== undefined && o !== null){
    const regionMult = (IRISH_REGIONS[state.region] || IRISH_REGIONS.east).ghi_multiplier || 1;
    const scale = o / regionMult;
    return buildHourlyGhi({ ...loc, ghi_kwh_m2_day: loc.ghi_kwh_m2_day.map(v => v * scale) });
  }
  return buildHourlyGhi(loc);
}

const buildPOA = (azimuthDeg, tiltDeg, ghi) => buildPoa(azimuthDeg, tiltDeg, ghi, currentLocation());

const buildPVGeneration = (poa, countPanels, panelW, sysLoss, inverterKw) =>
  buildPvGeneration(poa, { countPanels, panelW, sysLoss, inverterKw }, currentLocation());

const calcNPV20 = (annualBenefit, sysCostNet, batteryKwh, panelDegradation, discountRate) =>
  engineNpv20({ annualBenefit, sysCostNet, batteryKwh,
                panelDegradation: panelDegradation ?? undefined,
                discountRate: discountRate ?? undefined });

/** Dynamic plans price against the cached wholesale curve. */
const rateAt = (hour, plan, hourIdx) => engineRateAt(hour, plan, hourIdx, CACHE.wholesale);
const simulateBaseline = (plan, cons) => engineSimulateBaseline(plan, cons, CACHE.wholesale);

function applyRegion(regionId){
  const region = IRISH_REGIONS[regionId] || IRISH_REGIONS.east;
  LOCATION.name = region.name;
  LOCATION.lat = region.lat;
  LOCATION.lon = LOCATION_BASE.lon;
  LOCATION.ghi_kwh_m2_day = LOCATION_BASE.ghi_kwh_m2_day.map(v => v * region.ghi_multiplier);
  LOCATION.kt = LOCATION_BASE.kt.slice();
  LOCATION.temp_c = LOCATION_BASE.temp_c.map(v => v + (region.temp_offset || 0));
}

// SEMOpx day-ahead market typical profile, Ireland 2025-26 (incl VAT, pre-cap)
// Monthly mean wholesale price €/kWh — calibrated to actual market data
const WHOLESALE_MONTHLY_BASE = [
  0.150, 0.130, 0.105, 0.085, 0.075, 0.070,   // Jan-Jun
  0.070, 0.075, 0.090, 0.110, 0.135, 0.165    // Jul-Dec
];

// Hourly multiplier on monthly mean (typical Irish SMP shape)
// Low overnight (wind keeps running), morning ramp, midday lull, big 17-19h peak.
const WHOLESALE_HOURLY_MULT = [
  0.55, 0.50, 0.45, 0.42, 0.40, 0.45,    // 0-5am
  0.65, 0.85, 1.10, 1.05, 0.90, 0.85,    // 6-11am
  0.85, 0.80, 0.80, 0.85, 0.95, 1.35,    // 12-17h
  2.10, 1.95, 1.30, 1.00, 0.80, 0.65     // 18-23h
];
const WHOLESALE_NEG_FLOOR = -0.10;   // €/kWh — paid to consume during wind surplus

/* ============================================================
   2. STATE  (minimal — most fields auto-inferred from 3 inputs)
   ============================================================ */
const DEFAULT_STATE = {
  onboarding_complete: false,
  current_tab: 'dashboard',
  // From 3-step onboarding
  address: "",
  eircode: "",
  heating_type: "gas",         // gas | heatpump | storage | direct
  bimonthly_bill_eur: 200,     // user's average €/bimonth
  // Inferred (editable in Refine)
  bills: {},                   // 6 bimonthly kWh values — derived from €/bimonth + heating shape
  // System (defaults match engineering tool for output parity)
  panel_w: 460,
  panel_tech: "n_type",
  panel_degradation: 0.004,
  has_solar: false,            // user explicitly enabled solar modelling
  count_A: 10,                 // primary roof panel count
  azimuth_A: 180,              // primary roof orientation (180 = south)
  tilt_A: 30,                  // primary roof tilt
  count_B: 0,                  // second roof panel count (0 = single roof)
  azimuth_B: 270,              // second roof orientation
  tilt_B: 30,
  inverter_kw: 5.0,
  battery_kwh: 0,              // precise kWh (was tier-based, now numeric)
  battery_eff: 0.92,
  battery_min: 0.10,
  battery_max_cycles: 1.2,
  battery_charge_kw: 3.0,
  battery_discharge_kw: 5.0,
  export_enabled: true,
  export_limit_kw: 6.0,
  install_cost: 9500,
  grant_seai: 1800,
  // Set true once the user types their own grant/cost — auto-recalculation
  // then keeps its hands off until they edit the field again.
  grant_is_manual: false,
  cost_is_manual: false,
  // Profile
  ev_active: false,
  ev_km_per_year: 0,
  ev_kwh_per_100km: 17,
  ev_in_bill: false,            // true = the entered bill already includes EV charging
  simple_mode: true,            // collapsed view for non-power-users (user owns the car)
  ev_charger_kw: 7.0,
  ice_l_per_100km: 6.0,
  fuel_price: 1.83,
  hot_water_strategy: "smart",  // tool default — 15% of load shifted to 2-5am
  base_load_w: 220,
  // Strategy — defaults match engineering tool for output parity
  strategy_mode: "auto",           // each plan scored with whichever battery strategy suits it
  charge_from_grid: true,          // tool default; auto-disabled if battery_kwh == 0
  battery_max: 1.00,               // SoC ceiling fraction (tool uses this; default 100%)
  // Baseline plan (for "savings vs" comparison)
  baseline: "EI-24",
  // Plan the user has decided to go with, overriding the cheapest-first pick.
  // null = follow the ranking. Set, it replaces the recommendation everywhere:
  // result screen, solar economics, monitor, and the PDF report.
  chosen_plan: null,
  // % off unit rates on the CURRENT plan only — sign-up discount or legacy
  // rates. Standing charge stays full price (matches how Irish discounts work).
  baseline_discount_pct: 0,
  scenarios: [],            // saved configuration snapshots (Compare tab)
  _compare_sel: [],         // scenario ids currently ticked for comparison
  // Usage anchor: 'bill' (€/2mo, the default) or 'kwh' (yearly consumption —
  // ground truth from an annual statement or smart meter, no € inference).
  usage_input_mode: 'bill',
  annual_kwh: 0,
  // Region — drives PVGIS-calibrated GHI multipliers (south=+6%, NW=−6%)
  region: "east",
  // User-edited tariff rates (per-plan overrides). Empty by default; edits land here.
  // Shape: { 'EI-24': { rates: { day: 0.32 }, standing: 220, export_rate: 0.20 } }
  plan_overrides: {},
  // ── Companion layer (product-vision additions) ──
  theme: 'light',               // 'light' | 'dark' — appearance
  monitoring_on: true,          // Market Monitor active
  contract_end_date: "",        // ISO date string for renewal reminder
  solar_quotes: [],             // [{id, installer, price, kwp, battery}]
  switch_history: [],           // [{date, planId, planName, savings}] — retention ledger
  solar_is_estimate: false,     // true when system spec came from our defaults, not the user
  switched_to: null,            // id of plan the user marked as "switched to"
  switched_date: null,          // ISO date when they switched
  schema_version: 3             // bump + add a migrateState case when a field's MEANING changes
};

let state;
// Testing: open the app with ?fresh to start from the very beginning.
if (/[?&]fresh\b/.test(location.search)) {
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  history.replaceState(null, '', location.pathname);
}
try {
  const raw = localStorage.getItem("solarAppState_v2");
  state = raw ? JSON.parse(raw) : structuredClone(DEFAULT_STATE);
  state = deepMerge(structuredClone(DEFAULT_STATE), state);
  // First visit only: honour the device's OS dark/light preference as the
  // starting theme. Once the user picks a theme themselves it's saved and wins.
  if (!raw){
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches){
        state.theme = 'dark';
      }
    } catch(e){}
  }
  // Migration: users who declared an owned EV before ev_in_bill existed — their
  // entered bill includes the car's charging, so carve it out of the base load
  if (state.ev_active && raw && JSON.parse(raw).ev_in_bill === undefined) state.ev_in_bill = true;
  // Versioned migrations — deepMerge already backfills NEW fields with defaults,
  // so this is only for cases where an EXISTING field's meaning/shape changes.
  if (raw) migrateState(JSON.parse(raw));
} catch(e){ state = structuredClone(DEFAULT_STATE); }

// Transform an older saved state to the current schema. Each case handles one
// version step; they run in order so a very old state migrates fully. Keep each
// step small and reversible-in-spirit. Bump DEFAULT_STATE.schema_version when
// you add a case here.
function migrateState(saved){
  try {
    let v = (saved && typeof saved.schema_version === 'number') ? saved.schema_version : 1;
    // v1 → v2: schema_version field introduced; nothing structural changed, so
    // just stamp the current version. (Future steps go here as: if (v < 3) {...} )
    if (v < 2){ v = 2; }
    // v2 → v3: the battery strategy was a single global switch, and it
    // was often "self-consume" only because a no-solar setup had reset it, so
    // homes that later modelled a battery were never scored with grid
    // charging. Automatic scores every plan with the strategy that suits it.
    if (v < 3){ state.strategy_mode = 'auto'; state.charge_from_grid = true; v = 3; }
    state.schema_version = Math.max(v, DEFAULT_STATE.schema_version);
  } catch(e){ /* leave state as merged defaults */ }
}

function deepMerge(target, source){
  if (typeof source !== "object" || source === null) return source;
  if (Array.isArray(source)) return source.slice();
  const out = {...target};
  for (const k in source){
    if (typeof source[k] === "object" && source[k] !== null && !Array.isArray(source[k]) && typeof target[k] === "object"){
      out[k] = deepMerge(target[k], source[k]);
    } else {
      out[k] = source[k];
    }
  }
  return out;
}
function saveState(){
  state._saved_at = Date.now();
  try { localStorage.setItem("solarAppState_v2", JSON.stringify(state)); } catch(e){}
  queueCloudSave();
}

/* ============================================================
   2b. WATCHING THE BATTERY STRATEGY
   ============================================================

   A user reports arbitrage switching itself off when they open the Solar tab,
   and back on when they open it again. Five separate attempts to reproduce it
   have failed: real clicks with real navigation and a reload; the arbitrage row
   watched across repeated screen changes and a report; a fuzzer over 230
   controls on 12 screens; the customise screen's own Solar section toggled five
   times; and a sweep of 144 different homes. All stable, on the same build the
   phone is running.

   So stop guessing at the state and record it. Every write to the three fields
   that decide whether arbitrage is in force is captured with a stack, and the
   last few are shown at the bottom of More. When it next flips, the app can say
   what did it instead of me trying to imagine which two taps it was.

   Deliberately small and always on: a bug that only appears on someone else's
   device is not one you can instrument on demand.
   ============================================================ */

const STRATEGY_TRACE = [];
function traceStrategy(){
  try {
    const watched = ['strategy_mode', 'charge_from_grid', 'battery_kwh'];
    let last = {};
    const record = (key, from, to) => {
      // Inside a declared hypothetical the engine sets these on purpose and
      // puts them back; recording that churn fills the buffer with the twelve
      // designs of the sweep and pushes the one interesting line off the end.
      if (_scenarioDepth > 0) return;
      const where = (new Error().stack || '').split('\n').slice(3, 6)
        .map(l => l.trim().replace(/^at\s+/, '').split(' ')[0])
        .filter(Boolean).join(' <- ');
      STRATEGY_TRACE.push({
        t: new Date().toLocaleTimeString(),
        screen: state.current_screen,
        change: `${key}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`,
        where: where.slice(0, 120),
      });
      while (STRATEGY_TRACE.length > 40) STRATEGY_TRACE.shift();
    };
    watched.forEach((k) => {
      last[k] = state[k];
      let v = state[k];
      Object.defineProperty(state, k, {
        configurable: true,
        enumerable: true,
        get(){ return v; },
        set(nv){ if (nv !== v) record(k, v, nv); v = nv; },
      });
    });
  } catch (e) { /* tracing must never break the app */ }
}

/* ============================================================
   3. SOLAR PHYSICS — verbatim from main engine, adapted for
   single-roof simplified state. NOAA solar position + Erbs
   diffuse split + isotropic POA + NOCT temperature derate.
   ============================================================ */

// Erbs model — diffuse fraction from monthly clearness index

function buildSolar(){
  const ghi = buildHourlyGHI();
  // has_solar gates generation: panel config is preserved in state so users can
  // toggle solar back on without re-entering it, but a "no solar" home must
  // simulate ZERO generation — otherwise default panel counts leak phantom
  // solar savings into no-solar results.
  const nA = state.has_solar ? (state.count_A || 0) : 0;
  const nB = state.has_solar ? (state.count_B || 0) : 0;
  // Match the engineering tool's behavior: clip per-array at the inverter limit.
  // Less accurate than combined clipping but matches the original engine.
  const poaA = buildPOA(state.azimuth_A, state.tilt_A, ghi);
  const invKw = state.inverter_kw || 5.0;
  const genA = buildPVGeneration(poaA, nA, state.panel_w, 0.86, invKw);

  // Roof B — only compute if panels present, to save cycles
  let poaB = null, genB = null;
  if (nB > 0){
    poaB = buildPOA(state.azimuth_B, state.tilt_B, ghi);
    genB = buildPVGeneration(poaB, nB, state.panel_w, 0.86, invKw);
  }

  const total = new Float32Array(HOURS_IN_YEAR);
  for (let i=0;i<HOURS_IN_YEAR;i++){
    total[i] = genA[i] + (genB ? genB[i] : 0);
  }
  return { ghi, poaA, poaB, genA, genB, total };
}

// Helper functions for total panel count and total kWp
function totalPanels(){ return (state.count_A || 0) + (state.count_B || 0); }
function totalKwp(){ return totalPanels() * state.panel_w / 1000; }

/* ============================================================
   4. CONSUMPTION SHAPES & BUILDER
   Heating-type-driven hourly load profiles.
   ============================================================ */
const BIMONTHLY = [
  {key:"Jan-Feb", months:[0,1]},
  {key:"Mar-Apr", months:[2,3]},
  {key:"May-Jun", months:[4,5]},
  {key:"Jul-Aug", months:[6,7]},
  {key:"Sep-Oct", months:[8,9]},
  {key:"Nov-Dec", months:[10,11]}
];

function bimonthlyFor(month){
  for (const b of BIMONTHLY) if (b.months.includes(month)) return b;
  return BIMONTHLY[0];
}

// Heating shape arrays — verified against real Irish load profiles.
// 24 hourly relative factors, scaled to match daily total kWh.
// Imported from solar_tool.html for engine parity.

// Heat pump: low-but-not-zero overnight (cycling), broad daytime, evening peak.
const SHAPE_HEATPUMP_WINTER = [
  0.85,0.80,0.75,0.75,0.80,0.95, 1.15,1.40,1.30,1.05,0.90,0.85,
  0.90,0.95,1.05,1.20,1.45,1.85, 1.95,1.55,1.25,1.10,0.95,0.85
];
const SHAPE_HEATPUMP_SUMMER = [
  0.55,0.50,0.45,0.45,0.50,0.65, 0.90,1.10,1.00,0.85,0.75,0.75,
  0.80,0.85,0.90,1.00,1.25,1.65, 1.80,1.40,1.10,0.95,0.80,0.65
];
// Gas/oil boiler house: small morning peak (kettle/toaster/shower only),
// flat low daytime when out, big sustained evening peak (oven, dryer, lights, TV).
const SHAPE_GAS_WINTER = [
  0.25,0.22,0.22,0.22,0.25,0.35, 0.55,0.85,0.70,0.50,0.45,0.50,
  0.55,0.60,0.70,0.90,1.45,2.20, 2.45,2.10,1.65,1.15,0.70,0.40
];
const SHAPE_GAS_SUMMER = [
  0.30,0.25,0.25,0.25,0.30,0.40, 0.60,0.85,0.70,0.50,0.45,0.45,
  0.50,0.55,0.60,0.70,1.00,1.50, 1.85,1.65,1.30,0.95,0.60,0.40
];
// Night-storage heaters (legacy NightSaver): massive 23:00-05:00 charging load.
const SHAPE_STORAGE_WINTER = [
  2.30,2.30,2.30,2.30,2.30,2.20, 1.80,0.90,0.55,0.45,0.40,0.40,
  0.45,0.50,0.55,0.60,0.85,1.20, 1.40,1.10,0.85,0.70,1.50,2.10
];
const SHAPE_STORAGE_SUMMER = [
  0.55,0.50,0.50,0.50,0.55,0.65, 0.95,1.20,1.00,0.75,0.65,0.65,
  0.70,0.75,0.80,0.90,1.10,1.55, 1.70,1.40,1.15,0.95,0.75,0.60
];
// Direct electric: elevated overnight base + daytime use when at home.
const SHAPE_DIRECT_WINTER = [
  0.80,0.75,0.70,0.70,0.75,0.95, 1.30,1.55,1.25,0.95,0.85,0.85,
  0.90,0.95,1.05,1.20,1.55,2.00, 2.10,1.70,1.35,1.10,0.95,0.85
];
const SHAPE_DIRECT_SUMMER = [
  0.40,0.35,0.35,0.35,0.40,0.55, 0.85,1.10,1.00,0.85,0.75,0.75,
  0.80,0.85,0.90,1.00,1.25,1.70, 1.85,1.45,1.15,0.95,0.75,0.55
];

// Returns the hourly shape for a given month (0-11). Matches engineering tool exactly.
// Shoulder seasons (Mar/Apr/Sep/Oct) average winter + summer for smooth transition.
// Hot water strategy shifts ~15% of daily load between morning/evening peaks (legacy)
// and the 2-5am window (smart). Optional 4-bucket user override reshapes the curve.
function getShape(month){
  // 1) Base shape by heating type — with shoulder season averaging
  const heatingType = state.heating_type || 'gas';
  const isWinter = [10,11,0,1,2].includes(month);
  const isSummer = [5,6,7].includes(month);

  function pickShape(winterArr, summerArr){
    if (isWinter) return [...winterArr];
    if (isSummer) return [...summerArr];
    return winterArr.map((v,i) => (v + summerArr[i]) / 2);  // shoulder = average
  }

  let base;
  switch (heatingType){
    case "heatpump":
      base = pickShape(SHAPE_HEATPUMP_WINTER, SHAPE_HEATPUMP_SUMMER); break;
    case "storage":
      base = pickShape(SHAPE_STORAGE_WINTER, SHAPE_STORAGE_SUMMER); break;
    case "direct":
      base = pickShape(SHAPE_DIRECT_WINTER, SHAPE_DIRECT_SUMMER); break;
    case "gas":
    case "oil":
    case "none":
    default:
      base = pickShape(SHAPE_GAS_WINTER, SHAPE_GAS_SUMMER); break;
  }

  // 2) Hot water strategy
  // - "smart" shifts 15% of daily load from morning/evening peaks → 2-5am
  // - "legacy" boosts evening peaks 10% (immersion on timer at peak times)
  // - "none" no change
  if (state.hot_water_strategy === "smart"){
    const baseSum = base.reduce((a,b)=>a+b, 0);
    const shiftFrac = 0.15;
    const shiftAmount = baseSum * shiftFrac;
    const removeHours = [7, 8, 17, 18, 19];
    const addHours = [2, 3, 4];
    const perRemove = shiftAmount / removeHours.length;
    const perAdd = shiftAmount / addHours.length;
    for (const h of removeHours) base[h] = Math.max(0.30, base[h] - perRemove);
    for (const h of addHours) base[h] += perAdd;
  } else if (state.hot_water_strategy === "legacy"){
    const peakHours = [7, 8, 17, 18, 19];
    for (const h of peakHours) base[h] *= 1.10;
  }

  // 3) Legacy `ev` flag (the actual EV kWh is layered on separately in buildConsumption)
  if (state.ev){
    const evHours = [2, 3, 4, 5];
    const baseSum = base.reduce((a,b)=>a+b, 0);
    const evBump = baseSum * 0.25;
    const perEvHour = evBump / evHours.length;
    for (const h of evHours) base[h] += perEvHour;
  }

  // 4) User override: 4-bucket reshaping from advanced consumption editor
  const buckets = state._shape_buckets;
  if (buckets){
    const sum = (buckets.night||0) + (buckets.morning||0) + (buckets.day||0) + (buckets.evening||0);
    if (sum >= 90 && sum <= 110){
      const bucketHours = {
        night:   [22,23,0,1,2,3,4,5],
        morning: [6,7,8,9],
        day:     [10,11,12,13,14,15,16],
        evening: [17,18,19,20,21]
      };
      const newBase = new Array(24).fill(0);
      Object.entries(bucketHours).forEach(([k, hrs]) => {
        const pct = (buckets[k] || 0) / sum;
        const perHour = pct / hrs.length;
        hrs.forEach(h => { newBase[h] = perHour * 24; });
      });
      return newBase;
    }
  }

  return base;
}

/* ------------------------------------------------------------
   buildConsumption — matches engineering tool's algorithm:
   - Uses bimonthlyFor() for precise month → bimonth mapping
   - Weekend factor (1.08 vs 0.985 weekday)
   - Rebalance step to ensure annual total = sum of bills exactly
   - EV smearing: 2-5am up to charger limit, overflow to 6-10am
   ------------------------------------------------------------ */
function buildConsumption(){
  // Build "without EV" array first (the user's CURRENT actual usage from bills)
  const consNoEv = new Float32Array(HOURS_IN_YEAR);
  let hourIdx = 0;

  // If user imported a smart meter CSV, we have a real 24-hour load shape.
  // Blend it 70/30 with the heating-type shape so seasonal variation is preserved.
  const csvShape = state._csv_hourly_shape;  // 24-element normalized array or null

  for (let m=0; m<12; m++){
    const bi = bimonthlyFor(m);
    // Days in this month / total days in this bimonth = month's share of bimonth
    const monthShare = DAYS_IN_MONTH[m] / (DAYS_IN_MONTH[bi.months[0]] + DAYS_IN_MONTH[bi.months[1]]);
    const monthKwh = (state.bills[bi.key] || 0) * monthShare;
    const dailyKwh = monthKwh / DAYS_IN_MONTH[m];
    const heatingShape = getShape(m);
    const heatingSum = heatingShape.reduce((a,b)=>a+b, 0);

    // Merge: if CSV shape available, blend 70% CSV + 30% heating-type
    let shape, shapeSum;
    if (csvShape && csvShape.length === 24){
      shape = new Array(24);
      const csvSum = csvShape.reduce((a,b)=>a+b, 0);
      for (let h=0; h<24; h++){
        const csvFrac   = csvShape[h]   / csvSum;
        const heatFrac  = heatingShape[h] / heatingSum;
        shape[h] = 0.70 * csvFrac + 0.30 * heatFrac;
      }
      shapeSum = shape.reduce((a,b)=>a+b, 0);
    } else {
      shape = heatingShape;
      shapeSum = heatingSum;
    }

    for (let d=0; d<DAYS_IN_MONTH[m]; d++){
      // Day-of-week — 1 Jan 2025 was Wed (day 3 from Sunday=0). dow = (doy + 4) % 7
      const dow = (dayOfYear(m,d+1) + 4) % 7;
      const weekendFactor = (dow >= 5) ? 1.08 : 0.985;  // weekends consume ~10% more
      for (let h=0; h<24; h++){
        const frac = shape[h] / shapeSum;
        consNoEv[hourIdx++] = dailyKwh * frac * weekendFactor;
      }
    }
  }
  // Rebalance to exact annual total from bills (handles rounding + weekend factor drift)
  const total = consNoEv.reduce((a,b)=>a+b, 0);
  const targetTotal = Object.values(state.bills).reduce((a,b)=>a+b, 0);
  if (total > 0){
    const k = targetTotal / total;
    for (let i=0;i<HOURS_IN_YEAR;i++) consNoEv[i] *= k;
  }

  // EV-in-bill carve-out: if the user's entered bill already includes their EV
  // charging (they own the car today), the bill-implied kWh contains the car —
  // remove its kWh from the base household load before (re)adding it as a
  // shaped night load. Without this the car is counted twice.
  const evConfKwh = (+state.ev_km_per_year || 0) * (+state.ev_kwh_per_100km || 17) / 100;
  if (state.ev_in_bill && evConfKwh > 0){
    let _tot = 0; for (let i=0;i<HOURS_IN_YEAR;i++) _tot += consNoEv[i];
    const _f = _tot > 0 ? Math.max(0.25, (_tot - evConfKwh) / _tot) : 1;
    for (let i=0;i<HOURS_IN_YEAR;i++) consNoEv[i] *= _f;
  }

  // Build "with EV" array
  const cons = new Float32Array(HOURS_IN_YEAR);
  for (let i=0;i<HOURS_IN_YEAR;i++) cons[i] = consNoEv[i];

  const evKmPerYear = state.ev_active ? (+state.ev_km_per_year || 0) : 0;
  const evKwhPer100 = +state.ev_kwh_per_100km || 17;
  const evAnnual = evKmPerYear * evKwhPer100 / 100;
  if (evAnnual > 0){
    const chargerKw = +state.ev_charger_kw || 7;
    const dailyEvKwh = evAnnual / 365;
    const nightCapacityKwh = chargerKw * 3;
    const nightKwh = Math.min(dailyEvKwh, nightCapacityKwh);
    const overflowKwh = Math.max(0, dailyEvKwh - nightCapacityKwh);
    const nightPerHour = nightKwh / 3;
    const dayPerHour = overflowKwh / 4;
    for (let i=0; i<HOURS_IN_YEAR; i++){
      const h = i % 24;
      if (h >= 2 && h < 5) cons[i] += nightPerHour;
      else if (h >= 6 && h < 10 && overflowKwh > 0) cons[i] += dayPerHour;
    }
  }
  return { cons, consNoEv };
}

/* ============================================================
   5. WHOLESALE — synthetic SEMOpx-tracking curve with NEGATIVE
   prices permitted (dynamic-tariff customers paid to consume
   during wind-surplus periods). Floor at -€0.10/kWh.
   ============================================================ */
function buildWholesale(){
  const prices = new Float32Array(HOURS_IN_YEAR);
  let h = 0;
  for (let m=0; m<12; m++){
    const monthBase = WHOLESALE_MONTHLY_BASE[m];
    for (let d=0; d<DAYS_IN_MONTH[m]; d++){
      // Deterministic daily variance (no random noise — results are stable)
      const dailyVar = 0.78 + 0.44 * Math.sin(d * 2.347 + m * 1.831 + 0.5);
      for (let hr=0; hr<24; hr++){
        let p = monthBase * WHOLESALE_HOURLY_MULT[hr] * dailyVar;
        if (p > WHOLESALE_CAP) p = WHOLESALE_CAP;
        if (p < WHOLESALE_NEG_FLOOR) p = WHOLESALE_NEG_FLOOR;
        prices[h++] = p;
      }
    }
  }
  return prices;
}

/* ============================================================
   6. TARIFF REGISTRY
   Curated subset of Irish residential plans (verified incl-VAT,
   June 2026). Includes one dynamic-tariff plan per CRU mandate.
   ============================================================ */
const EMBEDDED_TARIFFS = [
  {"id": "EI-24", "supplier": "Electric Ireland", "plan": "Home Electric+ Saver 16%", "type": "flat", "rates": {"day": 0.313, "night": 0.313, "peak": 0.313, "ev": 0.313}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Saver 16%", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Saver 16%"]}}, "notes": "Smart meter, 24-hour rate, 16% off unit rates for 12 months, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 30.0},
  {"id": "EI-SST", "supplier": "Electric Ireland", "plan": "Home Electric + SST Saver 16%", "type": "tou", "rates": {"day": 0.3405, "night": 0.1789, "peak": 0.3633, "ev": 0.1789}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric + SST Saver 16%", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00", "peak": "Peak: 17.00 - 19.00"}, "also": ["Home Electric SST Saver 16%"], "read": "2026-10-03"}, "notes": "Smart meter day/night/peak, 16% off unit rates for 12 months, new customers. Also listed, at the same rates, as 'Home Electric SST Saver 16%'. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-NB", "supplier": "Electric Ireland", "plan": "Home Electric+ Night Boost", "type": "ev", "rates": {"day": 0.376, "night": 0.1854, "ev": 0.1088}, "windows": {"night": [23, 8], "ev": [2, 4]}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Night Boost", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00", "ev": "Night Boost: 02.00 - 04.00"}, "read": "2026-10-03"}, "notes": "Smart meter; Night Boost 02:00-04:00, 5.5% off unit rates, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-NS", "supplier": "Electric Ireland", "plan": "Energysaver Nightsaver 16%", "type": "tou", "rates": {"day": 0.3412, "night": 0.1683}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver Nightsaver 16%", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver Nightsaver 16%"]}}, "notes": "Day & night (non-smart) meter, 16% off for 12 months. Nightsaver urban standing €328.58 not printed on the card; carried from the last full price list. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 20.0},
  {"id": "EI-ES", "supplier": "Electric Ireland", "plan": "Energysaver 16%", "type": "flat", "rates": {"day": 0.3195, "night": 0.3195, "peak": 0.3195, "ev": 0.3195}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver 16%", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver 16%"]}}, "notes": "Standard (non-smart) 24-hour meter, 16% off unit rates for 12 months, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 20.0},
  {"id": "EI-GREEN", "supplier": "Electric Ireland", "plan": "Green Electricity", "type": "flat", "rates": {"day": 0.3613, "night": 0.3613, "peak": 0.3613, "ev": 0.3613}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Green Electricity", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03"}, "notes": "Standard meter, 100% green electricity, 5.5% off unit rates. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-GREEN-NS", "supplier": "Electric Ireland", "plan": "Green Electricity NightSaver", "type": "tou", "rates": {"day": 0.3862, "night": 0.1915}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Green Electricity NightSaver", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00"}, "read": "2026-10-03"}, "notes": "Day & night meter, 100% green electricity, 5.5% off. Nightsaver standing carried from the last full price list. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-WKND", "supplier": "Electric Ireland", "plan": "Home Electric+ Weekender", "type": "flat", "rates": {"day": 0.3865, "night": 0.3865, "peak": 0.3865, "ev": 0.3865}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Weekender", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03"}, "notes": "Smart meter, one flat rate, and free electricity 08:00-23:00 on Saturday or Sunday (the customer picks; modelled as Saturday). Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "weekend": {"days": [5], "window": [8, 23], "rates": {"day": 0, "night": 0, "peak": 0, "ev": 0}}},
  {"id": "EI-DYN", "supplier": "Electric Ireland", "plan": "Dynamic Price Plan", "type": "dynamic", "rates": {"day": 0.1981, "night": 0.0852, "peak": 0.2255, "ev": 0.0852}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-06-02", "notes": "Not in Electric Ireland's new-customer plan list on 30 Sep 2026, and its rates are not published there; held back rather than shown with unconfirmed figures.", "discontinued": true},
  {"id": "BG-24", "supplier": "Bord Gáis Energy", "plan": "Smart All Day Electricity Discount", "type": "flat", "rates": {"day": 0.2995, "night": 0.2995, "peak": 0.2995, "ev": 0.2995}, "windows": {"ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart All Day Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day"}, "read": "2026-10-03"}, "notes": "Smart meter, one flat rate, 26% off unit rates for 12 months. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-TOU", "supplier": "Bord Gáis Energy", "plan": "Smart Standard Electricity Discount", "type": "tou", "rates": {"day": 0.32, "night": 0.2362, "peak": 0.3896, "ev": 0.2362}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Standard Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 26% off for 12 months. Peak 17:00-19:00 Monday to Friday only. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-TOU-PLUS", "supplier": "Bord Gáis Energy", "plan": "Smart Standard Plus Electricity Discount", "type": "tou", "rates": {"day": 0.32, "night": 0.2362, "peak": 0.3896, "ev": 0.2362}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Standard Plus Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Same rates as Smart Standard with the Spend Goal feature. Peak Monday to Friday only. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-EV", "supplier": "Bord Gáis Energy", "plan": "Smart EV Plus Electricity Discount", "type": "ev", "rates": {"day": 0.32, "night": 0.2419, "peak": 0.4083, "ev": 0.1252}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": [2, 5]}, "standing": 364.89, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart EV Plus Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night", "ev": "EV"}, "read": "2026-10-03"}, "notes": "Smart EV plan, 15% off for 12 months; EV time 02:00-05:00 every day, peak Monday to Friday (Smart EV tariff terms, Aug 2026). UNVERIFIED standing: €364.89 is the Smart EV plan's standing charge; the EV Plus card does not print one. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-WKND", "supplier": "Bord Gáis Energy", "plan": "Smart Weekend Electricity Discount", "type": "tou", "rates": {"day": 0.3152, "night": 0.2818, "peak": 0.3845, "ev": 0.2818}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Weekend Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Smart plan charged at the night rate all weekend, Friday 11pm to Monday 8am; 26% off for 12 months. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"span": [[4, 23], [0, 8]], "rates": {"day": 0.2818, "peak": 0.2818}, "same_as": {"day": "night", "peak": "night"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY", "supplier": "Bord Gáis Energy", "plan": "Standard Variable Smart All Day Electricity", "type": "flat", "rates": {"day": 0.4159, "night": 0.4159, "peak": 0.4159, "ev": 0.4159}, "windows": {"ev": null}, "standing": 244.77, "exit": 0, "length": 0, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Standard Variable Smart All Day Electricity", "Electricity unit rates"], "fields": {"day": "Day"}, "read": "2026-10-03"}, "notes": "No discount, no fixed term. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-DYN", "supplier": "Bord Gáis", "plan": "Smart Dynamic", "type": "dynamic", "rates": {"day": 0.1673, "night": 0.1673, "peak": 0.1673, "ev": 0.1673}, "windows": {"ev": null}, "standing": 331.96, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "notes": "★ NEW (1 June 2026). Single base rate 16.73c + half-hourly wholesale. No discount on base. Day-ahead prices at bordgaisenergy.ie/day-ahead-market-prices. UNVERIFIED since launch — the base rate is not published on the plan-comparison page and was not re-checked on 25 Aug 2026.", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Dynamic Electricity", "Electricity unit rates"], "fields": {"day": "Base"}, "read": "2026-10-03"}, "price_change": {"effective_date": "2026-10-09", "pct": 0.137, "standing_pct": 0.047, "direction": "increase", "source": "bordgaisenergy.ie/home/our-tariffs, Smart Dynamic table from 9 Oct 2026", "note": "Base rate 16.73c → 19.02c and standing €331.96 → €347.56 from 9 Oct 2026; the wholesale part is added hourly on top."}},
  {"id": "EN-SMART-24-HOUR", "supplier": "Energia", "plan": "Smart 24 Hour", "type": "flat", "rates": {"day": 0.281, "night": 0.281, "peak": 0.281, "ev": 0.281}, "windows": {"ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart 24 Hour"], "fields": {"day": "Smart meter"}, "read": "2026-10-03"}, "notes": "Smart meter flat rate, 30% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.04, "note": "28.10c → 29.22c from 12 Oct 2026."}},
  {"id": "EN-SMART", "supplier": "Energia", "plan": "Smart Data", "type": "tou", "rates": {"day": 0.3075, "night": 0.1691, "peak": 0.3454, "ev": 0.1691}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart Data"], "fields": {"night": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}, "peak": {"label": "Smart meter", "col": 3}}, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 27% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.03, "pct_bands": {"day": 0.03, "night": 0.28, "peak": 0.05, "ev": 0.28}, "note": "From 12 Oct 2026: day 30.75 → 31.68c, night 16.91 → 21.64c, peak 34.54 → 36.26c."}},
  {"id": "EN-SMART-DAY-NIGHT", "supplier": "Energia", "plan": "Smart Day/Night", "type": "tou", "rates": {"day": 0.3519, "night": 0.1734, "ev": 0.1734}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart Day/Night"], "fields": {"night": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}}, "read": "2026-10-03"}, "notes": "Smart day/night, no peak band, 20% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0, "pct_bands": {"day": 0, "night": 0.25, "ev": 0.25}, "note": "From 12 Oct 2026: night 17.34 → 21.67c, day unchanged."}},
  {"id": "EN-EV", "supplier": "Energia", "plan": "EV Smart Drive", "type": "ev", "rates": {"day": 0.4016, "night": 0.4016, "peak": 0.4016, "ev": 0.0942}, "windows": {"ev": [2, 6], "peak": null, "night": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "EV Smart Drive"], "fields": {"ev": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}}, "read": "2026-10-03"}, "notes": "Smart EV, charge window 02:00-06:00, 10% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0, "pct_bands": {"ev": 0.3}, "note": "From 12 Oct 2026: EV charge 9.42 → 12.25c, other hours unchanged."}},
  {"id": "EN-24", "supplier": "Energia", "plan": "Standard Electricity", "type": "flat", "rates": {"day": 0.2986, "night": 0.2986, "peak": 0.2986, "ev": 0.2986}, "windows": {"ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Standard Electricity"], "fields": {"day": "Standard 24hr meter"}, "read": "2026-10-03"}, "notes": "Standard (non-smart) 24-hour meter, 30% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.02, "note": "29.86c → 30.45c from 12 Oct 2026."}},
  {"id": "EN-DYN", "supplier": "Energia", "plan": "Dynamic Rates", "type": "dynamic", "rates": {"day": 0.2197, "night": 0.1251, "peak": 0.2292, "ev": 0.1251}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 299.75, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "notes": "Smart Track: base rates inc VAT from energia.ie/about-energia/our-tariffs (rates from 2 June 2026), plus the half-hourly wholesale price. Standing €299.75 urban.", "source": {"url": "https://www.energia.ie/about-energia/our-tariffs", "anchor": ["Dynamic Base Unit Rate Prices"], "fields": {"day": "Dynamic Day Base Unit Rate", "night": "Dynamic Night Base Unit Rate", "peak": "Dynamic Peak Base Unit Rate"}, "col": 1, "read": "2026-10-03"}},
  {"id": "EN-EV-PLUS", "supplier": "Energia", "plan": "EV Smart Drive Plus", "type": "ev", "rates": {"day": 0.3893, "night": 0.2399, "peak": 0.5108, "ev": 0.1103}, "windows": {"ev": [2, 6], "peak": [17, 19], "night": [23, 8]}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-06-02", "notes": "Not in Energia's new-customer plan table on 30 Sep 2026; still on its tariff list for existing customers.", "price_change": {"effective_date": "2026-10-12", "pct": 0.0, "pct_bands": {"day": 0.0, "night": 0.0, "peak": 0.0, "ev": 0.201}, "standing_pct": 0.28, "direction": "increase", "source": "Energia published tariff list effective 12 Oct 2026 (https://www.energia.ie/about-energia/our-tariffs)", "note": "Energia EV Smart Drive Plus from 12 Oct 2026: EV-window rate +20%, day/night/peak unchanged, standing charge +28%. From Energia's published price list."}, "discontinued": true},
  {"id": "SSE-EVDAY", "supplier": "SSE Airtricity", "plan": "Smart Everyday 30%", "type": "flat", "rates": {"day": 0.2879, "night": 0.2879, "peak": 0.2879, "ev": 0.2879}, "windows": {"ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-everyday-electricity-with-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "24hr meter", "standing": "Urban 24hr meter"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart meter flat rate, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-DNP", "supplier": "SSE Airtricity", "plan": "Smart Day/Night/Peak 30%", "type": "tou", "rates": {"day": 0.3047, "night": 0.1958, "peak": 0.3412, "ev": 0.1958}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-day-night-peak-electricity-with-top-discount", "anchor": ["Our electricity prices", "Electricity - Smart Meter"], "fields": {"day": "Smart Day", "night": "Smart Night", "peak": "Smart Peak", "standing": "Urban Smart"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-24", "supplier": "SSE Airtricity", "plan": "Home Electricity 30% (24hr)", "type": "flat", "rates": {"day": 0.2879, "night": 0.2879, "peak": 0.2879, "ev": 0.2879}, "windows": {"ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "24hr meter", "standing": "Urban 24hr"}, "col": 1, "read": "2026-10-03", "welcome": {"url": "https://www.sseairtricity.com/ie/home/help-centre/our-tariffs", "anchor": ["1 Year Electricity 30% plus"], "in": "html", "chars": 40}}, "notes": "Standard 24-hour meter, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "welcome_credit": 125.0},
  {"id": "SSE-NS", "supplier": "SSE Airtricity", "plan": "Home Electricity 30% (Nightsaver)", "type": "tou", "rates": {"day": 0.2917, "night": 0.1866}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 338.98, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "Night Saver meter (Day)", "night": "Night Saver meter (Night)", "standing": "Urban Night saver"}, "col": 1, "read": "2026-10-03", "welcome": {"url": "https://www.sseairtricity.com/ie/home/help-centre/our-tariffs", "anchor": ["1 Year Electricity 30% plus"], "in": "html", "chars": 40}}, "notes": "Day & night meter, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "welcome_credit": 125.0},
  {"id": "SSE-EVMAX", "supplier": "SSE Airtricity", "plan": "Smart EV Max", "type": "ev", "rates": {"day": 0.3858, "night": 0.3858, "peak": 0.3858, "ev": 0.1386}, "windows": {"ev": [23, 5], "peak": null, "night": null}, "standing": 357.23, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-smart-ev-max", "anchor": ["Our electricity prices"], "fields": {"day": "Smart EV Max 18 Hour", "ev": "Smart EV Max 6 Hour", "standing": "Urban Smart EV"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart EV: 6 cheap hours 23:00-05:00, 20% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-WKND", "supplier": "SSE Airtricity", "plan": "Smart Weekends", "type": "tou", "rates": {"day": 0.4033, "night": 0.2595, "peak": 0.4519, "ev": 0.2595}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 356.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-weekends-electricity", "anchor": ["Our electricity prices"], "fields": {"day": "Weekday Day", "night": "Weekday Night", "peak": "Weekday Peak", "weekend.day": "Weekend Day", "weekend.night": "Weekend Night", "weekend.peak": "Weekend Peak", "standing": "Urban Smart"}, "col": 1, "read": "2026-10-03"}, "notes": "Half-price electricity from 8am Saturday to 11pm Sunday; 15% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "weekend": {"span": [[5, 8], [6, 23]], "rates": {"day": 0.2017, "night": 0.1296, "peak": 0.2257}}},
  {"id": "YN-24", "supplier": "Yuno Energy", "plan": "Electricity Bonus 24hr", "type": "flat", "rates": {"day": 0.3485, "night": 0.3485, "peak": 0.3485, "ev": 0.3485}, "windows": {"ev": null}, "standing": 219.22, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus", "24hr Urban"], "fields": {"day": "24Hr Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03", "welcome": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus"], "within": 6}}, "notes": "24-hour meter, 12-month plan. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page).", "welcome_credit": 50.0},
  {"id": "YN-DN", "supplier": "Yuno Energy", "plan": "Electricity Bonus Day/Night", "type": "tou", "rates": {"day": 0.3812, "night": 0.2303}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 247.94, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus", "Day Night Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03", "welcome": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus"], "within": 6}}, "notes": "Day & night meter. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page).", "welcome_credit": 50.0},
  {"id": "YN-DNP", "supplier": "Yuno Energy", "plan": "Electricity Smart Bonus", "type": "tou", "rates": {"day": 0.3756, "night": 0.2298, "peak": 0.4076, "ev": 0.2298}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 235.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Smart Bonus", "Electricity Pricing", "Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "peak": "Peak Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "Smart day/night/peak (day 08-23, night 23-08, peak 17-19). Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "YN-EV", "supplier": "Yuno Energy", "plan": "EV Variable", "type": "ev", "rates": {"day": 0.367, "night": 0.367, "peak": 0.367, "ev": 0.1211}, "windows": {"ev": [2, 6], "peak": null, "night": null}, "standing": 334.19, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["EV Variable", "24hr Urban"], "fields": {"day": "24Hr Unit Rate", "ev": "EV 2am - 6am", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "24-hour rate with a 02:00-06:00 EV rate. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "YN-EV-DNP", "supplier": "Yuno Energy", "plan": "EV Variable Smart", "type": "ev", "rates": {"day": 0.4047, "night": 0.2146, "peak": 0.4538, "ev": 0.0859}, "windows": {"ev": [2, 6], "peak": [17, 19], "night": [23, 8]}, "standing": 358.07, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["EV Variable Smart", "DNP Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "peak": "Peak Unit Rate", "ev": "EV 2am - 6am", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "Smart day/night/peak with a 02:00-06:00 EV rate. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "FL-24", "supplier": "Flogas", "plan": "Smart 24hr 29%", "type": "flat", "rates": {"day": 0.2931, "night": 0.2931, "peak": 0.2931, "ev": 0.2931}, "windows": {"ev": null}, "standing": 300.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart 24Hr Electricity 29% Loyalty Discount", "fields": {"day": "24 hr unit rate", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": " Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-DNP", "supplier": "Flogas", "plan": "Smart Day/Night/Peak 29%", "type": "tou", "rates": {"day": 0.3194, "night": 0.2305, "peak": 0.3779, "ev": 0.2305}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 300.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart Electricity 29% Loyalty Discount", "fields": {"day": "day - 08:00", "night": "night - 23:00", "peak": "peak - 17:00", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": " Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-EV", "supplier": "Flogas", "plan": "Smart EV Night Charge 29%", "type": "ev", "rates": {"day": 0.3176, "night": 0.2466, "peak": 0.4095, "ev": 0.0996}, "windows": {"ev": [2, 5], "peak": [17, 19], "night": [23, 8]}, "standing": 387.16, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart EV Night Charge 29% Electricity Loyalty Discount", "fields": {"day": "day - 08:00", "night": "night - 23:00", "peak": "peak - 17:00", "ev": "ev night charge - 02:00", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": "EV Night Charge 02:00-05:00. Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-STD-24", "supplier": "Flogas", "plan": "Electricity 28% (24hr)", "type": "flat", "rates": {"day": 0.3168, "night": 0.3168, "peak": 0.3168, "ev": 0.3168}, "windows": {"ev": null}, "standing": 305.68, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Electricity 28% Loyalty Discount", "fields": {"day": "unit rate", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": "Standard (non-smart) 24-hour meter. Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "PIN-LF", "supplier": "Pinergy", "plan": "Lifestyle Standard Smart Tariff", "type": "tou", "rates": {"day": 0.458, "night": 0.3484, "peak": 0.4904, "ev": 0.3484}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Standard Smart Tariff"], "fields": {"day": "Day Unit Price", "night": "Night Unit Price", "peak": "Peak Unit Price", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": " Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check."},
  {"id": "PIN-WFH", "supplier": "Pinergy", "plan": "Lifestyle Working from Home Time", "type": "tou", "rates": {"day": 0.458, "wfh": 0.3206, "night": 0.458, "peak": 0.458, "ev": 0.458}, "windows": {"peak": null, "night": null, "ev": null, "wfh": [9, 17]}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Working from Home Time"], "fields": {"wfh": "Unit Price 9am to 5pm Weekdays", "day": "Unit Price All other times", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": "The 9am-5pm rate applies on weekdays only. Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check.", "weekend": {"days": [5, 6], "rates": {"wfh": 0.458}, "same_as": {"wfh": "day"}}},
  {"id": "PIN-FAM", "supplier": "Pinergy", "plan": "Lifestyle Family Time", "type": "tou", "rates": {"day": 0.458, "night": 0.2748, "peak": 0.458, "ev": 0.2748}, "windows": {"peak": null, "night": [19, 24], "ev": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Family Time"], "fields": {"night": "Unit Price 7pm to midnight", "day": "Unit Price All other times", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": "Cheap band 19:00-midnight every day. Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check."},
  {"id": "PIN-EV", "supplier": "Pinergy", "plan": "Lifestyle EV Night Time", "type": "ev", "rates": {"day": 0.4177, "night": 0.4177, "peak": 0.4177, "ev": 0.0599}, "windows": {"ev": [2, 5], "peak": null, "night": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "discontinued": true, "discontinued_date": "2026-05-21", "verified_date": "2026-09-15", "notes": "Pinergy: 'no longer on sale since 21 May 2026'."},
  {"id": "PPP-24", "supplier": "PrepayPower", "plan": "Standard 24 Hr (pay-as-you-go)", "type": "flat", "rates": {"day": 0.3762, "night": 0.3762, "peak": 0.3762, "ev": 0.3762}, "windows": {"ev": null}, "standing": 473.98, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Standard 24 Hr Urban"], "fields": {"day": {"label": "Standard Unit Rate", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-electricity", "anchor": [], "within": 400}}, "notes": "Early termination €11.25 per remaining month. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "PPP-NS", "supplier": "PrepayPower", "plan": "NightSaver (pay-as-you-go)", "type": "tou", "rates": {"day": 0.4206, "night": 0.2077}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 587.58, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Urban NightSaver"], "fields": {"day": {"label": "Standard Unit Rate Day", "col": 2}, "night": {"label": "Standard Unit Rate Night", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-electricity", "anchor": [], "within": 400}}, "notes": "Day & night meter. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "PPP-TOU", "supplier": "PrepayPower", "plan": "Smart Pay Day/Night/Peak (pay-as-you-go)", "type": "tou", "rates": {"day": 0.4165, "night": 0.216, "peak": 0.4681, "ev": 0.216}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 507.1, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Smart Pay Urban Day Night Peak"], "fields": {"day": {"label": "Unit Rate Day", "col": 2}, "night": {"label": "Unit Rate Night", "col": 2}, "peak": {"label": "Unit Rate Peak", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-smart-pay", "anchor": [], "within": 400}}, "notes": "Smart pay-as-you-go time of use. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "WP-24", "supplier": "Waterpower", "plan": "24 Hour (e-billing)", "type": "flat", "rates": {"day": 0.3142, "night": 0.3142, "peak": 0.3142, "ev": 0.3142}, "windows": {"ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Domestic 24 Hour Urban"], "fields": {"day": "Unit Rate c/kwh  (E-Bill Only)", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "WP-DN", "supplier": "Waterpower", "plan": "Day/Night (e-billing)", "type": "tou", "rates": {"day": 0.3296, "night": 0.2541}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Domestic Day/Night (E-Billing) Urban"], "fields": {"day": "Unit Day Rate", "night": "Unit Night Rate", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "WP-SST", "supplier": "Waterpower", "plan": "Smart Tariff (SST)", "type": "tou", "rates": {"day": 0.322, "night": 0.2284, "peak": 0.3658, "ev": 0.2284}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Waterpower Smart Tariff (SST) Urban"], "fields": {"day": "Unit Day Rate", "night": "Unit Night Rate", "peak": "Peak Rate", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "CP-24", "supplier": "Community Power", "plan": "Standard Variable 24hr", "type": "flat", "rates": {"day": 0.3996, "night": 0.3996, "peak": 0.3996, "ev": 0.3996}, "windows": {"ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Standard Variable Rate"], "fields": {"day": "24hr", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "CP-DN", "supplier": "Community Power", "plan": "Standard Variable Day/Night", "type": "tou", "rates": {"day": 0.4189, "night": 0.2564}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Standard Variable Rate"], "fields": {"day": "Day", "night": "Night", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "CP-SST", "supplier": "Community Power", "plan": "Smart SST", "type": "tou", "rates": {"day": 0.4189, "night": 0.2564, "peak": 0.4412, "ev": 0.2564}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Smart SST"], "fields": {"day": "Day", "night": "Night", "peak": "Peak", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "BG-SMART-ALL-DAY-ELECTRICITY", "supplier": "Bord Gáis", "plan": "Smart All Day Electricity", "type": "flat", "rates": {"day": 0.3161, "night": 0.3161, "peak": 0.3161, "ev": 0.3161}, "windows": {"ev": null}, "standing": 244.76, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-09-15", "notes": "Not in Bord Gáis's new-customer plan list on 30 Sep 2026.", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "Bord Gais price announcement, 9 Sep 2026", "note": "Bord Gais unit rates +9.1%, standing +7.2% from 9 Oct 2026."}, "discontinued": true},
  {"id": "BG-SMART-STANDARD-GREEN-ELECTRICITY-ONLY", "supplier": "Bord Gáis", "plan": "Smart Standard Green Electricity Only", "type": "tou", "rates": {"day": 0.3378, "night": 0.2493, "peak": 0.4112, "ev": 0.2493}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.76, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-09-15", "notes": "Not in Bord Gáis's new-customer plan list on 30 Sep 2026.", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "Bord Gais price announcement, 9 Sep 2026", "note": "Bord Gais unit rates +9.1%, standing +7.2% from 9 Oct 2026."}, "discontinued": true}
];

let TARIFFS = EMBEDDED_TARIFFS.slice();
let _tariffGen = 0;   // bumped whenever the price data is replaced

async function loadTariffs(){
  try {
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 3000) : null;
    // Cache-bust on the build id. `cache:no-cache` still revalidates against a
    // shared cache, and during the audit two browser contexts on the same build
    // disagreed about the rates — one had the current file, one a stale copy.
    // A returning user must never be advised from tariffs older than the ones
    // we shipped.
    const res = await fetch(`tariffs.json?v=${__BUILD_ID__}`, { cache:'no-cache', signal: ac ? ac.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty');
    const meta = data.find(t => t.id === '__meta__');
    if (meta) window._tariffsMeta = meta;
    const fetched = data.filter(t => t.id && t.id !== '__meta__' && t.supplier);

    // Only report a refresh when the rates actually differ from the ones
    // already loaded. This returned true on every successful fetch, so a normal
    // load — where the served file is byte-identical to the bundled one, which
    // is the overwhelmingly common case — still invalidated the whole cache and
    // repainted the entire screen a quarter-second after first paint, for no
    // change the reader could see.
    const changed = JSON.stringify(fetched) !== JSON.stringify(TARIFFS);
    TARIFFS = fetched; _tariffGen++;
    return changed;
  } catch(e){ return false; }
}

// Active (non-discontinued) tariffs sorted by company then plan name, for any
// user-facing plan picker. Keeps the engine's TARIFFS order untouched.
function activeTariffsSorted(){
  return TARIFFS.filter(t => !t.discontinued).slice().sort((a,b) => {
    const s = (a.supplier || '').localeCompare(b.supplier || '', 'en', { sensitivity:'base' });
    return s !== 0 ? s : (a.plan || '').localeCompare(b.plan || '', 'en', { sensitivity:'base' });
  });
}
function getPlanById(id){
  const base = TARIFFS.find(t => t.id === id);
  if (!base) return TARIFFS[0];
  const overrides = (state.plan_overrides || {})[id];
  if (!overrides) return base;
  // Merge user overrides on top of defaults so simulation uses edited rates
  return {
    ...base,
    rates: { ...base.rates, ...(overrides.rates || {}) },
    standing: overrides.standing !== undefined ? overrides.standing : base.standing,
    export_rate: overrides.export_rate !== undefined ? overrides.export_rate : base.export_rate,
    _is_edited: true
  };
}

// True if all band rates (day/night/peak/ev) are within 0.001c/kWh of each other

/* ============================================================
   7. SIMULATION ENGINE — hour-by-hour battery dispatch + costs
   ============================================================ */

function simulate(plan, gen, cons, strategy){
  const cap = state.battery_kwh || 0;          // usable kWh
  const minSoc = state.battery_min * cap;
  const maxSoc = (state.battery_max || 1.0) * cap;
  const eff = Math.sqrt(state.battery_eff); // applied each way
  const maxChargeKw = 5.0;                       // typical hybrid inverter limit
  const maxDischargeKw = 5.0;
  const isDynamic = plan.type === "dynamic";

  // For dynamic tariffs: pre-compute effective rates for the year
  let effRates = null;
  if (isDynamic){
    effRates = new Float32Array(HOURS_IN_YEAR);
    for (let i=0; i<HOURS_IN_YEAR; i++){
      const hour = i % 24;
      effRates[i] = rateAt(hour, plan, i);
    }
  }

  // Hourly outputs
  const out = {
    gen: gen,
    cons: cons,
    soc: new Float32Array(HOURS_IN_YEAR+1),
    grid_import: new Float32Array(HOURS_IN_YEAR),
    grid_export: new Float32Array(HOURS_IN_YEAR),
    battery_charge: new Float32Array(HOURS_IN_YEAR),  // kWh into battery
    battery_discharge: new Float32Array(HOURS_IN_YEAR), // kWh out of battery
    self_use: new Float32Array(HOURS_IN_YEAR),       // solar used directly
    curtailed: new Float32Array(HOURS_IN_YEAR),      // solar wasted due to export disabled / limit reached
    cost: new Float32Array(HOURS_IN_YEAR),
    revenue: new Float32Array(HOURS_IN_YEAR),
    band: new Array(HOURS_IN_YEAR),
    eff_rate: effRates,                              // hourly effective rates (dynamic only)
    plan_id: plan.id
  };

  let soc = minSoc + 0.3*(cap - minSoc); // start at 30% above min
  const exportRate = plan.export_rate;
  const peakRate = plan.rates.peak;
  const evRate = plan.windows.ev ? plan.rates.ev : null;

  // Export hardware constraints — if disabled, surplus is curtailed (clipped, not earned)
  const exportEnabled = state.export_enabled !== false;
  const exportLimit = exportEnabled ? (state.export_limit_kw || 999) : 0;

  for (let i=0; i<HOURS_IN_YEAR; i++){
    out.soc[i] = soc;
    const hour = i % 24;
    const g = gen[i];
    const c = cons[i];
    const band = bandAt(hour, plan);
    out.band[i] = band;
    const rate = isDynamic ? effRates[i] : staticRateAt(i, plan, band);

    // For dynamic, determine if THIS hour is cheap vs the surrounding 24h
    let isCheapDynamic = false, isExpensiveDynamic = false, dailyAvg = 0;
    if (isDynamic){
      let sum = 0, n = 0;
      for (let k=0; k<24 && i+k<HOURS_IN_YEAR; k++){ sum += effRates[i+k]; n++; }
      dailyAvg = n > 0 ? sum/n : rate;
      isCheapDynamic = rate < dailyAvg * 0.65;
      isExpensiveDynamic = rate > dailyAvg * 1.40;
    }

    let netSolarAfterLoad = g - c;   // positive = surplus, negative = deficit
    let directSelfUse = Math.min(g, c);
    out.self_use[i] = directSelfUse;

    let charge = 0, discharge = 0, imp = 0, exp = 0;

    // === Strategy logic ===
    let curtailed = 0;
    if (netSolarAfterLoad > 0){
      // Solar surplus. Decide: store in battery vs export.
      const headroom = maxSoc - soc;
      const canStore = Math.min(headroom / eff, maxChargeKw, netSolarAfterLoad);
      // If export rate > expected discharge value AND export is enabled, prefer export
      const expectedDischargeValue = isDynamic ? dailyAvg * 1.5 : peakRate;
      if (exportEnabled && exportRate * 1.0 > expectedDischargeValue * eff * eff){
        exp = netSolarAfterLoad;
      } else {
        charge = canStore;
        soc += charge * eff;
        const leftover = netSolarAfterLoad - charge;
        exp = Math.max(0, leftover);
      }
      // Apply hardware constraint: cap export at limit (excess is curtailed, lost)
      if (exp > exportLimit){
        curtailed = exp - exportLimit;
        exp = exportLimit;
      }
      out.curtailed[i] = curtailed;
    } else if (netSolarAfterLoad < 0){
      // Deficit — need to import or discharge battery
      const deficit = -netSolarAfterLoad;

      // Cheap-window determination (when we charge from grid)
      const isCheapWindow = isDynamic
        ? isCheapDynamic
        : ((band === "ev") || (band === "night" && rate <= 0.20));

      // Expensive-window determination (when we want to discharge)
      const isExpensiveWindow = isDynamic
        ? isExpensiveDynamic
        : (band === "peak" || band === "day");

      if (isExpensiveWindow && !isCheapWindow){
        // Discharge to meet load
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      } else if (isCheapWindow){
        // Cheap — charge battery from grid + meet load from grid
        if (strategy.charge_from_grid){
          const headroom = maxSoc - soc;
          // For dynamic: only charge if room AND we have hours that are noticeably cheap
          const chargeAmt = Math.min(headroom / eff, maxChargeKw);
          charge = chargeAmt;
          soc += chargeAmt * eff;
          imp = deficit + charge;
        } else {
          imp = deficit;
        }
      } else {
        // Neutral hour — meet load with battery if available, else import
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw * 0.5);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      }
    }

    out.grid_import[i] = imp;
    out.grid_export[i] = exp;
    out.battery_charge[i] = charge;
    out.battery_discharge[i] = discharge;
    out.cost[i] = imp * rate;
    out.revenue[i] = exp * exportRate;
  }
  out.soc[HOURS_IN_YEAR] = soc;
  return out;
}

/* ============================================================
   8. ORCHESTRATOR + CACHE
   ============================================================ */
const CACHE = { solar:null, cons:null, consNoEv:null, wholesale:null, dirty:true, sims:{}, baselines:{} };

function rebuildBase(){
  CACHE.solar = buildSolar();
  const consResult = buildConsumption();
  CACHE.cons = consResult.cons;
  CACHE.consNoEv = consResult.consNoEv;
  CACHE.wholesale = buildWholesale();
  CACHE.sims = {};
  CACHE.baselines = {};
  CACHE.dirty = false;
}

function sim(planId){
  if (CACHE.dirty) rebuildBase();
  if (CACHE.sims[planId]) return CACHE.sims[planId];
  const plan = getPlanById(planId);
  // Build strategy object on the fly from flat state (matches tool's interface)
  const eff = effectiveStrategy();
  const run = (mode, fromGrid) => {
    const r = simulate(plan, CACHE.solar.total, CACHE.cons, {
      mode, charge_from_grid: fromGrid,
      arbitrage_priority: 0.7, discharge_strategy: 'peak_first', reserve_for_evening: 0.0,
    });
    const sdf = baselineDiscountFactor(planId);
    if (sdf !== 1){ for (let i = 0; i < r.cost.length; i++) r.cost[i] *= sdf; }
    r.strategy_used = mode === 'arbitrage' && fromGrid ? 'arbitrage' : 'self-consume';
    return r;
  };
  let ssim;
  if (eff.hasBattery && eff.mode === 'auto'){
    // What an owner would do: set the inverter to whichever pays on this plan.
    // Grid charging earns on a plan with a cheap window and loses round-trip
    // energy on a flat one, so the choice is per plan, not global.
    const a = run('arbitrage', true), b = run('self-consume', false);
    ssim = annualCost(a, plan).net <= annualCost(b, plan).net ? a : b;
  } else {
    ssim = run(eff.mode, eff.charge_from_grid);
  }
  CACHE.sims[planId] = ssim;
  return CACHE.sims[planId];
}
function baselineSim(planId){
  if (CACHE.dirty) rebuildBase();
  if (CACHE.baselines[planId]) return CACHE.baselines[planId];
  // EV semantics: an OWNER's bill (ev_in_bill) includes the car, so their
  // current-plan cost must simulate the full load incl. EV. A PLANNER's bill
  // is pre-car, so the baseline stays as-billed and the EV only appears in
  // the forward-looking comparisons.
  const baseCons = (state.ev_active && state.ev_in_bill) ? CACHE.cons : CACHE.consNoEv;
  const bsim = simulateBaseline(getPlanById(planId), baseCons);
  const df = baselineDiscountFactor(planId);
  if (df !== 1){ for (let i = 0; i < bsim.cost.length; i++) bsim.cost[i] *= df; }
  CACHE.baselines[planId] = bsim;
  return CACHE.baselines[planId];
}
// Hot-water defaults by heating type (matches engineering tool exactly)
// Gas/oil/none: combi boiler usually handles HW → no electric load
// Heat pump: smart immersion timer is the typical install
// Storage / direct electric: legacy timer (peak immersion boost)
const DEFAULT_HW_FOR_HEATING = {
  'gas': 'none', 'oil': 'none', 'none': 'none',
  'heatpump': 'smart', 'storage': 'legacy', 'direct': 'legacy'
};

// Coerce critical numeric state to real, in-range numbers. State can arrive
// from a shared ?s= URL or hand-edited localStorage, where a field might be a
// string ("10") or NaN — "10" is truthy so it slips past `|| 0` and then breaks
// arithmetic downstream. Run on every invalidate so the engine only ever sees
// clean numbers.
const NUMERIC_STATE_FIELDS = {
  bimonthly_bill_eur: [250, 0, 100000],
  annual_kwh:         [0, 0, 200000],
  baseline_discount_pct: [0, 0, 60],
  count_A:    [0, 0, 200],
  count_B:    [0, 0, 200],
  tilt_A:     [30, 0, 90],
  tilt_B:     [30, 0, 90],
  azimuth_A:  [180, 0, 360],
  azimuth_B:  [180, 0, 360],
  panel_w:    [460, 100, 800],
  battery_kwh:[0, 0, 200],
  install_cost: [0, 0, 1000000],
  grant_seai:   [0, 0, 100000],
  ev_km:      [0, 0, 200000],
  ev_eff:     [17, 1, 100],
  fuel_price: [1.83, 0, 100]
};
function coerceNumericState(){
  for (const k in NUMERIC_STATE_FIELDS){
    if (!(k in state)) continue;
    const [fallback, min, max] = NUMERIC_STATE_FIELDS[k];
    let v = Number(state[k]);
    if (!Number.isFinite(v)) v = fallback;
    state[k] = Math.min(max, Math.max(min, v));
  }
}

/**
 * Depth of the current what-if batch.
 *
 * The scenario runners work by mutating state, rebuilding, measuring and
 * restoring — and every rebuild calls invalidate(), which clears the memo
 * caches. So computeScenarioRange() ran twelve scenarios and, on its way out,
 * destroyed the very cache computeSolarPaybackScenarios() had just written.
 * Nothing was ever reused: the solar screen re-ran the 8,760-hour simulation
 * from scratch on every single render, which is 57% of a 1.1-second paint.
 *
 * While a batch is in flight the memos are left alone; the batch owns them and
 * writes the final value itself against a checksum of the real inputs.
 */
let _scenarioDepth = 0;

/**
 * Scenario results by checksum. Small and bounded: one render needs at most the
 * average year plus the two range variants.
 */
const scenarioMemo = new Map();
function rememberScenario(ck, result){
  scenarioMemo.set(ck, result);
  while (scenarioMemo.size > 8) scenarioMemo.delete(scenarioMemo.keys().next().value);
}

/*
 * The cost comparison and the "make it pay back faster" list each need whole
 * extra rankings of every plan (with solar removed; with each lever applied).
 * Worked out inside the first paint they held the payback figure back by over
 * a second, so they are drawn a moment after it, as the design sweep is.
 */
let _solarExtrasReady = false, _solarExtrasPending = false;
function solarExtrasReady(){
  if (_solarExtrasReady) return true;
  if (!_solarExtrasPending){
    _solarExtrasPending = true;
    // Two separate tasks, after the screen has settled, so the page stays
    // responsive in between instead of freezing for both at once.
    const later = (fn, ms) => setTimeout(() => { try { fn(); } catch (e) { /* sections show their own state */ } }, ms);
    later(() => { if (state.has_solar) cachedScenario(false, state.ev_active); }, 400);
    later(() => {
      computeOptimisations();
      _solarExtrasPending = false;
      _solarExtrasReady = true;
      renderApp();
    }, 500);
  }
  return false;
}
const SOLAR_EXTRA_WAIT = (title) => `<div class="v7-imp v7-imp-wait" aria-busy="true"><b>${title}</b><div class="v7-imp-sub">Working it out on your home…</div></div>`;

function invalidate(){
  coerceNumericState();
  CACHE.dirty = true;
  if (_scenarioDepth === 0){
    CACHE._opt = null;
    CACHE._opt_ck = null;
    scenarioMemo.clear();
    singleScenarioMemo.clear();
    CACHE._range = null;
    CACHE._range_ck = null;
    _solarExtrasReady = false;
  }
  // _goalSweep survives invalidate deliberately: its checksum (goalSweepCk)
  // covers all inputs that affect it, and the sweep itself is independent of
  // the currently-applied system config.
  // Re-apply region's GHI multiplier so engine uses correct sunshine for selected county
  applyRegion(state.region || 'east');
  // Sanitize HW strategy: if heating type is gas/oil/none and HW is electric (smart/legacy),
  // reset to none. This avoids the "gas combi + smart timer" trap that artificially
  // favors EV plans by shifting 15% of phantom load to 2-5am cheap window.
  const ht = state.heating_type;
  if ((ht === 'gas' || ht === 'oil' || ht === 'none') && state.hot_water_strategy !== 'none'){
    state.hot_water_strategy = 'none';
  }
  // A battery strategy with no battery is simply not in effect — see
  // effectiveStrategy(). It used to be written back into state here, which
  // destroyed the user's own choice: every routine that trials a batteryless
  // design (the twelve-design sweep, the recommended-system search, the report
  // levers) zeroes battery_kwh, invalidates, and restores the battery
  // afterwards — but none of them knew to restore a setting they never touched.
  // So arbitrage silently switched itself off while the reader was clicking
  // around, and stayed off.
}

/**
 * The battery strategy actually in force.
 *
 * state.strategy_mode is what the user asked for and is never overwritten by
 * the engine. With no battery installed it cannot apply, so everything that
 * simulates or displays the strategy reads it through here.
 */
function effectiveStrategy(){
  const hasBattery = (state.battery_kwh || 0) > 0;
  return {
    mode: hasBattery ? (state.strategy_mode || 'auto') : 'self-consume',
    charge_from_grid: hasBattery ? state.charge_from_grid !== false : false,
    hasBattery,
  };
}
/** True when grid-charging arbitrage is genuinely running. */
function arbitrageOn(){
  const s = effectiveStrategy();
  if (s.hasBattery && s.mode === 'auto') return sim(getBestPlan().plan.id).strategy_used === 'arbitrage';
  return s.hasBattery && s.mode === 'arbitrage' && s.charge_from_grid;
}

/* ============================================================
   8b. SIMULATING A HYPOTHETICAL WITHOUT LOSING THE USER'S STATE
   ============================================================

   Half the app's value comes from answering "what if?" — what if there were no
   panels, what if the battery were bigger, what if this lever were flipped. The
   engine reads global state, so every one of those questions is asked by
   mutating `state`, simulating, and putting it back.

   Putting it back was done by hand, at five call sites, each with its own list
   of fields to save. That produced the same bug twice:

     · generating a report permanently switched the battery to self-consume,
       because a lever set battery_kwh to 0 and the sanitiser rewrote the
       strategy, which the lever's snapshot did not include;
     · arbitrage switched itself off while the reader clicked around, because
       the design sweep and the recommended-system search zero the battery too,
       and their snapshots did not include it either.

   Both were a field somebody forgot. A hand-written list per call site means
   four chances to forget and no way to notice: the restore silently succeeds,
   and the user's setting is simply gone.

   One list, used everywhere. Adding a field to state means adding it here once.
   ============================================================ */

/**
 * Every field the engine reads, or that the sanitiser may rewrite, while a
 * hypothetical is being simulated.
 *
 * Deliberately broader than any one call site needs. Restoring a field that
 * never changed costs nothing; failing to restore one costs the user's setting.
 */
const SIM_FIELDS = [
  'has_solar', 'solar_planned', 'count_A', 'count_B',
  'azimuth_A', 'azimuth_B', 'tilt_A', 'tilt_B', 'panel_w', 'panel_degradation',
  'battery_kwh', 'strategy_mode', 'charge_from_grid',
  'install_cost', 'grant_seai',
  'ev_active', 'ev_in_bill', 'ev_km_per_year', 'ev_kwh_per_100km',
  'heating_type', 'hot_water_strategy', 'region',
  'baseline', 'baseline_discount_pct', 'chosen_plan', 'include_dynamic',
  // Registering for export payments is a lever the optimisation advisor trials
  // by turning it OFF. It was missing here, so opening the Solar tab left it
  // off: every figure afterwards was computed with the export income deleted —
  // 2,448 kWh/yr of it — and the payback on a 10-panel, 9 kWh system read 14.4
  // years instead of 9.3.
  'export_enabled', 'export_limit_kw',
  'bills', 'annual_kwh', 'usage_input_mode', 'bimonthly_bill_eur',
  // Economic inputs. coerceNumericState() writes every numeric field back on
  // each invalidate, so a hypothetical touches these whether it meant to or
  // not — sim-state.spec.js caught fuel_price missing from this list.
  'fuel_price', 'ice_l_per_100km', 'ev_km', 'ev_eff',
  '_ghi_override',
];

/**
 * A copy of the simulation state.
 *
 * Shallow, which is what the hand-written versions were: `bills` is captured by
 * reference, so a trial must replace it rather than mutate it in place. Every
 * current caller does.
 */
function snapshotSim(){
  const snap = {};
  for (const k of SIM_FIELDS) snap[k] = state[k];
  return snap;
}

function restoreSim(snap){
  Object.assign(state, snap);
}

/**
 * Run `fn` with `changes` applied to state, then restore everything.
 *
 * The restore runs in a finally block: a parser throwing halfway through a
 * hypothetical must not leave the user looking at a home they do not own.
 */
function withSimState(changes, fn){
  // Snapshot the standing list AND whatever this call is about to overwrite.
  // The list is maintained by hand and has now been wrong three times; a change
  // the caller is explicitly making is one the caller cannot forget to declare,
  // so take it from the argument rather than from anybody's memory.
  const snap = snapshotSim();
  if (changes) for (const k in changes) if (!(k in snap)) snap[k] = state[k];
  _scenarioDepth += 1;
  try {
    if (changes) Object.assign(state, changes);
    invalidate();
    rebuildBase();
    return fn();
  } finally {
    // Restore while still inside the hypothetical: putting state back is part
    // of the hypothetical, not a change to report. Decrementing first made
    // every trial log its own tidy-up and buried the real event.
    restoreSim(snap);
    _scenarioDepth -= 1;
    invalidate();
    rebuildBase();
  }
}

/* ============================================================
   9. EV ECONOMICS
   ============================================================ */
function evEconomics(planId){
  if (!state.ev_active) return null;
  const km = Math.max(0, +state.ev_km_per_year || 0);
  const evKwhPer100 = state.ev_kwh_per_100km || 17;
  const iceL = state.ice_l_per_100km || 6.0;
  const fuel = state.fuel_price || 1.83;
  const evKwh = km * evKwhPer100 / 100;
  const litres = km * iceL / 100;
  const petrolCost = litres * fuel;
  // Approx EV-electricity cost on the chosen plan (mostly EV-window if available)
  const plan = getPlanById(planId);
  let evRate = plan.rates.ev || plan.rates.night || plan.rates.day;
  const evElectricityCost = evKwh * evRate;
  return {
    km, evKwh, litres, petrolCost, evElectricityCost,
    evVsPetrolNet: petrolCost - evElectricityCost
  };
}

/* ============================================================
   SCENARIO CALCULATOR — properly isolates solar benefit
   Runs the full engine (4 sims) with state temporarily mutated
   so we can compare with/without solar AND with/without EV.
   ============================================================ */
function runScenario(hasSolar, hasEv){
  const snap = snapshotSim();
  // Mutate state to scenario
  if (!hasSolar){
    state.count_A = 0;
    state.count_B = 0;
    state.battery_kwh = 0;
    state.has_solar = false;
  } else {
    state.has_solar = true;
  }
  if (hasEv){
    state.ev_active = true;
    if (!state.ev_km_per_year) state.ev_km_per_year = snap.ev_km_per_year || 15000;
  } else {
    state.ev_active = false;
    state.ev_km_per_year = 0;
  }
  // Recompute
  invalidate();
  rebuildBase();
  /**
   * Best plan for THIS scenario, not the global best.
   *
   * The no-solar branch must re-optimise even when the user has hand-picked a
   * plan, because it is the counterfactual: "what would I pay if I did not
   * install this?" — and someone who did not install solar would shop for the
   * plan that suits a home without it. Inheriting the choice there prices the
   * counterfactual on a tariff picked for its export rate, inflating the
   * apparent benefit of the panels. It made a 10-year payback read as 6.0 for
   * no reason other than the plan the user had selected.
   *
   * The with-solar branch does honour the choice: that is the plan they will
   * actually be on. Choosing a dearer plan therefore lengthens payback, which
   * is the only direction that can be true.
   */
  const best = getBestPlan(hasSolar ? undefined : { ignoreChoice: true });
  const totalGen = sumF(CACHE.solar.total);
  const totalImport = sumF(best.sim.grid_import);
  const totalExport = sumF(best.sim.grid_export);

  /**
   * The current plan costed under THIS scenario's assumptions.
   *
   * baselineSim() answers a different question — "what does your bill say
   * today?" — and for someone planning an EV it deliberately excludes the car,
   * because the car is not in the bill yet. Comparing that against a scenario
   * that includes the car compares two different houses. On screen it produced
   * a "best plan" that cost €267 more than the plan the user was already on,
   * which is not a thing that can be true, and reasonably destroyed their trust
   * in every other number on the page.
   *
   * So the comparison prices the current plan over the same load as everything
   * it is compared against.
   */
  const basePlan = getPlanById(state.baseline);
  let baselineCost = 0;
  if (basePlan){
    const bsim = simulateBaseline(basePlan, hasEv ? CACHE.cons : CACHE.consNoEv);
    const df = baselineDiscountFactor(basePlan.id);
    baselineCost = sumF(bsim.cost) * df + basePlan.standing + PSO_LEVY;
  }

  const result = {
    hasSolar, hasEv,
    baselineCost,
    baselinePlanId: basePlan ? basePlan.id : null,
    baselineSwitchable: isRankablePlan(basePlan),
    bestPlanId: best.plan.id,
    bestPlanLabel: best.plan.supplier + ' — ' + best.plan.plan,
    annualCost: best.net,
    annualGen: totalGen,
    annualImport: totalImport,
    annualExport: totalExport,
    petrolDisplaced: hasEv ? (evEconomics(best.plan.id)?.petrolCost || 0) : 0,
    evElectricityCost: hasEv ? (evEconomics(best.plan.id)?.evElectricityCost || 0) : 0
  };
  // Restore + rebuild so the global CACHE matches the user's actual state
  restoreSim(snap);
  invalidate();
  rebuildBase();
  return result;
}

// Returns { withEv: {payback, solarBenefit, ...}, withoutEv: {...} } — pure solar payback in both cases
// Worst / realistic / optimistic scenarios: re-run the engine with GHI multiplied
// down (poor year, heavy cloud) or up (good Irish summer). Gives Persona 5 the
// honest range they need without hiding Irish winter reality.
function rangeKey(){
  return JSON.stringify(['range', state.region, state.count_A, state.count_B,
    state.battery_kwh, state.install_cost, state.grant_seai, state.heating_type,
    usageKey(), state.ev_active, state.ev_in_bill, state.ev_km_per_year,
    state.chosen_plan]);
}
function computeScenarioRange(){
  const ck = rangeKey();
  if (CACHE._range_ck === ck && CACHE._range) return CACHE._range;

  const origMult = state._ghi_override;
  const run = (mult) => {
    state._ghi_override = mult;
    invalidate();
    rebuildBase();
    const s = computeSolarPaybackScenarios();
    return s[state.ev_active ? 'withEv' : 'withoutEv'];
  };

  _scenarioDepth += 1;
  let realistic, pessimist, optimist;
  try {
    realistic  = run(undefined);      // normal regional multiplier
    pessimist  = run(0.82);           // ~18% below average — a genuinely bad Irish year
    optimist   = run(1.15);           // ~15% above — a good summer
    // Restore inside the guard: this invalidate() would otherwise run at depth
    // zero and clear the three results that were just computed.
    state._ghi_override = origMult;
    invalidate();
    rebuildBase();
  } finally {
    _scenarioDepth -= 1;
  }

  const out = { realistic, pessimist, optimist };
  CACHE._range_ck = ck;
  CACHE._range = out;
  return out;
}

/**
 * Digest of the consumption the engine actually reads.
 *
 * Every scenario checksum keyed on `bimonthly_bill_eur`, but that field only
 * feeds `state.bills` through the anchor rebuild — a CSV import or a switch to
 * the annual-kWh anchor changes the load profile without touching it. Keying on
 * the profile itself closes the gap.
 */
function usageKey(){
  const b = state.bills || {};
  return Object.keys(b).sort().map(k => `${k}:${Math.round(b[k] || 0)}`).join(',');
}

/**
 * A single scenario, memoised and guarded.
 *
 * runScenario() mutates state, rebuilds and restores, and each rebuild
 * invalidates every memo in the app. Calling it straight from a render meant
 * the solar screen recomputed 286 full-year simulations on every paint and
 * wiped the payback memo on the way past.
 */
const singleScenarioMemo = new Map();
function cachedScenario(hasSolar, hasEv){
  const ck = JSON.stringify([hasSolar, hasEv, state.region, state.count_A, state.count_B,
    state.tilt_A, state.azimuth_A, state.battery_kwh, state.panel_w, state.heating_type,
    usageKey(), state.ev_km_per_year, state.baseline, state.chosen_plan,
    state.hot_water_strategy, state._ghi_override,
    // The scenario now costs the current plan too, so its discount is an input.
    state.baseline_discount_pct]);
  const hit = singleScenarioMemo.get(ck);
  if (hit) return hit;
  _scenarioDepth += 1;
  let out;
  try { out = runScenario(hasSolar, hasEv); } finally { _scenarioDepth -= 1; }
  singleScenarioMemo.set(ck, out);
  while (singleScenarioMemo.size > 8) singleScenarioMemo.delete(singleScenarioMemo.keys().next().value);
  return out;
}

function computeSolarPaybackScenarios(){
  const sysCost = state.install_cost - state.grant_seai;

  // Cache key — only recompute if relevant state changed
  // (region, panels, battery, install cost, EV km, heating, bills)
  const ck = JSON.stringify([state.region, state.count_A, state.count_B, state.azimuth_A, state.azimuth_B,
    state.tilt_A, state.tilt_B, state.battery_kwh, state.panel_w, state.install_cost, state.grant_seai,
    state.heating_type, usageKey(), state.ev_km_per_year, state.ev_kwh_per_100km,
    state.fuel_price, state.ice_l_per_100km, state.hot_water_strategy, state.region, state.ev_in_bill,
    // The hand-picked plan changes the with-solar side of every scenario.
    state.chosen_plan,
    // computeScenarioRange() re-runs this whole set at three different
    // irradiances. Without the override in the key, the bad-year and good-year
    // runs would be served the average-year answer.
    state._ghi_override]);
  const memo = scenarioMemo.get(ck);
  if (memo) return memo;

  // Scenarios A–D. The depth guard keeps each run's internal invalidate() from
  // clearing the memo this function is about to write.
  _scenarioDepth += 1;
  let A, B, C, D;
  try {
    A = runScenario(false, true);   // no solar, with EV
    B = runScenario(true,  true);   // with solar, with EV
    C = runScenario(false, false);  // no solar, no EV
    D = runScenario(true,  false);  // with solar, no EV
  } finally {
    _scenarioDepth -= 1;
  }

  // Pure solar benefits (electricity only — petrol displacement excluded; it happens regardless of solar)
  const solarBenefitWithEv = A.annualCost - B.annualCost;
  const solarBenefitNoEv   = C.annualCost - D.annualCost;
  const paybackWithEv = solarBenefitWithEv > 0 ? sysCost / solarBenefitWithEv : 999;
  const paybackNoEv   = solarBenefitNoEv   > 0 ? sysCost / solarBenefitNoEv   : 999;

  // Also expose "tariff switch saving" — orthogonal to solar, just the value of switching plans
  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = sumF(baseSim.cost) + baselinePlan.standing + PSO_LEVY;

  const result = {
    withEv: {
      hasSolarBestPlan: B.bestPlanLabel,
      noSolarBestPlan:  A.bestPlanLabel,
      costNoSolar:      A.annualCost,
      costWithSolar:    B.annualCost,
      solarBenefit:     solarBenefitWithEv,
      payback:          paybackWithEv,
      petrolDisplaced:  B.petrolDisplaced
    },
    withoutEv: {
      hasSolarBestPlan: D.bestPlanLabel,
      noSolarBestPlan:  C.bestPlanLabel,
      costNoSolar:      C.annualCost,
      costWithSolar:    D.annualCost,
      solarBenefit:     solarBenefitNoEv,
      payback:          paybackNoEv,
      petrolDisplaced:  0
    },
    baselineCost: baseCost,
    sysCost
  };
  rememberScenario(ck, result);
  return result;
}

/* ============================================================
   10. BEST-PLAN PICKER
   ============================================================ */
// Decompose baseline→best savings into auditable components that sum EXACTLY
// to the headline number: household usage on the new rates, EV charging
// (hourly-attributed share of energy cost), standing charge, and export rates.
// This answers "WHY does this plan win" — e.g. same kWh saves far more with an
// EV because 2,550 of them sit in the cheap night window the new plan prices low.
function savingsBreakdown(best){
  const basePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  // Baseline convention (parity-locked): displayed current-plan cost is import
  // cost + standing, with no export netting — so the decomposition follows it
  const baseEnergy = sumF(baseSim.cost);
  const baseNet = baseEnergy + basePlan.standing + PSO_LEVY;
  let evBase = 0, evBest = 0;
  if (state.ev_active){
    const cons = CACHE.cons, noEv = CACHE.consNoEv;
    for (let i = 0; i < cons.length; i++){
      const ev = cons[i] - noEv[i];
      if (ev <= 0 || cons[i] <= 0) continue;
      const share = ev / cons[i];
      evBest += best.sim.cost[i] * share;
      if (state.ev_in_bill) evBase += baseSim.cost[i] * share;
    }
  }
  return {
    household: (baseEnergy - evBase) - (best.energy_cost - evBest),
    ev:        evBase - evBest,
    standing:  basePlan.standing - best.standing,
    export_:   best.export_revenue,
    total:     baseNet - best.net
  };
}

// Most recent verification date across live tariffs — shown prominently so the
// user always knows how fresh the data behind a recommendation is.
/**
 * Oldest verification date among plans that can be recommended.
 *
 * Deliberately the minimum, not the maximum. Taking the newest let a single
 * re-scraped plan present the whole list as current — the result screen was
 * printing "all 25 live plans checked" against today's date while 25 of them
 * had not been checked in eight weeks.
 */
function dataVerifiedDate(){
  let min = '';
  for (const t of TARIFFS){
    if (t.discontinued || !t.verified_date) continue;
    if (!min || t.verified_date < min) min = t.verified_date;
  }
  return min;
}
function dataAgeDays(){
  const d = dataVerifiedDate();
  return d ? Math.round((Date.now() - new Date(d)) / 86400000) : 999;
}

/* ============================================================
   V6 DATA OBJECTS — the same figures, drawn
   ------------------------------------------------------------
   These adapters take what the engine already computed and shape it for the
   pure encoders in ui/charts.js. They add no arithmetic of their own: every
   euro and kilowatt-hour here is read straight off a simulation the app was
   already running, so a chart can never disagree with the text beside it.
   ============================================================ */

function renderSavingsBreakdown(best, baseCost){
  const b = savingsBreakdown(best);
  if (b.total <= 5) return '';
  const row = (label, v, sub) => Math.abs(v) < 3 ? '' : `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <div style="font-size:12px;color:var(--ink-soft)">${label}${sub ? `<div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-top:2px">${sub}</div>` : ''}</div>
      <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${v >= 0 ? 'var(--accent)' : 'var(--loss)'};white-space:nowrap">${v >= 0 ? '−' : '+'}${fmtCurrency(Math.abs(Math.round(v)))}</div>
    </div>`;
  const evKwh = Math.round((state.ev_km_per_year || 0) * (state.ev_kwh_per_100km || 17) / 100);
  const age = dataAgeDays();
  return `
    <div class="card" style="margin-bottom:14px">
      <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('scales',12,'vertical-align:-2px')} Why this plan wins</div>
      ${row('Your home\'s usage on the new rates', b.household)}
      ${state.ev_active ? row(state.ev_in_bill ? 'Your EV charging (night window)' : 'Adding the EV\'s charging', b.ev, evKwh ? evKwh.toLocaleString() + ' kWh in the cheap window' : '') : ''}
      ${row('Standing charge', b.standing)}
      ${state.has_solar ? row('Solar export payments (new plan)', b.export_) : ''}
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0 2px">
        <div style="font-size:12px;font-weight:700;color:var(--ink)">Total saving</div>
        <div style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--accent)">${fmtCurrency(Math.round(b.total))}/yr</div>
      </div>
      <div style="font-family:var(--mono);font-size:12px;color:${age > 60 ? 'var(--amber)' : 'var(--ink-dim)'};margin-top:8px;letter-spacing:.03em">
        ${age > 45 ? ic('warn',10,'vertical-align:-1px') + ' Oldest rate check ' + fmtShortDate(dataVerifiedDate()) + ' — ' + age + ' days ago, re-check before switching' : '✓ Every plan re-checked since ' + fmtShortDate(dataVerifiedDate())}
      </div>
    </div>`;
}

// For homes with PLANNED (not yet installed) solar: the honest switching
// figure excludes the un-bought panels. Returns {switchNow, withPlanned, total}.
function plannedSolarSplit(){
  if (!state.has_solar || !state.solar_planned) return null;
  if (CACHE.dirty) rebuildBase();
  const withSolar = getBestPlan();
  const basePlan = getPlanById(state.baseline);
  const baseCost = sumF(baselineSim(state.baseline).cost) + basePlan.standing + PSO_LEVY;
  // No-solar best computed with a direct, minimal snapshot — rebuilt in the
  // same pass so it can never read a stale per-plan sim cache.
  const noSolarNet = withSimState(
    { count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false },
    () => getBestPlan().net);
  const switchNow = Math.max(0, Math.round(baseCost - noSolarNet));
  const total = Math.max(0, Math.round(baseCost - withSolar.net));
  return { switchNow, withPlanned: Math.max(0, total - switchNow), total };
}

/** The four costs behind Home's staircase when solar is planned: now and
 *  best, each without and with the panels. */
/**
 * The household as the model sees it, for memo keys: UI state (the "_" keys,
 * which screen is open, the theme) is left out, so moving between screens or
 * tabs never re-simulates a year. A few "_" keys are the model: the meter
 * file's hourly shape changes every hour of the year without touching the bills.
 */
// Keys that change nothing in any figure: a page, the theme, which alerts were seen, the score toast.
const UI_ONLY = new Set(['current_screen', 'theme', 'alerts_seen', 'score_seen', 'switch_clicks']);
const MODEL_PRIVATE = new Set(['_csv_imported', '_csv_hourly_shape', '_ghi_override']);
function modelKey(){
  return JSON.stringify(state, (key, v) => (key && !MODEL_PRIVATE.has(key) && (key[0] === '_' || UI_ONLY.has(key)) ? undefined : v)) + '|' + _tariffGen;
}

let _plMemo = { k: null, v: null };
function plannedLadder(){
  if (!state.has_solar || !(totalPanels() > 0)) return null;
  // The no-solar run re-simulates the year; do it once per household, not per render.
  const k = modelKey();
  if (_plMemo.k === k && _plMemo.v) return _plMemo.v;
  _plMemo = { k, v: _plannedLadder() };
  return _plMemo.v;
}
function _plannedLadder(){
  if (CACHE.dirty) rebuildBase();
  const basePlan = getPlanById(state.baseline);
  // A planned car is in every other step, so "now" carries it too: the same
  // home on both sides, or staying put can look cheaper than the best plan.
  const today = (state.ev_active && !state.ev_in_bill)
    ? withSimState({ count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false }, () => annualCost(sim(basePlan.id), basePlan).net)
    : sumF(baselineSim(state.baseline).cost) + basePlan.standing + PSO_LEVY;
  const noSolar = withSimState({ count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false }, () => { const b = getBestPlan(); return { net: b.net, plan: b.plan }; });
  const withS = getBestPlan();
  const mine = annualCost(sim(basePlan.id), basePlan).net;
  return { today, noSolar, mine, best: { net: withS.net, plan: withS.plan } };
}

/* ── ANALYTICS: ONE QUESTION PER TAB ──────────────────────────
 * Bill, Hours, Solar, Car and Accuracy each answer one question, read from
 * the same simulations as every other screen. "Today" is the home as it is
 * billed now: a planned system is not bought yet, so it is left out; an
 * installed one is part of the home. Memoised on the whole model: the
 * no-panels side re-simulates the year. */
/*
 * Analytics follows the home being simulated (Home's switches: planned or
 * installed panels, the car) on one plan: the best for that home unless the
 * reader picks another in Analytics. A pick is a what-if for Analytics only,
 * and it lapses when the home changes, because the best plan may change with it.
 */
function anConfig(){
  return JSON.stringify([!!state.has_solar, totalPanels(), +state.battery_kwh || 0, !!state.solar_planned, !!state.ev_active, !!state.ev_in_bill, +state.ev_km_per_year || 0, state.baseline]);
}
/** The plan Analytics shows: { plan, best, picked }. Clears a pick the home has outgrown. */
function anPlan(){
  const best = getBestPlan();
  const pk = state._an_pick;
  if (pk && pk.cfg !== anConfig()){
    delete state._an_pick;
    state._an_note = `The home changed, so Analytics went back to its best plan: ${best.plan.supplier} ${best.plan.plan}.`;
  }
  const picked = state._an_pick ? getPlanById(state._an_pick.id) : null;
  return { plan: picked || best.plan, best: best.plan, picked: !!picked && picked.id !== best.plan.id, bestIsChoice: !!best.isChosen };
}
let _sdMemo = { k: null, v: null };
/** The solar figures worked out on a given plan: the engine's own, as if that plan were chosen. */
function solarDataFor(id){
  const best = getBestPlan();
  if (!id || id === best.plan.id) return v7SolarData();
  const k = modelKey() + '|' + id + '|' + (state._scenario_view || '');
  if (_sdMemo.k === k) return _sdMemo.v;
  const v = withSimState({ chosen_plan: id, _scenario_view: 'realistic' }, () => { const d = v7SolarData(); return { ...d, best: { ...d.best } }; });
  _sdMemo = { k, v };
  return v;
}
function anPick(id){
  if (!id || id === getBestPlan().plan.id) delete state._an_pick;
  else state._an_pick = { id, cfg: anConfig() };
  delete state._an_note;
  v7Sheet(null); saveState(); renderApp(); window.scrollTo(0, 0);
}

let _anMemo = { k: null, v: null };
function analyticsData(){
  const { plan } = anPlan();
  const k = modelKey() + '|' + plan.id;
  if (_anMemo.k === k && _anMemo.v) return _anMemo.v;
  _anMemo = { k, v: _analyticsData(plan) };
  return _anMemo.v;
}
function _analyticsData(plan){
  if (CACHE.dirty) rebuildBase();
  const sys = !!state.has_solar && totalPanels() > 0;
  const installed = sys && !state.solar_planned && !state.solar_is_estimate;
  const ap = anPlan();
  const s = sim(plan.id);
  const ac = annualCost(s, plan);
  const t = { cost: s.cost, revenue: s.revenue, band: s.band, use: s.cons, imp: s.grid_import,
    gen: s.gen, exp: s.grid_export, ch: s.battery_charge, dis: s.battery_discharge, soc: s.soc,
    energy: ac.energy_cost, standing: ac.standing, pso: ac.pso, outlook: ac.outlook_extra, credit: ac.export_revenue, total: ac.net };
  const byBand = {}, kwhBand = {};
  const month = new Array(12).fill(0), monthBuy = new Array(12).fill(0), monthSell = new Array(12).fill(0);
  const dayCost = new Array(365).fill(0);
  const hourUse = new Array(24).fill(0), hourImp = new Array(24).fill(0), hourCost = new Array(24).fill(0);
  let i = 0;
  for (let m = 0; m < 12; m++){
    for (let d = 0; d < DAYS_IN_MONTH[m]; d++){
      for (let h = 0; h < 24; h++, i++){
        if (i >= HOURS_IN_YEAR) break;
        const b = (t.band && t.band[i]) || bandAt(h, plan);
        const net = (t.cost[i] || 0) - (t.revenue ? (t.revenue[i] || 0) : 0);
        byBand[b] = (byBand[b] || 0) + (t.cost[i] || 0);
        kwhBand[b] = (kwhBand[b] || 0) + (t.imp[i] || 0);
        month[m] += net;
        monthBuy[m] += t.cost[i] || 0;
        monthSell[m] += t.revenue ? (t.revenue[i] || 0) : 0;
        dayCost[Math.floor(i / 24)] += net;
        hourUse[h] += (t.use[i] || 0) / 365;
        hourImp[h] += (t.imp[i] || 0) / 365;
        hourCost[h] += (t.cost[i] || 0);
      }
    }
  }
  let hi = 0, lo = 0;
  for (let d = 1; d < 365; d++){ if (dayCost[d] > dayCost[hi]) hi = d; if (dayCost[d] < dayCost[lo]) lo = d; }
  // What you pay now, as billed: the reference every saving is measured from.
  const basePlan = getPlanById(state.baseline);
  const ref = installed
    ? (() => { const r = annualCost(sim(basePlan.id), basePlan); return { plan: basePlan, net: r.net, energy: r.energy_cost, standing: r.standing, pso: r.pso, credit: r.export_revenue, outlook: r.outlook_extra }; })()
    : (state.ev_active && !state.ev_in_bill)
      // A planned car: priced in, as Home's "Now" bar does, so both sides are the same home.
      ? withSimState({ count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false }, () => { const r = annualCost(sim(basePlan.id), basePlan); return { plan: basePlan, net: r.net, energy: r.energy_cost, standing: r.standing, pso: r.pso, credit: 0, outlook: r.outlook_extra }; })
      : (() => { const e = sumF(baselineSim(basePlan.id).cost); return { plan: basePlan, net: e + basePlan.standing + PSO_LEVY, energy: e, standing: basePlan.standing, pso: PSO_LEVY, credit: 0, outlook: 0 }; })();
  // The best plan for this home, for comparison when another is picked.
  const bestAc = annualCost(sim(ap.best.id), ap.best);
  const best = { plan: ap.best, net: bestAc.net };
  let solar = null;
  if (sys){
    const gen = sumF(s.gen), exp = sumF(s.grid_export), curt = sumF(s.curtailed);
    solar = { plan, gen, exp, curt, kept: Math.max(0, gen - exp - curt), revenue: sumF(s.revenue),
      battIn: state.battery_kwh > 0 ? sumF(s.battery_charge) : 0, battOut: state.battery_kwh > 0 ? sumF(s.battery_discharge) : 0,
      cons: sumF(s.cons), arbitrage: state.battery_kwh > 0 && arbitrageOn() };
  }
  return { sys, installed, plan, picked: ap.picked, bestIsChoice: ap.bestIsChoice, _t: t,
    today: { total: t.total, energy: t.energy, standing: t.standing, pso: t.pso, outlook: t.outlook, credit: t.credit,
      byBand, kwhBand, month, monthBuy, monthSell, hourUse, hourImp, hourCost, kwh: sumF(t.use), imp: sumF(t.imp),
      dearest: { day: hi, cost: dayCost[hi] }, cheapest: { day: lo, cost: dayCost[lo] } },
    ref, best, solar };
}

/** One day of that same home on that plan, hour by hour. */
function analyticsDay(dayIdx){
  const d = analyticsData();
  const t = d._t;
  const day = Math.max(0, Math.min(364, Math.round(+dayIdx || 0)));
  // One scale for the whole year, so a winter day looks bigger than a summer one.
  if (d._yearMax == null){ let m = 0; for (let i = 0; i < HOURS_IN_YEAR; i++) if ((t.use[i] || 0) > m) m = t.use[i]; d._yearMax = m; }
  const hours = [];
  for (let h = 0; h < 24; h++){
    const i = day * 24 + h;
    const band = (t.band && t.band[i]) || bandAt(h, d.plan);
    hours.push({ h, band, rate: d.plan.rates[band] ?? d.plan.rates.day,
      use: t.use[i] || 0, imp: t.imp[i] || 0,
      gen: t.gen ? t.gen[i] || 0 : 0, exp: t.exp ? t.exp[i] || 0 : 0,
      ch: t.ch ? t.ch[i] || 0 : 0, dis: t.dis ? t.dis[i] || 0 : 0,
      soc: t.soc ? t.soc[i] || 0 : 0,
      cost: (t.cost[i] || 0) - (t.revenue ? t.revenue[i] || 0 : 0) });
  }
  const solar = d.sys ? { plan: d.plan, planned: !d.installed, cap: +state.battery_kwh || 0, hours } : null;
  return { day, hours, yearMax: d._yearMax, solar };
}

/**
 * Poor, typical and good solar years. Three full re-runs of the year, so it is
 * worked out after the screen has painted, then drawn in: null until then.
 */
let _rangePending = false;
function solarRange(){
  if (CACHE._range_ck === rangeKey() && CACHE._range) return CACHE._range;
  if (!_rangePending){
    _rangePending = true;
    setTimeout(() => {
      try { if (state.has_solar && totalPanels() > 0) computeScenarioRange(); } catch (e) { /* the tiles keep their placeholder */ }
      _rangePending = false;
      if (state.current_screen === 'solar') renderApp();
    }, 450);
  }
  return null;
}

/** What the accuracy would be with the meter file in: usage measured, all else as now. */
function accuracyWithMeter(){
  const parts = modelAccuracy().parts.map((p) => (/^Usage/.test(p.label) ? { ...p, err: 1 } : p));
  return Math.max(2, Math.round(Math.sqrt(parts.reduce((x, p) => x + p.err * p.err, 0))));
}

/**
 * Take the car in or out of every figure, as solar's "Leave out" does: the
 * car itself (distance, size, charger) is kept, so it comes back as it was.
 */
function toggleEvModel(){
  if (!state.ev_active && !state._ev_left_out) return startEvGuide();
  state.ev_active = !state.ev_active;
  state._ev_left_out = !state.ev_active;
  if (!state.ev_active && state._an_tab === 'car') state._an_tab = 'bill';
  invalidate(); saveState();
  if (state.current_screen === 'analytics' || state.current_screen === 'solar') renderApp(); else setScreen(state.current_screen);
}
const removeEv = toggleEvModel;

/** Analytics' own tabs. Solar keeps its screen id ('solar') so every link
 *  into it — Home, the solar guide — still lands on it. */
function anTab(t, from){
  if (from !== undefined) state._an_from = from;
  if (t === 'car' && !state.ev_active) t = 'bill';
  // The "plan went back" note is read on arrival, and cleared by the next tab change.
  if (state.current_screen === 'analytics' || state.current_screen === 'solar') delete state._an_note;
  state._an_tab = t;
  const screen = t === 'solar' ? 'solar' : 'analytics';
  if (state.current_screen === screen){ saveState(); renderApp(); }
  else setScreen(screen);
  // A tab is a new question: it starts at the top.
  window.scrollTo(0, 0);
}

// The savings figure that's honest to publish (share card / PDF): for planned
// solar, switch-now only; otherwise the full figure.
function publishableSavings(){
  const split = plannedSolarSplit();
  if (split) return split.switchNow;
  const best = getBestPlan();
  const basePlan = getPlanById(state.baseline);
  const baseCost = sumF(baselineSim(state.baseline).cost) + basePlan.standing + PSO_LEVY;
  return Math.max(0, Math.round(baseCost - best.net));
}

/**
 * Is `plan` one the ranking can offer? Discontinued plans cannot be switched
 * to, and dynamic ones are held back unless the user opts in.
 */
function isRankablePlan(plan){
  if (!plan || plan.discontinued) return false;
  if (plan.type === 'dynamic' && !state.include_dynamic) return false;
  return true;
}

/**
 * Evaluate the hand-picked plan, or null if there isn't a usable one.
 *
 * A stored choice can go stale — the plan may be withdrawn by the supplier on
 * the next tariff refresh, or the user may turn dynamic plans back off. Rather
 * than fail, fall through to the ranking; the surfaces that matter show the
 * choice explicitly, so its disappearance is visible.
 */
function evaluateChosenPlan(){
  const id = state.chosen_plan;
  if (!id) return null;
  const plan = getPlanById(id);
  if (!isRankablePlan(plan)) return null;
  const s = sim(plan.id);
  const c = annualCost(s, plan);
  return { plan, sim: s, net: c.net, ...c, isChosen: true };
}

/**
 * The plan the rest of the app should reason about.
 *
 * Normally that is the cheapest for this household. If the user has picked a
 * plan by hand — a fixed-term deal they want for its own reasons, a supplier
 * they will not leave — that choice wins, and every downstream figure (savings,
 * solar payback, the report) is computed on it instead. `isChosen` lets a
 * surface say so rather than presenting a manual pick as our recommendation.
 *
 * `opts.ignoreChoice` re-optimises regardless, for counterfactuals that must
 * not inherit the choice — see runScenario().
 */
function getBestPlan(opts){
  if (CACHE.dirty) rebuildBase();
  let best = opts && opts.ignoreChoice ? null : evaluateChosenPlan();
  // EXCLUDE discontinued plans (can't be switched to) and — for now — dynamic
  // wholesale-tracking plans: their pricing is too unpredictable to rank
  // honestly until clarity is established. Opt back in via Expert settings.
  if (!best){
    for (const plan of TARIFFS){
      if (!isRankablePlan(plan)) continue;
      const s = sim(plan.id);
      const c = annualCost(s, plan);
      if (!best || c.net < best.net){
        best = { plan, sim: s, net: c.net, ...c, isChosen: false };
      }
    }
  }
  // No rankable plan at all (every tariff discontinued/filtered, or the data
  // failed to load). Return a clearly-flagged null result instead of letting
  // `best.plan.id` throw a cascade of errors across the result screen.
  if (!best){ return { plan: null, sim: null, net: 0, energy_cost: 0, export_revenue: 0, standing: 0, baseCost: 0, savings: 0, _noPlan: true }; }
  const baselinePlan = getPlanById(state.baseline);
  const bs = baselineSim(state.baseline);
  const baseCost = bs ? (sumF(bs.cost) + (baselinePlan ? baselinePlan.standing + PSO_LEVY : 0)) : 0;
  best.baseCost = baseCost;
  best.savings = baseCost - best.net;
  return best;
}

/* ============================================================
   10b. SINGLE SOURCE OF TRUTH — recommendation + counts
   ============================================================
   Root cause of the three-surface mismatch (P0.1):
   - getBestPlan() correctly filters out dynamic plans (unless include_dynamic).
   - rankOfPlan() did NOT apply the same dynamic filter, so its `total` was 26
     (all non-discontinued) while getBestPlan() ranked against 25.
   - Result screen, Monitor, and Analytics each computed plan/savings independently,
     so any difference in state at call-time (cache staleness, filter state) could
     produce different numbers.
   Fix: getRecommendation() is the one place that does this work. Every screen
   reads from it. rankOfPlan() now also respects the dynamic filter so counts align.
   ============================================================ */
function getRecommendation(){
  if (CACHE.dirty) rebuildBase();
  const totalNonDiscontinued = TARIFFS.filter(p => !p.discontinued).length;
  const dynamicCount = TARIFFS.filter(p => !p.discontinued && p.type === 'dynamic').length;
  const excludedCount = state.include_dynamic ? 0 : dynamicCount;
  const rankedCount = totalNonDiscontinued - excludedCount;

  // Rank plans — mirrors getBestPlan() filter exactly
  const ranked = [];
  for (const plan of TARIFFS){
    if (!isRankablePlan(plan)) continue;
    const s = sim(plan.id);
    const c = annualCost(s, plan);
    ranked.push({ plan, sim: s, net: c.net, ...c });
  }
  ranked.sort((a, b) => a.net - b.net);

  // `cheapest` is what the ranking says; `best` is what the app acts on. They
  // differ only when the user has chosen a plan by hand.
  const cheapest = ranked[0] || null;
  const chosenIdx = state.chosen_plan
    ? ranked.findIndex(r => r.plan.id === state.chosen_plan)
    : -1;
  const best = chosenIdx >= 0 ? ranked[chosenIdx] : cheapest;
  const isManualChoice = chosenIdx >= 0;
  const chosenRank = chosenIdx >= 0 ? chosenIdx + 1 : null;
  // What sticking with the hand-picked plan costs against the cheapest.
  const choicePremium = isManualChoice && cheapest ? best.net - cheapest.net : 0;
  const baselinePlan = getPlanById(state.baseline);
  const bs = baselineSim(state.baseline);
  const baseCost = bs ? (sumF(bs.cost) + (baselinePlan ? baselinePlan.standing + PSO_LEVY : 0)) : 0;
  const annualSavings = best ? Math.max(0, baseCost - best.net) : 0;
  const baselineRank = best ? (ranked.findIndex(r => r.plan.id === state.baseline) + 1) : null;

  const excludedNote = excludedCount > 0
    ? ` — ${excludedCount} dynamic plan${excludedCount > 1 ? 's' : ''} excluded (enable in Settings)`
    : '';

  return {
    best,                   // the plan in effect (chosen if set, else cheapest)
    cheapest,               // always rank 1, regardless of any manual choice
    isManualChoice,         // true when `best` is the user's pick, not the ranking's
    chosenRank,             // 1-based rank of that pick, null if none
    choicePremium,          // €/yr it costs versus the cheapest plan
    ranked,                 // all rankable plans sorted cheapest-first
    baseCost,
    annualSavings,
    rankedCount,            // plans in the ranking (dynamic excluded if setting off)
    totalPlanCount: totalNonDiscontinued,
    excludedCount,
    baselineRank,           // rank of the user's current plan (1-based)
    countLabel: `${rankedCount} of ${totalNonDiscontinued}${excludedNote}`,
  };
}

/* ============================================================
   11. NPV CALCULATOR (3% discount, panel degradation, Y12 batt swap)
   ============================================================ */

function toggleNpvBreakdown(){
  state._show_npv_breakdown = !state._show_npv_breakdown;
  saveState();
  renderApp();
}

function renderNpvBreakdown(annualBenefit, sysCostNet, batteryKwh, panelDegradation){
  const r = 0.03;
  const deg = panelDegradation || 0.005;
  // Year-by-year cash flow
  const rows = [];
  let cumulative = -sysCostNet;
  let totalDiscountedSavings = 0;
  for (let y = 1; y <= 20; y++){
    const undiscounted = annualBenefit * Math.pow(1 - deg, y - 1);
    let discounted = undiscounted / Math.pow(1 + r, y);
    let batteryCost = 0;
    if (batteryKwh > 0 && y === 12){
      batteryCost = -400 * batteryKwh / Math.pow(1 + r, 12);
    }
    totalDiscountedSavings += discounted;
    cumulative += discounted + batteryCost;
    rows.push({ y, undiscounted, discounted, batteryCost, cumulative });
  }
  const finalNpv = cumulative;
  const breakevenYear = rows.findIndex(r => r.cumulative >= 0);
  const breakevenLabel = breakevenYear < 0 ? 'never within 20yr' : 'Year ' + (breakevenYear + 1);
  const batterySwapNominal = batteryKwh > 0 ? 400 * batteryKwh : 0;
  const batterySwapDiscounted = batteryKwh > 0 ? 400 * batteryKwh / Math.pow(1 + r, 12) : 0;

  return `<div class="card" style="margin-bottom:14px;cursor:default;padding:18px 20px;border-color:var(--accent);background:linear-gradient(140deg,var(--panel) 0%,var(--panel-2) 100%);box-shadow:0 0 24px -12px var(--accent-glow)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.14em;text-transform:uppercase;font-weight:700">How the 20-yr NPV is built</div>
      <button onclick="toggleNpvBreakdown()" style="background:transparent;border:1px solid var(--line);color:var(--ink-soft);font-family:var(--mono);font-size:12px;padding:5px 10px;border-radius:4px;cursor:pointer;letter-spacing:.04em">HIDE ▴</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;line-height:1.55">
      <div>Net install (Y0)</div><div style="text-align:right;color:var(--loss)">−${fmtCurrency(sysCostNet)}</div>
      <div>Discounted savings (Y1–Y20)</div><div style="text-align:right;color:var(--accent)">+${fmtCurrency(totalDiscountedSavings)}</div>
      ${batteryKwh > 0 ? `<div>Battery replacement (Y12, ${batteryKwh} kWh × €400)</div><div style="text-align:right;color:var(--loss)">−${fmtCurrency(batterySwapDiscounted)}</div>` : ''}
      <div style="border-top:1px solid var(--line);padding-top:8px;font-weight:700;color:var(--ink)">= 20-yr NPV</div><div style="text-align:right;border-top:1px solid var(--line);padding-top:8px;font-weight:700;color:${finalNpv > 0 ? 'var(--accent)' : 'var(--loss)'}">${fmtCurrency(finalNpv)}</div>
    </div>

    <div style="margin-top:14px;padding:10px 12px;background:var(--well);border:1px solid var(--line);border-radius:8px;font-size:12px;color:var(--ink-soft);line-height:1.55;font-family:var(--mono);letter-spacing:.02em">
      <div style="color:var(--accent);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:6px">Assumptions</div>
      <div>· Annual benefit (Y1): <b style="color:var(--ink)">${fmtCurrency(annualBenefit)}</b> = solar electricity benefit only (same EV state, with vs without solar — petrol savings excluded)</div>
      <div>· Discount rate: <b style="color:var(--ink)">3%/yr</b> (Irish bond yields + small premium)</div>
      <div>· Panel degradation: <b style="color:var(--ink)">${(deg*100).toFixed(1)}%/yr</b> (LG/Jinko Tier-1 spec)</div>
      ${batteryKwh > 0 ? `<div>· Battery swap: <b style="color:var(--ink)">€${batterySwapNominal} nominal</b> at Y12 (€400/kWh in 2026 € — assumes price decay matches inflation)</div>` : ''}
      <div>· Tariff rates: held constant in real terms (inflation cancels with nominal rate growth)</div>
    </div>

    <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--well);border-radius:8px">
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);letter-spacing:.04em">Break-even (discounted)</div>
      <div style="font-family:var(--mono);font-size:13px;font-weight:600;color:${breakevenYear < 0 ? 'var(--loss)' : 'var(--accent)'}">${breakevenLabel}</div>
    </div>

    <div style="margin-top:14px">
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase;font-weight:600;margin-bottom:8px">Cumulative cash position (€, discounted)</div>
      <!-- The line starts at year 0 in the hole for the install and climbs.
           Where it crosses the dashed zero is break-even — the same year the
           row above names, drawn rather than asserted. The depth of the dip is
           what is actually at risk; the final height is what it is worth. -->
      ${paybackCurve({ cumulative: [-sysCostNet, ...rows.map(r => r.cumulative)] })}
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-top:6px;letter-spacing:.03em">Below the dashed line = still paying off the install · above it = in profit${breakevenYear < 0 ? ' · this system does not cross it inside 20 years' : ' · the dot is break-even, year ' + (breakevenYear + 1)}</div>
    </div>
  </div>`;
}

/* ============================================================
   11b. OPTIMISATION ADVISOR — finds free settings changes that
   increase the user's benefit, with REAL simulated € values.
   Each candidate re-runs the full engine with one lever flipped
   and reports the actual annual delta vs the current setup.
   ============================================================ */
function simulateWithOverrides(overrides){
  // This used to snapshot only the keys in `overrides`, so a lever that set
  // battery_kwh to 0 restored the battery but not the strategy the sanitiser
  // rewrote underneath it.
  return withSimState(overrides, () => {
    const best = getBestPlan();
    return { net: best.net, planLabel: best.plan.supplier + ' — ' + best.plan.plan };
  });
}

const OPTIMISATIONS = {
  arbitrage: {
    overrides: { strategy_mode: 'arbitrage', charge_from_grid: true },
    off: { strategy_mode: 'self-consume', charge_from_grid: false },
    title: 'Switch your battery to arbitrage',
    body: (d, alt) => `Your battery currently only stores solar surplus. Arbitrage also charges it from the grid in the cheap night/EV window and discharges at peak — buying low, using high.${alt ? ' Best plan becomes ' + alt + '.' : ''} One setting in your inverter app.`
  },
  selfconsume: {
    overrides: { strategy_mode: 'self-consume', charge_from_grid: false },
    off: { strategy_mode: 'arbitrage', charge_from_grid: true },
    title: 'Switch your battery to self-consume only',
    body: (d, alt) => `On your current setup, grid-charging the battery loses more in round-trip efficiency than the cheap window saves. Filling it from solar surplus only comes out ahead.${alt ? ' Best plan becomes ' + alt + '.' : ''}`
  },
  smart_hw: {
    overrides: { hot_water_strategy: 'smart' },
    off: { hot_water_strategy: 'none' },
    title: 'Heat your water on a smart timer (2–5am)',
    body: (d, alt) => `A smart immersion timer (~€100–150 one-off) shifts your hot-water heating into the cheapest overnight window instead of peak hours.${alt ? ' Best plan becomes ' + alt + '.' : ''}`
  },
  enable_export: {
    overrides: { export_enabled: true },
    off: { export_enabled: false },
    title: 'Register for export payments (CEG)',
    body: (d, alt) => `Your surplus solar is currently being wasted. Registering your system with your supplier (free, one form via ESB Networks) gets you paid for every exported kWh.${alt ? ' Best plan becomes ' + alt + '.' : ''}`
  }
};

/** Apply a suggested upgrade (more panels, a bigger battery) to the system. */
/**
 * "Try it" and "Apply" change the home's model; each keeps what was there
 * before, so one tap puts it back. Only the latest change is kept.
 */
let _undo = null;
function rememberForUndo(label){
  const snap = JSON.parse(JSON.stringify(state));
  for (const k of ['current_screen', '_sheet', '_an_tab', '_return_to']) delete snap[k];
  _undo = { label, snap };
}
function undoLast(){
  if (!_undo) return;
  Object.assign(state, _undo.snap);
  _undo = null;
  invalidate(); saveState();
  showToast('Back to your system as it was.', { type: 'accent', icon: ic('checkC', 16) });
  renderApp();
}
function undoBar(){
  return _undo ? `<div class="v7-undo">${ic('checkC', 16)}<span>${esc(_undo.label)}</span><button onclick="undoLast()">Undo</button><button class="v7-undo-x" aria-label="Keep it" onclick="_undoKeep()">${ic('x', 14)}</button></div>` : '';
}
function _undoKeep(){ _undo = null; renderApp(); }
function computeOptimisations(){
  const ck = JSON.stringify([state.strategy_mode, state.charge_from_grid, state.hot_water_strategy,
    state.export_enabled, state.battery_kwh, state.heating_type, usageKey(), state.region,
    state.count_A, state.count_B, state.has_solar, state.baseline, state.ev_active, state.ev_km_per_year, state.ev_in_bill]);
  if (CACHE._opt_ck === ck && CACHE._opt) return CACHE._opt;

  if (CACHE.dirty) rebuildBase();
  const currentNet = getBestPlan().net;
  const suggest = [];
  const confirmed = [];
  const MIN_VALUE = 15; // €/yr — don't surface noise

  const tryOpt = (id) => {
    const o = OPTIMISATIONS[id];
    const r = simulateWithOverrides(o.overrides);
    const delta = currentNet - r.net;
    if (delta >= MIN_VALUE){
      const currentBest = getBestPlan().plan;
      const altPlan = r.planLabel !== (currentBest.supplier + ' — ' + currentBest.plan) ? r.planLabel : null;
      suggest.push({ id, delta, title: o.title, body: o.body(delta, altPlan) });
    }
  };
  // For levers the user ALREADY has on: simulate switching it OFF — the loss is
  // the value of keeping it. Surfaces as a "✓ already optimised" confirmation
  // so an active lever is never silently invisible.
  const tryConfirm = (id, title) => {
    const o = OPTIMISATIONS[id];
    const r = simulateWithOverrides(o.off);
    const keep = r.net - currentNet;
    if (keep >= MIN_VALUE) confirmed.push({ id, keep, title, body: o.body(keep, null) });
  };

  // Battery strategy — evaluate whichever direction the user ISN'T on
  if ((state.battery_kwh || 0) > 0 && effectiveStrategy().mode !== 'auto'){
    const onArb = arbitrageOn();
    if (onArb){
      tryOpt('selfconsume');
      if (!suggest.find(s => s.id === 'selfconsume'))
        tryConfirm('arbitrage', 'Battery arbitrage is on');
    } else {
      tryOpt('arbitrage');
    }
  }
  // Smart hot-water timer — only for homes with electric hot water
  if (['heatpump','storage','direct'].includes(state.heating_type)){
    if (state.hot_water_strategy !== 'smart'){
      tryOpt('smart_hw');
    } else {
      tryConfirm('smart_hw', 'Smart hot-water timing is on');
    }
  }
  // Export
  if (state.has_solar){
    if (state.export_enabled === false){
      tryOpt('enable_export');
    } else {
      tryConfirm('enable_export', 'Export payments (CEG) are on');
    }
  }

  suggest.sort((a,b) => b.delta - a.delta);
  confirmed.sort((a,b) => b.keep - a.keep);

  // Hardware upgrade economics — each candidate priced at market benchmarks and
  // its benefit simulated on this exact home, so payback claims are defensible
  const upgrades = [];
  if (state.has_solar && totalPanels() > 0){
    const kwp = totalKwp();
    const batt = state.battery_kwh || 0;
    const tryUpgrade = (label, overrides, newKwp, newBatt) => {
      const grossExtra = estimateInstallCost(newKwp, newBatt) - estimateInstallCost(kwp, batt);
      const grantExtra = calcSeaiGrant(newKwp, newBatt).total - calcSeaiGrant(kwp, batt).total;
      const netExtra = Math.max(0, grossExtra - grantExtra);
      const r = simulateWithOverrides(overrides);
      const gain = currentNet - r.net;
      if (netExtra > 0 && gain > 0){
        upgrades.push({ label, netExtra, gain, payback: netExtra / gain, overrides });
      } else if (netExtra > 0){
        upgrades.push({ label, netExtra, gain: Math.max(0, gain), payback: Infinity, overrides });
      }
    };
    if (batt < 15) tryUpgrade(`+5 kWh battery (→ ${batt + 5} kWh)`, { battery_kwh: batt + 5 }, kwp, batt + 5);
    if ((state.count_A || 0) > 0 && (state.count_A || 0) <= 14){
      const nA = state.count_A + 4;
      const newKwp = kwp + 4 * (state.panel_w || 440) / 1000;
      tryUpgrade(`+4 panels (→ ${newKwp.toFixed(1)} kWp)`, { count_A: nA }, newKwp, batt);
    }
  }

  const out = { suggest, confirmed, upgrades };
  CACHE._opt_ck = ck;
  CACHE._opt = out;
  return out;
}

function toggleOptExpand(id){
  state._opt_open = state._opt_open === id ? '' : id;
  renderApp();
}

function removeOptimisation(id){
  const o = OPTIMISATIONS[id];
  if (!o || !o.off) return;
  const conf = ((CACHE._opt && CACHE._opt.confirmed) || []).find(x => x.id === id);
  Object.assign(state, o.off);
  state._opt_open = '';
  invalidate();
  saveState();
  showToast(conf ? `Removed — your model loses about ${fmtCurrency(conf.keep)}/yr` : 'Removed from your model', { type:'amber', icon:ic('x',16) });
  renderApp();
}

function applyOptimisation(id){
  const o = OPTIMISATIONS[id];
  if (!o) return;
  const opt = ((CACHE._opt && CACHE._opt.suggest) || []).find(x => x.id === id);
  rememberForUndo(`${o.title}: applied`);
  Object.assign(state, o.overrides);
  invalidate();   // may sanitise the change back (e.g. arbitrage needs a battery)
  saveState();
  // Verify the override actually held — invalidate() reverts impossible combos
  // (arbitrage with no battery, etc). Only claim success if it truly applied,
  // so we never show "Applied" while the engine silently reverted it.
  const held = Object.keys(o.overrides).every(k => state[k] === o.overrides[k]);
  if (held){
    showToast(`Applied — worth about ${opt ? fmtCurrency(opt.delta) : ''}/yr on your setup. <button class="toast-undo" onclick="undoLast()">Undo</button>`, { type:'accent', icon:ic('checkC',16), title:o.title });
  } else if (id === 'arbitrage' && (state.battery_kwh || 0) === 0){
    showToast('Battery arbitrage needs a home battery — add one in Settings first.', { type:'amber', icon:ic('warn',16), title:'No battery to charge' });
  } else {
    showToast('That setting doesn\'t apply to your current setup.', { type:'amber', icon:ic('warn',16) });
  }
  renderApp();
}

function generateAdvice(best){
  const advice = [];
  if (!best || !best.sim) return advice;
  const s = best.sim;
  const totalImport = sumF(s.grid_import);
  const totalExport = sumF(s.grid_export);
  const totalGen = sumF(s.gen);
  const totalCons = sumF(s.cons);
  // Summer = months 5-8 (Jun-Sep), Winter = months 0-2 + 10-11
  const HOURS_PER_MONTH = HOURS_IN_YEAR / 12;
  let summerExport = 0, winterImport = 0, peakImport = 0;
  for (let i=0; i<HOURS_IN_YEAR; i++){
    const month = Math.floor(i / HOURS_PER_MONTH);
    const hour = i % 24;
    if (month >= 5 && month <= 8) summerExport += s.grid_export[i];
    if (month <= 2 || month >= 10) winterImport += s.grid_import[i];
    if (hour >= 17 && hour < 19) peakImport += s.grid_import[i];
  }
  const winterImportShare = totalCons > 0 ? winterImport / totalCons : 0;
  const peakImportShare = totalCons > 0 ? peakImport / totalCons : 0;

  // Battery SoC reach: rough proxy — fraction of hours we hit ≥95% capacity
  let highSocHours = 0;
  if (state.battery_kwh > 0){
    const threshold = state.battery_kwh * 0.95;
    for (let i=0; i<HOURS_IN_YEAR; i++) if (s.soc[i] >= threshold) highSocHours++;
  }
  const socFillRate = state.battery_kwh > 0 ? highSocHours / HOURS_IN_YEAR : 0;

  // ADVICE 1: high summer export + significant 5-7 PM peak imports → MORE BATTERY
  // Honesty gate: only recommend if the marginal battery actually pays for
  // itself within a sane horizon — must agree with the Hardware upgrades rows.
  if (summerExport > 500 && peakImport > 200){
    const _kwpAdv = totalKwp();
    const _b1 = state.battery_kwh || 0;
    const _battMarg = estimateInstallCost(_kwpAdv, _b1 + 5) - estimateInstallCost(_kwpAdv, _b1);
    const _battGrantExtra = calcSeaiGrant(_kwpAdv, _b1 + 5).total - calcSeaiGrant(_kwpAdv, _b1).total;
    const _battNet = _battMarg - _battGrantExtra;
    // crude benefit ceiling: every peak kWh shifted saves ~(peak − day) ≈ 18c
    const _battBenefit = Math.min(peakImport, 5 * 250) * 0.18;
    const _battPayback = _battBenefit > 0 ? _battNet / _battBenefit : 999;
    if (_battPayback <= 12){
      advice.push({
        kind: 'battery',
        headline: state.battery_kwh > 0 ? 'Prioritise more battery storage' : 'A battery would earn its keep here',
        body: `Your roof array is performing excellently — you're exporting ${summerExport.toFixed(0)} kWh of summer surplus — but you're still pulling ${peakImport.toFixed(0)} kWh from the grid at premium evening peak rates (5-7 PM). Adding 5 kWh of storage (~${fmtCurrency(_battNet)} after grant) would bank that cheap daytime energy and pay for itself in roughly ${_battPayback.toFixed(0)} years.`
      });
    } else {
      advice.push({
        kind: 'battery-hold',
        headline: state.battery_kwh > 0 ? 'More battery? Not at current prices' : 'A battery? Not at current prices',
        body: `You're exporting ${summerExport.toFixed(0)} kWh of summer surplus and still importing ${peakImport.toFixed(0)} kWh at evening peak — the classic case for ${state.battery_kwh > 0 ? 'more storage' : 'storage'}. But at today's battery prices (~${fmtCurrency(_battNet)} for ${state.battery_kwh > 0 ? '+5 kWh' : 'a 5 kWh battery'} after grant) ${state.battery_kwh > 0 ? 'the extra capacity' : 'it'} wouldn't pay for itself within a reasonable horizon. Worth revisiting when battery prices fall.`
      });
    }
  }

  // ADVICE 2: battery rarely full + winter import > 80% → MORE PANELS
  if (state.battery_kwh > 0 && socFillRate < 0.10 && winterImportShare > 0.30){
    advice.push({
      kind: 'panels',
      headline: 'Prioritise more solar panels',
      body: `Your battery is barely filling up (only ${(socFillRate*100).toFixed(0)}% of hours at high SoC) and winter import remains at ${(winterImportShare*100).toFixed(0)}% of your total consumption. Your storage capacity is fine — the bottleneck is raw generation. Adding 2-4 panels will accelerate winter self-sufficiency.`
    });
  }

  // ADVICE 3: heavy export + no battery — but ONLY recommend if the simulated
  // marginal benefit clears the gate. A battery earns the SPREAD between the
  // export rate you're paid and the evening rate you avoid — not the full
  // export revenue. The Hardware-upgrades row simulates this properly; this
  // card must agree with it. (One battery card max: skip if ADVICE 1 spoke.)
  if (state.battery_kwh === 0 && totalExport > 800 && !advice.some(a => a.kind === 'battery' || a.kind === 'battery-hold')){
    const _bUp = (computeOptimisations().upgrades || []).find(u => /battery/i.test(u.label || ''));
    const _bBenefit = _bUp ? _bUp.gain : 0;
    const _bNet = _bUp ? _bUp.netExtra : (estimateInstallCost(totalKwp(), 5) - estimateInstallCost(totalKwp(), 0) - (calcSeaiGrant(totalKwp(), 5).total - calcSeaiGrant(totalKwp(), 0).total));
    const _bPayback = _bBenefit > 0 ? _bNet / _bBenefit : 999;
    if (_bPayback <= 12){
      advice.push({
        kind: 'battery',
        headline: 'A battery would earn its keep here',
        body: `You export ${totalExport.toFixed(0)} kWh/yr at ${fmtCent(best.plan.export_rate || 0.20)} while buying evening power at day rates. A 5 kWh battery captures that spread — simulated at ${fmtCurrency(Math.round(_bBenefit))}/yr, paying for itself in roughly ${_bPayback.toFixed(0)} years (~${fmtCurrency(Math.round(_bNet))} after grant).`
      });
    } else {
      advice.push({
        kind: 'battery-hold',
        headline: 'A battery? Not at current prices',
        body: `You export ${totalExport.toFixed(0)} kWh/yr — but you're paid ${fmtCent(best.plan.export_rate || 0.20)} for it, close to what storage would save you, so the simulated gain is only ${fmtCurrency(Math.round(_bBenefit))}/yr against ~${fmtCurrency(Math.round(_bNet))} after grant. The honest call: it doesn't pay yet. Worth revisiting when battery prices fall or export rates drop.`
      });
    }
  }

  // ADVICE 4: high self-consumption, no upgrades needed
  if (advice.length === 0 && totalGen > 0){
    // Unified definition (same as Solar + Analytics tabs): solar that wasn't
    // exported or curtailed counts as self-consumed, whether direct or via battery.
    // (Do NOT add battery_discharge — on arbitrage strategies it includes
    // grid-charged energy and overstates the ratio.)
    const selfUseKwh = Math.max(0, totalGen - sumF(s.grid_export) - sumF(s.curtailed));
    const selfConsumPct = (selfUseKwh / totalGen) * 100;
    if (selfConsumPct > 60){
      advice.push({
        kind: 'optimal',
        headline: 'Your system is well-balanced',
        body: `${selfConsumPct.toFixed(0)}% of generation is consumed on-site. The current sizing is appropriate for your usage pattern — no obvious upgrade lever.`
      });
    }
  }

  return advice;
}

/* ============================================================
   13. QUOTE AUDITOR — evaluates an installer quote against
   2026 Irish market benchmarks.
   ============================================================ */
function auditQuote(quotedPrice, numPanels, batteryKwh){
  // Assume 440W panels (mid-market reference)
  const kwp = numPanels * 440 / 1000;
  // Market benchmarks (€ per kWp installed for panels+inverter)
  const PANEL_LO = 950, PANEL_HI = 1200;
  // Battery (€ per kWh capacity, installed)
  const BATT_LO = 350, BATT_HI = 480;
  // Fixed overhead: SEAI cert, scaffolding, basic wiring
  const FIXED_LO = 1100, FIXED_HI = 1300;
  const expLo = kwp * PANEL_LO + batteryKwh * BATT_LO + FIXED_LO;
  const expHi = kwp * PANEL_HI + batteryKwh * BATT_HI + FIXED_HI;
  const expMid = (expLo + expHi) / 2;
  // Verdict
  let verdict, color, headline, advice;
  const delta = quotedPrice - expMid;
  const deltaPct = expMid > 0 ? (delta / expMid) * 100 : 0;
  if (quotedPrice <= expLo * 0.95){
    verdict = 'excellent';
    headline = 'Aggressive / Excellent Pricing';
    advice = 'This quote is below typical market range. Verify the installer is SEAI-registered, confirm all panel and battery brands are tier-1 (e.g., Sigenergy, Longi, JA Solar, GivEnergy), and that scaffolding and certification costs are included.';
  } else if (quotedPrice <= expHi){
    verdict = 'fair';
    headline = 'Fair Market Value';
    advice = `Within the typical 2026 Irish market range (€${expLo.toLocaleString()}-€${expHi.toLocaleString()} for this spec). Compare with at least one more SEAI-registered installer to confirm.`;
  } else if (quotedPrice <= expHi * 1.20){
    verdict = 'premium';
    headline = 'Premium Quote';
    advice = `€${Math.abs(delta).toFixed(0)} above the market midpoint (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}%). Request an itemised breakdown showing inverter make/model, battery brand, scaffolding cost, and SEAI cert fees before signing.`;
  } else {
    verdict = 'warning';
    headline = 'Significantly Over-Market';
    advice = `€${Math.abs(delta).toFixed(0)} above market midpoint (+${deltaPct.toFixed(0)}%). Walk away unless the quote includes substantial extras (e.g., complex roof access, slate roof, EV charger install, dedicated consumer unit). Get 2 more quotes from SEAI-registered installers in your area.`;
  }
  // Apply SEAI grant using correct 2024 tiered structure
  const grant = calcSeaiGrant(kwp, batteryKwh).total;
  const netQuoted = quotedPrice - grant;

  /*
   * What the quoted system is worth, per year.
   *
   * This used to be `getBestPlan().savings` — the saving from switching
   * TARIFF on whatever system the reader already had. For the overwhelmingly
   * common case, someone with no solar collecting quotes, that is the saving
   * from changing supplier: nothing whatever to do with the panels being
   * quoted. A €12,000 quote was credited with €517 a year, and the screen
   * reported a 19.7-year payback and a NEGATIVE twenty-year NPV — it told
   * people that a perfectly ordinary quote would lose them four thousand
   * euro. Simulated properly the same system returns €1,362 a year and pays
   * back in 6.2 years. The sign was wrong, not just the magnitude.
   *
   * The benefit is now the difference between two simulations of THIS home:
   * one with the quoted system on the roof, one with nothing. Both include
   * the EV if there is one, so the car cancels out instead of being added to
   * the panels' credit — an EV's petrol saving is not something a solar
   * installer delivers.
   */
  const withSystem = withSimState({
    has_solar: true, count_A: numPanels, count_B: 0,
    battery_kwh: batteryKwh, install_cost: quotedPrice, grant_seai: grant,
  }, () => getBestPlan().net);
  const withoutSystem = withSimState({
    has_solar: false, count_A: 0, count_B: 0, battery_kwh: 0,
  }, () => getBestPlan().net);
  const totalAnnualBenefit = Math.max(0, withoutSystem - withSystem);

  const payback = totalAnnualBenefit > 0 ? netQuoted / totalAnnualBenefit : 999;
  const npv20 = calcNPV20(totalAnnualBenefit, netQuoted, batteryKwh, state.panel_degradation);
  return {
    verdict, color, headline, advice,
    quotedPrice, expLo, expHi, expMid, grant, netQuoted,
    payback, npv20, totalAnnualBenefit, kwp,
    withSystem, withoutSystem,
    perKwp: kwp > 0 ? quotedPrice / kwp : 0
  };
}

/* ============================================================
   PRODUCT LAYER ADJUSTMENTS — runs after engine loads to add
   product-specific state fields (screens, email capture flag,
   affiliate URLs on tariffs) without modifying engine logic.
   ============================================================ */

// Affiliate URLs — UTM-tagged referral links to supplier sign-up pages.
// Replace with real affiliate tracking URLs when partner accounts are approved.
// Format: { 'TARIFF_ID': 'https://supplier.ie/switch?utm_source=solaropt&utm_medium=referral&utm_campaign=PLAN_ID' }
const AFFILIATE_URLS = {
  // Yuno Energy
  'YN-24':    'https://yuno.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=YN-24&utm_content=tariff_card',
  'YN-DNP':   'https://yuno.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=YN-DNP&utm_content=tariff_card',
  'YN-EV':    'https://yuno.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=YN-EV&utm_content=tariff_card',
  // Electric Ireland
  'EI-24':    'https://www.electricireland.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EI-24&utm_content=tariff_card',
  'EI-DYN':   'https://www.electricireland.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EI-DYN&utm_content=tariff_card',
  'EI-NB':    'https://www.electricireland.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EI-NB&utm_content=tariff_card',
  'EI-SST':   'https://www.electricireland.ie/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EI-SST&utm_content=tariff_card',
  // EI-NS is the legacy Nightsaver — not switchable; no affiliate
  // Energia
  'EN-24':    'https://www.energia.ie/energy-plans/electricity?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EN-24&utm_content=tariff_card',
  'EN-EV':    'https://www.energia.ie/energy-plans/electricity?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EN-EV&utm_content=tariff_card',
  'EN-SMART': 'https://www.energia.ie/energy-plans/electricity?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EN-SMART&utm_content=tariff_card',
  'EN-DYN':   'https://www.energia.ie/energy-plans/electricity?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=EN-DYN&utm_content=tariff_card',
  // Bord Gáis Energy
  'BG-24':    'https://www.bordgaisenergy.ie/home/our-plans?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=BG-24&utm_content=tariff_card',
  'BG-EV':    'https://www.bordgaisenergy.ie/home/our-plans?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=BG-EV&utm_content=tariff_card',
  'BG-TOU':   'https://www.bordgaisenergy.ie/home/our-plans?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=BG-TOU&utm_content=tariff_card',
  'BG-DYN':   'https://www.bordgaisenergy.ie/home/our-plans?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=BG-DYN&utm_content=tariff_card',
  // Flogas
  'FL-24':    'https://flogas.ie/electricity/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=FL-24&utm_content=tariff_card',
  'FL-DNP':   'https://flogas.ie/electricity/residential?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=FL-DNP&utm_content=tariff_card',
  // SSE Airtricity
  'SSE-EVDAY':'https://www.sseairtricity.com/ie/home?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=SSE-EVDAY&utm_content=tariff_card',
  'SSE-DNP':  'https://www.sseairtricity.com/ie/home?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=SSE-DNP&utm_content=tariff_card',
  'SSE-EVMAX':'https://www.sseairtricity.com/ie/home?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=SSE-EVMAX&utm_content=tariff_card',
  // Pinergy
  'PIN-LF':   'https://pinergy.ie/home-electricity/?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=PIN-LF&utm_content=tariff_card',
  'PIN-WFH':  'https://pinergy.ie/home-electricity/?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=PIN-WFH&utm_content=tariff_card',
  'PIN-FAM':  'https://pinergy.ie/home-electricity/?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=PIN-FAM&utm_content=tariff_card',
  'PIN-EV':   'https://pinergy.ie/home-electricity/?utm_source=solaroptimiser&utm_medium=referral&utm_campaign=PIN-EV&utm_content=tariff_card',
};

// Override DEFAULT_STATE with product-specific fields BEFORE state initialization runs.
// We do this by patching the state object after the engine declares it.
Object.assign(state, {
  // Product flow state
  current_screen: state.current_screen || 'onboarding',  // onboarding | result | solar | auditor | refine
  ob_step: state.ob_step || 1,
  considering_solar: state.considering_solar || false,    // user clicked "what if I add solar"
  email_captured: state.email_captured || false,
  user_email: state.user_email || '',
  // Switching tracking — counts how many times user clicked an affiliate link
  switch_clicks: state.switch_clicks || 0,
  // For "audit a quote" landing path (entry without onboarding)
  auditor_entry: state.auditor_entry || false
});

// If user re-opens the app after onboarding, default to result screen
if (state.onboarding_complete && state.current_screen === 'onboarding'){
  state.current_screen = 'result';
}
// First-ever load (no prior state) — open ON the answer, not in front of it.
//
// There used to be a three-slide carousel here, then a welcome screen that
// repeated the same pitch and offered a five-step setup. That was four screens
// of preamble before the reader gave us a single number. The quick path asks
// for the one number that matters and states every assumption as a chip on the
// result, so the answer costs one tap. Full setup is still one tap away from
// the welcome screen for anyone who wants to tune all of it.
// A first visit now opens on the start page: one screen that says what the
// app is, with the 30-second answer as its first button. The splash covers
// launch for everyone; returning homes go straight to Home.
if (!state.onboarding_complete && (state.current_screen === 'onboarding' || !state.current_screen)){
  state.current_screen = 'welcome';
  state.seen_intro = true;
}
// Returning user who finished onboarding — never show intro again
if (state.onboarding_complete) state.seen_intro = true;

// Helper — get affiliate URL for a tariff, fallback to a placeholder
/*
 * Plans whose supplier pays us for a switch. Ranking NEVER reads this — it is
 * used only to label the plan "We may earn a commission" and to tag clicks.
 * A test proves the ranking is identical with and without partners.
 */
const PARTNER_PLANS = new Set(window.__SAWED_PARTNERS || []);
function isPartnerPlan(planId){ return PARTNER_PLANS.has(planId); }

function getAffiliateUrl(planId){
  const url = AFFILIATE_URLS[planId];
  if (!url) return null;
  return url;
}

/* ============================================================
   FORMATTERS — used by all UI screens
   ============================================================ */
function fmtCurrency(v){
  if (!isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return sign + "€" + Math.abs(Math.round(v)).toLocaleString("en-IE");
}
function fmtKwh(v){ return Math.round(v).toLocaleString("en-IE") + " kWh"; }
function fmtCent(v){ return (v * 100).toFixed(1) + "c"; }
function fmtPercent(v){ return Math.round(v) + '%'; }

/* ============================================================
   AFFILIATE TRACKING — call when user clicks "switch to this plan"
   In production, this fires an analytics event + opens the link.
   ============================================================ */
/* ============================================================
   ANALYTICS — funnel events (Sprint 2 / B2)
   Fires to Plausible (if loaded) + always logs to console.
   To enable Plausible: add <script defer data-domain="yourdomain.ie"
   src="https://plausible.io/js/script.js"><\/script> in <head>.
   ============================================================ */
/* ============================================================
   ANALYTICS — funnel events (Sprint 2 / B2)
   To enable Plausible: add <script defer data-domain="yourdomain.ie"
   src="https://plausible.io/js/script.js"><\/script> in <head>.
   ============================================================ */

// In-memory ring buffer — last 50 events, retrievable via window.dumpAnalytics()
const _dlog_ring = [];
const _DEBUG_ENABLED = (() => {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    if (window.location.search && /[?&]debug=1\b/.test(window.location.search)) return true;
    if (window.localStorage && window.localStorage.getItem('_debug') === '1') return true;
    // Treat localhost & replit.dev preview as dev (visible console); replit.app published = silent
    const h = window.location.hostname || '';
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.replit.dev')) return true;
    return false;
  } catch(e){ return false; }
})();

function dlog(category, eventName, payload){
  // Always keep an in-memory record (useful for support — tap "Reveal events" in Settings)
  _dlog_ring.push({ ts: Date.now(), category, eventName, payload });
  if (_dlog_ring.length > 50) _dlog_ring.shift();
  // Only print if explicitly opted in — production users shouldn't see this
  if (!_DEBUG_ENABLED) return;
  try {
    const formatted = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    console.debug(`[${category}] ${eventName}${formatted ? ' ' + formatted : ''}`);
  } catch(e){ /* never let logging itself error */ }
}

// Optional helper: lets users (or us) dump the ring in DevTools by typing `dumpAnalytics()`
if (typeof window !== 'undefined') {
  window.dumpAnalytics = () => _dlog_ring.slice();
}

/* ---- Consent-gated, first-party event tracking ---------------------------
 * Partners are billed on counted events (quote requests, switch clicks), so
 * they are recorded on our own server — but only when the person has said yes
 * to anonymous usage measurement. No personal data is sent with an event. */
const escAttr = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function analyticsConsent(){ try { return localStorage.getItem('sawed_analytics'); } catch (e) { return null; } }
function analyticsSession(){
  if (analyticsConsent() !== 'yes') return null;
  try {
    let id = sessionStorage.getItem('sawed_sid');
    if (!id){ id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 36); sessionStorage.setItem('sawed_sid', id); }
    return id;
  } catch (e) { return null; }
}
function setAnalyticsConsent(granted){
  try { localStorage.setItem('sawed_analytics', granted ? 'yes' : 'no'); } catch (e) { /* private mode */ }
  fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'analytics', granted, text_version: 'v1', session_id: granted ? analyticsSession() : null }) }).catch(() => {});
  renderApp();
}
function trackEvent(name, props, clickId){
  fireEvent(name, props);
  const sid = analyticsSession();
  if (!sid) return;
  fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, props, session_id: sid, click_id: clickId || null }) }).catch(() => {});
}
/** One-line consent bar, shown until answered. */
function renderConsentBar(){
  if (analyticsConsent()) return '';
  return `<div class="consent-bar" role="region" aria-label="Usage measurement">
    <span>May we count anonymous usage (which screens and buttons are used) to improve ${BRAND.name}? No personal data, no ads.</span>
    <span class="consent-btns"><button onclick="setAnalyticsConsent(false)">No thanks</button><button class="is-yes" onclick="setAnalyticsConsent(true)">Allow</button></span>
  </div>`;
}

function fireEvent(name, props){
  // Plausible custom events
  if (typeof window.plausible === 'function'){
    try { window.plausible(name, { props }); } catch(e){}
  }
  // PostHog
  if (typeof window.posthog === 'object' && window.posthog && window.posthog.capture){
    try { window.posthog.capture(name, props); } catch(e){}
  }
  // GA4 / gtag
  if (typeof window.gtag === 'function'){
    try { window.gtag('event', name, props); } catch(e){}
  }
  dlog('ANALYTICS', name, props);
}

function trackSwitchClick(planId, planName, savings){
  state.switch_clicks++;
  saveState();
  fireEvent('switch_click', {
    plan_id: planId,
    plan_name: planName,
    savings_eur: Math.round(savings),
    region: state.region,
    heating: state.heating_type,
    has_solar: state.has_solar,
    has_ev: state.ev_active,
    total_clicks: state.switch_clicks
  });
}

function trackPlanView(planId){
  fireEvent('plan_view', { plan_id: planId, region: state.region });
}

function trackObComplete(){
  fireEvent('ob_complete', {
    region: state.region,
    heating: state.heating_type,
    has_solar: state.has_solar,
    has_ev: state.ev_active,
    bill_eur: state.bimonthly_bill_eur
  });
}

function trackLeadSubmit(source){
  fireEvent('lead_submit', { source, has_solar: state.has_solar, region: state.region });
}

function trackPageView(screen){
  fireEvent('page_view', { screen, region: state.region || 'unknown' });
}

/* ============================================================
   EMAIL CAPTURE — placeholder, wires to your email service
   ============================================================ */
/**
 * Capture contact details.
 *
 * There is no server. Nothing here is transmitted anywhere, and until an
 * endpoint exists the interface must not imply otherwise — it used to confirm
 * "we'll match you with 3 SEAI installers within 48h" while writing the address
 * to this device and stopping.
 *
 * Details are queued locally so nothing the user typed is lost when the
 * endpoint does arrive. Set `LEAD_ENDPOINT` to start sending; the queue drains
 * on the next capture.
 */
const LEAD_ENDPOINT = '';   // e.g. 'https://formspree.io/f/xxxxxxx'

function captureEmail(email, source){
  state.user_email = email;
  state.email_captured = true;
  if (!Array.isArray(state.lead_queue)) state.lead_queue = [];
  state.lead_queue.push({ email, source, at: new Date().toISOString(), address: state.address || '' });
  if (state.lead_queue.length > 50) state.lead_queue = state.lead_queue.slice(-50);
  saveState();
  trackLeadSubmit(source);
  dlog('LEAD', 'email_capture', { email, source, address: state.address });
  flushLeadQueue();
}

/** Send anything queued, if an endpoint has been configured. No-op otherwise. */
async function flushLeadQueue(){
  if (!LEAD_ENDPOINT || !state.lead_queue?.length) return;
  const batch = state.lead_queue.slice();
  try {
    const res = await fetch(LEAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads: batch }),
    });
    if (!res.ok) return;                 // keep the queue; try again next time
    state.lead_queue = state.lead_queue.slice(batch.length);
    saveState();
  } catch (e){ /* offline or blocked — the queue survives */ }
}

/* ============================================================
   COMPASS WIDGET — visual roof-orientation picker
   ============================================================ */
const EIRCODE_RE = /^[A-Z0-9]{3} ?[A-Z0-9]{4}$/i;
const AVG_MARKET_RATE = 0.30;

// Heating shape multipliers for the 6 bimonthly periods (sums = 6.0 each).
const SEASONAL_SHAPE = {
  gas:      [1.40, 1.20, 0.70, 0.60, 0.90, 1.20],
  heatpump: [1.35, 1.20, 0.75, 0.65, 0.95, 1.10],
  storage:  [1.65, 1.30, 0.60, 0.45, 0.80, 1.20],
  direct:   [1.45, 1.25, 0.70, 0.55, 0.90, 1.15]
};

// When the user has told us their actual plan, the flat market-average €/kWh
// conversion is wrong — someone on a cheap EV/night tariff buys far more kWh
// per euro. Iteratively rescale the inferred kWh until the simulated annual
// cost on THEIR plan matches what they actually pay. Skipped when real smart
// meter data is loaded (truth beats inference) or the plan isn't confirmed.
// Discount multiplier for the user's CURRENT plan. A 20% sign-up discount
// (or equivalent legacy rates) means every unit-rate euro costs them 0.80.
// Applies only to the baseline plan id — candidate plans always rank at
// today's sticker prices, because that's what a switcher would pay.
function baselineDiscountFactor(planId){
  const pct = +state.baseline_discount_pct || 0;
  if (!pct || planId !== state.baseline) return 1;
  return Math.min(1.5, Math.max(0.2, 1 - pct / 100));
}

// Rebuild state.bills from whichever usage anchor the user chose.
// 'kwh' mode treats the entered yearly kWh as ground truth (no € inference,
// no calibration); 'bill' mode keeps the original infer-then-calibrate path.
function applyUsageInput(){
  if (state._csv_imported) return;
  if (state.usage_input_mode === 'kwh' && (+state.annual_kwh || 0) >= 500){
    const shape = SEASONAL_SHAPE[state.heating_type] || SEASONAL_SHAPE.gas;
    const per = state.annual_kwh / 6;
    const keys = ["Jan-Feb","Mar-Apr","May-Jun","Jul-Aug","Sep-Oct","Nov-Dec"];
    const bills = {};
    keys.forEach((k, i) => { bills[k] = Math.max(1, Math.round(per * shape[i])); });
    state.bills = bills;
    syncDerivedBill();
  } else {
    state.bills = inferBillsFromEuro(state.bimonthly_bill_eur, state.heating_type);
    calibrateBillsToBaseline();
  }
}

// In kWh mode the € figure becomes display-only — derive it from the simulated
// annual cost on the current plan (incl. any discount) so every "€X/bimonth"
// surface stays honest instead of showing a stale typed number.
function syncDerivedBill(){
  try {
    invalidate(); rebuildBase();
    const plan = getPlanById(state.baseline);
    const s = baselineSim(state.baseline);
    const annual = sumF(s.cost) + plan.standing + PSO_LEVY;
    if (annual > 0) state.bimonthly_bill_eur = Math.round(annual / 6);
  } catch(e){}
}

function calibrateBillsToBaseline(){
  // kWh mode: consumption is ground truth — never rescale it to match a €
  // figure. Just refresh the derived display bill instead.
  if (state.usage_input_mode === 'kwh' && (+state.annual_kwh || 0) >= 500){ syncDerivedBill(); return; }
  // The bill the user typed is ground truth. Calibrate against the baseline
  // plan even when it's our unconfirmed default — otherwise the trust panel
  // shows a baseline cost that contradicts what the user just told us. (AUD-01)
  if (state._csv_imported) return;
  if (!state.bills || !Object.keys(state.bills).length) return;
  // Floor the target: a near-zero bill (€10/2mo or less) would otherwise drive
  // the calibration factor toward extremes. Below that, the inferred profile
  // is more trustworthy than the typed figure, so we leave it uncalibrated.
  let target = (state.bimonthly_bill_eur || 0) * 6;
  if (target <= 60) return;
  let prevErr = Infinity;
  for (let it = 0; it < 3; it++){
    invalidate();
    rebuildBase();
    const plan = getPlanById(state.baseline);
    if (!plan) return;
    const sim = baselineSim(state.baseline);
    const cost = sumF(sim.cost) + plan.standing + PSO_LEVY;
    if (!(cost > 0)) break;
    const f = Math.min(3, Math.max(0.3, target / cost));
    if (Math.abs(f - 1) < 0.015) break;
    // Divergence guard: if the gap to target isn't shrinking, the factor is
    // oscillating — stop rather than amplify the instability.
    const err = Math.abs(cost - target);
    if (err >= prevErr) break;
    prevErr = err;
    for (const k in state.bills) state.bills[k] = Math.max(1, Math.round(state.bills[k] * f));
  }
  invalidate();
}

function inferBillsFromEuro(bimonthlyEur, heatingType){
  const avgKwhPerBimonth = (bimonthlyEur || 0) / AVG_MARKET_RATE;
  const shape = SEASONAL_SHAPE[heatingType] || SEASONAL_SHAPE.gas;
  const bills = {};
  const keys = ["Jan-Feb","Mar-Apr","May-Jun","Jul-Aug","Sep-Oct","Nov-Dec"];
  keys.forEach((k, i) => { bills[k] = Math.round(avgKwhPerBimonth * shape[i]); });
  return bills;
}

const COMPASS_POINTS = [
  { az: 0,   label: 'N',  short: 'N',  x: 50, y: 4,  hint: 'low yield' },
  { az: 45,  label: 'NE', short: 'NE', x: 82, y: 18, hint: '' },
  { az: 90,  label: 'E',  short: 'E',  x: 96, y: 50, hint: '' },
  { az: 135, label: 'SE', short: 'SE', x: 82, y: 82, hint: '' },
  { az: 180, label: 'S',  short: 'S',  x: 50, y: 96, hint: 'max yield' },
  { az: 225, label: 'SW', short: 'SW', x: 18, y: 82, hint: '' },
  { az: 270, label: 'W',  short: 'W',  x: 4,  y: 50, hint: '' },
  { az: 315, label: 'NW', short: 'NW', x: 18, y: 18, hint: '' }
];

function compassWidget(currentAz, callbackName){
  const closest = COMPASS_POINTS.reduce((a, b) =>
    Math.abs(b.az - currentAz) < Math.abs(a.az - currentAz) ? b : a);
  return `<div class="compass-wrap">
    <div class="compass">
      <div class="compass-ring"></div>
      <div class="compass-center">${ic('home',22)}</div>
      ${COMPASS_POINTS.map(p => `
        <div class="compass-point ${p.az === closest.az ? 'active' : ''}"
             style="left:${p.x}%;top:${p.y}%"
             onclick="${callbackName}(${p.az})">${p.short}</div>
      `).join('')}
    </div>
    <div class="compass-label">
      Facing <b>${closest.label} — ${closest.az}°</b>
      ${closest.hint ? `<div class="compass-degrees">${closest.hint}</div>` : ''}
    </div>
  </div>`;
}

/* ============================================================
   ONBOARDING STATE — consolidated object
   ============================================================ */
function makeOb(){
  return {
    step: 1,
    region: 'east',
    address: '',
    baseline: 'EI-24',
    baseline_known: false,
    heating: 'gas',
    hot_water_strategy: 'none',  // auto-set when heating is picked
    bill: 200,
    usage_mode: 'bill',          // 'bill' | 'kwh' | 'csv' — which usage anchor
    annual_kwh: 0,               // yearly consumption when usage_mode === 'kwh'
    baseline_discount: 0,        // % off unit rates on the current plan
    has_solar: false,
    solar_status: false,         // false | 'have' | 'plan'
    count_A: 8, azimuth_A: 180, tilt_A: 30,
    count_B: 0, azimuth_B: 270, tilt_B: 30,
    battery_kwh: 0,
    _batt_custom: false,
    install_cost: 9500,
    strategy: 'arbitrage',       // 'arbitrage' | 'self-consume'
    charge_from_grid: true,
    install_grant: -1,           // -1 = auto-calc from panels; ≥0 = user override
    grant_touched: false,
    cost_touched: false,
    has_ev: false,
    ev_in_bill: true,
    ev_km: 15000,
    ev_eff: 17
  };
}
let _ob = makeOb();
const OB_TOTAL_STEPS = 5;

/* ============================================================
   WELCOME SCREEN — in-app landing, first thing users see
   ============================================================ */
// ============================================================
// INTRO FLOW — shown once to new users (app-store style onboarding)
// ============================================================
let _introStep = 1;  // 1=splash  2=features  3=sign-in

function introNext(){
  _introStep = Math.min(_introStep + 1, 3);
  renderApp();
}
function introBack(){
  if (_introStep <= 1){ return; }
  _introStep--;
  renderApp();
}
function introFinish(){
  state.seen_intro = true;
  state.current_screen = 'welcome';
  saveState();
  renderApp();
}
function introSignInEmail(){
  state.seen_intro = true;
  // Stay where the user is and open the sheet over it. Navigating to the
  // welcome screen dropped them out of the flow AND past the modal injection.
  state.current_screen = state.onboarding_complete ? 'result' : 'welcome';
  _authModalOpen = true;
  window._authEmailOpen = true;
  _authEmailView = 'login';
  saveState();
  renderApp();
}

function renderIntro(){
  const s = _introStep;
  const pct = [0, 30, 65, 100][s] || 0;
  const showBack = s >= 2;
  const showProgress = s >= 2;

  const progressBar = showProgress ? `
    <div style="padding:${showBack?'54px':'20px'} 20px 0;flex-shrink:0">
      <div class="intro-progress-bar"><div class="intro-progress-fill" style="width:${pct}%"></div></div>
    </div>` : '';

  const backBtn = showBack ? `
    <button class="intro-back" onclick="introBack()" aria-label="Back">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 5.6 8.2 12l6.4 6.4"/></svg>
    </button>` : '';

  let heroHTML = '';
  let footerHTML = '';

  if (s === 1){
    // ── Splash ──
    heroHTML = `
      <div class="intro-hero" style="padding-top:env(safe-area-inset-top,30px)">
        <div style="position:relative;width:230px;height:230px;flex-shrink:0;margin:0 auto 36px">
          <div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(0,230,118,.2) 0%,transparent 68%)"></div>
          <div class="intro-hero-blob" style="width:100%;height:100%;background:linear-gradient(145deg,#0d2a1a 0%,#061510 100%);border:1px solid rgba(0,230,118,.18);box-shadow:0 0 0 1px rgba(0,230,118,.06),0 20px 60px -10px rgba(0,230,118,.25);margin:0">
            <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" width="110" height="110">
              <circle cx="50" cy="50" r="16" stroke="#00e676" stroke-width="2.2"/>
              <path d="M50 14v9M50 77v9M86 50h-9M23 50h-9M75.5 24.5l-6.4 6.4M30.9 69.1l-6.4 6.4M75.5 75.5l-6.4-6.4M30.9 30.9l-6.4-6.4" stroke="#00e676" stroke-width="2" stroke-linecap="round"/>
              <path d="M50 26 36 60h10L42 74 56 40H46z" fill="#00e676"/>
            </svg>
          </div>
        </div>
        <div class="intro-title">Your personal<br>energy advisor.</div>
        <div class="intro-sub">Find your cheapest Irish electricity plan — with or without solar. In 30 seconds.</div>
      </div>`;
    footerHTML = `
      <div class="intro-footer">
        <button class="intro-cta" onclick="introNext()">Get started</button>
        <button class="intro-ghost" onclick="_authModalOpen=false;${sbInitialized() && _sbUser ? "introFinish()" : "introSignInEmail()"}">Have an account? <strong>Sign in</strong></button>
      </div>`;

  } else if (s === 2){
    // ── Features ──
    const feats = [
      { bg:'#0d2a1a', icon: `<svg viewBox="0 0 48 48" fill="none" stroke="#00e676" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8 36V20"/><path d="M18 36V10"/><path d="M28 36V26"/><path d="M38 36V16"/></svg>`, title:'Find your cheapest tariff', body:'All Irish residential plans modelled against your actual usage — not averages.' },
      { bg:'#1a1a0d', icon: `<svg viewBox="0 0 48 48" fill="none" stroke="#ffe066" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="7"/><path d="M24 6v4M24 38v4M42 24h-4M10 24H6M36.6 11.4l-2.8 2.8M14.2 33.8l-2.8 2.8M36.6 36.6l-2.8-2.8M14.2 14.2l-2.8-2.8"/></svg>`, title:'Real solar payback', body:'Your roof, your tariff, your numbers — not generic marketing estimates.' },
      { bg:'#0d1a2a', icon: `<svg viewBox="0 0 48 48" fill="none" stroke="#8ab4f8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="14" width="32" height="22" rx="4"/><path d="M16 36v4M32 36v4M12 40h24"/><path d="M16 26l5 5 11-12"/></svg>`, title:'Audit any installer quote', body:'Independent benchmark against 2026 Irish market prices — spot overpriced quotes instantly.' },
    ];
    heroHTML = `
      <div class="intro-hero" style="justify-content:flex-start;padding-top:8px">
        <div class="intro-step-counter">Features</div>
        <div class="intro-title" style="font-size:25px;text-align:left;margin-bottom:20px">All you need to<br>cut your energy bills</div>
        <div class="intro-feat-list">
          ${feats.map(f=>`
            <div class="intro-feat">
              <div class="intro-feat-icon" style="background:${f.bg}">${f.icon}</div>
              <div>
                <div class="intro-feat-title">${f.title}</div>
                <div class="intro-feat-body">${f.body}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
    footerHTML = `
      <div class="intro-footer">
        <button class="intro-cta" onclick="introNext()">Next</button>
      </div>`;

  } else {
    // ── Sign in / continue as guest ──
    heroHTML = `
      <div class="intro-hero" style="justify-content:center">
        <div style="position:relative;margin:0 auto 36px;width:230px;height:230px;flex-shrink:0">
          <div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(138,180,248,.18) 0%,transparent 70%)"></div>
          <div class="intro-hero-blob" style="width:100%;height:100%;background:linear-gradient(145deg,#101c2e 0%,#090f1a 100%);border:1px solid rgba(138,180,248,.15);box-shadow:0 0 0 1px rgba(138,180,248,.06),0 20px 60px -10px rgba(138,180,248,.2);margin:0">
            <svg width="110" height="110" viewBox="0 0 110 110" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="12" y="28" width="60" height="42" rx="5" stroke="#8ab4f8" stroke-width="2"/>
              <path d="M42 70v8M28 78h28" stroke="#8ab4f8" stroke-width="2" stroke-linecap="round"/>
              <rect x="52" y="38" width="46" height="34" rx="5" fill="#090f1a" stroke="#8ab4f8" stroke-width="2"/>
              <rect x="57" y="43" width="36" height="22" rx="2" fill="rgba(138,180,248,.08)"/>
              <path d="M57 68h36" stroke="#8ab4f8" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="75" cy="75" r="3" fill="#8ab4f8" opacity=".5"/>
            </svg>
          </div>
        </div>
        <div class="intro-title" style="margin-bottom:12px">Access your results<br>on any device</div>
        <div class="intro-sub">Save your setup and pick it up on any device.</div>
      </div>`;
    footerHTML = `
      <div class="intro-footer">
        <button class="intro-oauth-btn" onclick="doGoogleSignIn()">
          ${GOOGLE_SVG} Continue with Google
        </button>
        <div class="intro-or">or</div>
        <button class="intro-email-btn" onclick="introSignInEmail()">Continue with Email</button>
        <div id="auth-msg" class="auth-msg" style="margin-top:8px"></div>
        <button class="intro-ghost" style="margin-top:12px" onclick="state.current_screen=state.onboarding_complete?'result':'welcome';renderApp()">Continue as guest</button>
      </div>`;
  }

  return `<div class="intro-screen">${backBtn}${progressBar}${heroHTML}${footerHTML}</div>`;
}

function renderWelcome(){
  // A day of prices: the evening peak, drawn dotted, levels into the gold line.
  const peak = 'M0 92 C60 92 120 86 160 78 C190 72 200 14 225 14 C250 14 255 80 280 86 C300 90 310 92 320 92';
  const flat = 'M0 84 C60 84 120 84 160 84 C190 84 200 84 225 84 C250 84 255 84 280 84 C300 84 310 84 320 84';
  return `<div class="pk-land">
    <div class="pk-land-hero">
      <div class="pk-land-brand">
        <span class="pk-land-icon">${ic('logo', 26, 'stroke-width:1.6')}</span>
        ${wordmarkHtml('pk-word-xl pk-word-inv')}
      </div>
      <svg class="pk-land-curve" viewBox="0 0 320 120" role="img" aria-label="A day of electricity prices: the evening peak flattens into a level line">
        <path class="pk-curve-ghost" d="${peak}"/>
        <path class="pk-curve-live" d="${peak}">
          <animate attributeName="d" from="${peak}" to="${flat}" begin="0.5s" dur="1.4s" fill="freeze"
            calcMode="spline" keySplines=".5 0 .2 1" keyTimes="0;1"/>
        </path>
        <text x="225" y="8" text-anchor="middle" class="pk-curve-tag">6pm peak</text>
        <text x="0" y="116" class="pk-curve-axis">midnight</text>
        <text x="225" y="116" text-anchor="middle" class="pk-curve-axis">6pm</text>
        <text x="320" y="116" text-anchor="end" class="pk-curve-axis">midnight</text>
      </svg>
      <h1 class="pk-land-title">Take the peak<br>out of your bill.</h1>
      <p class="pk-land-sub">Every Irish electricity plan, run against your home hour by hour, with or without solar, a battery or an EV. Free and independent.</p>
    </div>
    <div class="pk-land-actions">
      <button class="pk-btn-gold" onclick="startFlow()">Get my answer in 30 seconds</button>
      <button class="pk-link" onclick="${state.onboarding_complete ? "setScreen('solar');v7Sheet('quote')" : 'navigateAuditor()'}">${ic('clip', 14)} Already have a solar quote? Check it</button>
      <button class="pk-land-link" onclick="startOnboarding()">Full guided setup, with solar and EV ${ic('chevR', 14)}</button>
      ${state.onboarding_complete ? `<button class="pk-land-link" onclick="setScreen('result')">${ic('chevL', 14)} Back to my results</button>` : ''}
      <div class="pk-land-trust">${TARIFFS.length} plans · prices checked daily · your data stays on this phone</div>
    </div>
  </div>`;
}

function startOnboarding(){
  _ob.step = 1;
  state.current_screen = 'onboarding';
  saveState();
  renderApp();
}

function goFastPath(){
  // The 30-second quick answer is a no-solar electricity-only view. Clear any
  // solar/battery/EV-arbitrage setup carried over from a previous full setup
  // so the simple route starts from a clean slate (the user can still build
  // solar back up via the full setup link at the bottom).
  state.has_solar = false;
  state.considering_solar = false;
  state.solar_is_estimate = false;
  state.count_A = 0;
  state.count_B = 0;
  state.battery_kwh = 0;
  state.solar_status = null;
  state._solar_user_configured = false;
  state._solar_payback_intro_done = false;
  state.solar_view = 'mine';
  // Automatic is right whatever battery is modelled next.
  state.strategy_mode = 'auto';
  state.charge_from_grid = true;
  state._fp_csv_mode = false;
  invalidate();
  state.current_screen = 'fastpath';
  saveState();
  renderApp();
}

function goLanding(){
  state.current_screen = 'welcome';
  saveState();
  renderApp();
}

// Re-run the full guided onboarding from Home — pre-filled with current answers
function reRunOnboarding(){
  _ob.region = state.region || 'east';
  _ob.baseline = state.baseline || 'EI-24';
  _ob.baseline_known = !!state.baseline_known;
  _ob.heating = state.heating_type || 'gas';
  _ob.hot_water_strategy = state.hot_water_strategy || 'none';
  _ob.bill = state.bimonthly_bill_eur || 200;
  _ob.usage_mode = state._csv_imported ? 'csv' : (state.usage_input_mode || 'bill');
  _ob.annual_kwh = state.annual_kwh || 0;
  _ob.baseline_discount = state.baseline_discount_pct || 0;
  _ob.has_solar = !!state.has_solar;
  _ob.count_A = state.count_A || 8;
  _ob.azimuth_A = state.azimuth_A != null ? state.azimuth_A : 180;
  _ob.tilt_A = state.tilt_A != null ? state.tilt_A : 30;
  _ob.count_B = state.count_B || 0;
  _ob.azimuth_B = state.azimuth_B != null ? state.azimuth_B : 270;
  _ob.tilt_B = state.tilt_B != null ? state.tilt_B : 30;
  _ob.battery_kwh = state.battery_kwh || 0;
  _ob.install_cost = state.install_cost || 9500;
  _ob.install_grant = state.grant_seai != null ? state.grant_seai : -1;
  _ob.grant_touched = !!state.grant_is_manual;
  _ob.cost_touched  = !!state.cost_is_manual;
  _ob.strategy = state.strategy_mode || 'auto';
  _ob.charge_from_grid = state.charge_from_grid !== false;
  _ob.has_ev = !!state.ev_active;
  _ob.ev_in_bill = state.ev_in_bill !== false;
  _ob.solar_status = state.has_solar ? (state.considering_solar ? 'have' : 'plan') : false;
  _ob.ev_km = state.ev_km_per_year || 15000;
  _ob.ev_eff = state.ev_kwh_per_100km || 17;
  startOnboarding();
}

/* ============================================================
   EXPANDED ONBOARDING — 5 steps
   ============================================================ */
function renderOnboarding(){
  return `<div class="ob-page">
    <div class="ob-shell">
      <div class="ob-header">
        <div class="ob-brand">Solar <em>Optimiser</em> · Ireland</div>
        <span class="ob-skip" onclick="confirmExitOnboarding()">✕ Exit</span>
      </div>
      <div class="ob-progress">
        ${Array.from({length:OB_TOTAL_STEPS}).map((_,i) => {
          const n = i + 1;
          return `<span class="${n < _ob.step ? 'done' : n === _ob.step ? 'current' : ''}"></span>`;
        }).join('')}
      </div>
      <div style="font-family:var(--display);font-size:12px;color:var(--ink-dim);letter-spacing:.04em;margin:-22px 0 22px;text-align:center">${ic('info',10)} Takes about 2 minutes · you can change anything later</div>
      <div class="ob-content">${renderObStep(_ob.step)}</div>
      <div class="ob-nav">
        ${_ob.step > 1 ? `<button class="ob-back-btn" onclick="obBack()">← Back</button>` : ''}
        <button class="switch-cta" style="flex:1;margin-bottom:0" onclick="obNext()">
          ${_ob.step < OB_TOTAL_STEPS ? 'Continue →' : 'Show me my best plan →'}
        </button>
      </div>
    </div>
  </div>`;
}

function renderObStep(n){
  if (n === 1) return obStep1Home();     // location + heating
  if (n === 2) return obStep2Usage();    // CSV / bill / kWh - one question
  if (n === 3) return obStep5CurrentPlan();
  if (n === 4) return obStep6Solar();
  if (n === 5) return obStep7EV();
  return '';
}

function setObBaseline(planId){
  if (planId === null){
    _ob.baseline = 'EI-24';
    _ob.baseline_known = false;
    _ob.baseline_discount = 0;
  } else {
    _ob.baseline = planId;
    _ob.baseline_known = true;
  }
  renderApp();
}

function obStep5CurrentPlan(){
  const plans = activeTariffsSorted();
  const typeLabel = { flat: 'One price', tou: 'Cheaper at night', ev: 'For EVs', dynamic: 'Changes hourly', dn: 'Cheaper at night' };
  // Supplier-first: pick supplier, then see just their plans
  const suppliers = [...new Set(plans.map(p => p.supplier))].sort();
  const selSup = _ob._ob5_supplier || null;
  const filteredPlans = selSup ? plans.filter(p => p.supplier === selSup) : [];

  const supplierGrid = suppliers.map(sup => {
    const active = selSup === sup;
    const count = plans.filter(p => p.supplier === sup).length;
    return `<button onclick="_ob._ob5_supplier='${sup}';renderApp();" style="flex:1;min-width:calc(50% - 4px);padding:10px 8px;border-radius:8px;font-size:12px;font-weight:700;font-family:var(--display);border:1.5px solid ${active ? 'var(--accent)' : 'var(--line)'};background:${active ? 'var(--accent-soft)' : 'var(--well)'};color:${active ? 'var(--accent)' : 'var(--ink)'};cursor:pointer;text-align:center">
      <div>${sup}</div>
      <div style="font-size:12px;font-weight:400;color:${active ? 'var(--accent)' : 'var(--ink-dim)'};margin-top:2px;font-family:var(--mono)">${count} plan${count !== 1 ? 's' : ''}</div>
    </button>`;
  }).join('');

  const planList = selSup ? filteredPlans.map(p => `
    <div class="ob-plan-option ${_ob.baseline === p.id && _ob.baseline_known ? 'active' : ''}" onclick="setObBaseline('${p.id}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <div class="ob-plan-option-name">${p.plan}</div>
          <div class="ob-plan-option-rate">${fmtCent(p.rates.day)}/kWh · Standing ${fmtCurrency(p.standing)}/yr</div>
        </div>
        <span class="ob-plan-type-pill ${p.type}">${typeLabel[p.type] || p.type}</span>
      </div>
    </div>
  `).join('') : '';

  return `
    <div class="ob-step-num">Step 3 of 5 · Current Plan</div>
    <h1 class="ob-title">What plan are you <em>on now</em>?</h1>

    <div class="ob-plan-notsure ${!_ob.baseline_known ? 'active' : ''}" onclick="setObBaseline(null)" style="margin-bottom:10px">
      <span>Not sure — I'll set it later</span>
      <span style="font-family:var(--mono);font-size:12px;letter-spacing:.04em">${!_ob.baseline_known ? '✓' : '›'}</span>
    </div>

    <div style="font-size:12px;font-weight:700;color:var(--ink-soft);font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">1. Pick your supplier</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
      ${supplierGrid}
    </div>

    ${selSup ? `
    <div style="font-size:12px;font-weight:700;color:var(--ink-soft);font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">2. Pick your plan</div>
    <div class="ob-plan-picker" style="max-height:240px">
      ${planList}
    </div>` : `
    <div style="padding:14px;border:1px dashed var(--line);border-radius:8px;text-align:center;color:var(--ink-dim);font-size:12px">
      Select a supplier above to see their plans
    </div>`}

    ${_ob.baseline_known ? `
    <div style="margin-top:12px;padding:12px 14px;background:var(--accent-faint);border:1px solid var(--line);border-radius:12px">
      <div style="font-size:12px;font-weight:700;color:var(--ink)">Any discount on this plan?</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:2px;line-height:1.5">Discount off unit rates — it's on your bill.</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">
        ${[0,5,10,15,20,25,30,40].map(p => `
          <div onclick="_ob.baseline_discount=${p};renderApp();" style="padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${(+_ob.baseline_discount||0)===p ? 'var(--accent)' : 'var(--line)'};background:${(+_ob.baseline_discount||0)===p ? 'var(--accent-soft)' : 'var(--panel)'};color:${(+_ob.baseline_discount||0)===p ? 'var(--accent)' : 'var(--ink-soft)'}">${p === 0 ? 'None' : p + '%'}</div>`).join('')}
      </div>
    </div>` : ''}
    <p class="ob-help" style="margin-top:10px">Not sure? Pick the closest match, or tap Not sure.</p>`;
}

function obStep1Home(){
  return `
    <div class="ob-step-num">Step 1 of 5 · Your home</div>
    <h1 class="ob-title">Where are you, and how do you <em>heat</em> it?</h1>
    <p class="ob-sub">Sets your solar yield and when you use power.</p>

    <div class="ob-field-label">Part of Ireland</div>
    ${renderRegionPicker(_ob.region)}

    <div class="ob-field-label" style="margin-top:22px">Heating</div>
    <div class="ob-tiles">
      ${[
        ['gas', ic('flame',20), 'Gas / Oil Boiler', 'Most Irish homes'],
        ['heatpump', ic('waves',20), 'Heat Pump', 'Modern A-rated'],
        ['storage', ic('layers',20), 'Storage Heaters', 'Older systems'],
        ['direct', ic('bolt',20), 'Electric Heaters', 'Apartments / minimal']
      ].map(([v, i, lbl, sub]) => `
        <div class="ob-tile ${_ob.heating === v ? 'active' : ''}" onclick="pickObHeating('${v}')">
          <div class="ob-tile-icon">${i}</div>
          <div class="ob-tile-label">${lbl}</div>
          <div class="ob-tile-sub">${sub}</div>
        </div>`).join('')}
    </div>
    <p class="ob-help" style="margin-top:12px">County is accurate enough.</p>`;
}

function pickObHeating(heating){
  _ob.heating = heating;
  // Auto-reset HW strategy to the sensible default for this heating type
  _ob.hot_water_strategy = DEFAULT_HW_FOR_HEATING[heating] || 'none';
  renderApp();
}

function obStep2Usage(){
  const m = _ob.usage_mode || 'bill';
  const pill = (mode, label) => `<button onclick="setObUsageMode('${mode}')" style="padding:8px 14px;font-size:12px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${m === mode ? 'var(--accent)' : 'transparent'};color:${m === mode ? '#fff' : 'var(--ink-soft)'}">${label}</button>`;
  const pills = `<div style="display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well);margin-bottom:14px">${pill('bill','€ Bill')}${pill('kwh','kWh / year')}${pill('csv','Smart meter')}</div>`;

  // An imported CSV wins over everything — one source of truth.
  if (state._csv_imported){
    return `
    <div class="ob-step-num">Step 2 of 5 · Your usage</div>
    <h1 class="ob-title">Usage comes from your <em>smart meter</em></h1>
    <p class="ob-sub">Using your 30-minute meter readings. Manual entry is off.</p>
    ${csvLockCard()}
    <p class="ob-help" style="margin-top:12px">Continue when you're ready.</p>`;
  }

  const head = `
    <div class="ob-step-num">Step 2 of 5 · Your usage</div>
    <h1 class="ob-title">How much electricity do you <em>use</em>?</h1>
    <p class="ob-sub">Whichever you have to hand. A bill is enough.</p>
    ${pills}`;

  if (m === 'csv'){
    return `${head}
    <div class="card" style="margin-top:0;margin-bottom:12px">
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.7">Log in at <b>myaccount.esbnetworks.ie</b> → My Meter → <b>Download HDF Data</b> (12 months if offered). The file looks like <span style="font-family:var(--mono);font-size:12px;background:var(--well);padding:2px 6px;border-radius:4px">HDF_XXXXXXXX_YYYY-MM-DD.csv</span>.</div>
      <label class="btn-secondary" style="display:block;text-align:center;cursor:pointer;margin-top:10px;padding:12px 16px;border:1px dashed var(--blue);color:var(--blue)">
        Choose CSV file
        <input id="csv-file-input" type="file" accept=".csv,.CSV" style="display:none" onchange="handleCsvFile(event)">
      </label>
    </div>
    <div id="csv-parse-result" style="margin-top:4px;margin-bottom:8px"></div>
    <p class="ob-help">No file handy? Switch to <b>€ Bill</b> above, or continue and import later from More → Import smart-meter data.</p>`;
  }

  if (m === 'kwh'){
    return `${head}
    <div style="position:relative;">
      <input id="ob-bill" class="ob-input mono" type="number" inputmode="numeric" min="500" max="40000" step="100" value="${_ob.annual_kwh || 4200}" style="padding-right:70px">
      <span style="position:absolute;right:18px;top:20px;font-size:15px;color:var(--ink-soft);font-family:var(--mono);">kWh</span>
    </div>
    <p class="ob-help">Typical: 3,500–4,500 kWh/yr · heat pump 7,000–12,000.</p>
    <div id="ob-bill-preview" class="ob-bill-preview" style="display:none"></div>`;
  }

  const hint = _ob.heating === 'gas'
    ? `${ic('info',13,'vertical-align:-2px;color:var(--blue)')} <b>Gas home:</b> enter your <b>electricity bill only</b> — from Electric Ireland, Bord Gáis Energy, Energia and so on. Your gas bill is separate. Typical: <b>€80–€180/2 months</b>.`
    : `${ic('bolt',13,'vertical-align:-2px')} <b>Electricity bill only</b>, for a 2-month period. ${_ob.heating === 'heatpump' ? 'Heat pump homes typically pay <b>€200–€450</b>.' : _ob.heating === 'storage' ? 'Storage heater homes typically pay <b>€180–€380</b>.' : 'Typical Irish home: <b>€150–€350</b>.'}`;
  const hintBg = _ob.heating === 'gas' ? 'background:var(--blue-soft);border:1px solid var(--blue)' : 'background:var(--accent-faint);border:1px solid var(--line)';

  return `${head}
    <div style="${hintBg};border-radius:8px;padding:10px 13px;margin-bottom:12px;font-size:12px;color:var(--ink);line-height:1.5">${hint}</div>
    <div style="position:relative;">
      <span style="position:absolute;left:18px;top:18px;font-size:25px;color:var(--ink-soft);font-family:var(--mono);">€</span>
      <input id="ob-bill" class="ob-input mono" type="number" inputmode="numeric" min="50" max="1500" step="10" value="${_ob.bill}" style="padding-left:46px">
    </div>
    <div id="ob-bill-preview" class="ob-bill-preview" style="display:none"></div>`;
}

// ── Tap-first controls for the setup flow — no keyboard needed ──────────
function obSetVal(key, v){
  _ob[key] = v;
  // Panels/battery drive the SEAI grant — re-auto-calc unless the user has
  // typed their own grant value (the manual-grant lock).
  if ((key === 'count_A' || key === 'count_B' || key === 'battery_kwh') && !_ob.grant_touched && _ob.install_grant !== 0){
    _ob.install_grant = -1;
  }
  renderApp();
}
function obAdj(key, delta, min, max){
  let v = (+_ob[key] || 0) + delta;
  v = Math.min(max, Math.max(min, Math.round(v * 10) / 10));
  _ob[key] = v;
  if ((key === 'count_A' || key === 'count_B' || key === 'battery_kwh') && !_ob.grant_touched && _ob.install_grant !== 0){
    _ob.install_grant = -1;
  }
  renderAppDebounced();
}
function obStepper(key, val, min, max, unit){
  const btn = (d, sym) => `<button onclick="obAdj('${key}',${d},${min},${max})" style="width:46px;height:46px;border-radius:12px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink);font-size:20px;font-weight:700;font-family:var(--mono);cursor:pointer;flex-shrink:0">${sym}</button>`;
  return `<div style="display:flex;align-items:center;gap:10px">
    ${btn(-1, '−')}
    <div style="flex:1;text-align:center;font-family:var(--mono);font-size:25px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${val}<span style="font-size:12px;font-weight:400;color:var(--ink-soft)"> ${unit || ''}</span></div>
    ${btn(1, '+')}
  </div>`;
}
function obPills(key, val, options){
  const opts = options.slice();
  // Preserve any custom value the user already has — show it as its own pill
  if (!opts.some(([v]) => Math.abs(v - val) < 0.001)) opts.push([val, String(val)]);
  return `<div style="display:flex;flex-wrap:wrap;gap:7px">${opts.map(([v, l]) => `
    <div onclick="obSetVal('${key}',${v})" style="padding:9px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--line)'};background:${Math.abs(v - val) < 0.001 ? 'var(--accent-soft)' : 'var(--panel)'};color:${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--ink-soft)'}">${l}</div>`).join('')}</div>`;
}

function obStep6Solar(){
  return `
    <div class="ob-step-num">Step 4 of 5 · Solar (optional)</div>
    <h1 class="ob-title">Do you have or plan to add <em>solar</em>?</h1>
    <p class="ob-sub">No solar? Skip this step.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div onclick="_ob.has_solar=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${!_ob.has_solar?'var(--accent)':'var(--line)'};background:${!_ob.has_solar?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${!_ob.has_solar?'var(--accent)':'var(--ink)'}">No solar</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Don't have it</div>
      </div>
      <div onclick="_ob.has_solar=true; _ob.solar_status='have'; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent)':'var(--line)'};background:${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent)':'var(--ink)'}">I have it</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Already installed</div>
      </div>
      <div onclick="_ob.has_solar=true; _ob.solar_status='plan'; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent)':'var(--line)'};background:${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent)':'var(--ink)'}">Planning it</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Getting quotes</div>
      </div>
    </div>

    ${_ob.has_solar ? `
      <div class="ob-mini-section">
        <div class="ob-mini-title">${ic('home',14)} Front roof</div>
        <div class="ob-mini-label">Number of panels</div>
        <input id="ob-cA" class="ob-mini-input" type="number" inputmode="numeric" min="1" max="40" step="1" value="${_ob.count_A}">
        <div class="ob-mini-label" style="margin-top:14px">Roof tilt</div>
        ${obPills('tilt_A', _ob.tilt_A, [[20,'20° shallow'],[30,'30° typical'],[40,'40° steep'],[10,'10° flat-ish']])}
        <div class="ob-mini-label" style="margin-top:14px">Which way does this roof face?</div>
        ${compassWidget(_ob.azimuth_A, 'setObAzA')}
      </div>

      <div class="ob-toggle-row ${_ob.count_B > 0 ? 'active' : ''}" onclick="toggleRoofB()">
        <div class="ob-toggle-row-label">
          <div>${_ob.count_B > 0 ? '✓ Two-roof setup' : '+ Add a back roof'}</div>
          <div>${_ob.count_B > 0 ? `Back roof: ${_ob.count_B} panels facing ${COMPASS_POINTS.reduce((a,b)=>Math.abs(b.az-_ob.azimuth_B)<Math.abs(a.az-_ob.azimuth_B)?b:a).label}` : 'For homes with panels on two slopes'}</div>
        </div>
        <div class="toggle ${_ob.count_B > 0 ? 'active' : ''}"><div class="toggle-track"><div class="toggle-thumb"></div></div></div>
      </div>

      ${_ob.count_B > 0 ? `
        <div class="ob-mini-section">
          <div class="ob-mini-title">${ic('home',14)} Back roof</div>
          <div class="ob-mini-label">Number of panels</div>
          <input id="ob-cB" class="ob-mini-input" type="number" inputmode="numeric" min="1" max="40" step="1" value="${_ob.count_B}">
          <div class="ob-mini-label" style="margin-top:14px">Roof tilt</div>
          ${obPills('tilt_B', _ob.tilt_B, [[20,'20° shallow'],[30,'30° typical'],[40,'40° steep'],[10,'10° flat-ish']])}
          <div class="ob-mini-label" style="margin-top:14px">Which way does this roof face?</div>
          ${compassWidget(_ob.azimuth_B, 'setObAzB')}
        </div>
      ` : ''}

      <div class="ob-mini-section">
        <div class="ob-mini-title">${ic('battery',14)} Battery</div>
        <div class="ob-mini-label">Capacity in kWh (enter 0 if no battery)</div>
        <input id="ob-batt" class="ob-mini-input" type="number" inputmode="decimal" min="0" max="50" step="0.1" value="${_ob.battery_kwh}">
        <div style="margin-top:8px;font-size:12px;color:var(--ink-dim);font-family:var(--display);line-height:1.5">Typical: 5–13.5 kWh. Powerwall 13.5 · GivEnergy 9.5.</div>
      </div>

      ${_ob.battery_kwh > 0 ? `
      <div class="ob-mini-section">
        <div class="ob-mini-title">${ic('bolt',14)} Battery strategy</div>
        <p style="font-size:12px;color:var(--ink-dim);margin:0 0 10px;line-height:1.6;font-family:var(--display)">How should the battery charge?</p>
        <div onclick="_ob.strategy='auto';_ob.charge_from_grid=true;renderApp();" style="padding:12px 10px;margin-bottom:8px;border:1.5px solid ${_ob.strategy === 'auto' ? 'var(--accent)' : 'var(--line)'};border-radius:8px;cursor:pointer;background:${_ob.strategy === 'auto' ? 'var(--accent-soft)' : 'transparent'}">
          <div style="font-size:13px;font-weight:700;color:${_ob.strategy === 'auto' ? 'var(--accent)' : 'var(--ink)'}">Automatic (recommended)</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.5">We cost every plan with the setting that suits it: charging overnight from the grid where there's a cheap window, solar only where there isn't.</div>
        </div>
        <div style="display:flex;gap:8px">
          <div onclick="_ob.strategy='arbitrage';_ob.charge_from_grid=true;renderApp();" style="flex:1;padding:12px 10px;border:1.5px solid ${_ob.strategy === 'arbitrage' ? 'var(--accent)' : 'var(--line)'};border-radius:8px;cursor:pointer;background:${_ob.strategy === 'arbitrage' ? 'var(--accent-soft)' : 'transparent'}">
            <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${_ob.strategy === 'arbitrage' ? 'var(--accent)' : 'var(--ink-soft)'};letter-spacing:.06em">ARBITRAGE</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.5">Fills overnight, discharges at peak. Needs a night or EV plan.</div>
          </div>
          <div onclick="_ob.strategy='self-consume';_ob.charge_from_grid=false;renderApp();" style="flex:1;padding:12px 10px;border:1.5px solid ${_ob.strategy === 'self-consume' ? 'var(--blue)' : 'var(--line)'};border-radius:8px;cursor:pointer;background:${_ob.strategy === 'self-consume' ? 'rgba(41,182,246,.06)' : 'transparent'}">
            <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${_ob.strategy === 'self-consume' ? 'var(--blue)' : 'var(--ink-soft)'};letter-spacing:.06em">SELF-CONSUME</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.5">Fills from solar only.</div>
          </div>
        </div>
      </div>
      ` : ''}

      <div class="ob-mini-section">
        <div class="ob-mini-title">€ Install cost</div>
        <div class="ob-mini-grid">
          <div>
            <div class="ob-mini-label">Gross install (€)</div>
            <input id="ob-cost" class="ob-mini-input" type="number" inputmode="numeric" min="0" max="50000" step="100" value="${_ob.install_cost}">
          </div>
          <div>
            <div class="ob-mini-label">SEAI grant (€)</div>
            <input id="ob-grant" class="ob-mini-input" type="number" inputmode="numeric" min="0" max="5000" step="100" value="${_ob.install_grant >= 0 ? _ob.install_grant : calcSeaiGrant((_ob.count_A + _ob.count_B) * 440/1000, _ob.battery_kwh).total}">
          </div>
        </div>
        <p style="font-size:12px;color:var(--ink-dim);margin-top:6px;line-height:1.5;font-family:var(--display)">SEAI 2025: €900/kWp on the first 2 kWp, max €1,800.</p>
      </div>
    ` : ''}`;
}

function obStep7EV(){
  return `
    <div class="ob-step-num">Step 5 of 5 · Electric vehicle (optional)</div>
    <h1 class="ob-title">Do you have or plan to add an <em>EV</em>?</h1>
    <p class="ob-sub">An EV changes which plan wins.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div onclick="_ob.has_ev=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${!_ob.has_ev?'var(--accent)':'var(--line)'};background:${!_ob.has_ev?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${!_ob.has_ev?'var(--accent)':'var(--ink)'}">No EV</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Don't have one</div>
      </div>
      <div onclick="_ob.has_ev=true; _ob.ev_in_bill=true; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent)':'var(--line)'};background:${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent)':'var(--ink)'}">I have one</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">In my bill already</div>
      </div>
      <div onclick="_ob.has_ev=true; _ob.ev_in_bill=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent)':'var(--line)'};background:${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent)':'var(--ink)'}">Planning it</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Will add charging</div>
      </div>
    </div>

    ${_ob.has_ev ? `
      <div class="ob-mini-section">
        <div class="ob-mini-title">${ic('car',14)} Electric vehicle usage</div>
        <div class="ob-mini-grid">
          <div>
            <div class="ob-mini-label">Annual km</div>
            <input id="ob-evkm" class="ob-mini-input" type="number" inputmode="numeric" min="0" max="100000" step="500" value="${_ob.ev_km}">
          </div>
          <div>
            <div class="ob-mini-label">kWh per 100 km</div>
            <input id="ob-eveff" class="ob-mini-input" type="number" inputmode="decimal" min="5" max="35" step="0.5" value="${_ob.ev_eff}">
          </div>
        </div>
        <p style="font-size:12px;color:var(--ink-dim);margin-top:6px;line-height:1.5;font-family:var(--display)">Irish average 16,500 km/yr · small EV 14, mid 16–18, SUV 20+.</p>
      </div>
    ` : ''}`;
}

// Compass setters
function setObAzA(az){ _ob.azimuth_A = az; renderApp(); }
function setObAzB(az){ _ob.azimuth_B = az; renderApp(); }

function toggleRoofB(){
  if (_ob.count_B > 0){ _ob.count_B = 0; }
  else { _ob.count_B = 4; _ob.azimuth_B = 270; _ob.tilt_B = _ob.tilt_A; }
  renderApp();
}

function setObUsageMode(mode){
  if (mode === _ob.usage_mode) return;
  _ob.usage_mode = mode;
  if (mode === 'kwh' && !(+_ob.annual_kwh > 0)){
    _ob.annual_kwh = Math.round((_ob.bill || 200) * 6 / AVG_MARKET_RATE);
  }
  renderApp();
  if (mode === 'csv' && !state._csv_imported){
    // focus nothing — just make the upload affordance obvious
  }
}

function bindOnboarding(){
  // Step 1: region (no input — tap tiles or map). No binding required.
  // Step 3: bill
  const billEl = document.getElementById('ob-bill');
  if (billEl){
    billEl.addEventListener('input', e => {
      if (_ob.usage_mode === 'kwh') _ob.annual_kwh = +e.target.value || 0;
      else _ob.bill = +e.target.value || 0;
      updateBillPreview();
    });
    setTimeout(() => billEl.focus(), 100);
    updateBillPreview();
  }
  // Step 4: solar inputs (just capture changes, no re-render needed for numeric)
  ['ob-cA','ob-tiltA','ob-cB','ob-tiltB','ob-batt','ob-cost','ob-grant'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', e => {
      const v = +e.target.value;
      if (isNaN(v)) return;
      if (id === 'ob-cA')    _ob.count_A = v;
      if (id === 'ob-tiltA') _ob.tilt_A = v;
      if (id === 'ob-cB')    _ob.count_B = v;
      if (id === 'ob-tiltB') _ob.tilt_B = v;
      if (id === 'ob-batt')  _ob.battery_kwh = v;
      if (id === 'ob-cost'){ _ob.install_cost = v; _ob.cost_touched = true; }
      if (id === 'ob-grant'){ _ob.install_grant = v; _ob.grant_touched = true; }   // user override — sticks
      // When panels or battery change, reset grant back to auto-calc — but ONLY
      // if the user has never typed their own grant value (incl. 0)
      if ((id === 'ob-cA' || id === 'ob-cB' || id === 'ob-batt') && !_ob.grant_touched && _ob.install_grant !== 0){
        _ob.install_grant = -1; // re-auto-calc on next render
      }
    });
  });
  // Step 5: EV
  ['ob-evkm','ob-eveff'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', e => {
      const v = +e.target.value;
      if (isNaN(v)) return;
      if (id === 'ob-evkm')  _ob.ev_km = v;
      if (id === 'ob-eveff') _ob.ev_eff = v;
    });
  });
}

function validateEircodeOb(){
  const el = document.getElementById('ob-eircode-warning');
  if (!el) return;
  const v = _ob.address.trim().toUpperCase().replace(/\s+/g,' ');
  if (EIRCODE_RE.test(v)){
    el.style.display = 'block';
    el.className = 'ob-help warning';
    el.innerHTML = `<b style="color:var(--amber)">Eircode detected.</b> Eircode databases are proprietary. We'll proceed but for best results just use the town name.`;
  } else {
    el.style.display = 'none';
  }
}

function updateBillPreview(){
  const el = document.getElementById('ob-bill-preview');
  if (!el) return;
  if (_ob.usage_mode === 'kwh'){
    if (!_ob.annual_kwh || _ob.annual_kwh < 500){ el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `
      <div style="font-size:12px;color:var(--accent);font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px">Using your real consumption — no € guessing</div>
      <div style="font-family:var(--mono);font-size:17px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${(+_ob.annual_kwh).toLocaleString()} kWh/yr</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono)">shaped across the year by your ${_ob.heating} heating profile</div>`;
    return;
  }
  if (!_ob.bill || _ob.bill < 30){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  const bills = inferBillsFromEuro(_ob.bill, _ob.heating);
  const total = Object.values(bills).reduce((a,b)=>a+b,0);
  el.innerHTML = `
    <div style="font-size:12px;color:var(--accent);font-family:var(--display);letter-spacing:.02em;text-transform:uppercase;font-weight:700;margin-bottom:6px">Rough first estimate — refined against your plan at the end</div>
    <div style="font-family:var(--mono);font-size:17px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${total.toLocaleString()} kWh/yr</div>
    <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono)">~€${(_ob.bill * 6).toLocaleString()} per year</div>`;
}

function obNext(){
  // Validate each step
  if (_ob.step === 1 && !_ob.region){
    return;  // shouldn't happen — region tile defaults to 'east'
  }
  if (_ob.step === 2 && !state._csv_imported){
    // CSV chosen but not imported yet - don't block; they can import later.
    if (_ob.usage_mode === 'csv'){ _ob.step++; renderApp(); return; }
    const effMode = _ob.usage_mode;
    const bad = effMode === 'kwh' ? (!_ob.annual_kwh || _ob.annual_kwh < 500) : (!_ob.bill || _ob.bill < 30);
    if (bad){ const el = document.getElementById('ob-bill'); if (el) el.focus(); return; }
  }
  if (_ob.step < OB_TOTAL_STEPS){ _ob.step++; renderApp(); return; }
  // Final step — commit
  commitOnboarding();
}

function obBack(){
  if (_ob.step > 1){ _ob.step--; renderApp(); }
  else {
    // Back from step 1 returns to Home (if set up) or the landing page
    state.current_screen = state.onboarding_complete ? 'result' : 'welcome';
    saveState();
    renderApp();
  }
}

function commitOnboarding(){
  // Commit basics
  state.region = _ob.region || 'east';
  state.address = IRISH_REGIONS[state.region]?.name || '';   // human-readable label
  state.eircode = "";
  state.heating_type = _ob.heating;
  state.hot_water_strategy = _ob.hot_water_strategy || DEFAULT_HW_FOR_HEATING[_ob.heating] || 'none';
  state.baseline_discount_pct = _ob.baseline_known ? (+_ob.baseline_discount || 0) : 0;
  if (!state._csv_imported){
    // Manual usage anchors only apply when no smart-meter CSV is active —
    // imported interval data always outranks a typed € or kWh figure.
    // ('csv' without an actual import can't happen via the UI, but degrade safely.)
    state.usage_input_mode = (_ob.usage_mode === 'csv' ? 'bill' : _ob.usage_mode) || 'bill';
    state.annual_kwh = _ob.annual_kwh || 0;
    state.bimonthly_bill_eur = _ob.bill;
    state.bills = inferBillsFromEuro(_ob.bill, _ob.heating);
  }

  // Commit solar config
  state.has_solar = _ob.has_solar;
  // 'Planning it' = the panels don't exist yet: mark them planned + estimated
  state.solar_planned = !!(_ob.has_solar && _ob.solar_status === 'plan');
  state.solar_is_estimate = state.solar_planned;
  if (_ob.has_solar){
    state.count_A = _ob.count_A;
    state.azimuth_A = _ob.azimuth_A;
    state.tilt_A = _ob.tilt_A;
    state.count_B = _ob.count_B;
    state.azimuth_B = _ob.azimuth_B;
    state.tilt_B = _ob.tilt_B;
    state.battery_kwh = _ob.battery_kwh;
    state.install_cost = _ob.install_cost;
    // Grant: use user's manual value if set (≥0), else auto-calc
    const kwp = (_ob.count_A + _ob.count_B) * 440 / 1000;
    const autoGrant = calcSeaiGrant(kwp, _ob.battery_kwh).total;
    state.grant_seai = _ob.install_grant >= 0 ? _ob.install_grant : autoGrant;
    if (_ob.grant_touched) state.grant_is_manual = true;
    if (_ob.cost_touched)  state.cost_is_manual = true;
  } else {
    state.count_A = 0;
    state.count_B = 0;
    state.battery_kwh = 0;
    state.install_cost = 0;
    state.grant_seai = 0;
    // No system, so no price of one: a quote typed on an earlier run must not
    // be applied to whatever system is modelled next.
    state.cost_is_manual = false;
    state.grant_is_manual = false;
  }

  // Commit battery strategy from onboarding
  if (_ob.battery_kwh > 0){
    state.strategy_mode = _ob.strategy || 'auto';
    state.charge_from_grid = _ob.charge_from_grid !== false;
  } else {
    state.strategy_mode = 'auto';   // right for whatever battery is modelled later
    state.charge_from_grid = true;
  }

  // Commit EV
  state.ev_active = _ob.has_ev;
  state.ev_in_bill = _ob.has_ev ? _ob.ev_in_bill !== false : false;
  if (_ob.has_ev){
    state.ev_km_per_year = _ob.ev_km;
    state.ev_kwh_per_100km = _ob.ev_eff;
    // EV + battery always enables arbitrage (override self-consume if EV added later)
    if (state.battery_kwh > 0 && state.strategy_mode === 'arbitrage'){
      state.charge_from_grid = true;
      state.strategy_mode = 'arbitrage';
    }
  } else {
    state.ev_km_per_year = 0;
  }

  // Commit baseline plan selection
  state.baseline = _ob.baseline || 'EI-24';
  state.baseline_known = _ob.baseline_known || false;

  // Usage anchor: kWh ground truth replaces the € inference (needs the
  // committed baseline above so the derived display bill is computed on it)
  if (state.usage_input_mode === 'kwh') applyUsageInput();

  state.considering_solar = _ob.has_solar;
  // Solar configured during the full setup → the Solar tab should open on
  // "My system". Removed solar in this run → reset, so the tab's one-time
  // fastest-payback intro can fire again on the next visit.
  if (_ob.has_solar){
    state._solar_user_configured = true;
    state._solar_payback_intro_done = true;
  } else {
    state._solar_user_configured = false;
    state._solar_payback_intro_done = false;
  }
  state.onboarding_complete = true;
  state.current_screen = 'result';
  invalidate();
  saveState();
  trackObComplete();
  renderApp();
}

function confirmExitOnboarding(){
  if (confirm('Exit setup? You can come back any time — your progress isn\'t saved yet.')){
    state.current_screen = state.onboarding_complete ? 'result' : 'welcome';
    saveState();
    renderApp();
  }
}

/* ============================================================
   TARIFF STALENESS — warns users if rate data is >45 days old
   ============================================================ */
/**
 * Sorted verification dates for the plans that can actually be recommended.
 *
 * Discontinued plans are excluded: they are never offered, so their age says
 * nothing about the quality of the advice.
 */
function verifiedDates(){
  return (TARIFFS || [])
    .filter(t => !t.discontinued && t.verified_date)
    .map(t => t.verified_date)
    .sort();
}

const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 864e5);

/**
 * Is the rate data too old to advise on?
 *
 * Keyed on the OLDEST plan, not the newest. Keying on the newest meant a single
 * plan refreshed today silenced the warning for every other plan however stale,
 * which is exactly what happened: 25 of 26 plans sat 54 days old behind one
 * that had been re-scraped, and the banner never appeared.
 */
function checkTariffStaleness(){
  const dates = verifiedDates();
  if (!dates.length) return null;
  const oldest = dates[0];
  const days = daysSince(oldest);
  if (days <= 45) return null;
  const staleCount = dates.filter(d => daysSince(d) > 45).length;
  return { days, date: oldest, staleCount, total: dates.length };
}

/**
 * How fresh the rate data is, for the always-visible label.
 *
 * Reports the oldest plan, or a range when the set spans more than a week.
 * Quoting the newest date let one re-scraped plan claim currency on behalf of
 * the whole list — the app told users rates were verified today while most were
 * eight weeks old.
 */
function latestVerifiedLabel(){
  try {
    const dates = verifiedDates();
    if (!dates.length) return '';
    const oldest = dates[0];
    const newest = dates[dates.length - 1];
    if (daysSince(oldest) - daysSince(newest) <= 7) return fmtVerifiedDate(oldest);
    return `${fmtVerifiedDate(oldest)} – ${fmtVerifiedDate(newest)}`;
  } catch(e){ return ''; }
}

function fmtVerifiedDate(isoDate){
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-IE', { day:'numeric', month:'short', year:'numeric' });
}

/**
 * The freshness chip, when the plan we are recommending is one we do not trust.
 *
 * The staleness banner answers "how old is this data?" for the registry as a
 * whole. It cannot answer the more dangerous question, which is whether the
 * plan we just told someone to switch to is one of the ones in doubt.
 *
 * Two states earn the warning, and they are not the same thing. UNVERIFIED
 * means nobody has re-checked the plan against the supplier's own price list.
 * DISPUTED means somebody did, and a published source gave a different number
 * — Yuno's standard unit rate was 6c/kWh apart across two sources in August
 * 2026, which is more than enough to move a plan to the top of a ranking it
 * should not win.
 *
 * These plans stay in the comparison. Dropping them would quietly shrink the
 * market the reader thinks they are being shown, which is a worse lie than
 * "we are not certain about this one". The rule is disclose, not hide.
 *
 * It replaces the freshness chip rather than sitting beside it, for two
 * reasons. It is the same question, answered more precisely — two chips would
 * be two answers to one thing. And the home screen has a height budget of two
 * viewports, pinned by test; an extra block spent it and the test said so.
 */
function planDataFlag(plan){
  const notes = (plan && plan.notes) || '';
  if (/\bDISPUTED\b/.test(notes))   return 'disputed';
  if (/\bUNVERIFIED\b/.test(notes)) return 'unverified';
  return null;
}

function renderStalenessBanner(){
  const stale = checkTariffStaleness();
  if (!stale) return '';
  return `<div class="staleness-banner">
    <span class="staleness-icon">${ic('warn',13)}</span>
    <div><b>${stale.staleCount} of ${stale.total} plans not re-checked recently</b> — oldest verified ${fmtVerifiedDate(stale.date)}, ${stale.days} days ago. Suppliers can change rates without notice.
      <a href="#" onclick="event.preventDefault(); setScreen('plans')">See each plan's date →</a>
    </div>
  </div>`;
}

/* ============================================================
   TARIFF AUTO-REFRESH — calls server-side scraper
   ============================================================ */
async function refreshTariffs(){
  if (state._tariff_refreshing) return;
  state._tariff_refreshing = true;
  renderApp();
  try {
    const res = await fetch('/api/refresh-tariffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    // Static deployment returns 404 or HTML (not JSON) — treat as "API unavailable"
    if (!res.ok) {
      state._refresh_api_available = false;
      state._tariff_refreshing = false;
      saveState();
      renderApp();
      showToast('Tariff refresh runs on the dev server, not the static deploy. Showing verified-date stamps from the bundled data instead.', { type:'blue', icon:'ⓘ', title:'Live refresh unavailable' });
      return;
    }
    // Confirm it's actually JSON
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      state._refresh_api_available = false;
      state._tariff_refreshing = false;
      saveState();
      renderApp();
      showToast('Server returned non-JSON. The refresh API likely isn\u2019t wired in this deployment.', { type:'blue', icon:'ⓘ', title:'Live refresh unavailable' });
      return;
    }
    const data = await res.json();
    state._tariff_status = data;
    state._refresh_api_available = true;
    if (data.success) {
      // Reload the freshly written tariffs.json
      await loadTariffs();
      invalidate();
      const confirmed = data.plans_confirmed || 0;
      const changed   = (data.potential_changes || []).length;
      const unreached = (data.unreachable_suppliers || []).length;
      if (changed > 0){
        showToast(`${confirmed} plans confirmed · ${changed} possible rate change${changed>1?'s':''} detected`, { type:'amber', icon:ic('warn',16), title:'Refreshed with warnings' });
      } else if (unreached > 0 && confirmed === 0){
        // This used to say the suppliers had blocked us. They had not. The logs
        // showed eleven 404s and one bad certificate chain across twelve failed
        // requests — dead links after site reorganisations, and entirely our
        // problem to fix. Telling users it was anti-bot defence turned a bug
        // into a fact of life and kept anyone from looking at it for weeks.
        showToast(`Couldn't read ${unreached} supplier site${unreached>1?'s':''}. Showing the rates we last verified — that's a fault on our side, and it's logged.`, { type:'amber', icon:ic('warn',16), title:'Check incomplete' });
      } else {
        showToast(`Rates up to date · ${confirmed} plan${confirmed!==1?'s':''} confirmed`, { type:'accent', icon:ic('checkC',16), title:'Refreshed' });
      }
    } else {
      showToast(`Check failed: ${(data.error || 'unknown').slice(0,80)}`, { type:'amber', icon:ic('x',16) });
    }
  } catch(e){
    // Network error (offline, CORS, etc.) — also treat as API unavailable
    state._refresh_api_available = false;
    showToast(`Could not reach the refresh API. Showing last-verified dates instead.`, { type:'blue', icon:'ⓘ', title:'Offline or static build' });
  }
  state._tariff_refreshing = false;
  saveState();
  renderApp();
}

async function loadTariffStatus(){
  try {
    const res = await fetch('/api/tariff-status');
    if (!res.ok) {
      state._refresh_api_available = false;
      return;
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      state._refresh_api_available = false;
      return;
    }
    const data = await res.json();
    if (data && data.timestamp){
      state._tariff_status = data;
      state._refresh_api_available = true;
    }
  } catch(e){
    state._refresh_api_available = false;
  }
}

function navigateAuditor(){
  state.auditor_entry = true;
  state.current_screen = 'auditor';
  state.onboarding_complete = true;  // skip onboarding for auditor-first users
  // Set sane defaults so the engine doesn't crash
  if (!Object.keys(state.bills).length){
    state.bills = inferBillsFromEuro(200, 'gas');
    state.bimonthly_bill_eur = 200;
    state.heating_type = 'gas';
  }
  invalidate();
  saveState();
  renderApp();
}

/* ============================================================
   EV SAVINGS CARD — shown on result screen when EV is active.
   Makes the full economic picture clear: electricity cost goes
   up, but petrol displacement is much larger. Net = win.
   ============================================================ */
function renderEvSavingsCard(best){
  if (!state.ev_active) return '';
  const econ = evEconomics(best.plan.id);
  if (!econ) return '';

  const netSaving = econ.evVsPetrolNet;        // petrolCost - evElectricityCost
  const isPositive = netSaving > 0;
  // EV electricity cost IS the incremental electricity spend (EV charging load)
  const electricityCostIncrease = econ.evElectricityCost;

  return `<div style="margin-top:14px;padding:14px 16px;background:rgba(41,182,246,.06);border:1.5px solid var(--blue);border-radius:12px">
    <div style="font-family:var(--mono);font-size:12px;color:var(--blue);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('car',12,'vertical-align:-2px')} ${state.ev_in_bill ? 'Your EV vs running a petrol car' : 'If you get the EV — what changes'}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div style="padding:10px;background:${state.ev_in_bill ? 'var(--well)' : 'rgba(255,23,68,.06)'};border-radius:8px">
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">${state.ev_in_bill ? 'Charging cost (in your bill)' : 'Electricity added to your bill'}</div>
        <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:${state.ev_in_bill ? 'var(--ink)' : 'var(--loss)'};margin-top:3px">${state.ev_in_bill ? '' : '+'}${fmtCurrency(Math.round(electricityCostIncrease))}<span style="font-size:12px;font-weight:400">/yr</span></div>
        <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">${Math.round(econ.evKwh).toLocaleString()} kWh charging your ${econ.km.toLocaleString()} km</div>
      </div>
      <div style="padding:10px;background:var(--accent-faint);border-radius:8px">
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Petrol for the same km</div>
        <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--accent);margin-top:3px">−${fmtCurrency(Math.round(econ.petrolCost))}<span style="font-size:12px;font-weight:400">/yr</span></div>
        <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">${Math.round(econ.litres).toLocaleString()} L @ €${(state.fuel_price || 1.83).toFixed(2)}/L ${state.ev_in_bill ? "you're NOT buying" : "you'd avoid buying"}</div>
      </div>
    </div>
    <div style="padding:12px;background:${isPositive ? 'rgba(0,230,118,.08)' : 'rgba(255,145,0,.08)'};border-radius:8px;border:1px solid ${isPositive ? 'var(--accent)' : 'var(--amber)'}">
      <div style="font-family:var(--mono);font-size:12px;color:${isPositive ? 'var(--accent)' : 'var(--amber)'};text-transform:uppercase;letter-spacing:.08em">${state.ev_in_bill ? 'Your EV saves vs a petrol car' : 'Net transport saving if you get it'}</div>
      <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:${isPositive ? 'var(--accent)' : 'var(--amber)'};margin-top:3px">${isPositive ? '' : '-'}${fmtCurrency(Math.abs(Math.round(netSaving)))}<span style="font-size:12px;font-weight:400;color:var(--ink-soft)">/yr</span></div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono);line-height:1.6">
        = ${fmtCurrency(Math.round(econ.petrolCost))} petrol − ${fmtCurrency(Math.round(electricityCostIncrease))} charging · ${econ.km.toLocaleString()} km/yr
      </div>
    </div>
  </div>`;
}

/* ============================================================
   ENERGY HEALTH SCORE — one number people can improve, built
   only from values the engine already defends elsewhere.
   ============================================================ */
function computeEnergyScore(best, baseCost){
  const clamp = (v) => Math.max(1, Math.min(100, Math.round(v)));
  const parts = [];
  // Plan efficiency: the best plan's cost as a share of your current plan's,
  // both on the home as it is — solar and battery included. It compared your
  // bill WITHOUT solar against the best plan WITH it, so a solar home scored
  // 23 for "plan efficiency" when switching was worth €148 of a €551 bill:
  // the panels' earnings were being blamed on the tariff.
  const basePlanNow = getPlanById(state.baseline);
  const mineNow = annualCost(sim(basePlanNow.id), basePlanNow).net;
  const gap = mineNow - best.net;
  const planScore = gap <= 1 ? 100
    : mineNow <= 0 ? clamp(100 - gap / 10)       // already a net earner: score the euros left on the table
    : clamp(100 * Math.max(0, best.net) / mineNow);
  parts.push({ key:'plan', label:'Plan efficiency', score:planScore,
    why: planScore >= 99 ? "You're on the best plan for your usage" : `You pay ${fmtCurrency(Math.round(mineNow))}, best is ${fmtCurrency(Math.round(best.net))} — switching closes the gap`,
    fix: planScore >= 99 ? null : { label:`Switch and save ${fmtCurrency(Math.round(gap))}/yr`, go:"setScreen('plans')" } });
  // Solar: performance if installed, potential if not
  if (state.has_solar && totalPanels() > 0){
    const s = best.sim;
    const gen = sumF(CACHE.solar.total);
    const selfUse = gen > 0 ? Math.max(0, (gen - sumF(s.grid_export) - sumF(s.curtailed)) / gen) * 100 : 0;
    parts.push({ key:'solar', label:'Solar performance', score: clamp(35 + selfUse * 0.6 + (state.export_enabled !== false ? 8 : 0)),
      why: `${Math.round(selfUse)}% of generation used on-site${state.export_enabled === false ? ' · export payments OFF' : ''}`,
      fix: { label:'See the free changes that raise this', go:"setScreen('solar')" } });
  } else {
    const mult = (IRISH_REGIONS[state.region] || {}).ghi_multiplier || 1;
    parts.push({ key:'solar', label:'Solar potential', score: clamp(80 + (mult - 1) * 200),
      why: `${IRISH_REGIONS[state.region] ? IRISH_REGIONS[state.region].name : 'Your region'} yield ${mult >= 1 ? '+' : ''}${Math.round((mult-1)*100)}% vs national`,
      fix: { label:'Model a system for your roof', go:"setScreen('solar')" } });
  }
  // EV readiness: is the charging actually landing in a cheap window?
  if (state.ev_active){
    const basePlan = getPlanById(state.baseline);
    const baseHasWindow = !!(basePlan.windows && (basePlan.windows.ev || basePlan.windows.night));
    const bestHasWindow = !!(best.plan.windows && (best.plan.windows.ev || best.plan.windows.night));
    const evScore = clamp(baseHasWindow ? 92 : (bestHasWindow ? 58 : 45));
    parts.push({ key:'ev', label:'EV readiness', score:evScore,
      why: baseHasWindow ? 'Your plan has a cheap charging window' : 'Your current plan has no night/EV window — the recommended switch captures one',
      fix: baseHasWindow ? null : { label:'See plans with a cheap EV window', go:"setScreen('plans')" } });
  }
  // Export optimisation
  if (state.has_solar && totalPanels() > 0){
    const bestExport = Math.max(...TARIFFS.filter(t=>!t.discontinued).map(t=>t.export_rate || 0));
    const cur = (getPlanById(state.baseline).export_rate || 0);
    parts.push({ key:'export', label:'Export optimisation',
      score: state.export_enabled === false ? 15 : clamp(100 * cur / Math.max(0.01, bestExport)),
      why: state.export_enabled === false ? 'Export payments not registered — free money missed' : `Your export rate ${fmtCent(cur)} vs best available ${fmtCent(bestExport)}`,
      fix: state.export_enabled === false ? { label:'How to register for export payments', go:"setScreen('how-to-switch')" } : null });
  }
  const overall = clamp(parts.reduce((a,p)=>a+p.score,0) / parts.length);
  return { overall, parts };
}

/**
 * The health score, with its weakest factor stated up front.
 *
 * Collapsed, this used to read "58/100 — Energy health score, 3 factors" and
 * nothing else: an unexplained scale, unnamed factors and no action, delivered
 * immediately below the switch button. That is a criticism at the moment of
 * commitment. It now names what is dragging the score down and offers the one
 * thing that would raise it.
 */
function renderEnergyScore(best, baseCost){
  const s = computeEnergyScore(best, baseCost);
  const open = !!state._score_open;
  const tone = (v) => v >= 80 ? 'var(--accent)' : v >= 55 ? 'var(--amber)' : 'var(--loss)';
  const weakest = s.parts.reduce((a, p) => (p.score < a.score ? p : a), s.parts[0]);
  return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:10px 0;margin:-10px 0" onclick="state._score_open=!state._score_open;renderApp();">
        <div style="font-family:var(--mono);font-size:25px;font-weight:700;color:${tone(s.overall)}">${s.overall}<span style="font-size:12px;color:var(--ink-dim);font-weight:400">/100</span></div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--ink)">Energy health score</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);letter-spacing:.03em;margin-top:2px">${s.overall >= 80 ? 'Little left on the table' : 'Weakest: ' + weakest.label.toLowerCase()}</div>
        </div>
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink-dim)">${open ? '▴' : '▾'}</span>
      </div>
      ${!open && weakest && weakest.score < 80 ? `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-soft)">
          <div style="font-size:13px;color:var(--ink-soft);line-height:1.5">${weakest.why}.</div>
          ${weakest.fix && weakest.key !== 'plan' ? `<button class="btn-secondary" style="margin-top:8px" onclick="${weakest.fix.go}">${weakest.fix.label} →</button>` : ''}
        </div>` : ''}
      ${open ? s.parts.map(p => `
        <div style="margin-top:11px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
            <span style="color:var(--ink);font-weight:600">${p.label}</span>
            <span style="font-family:var(--mono);font-weight:700;color:${tone(p.score)}">${p.score}</span>
          </div>
          <div style="height:5px;background:var(--track-soft);border-radius:999px;overflow:hidden"><div style="height:100%;width:${p.score}%;background:${tone(p.score)};border-radius:999px"></div></div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:4px;line-height:1.5">${p.why}.</div>
          ${p.fix ? `<div style="margin-top:6px"><a href="#" onclick="event.preventDefault();${p.fix.go}" style="font-size:12px;color:var(--accent);text-decoration:underline;text-underline-offset:2px">${p.fix.label} →</a></div>` : ''}
        </div>`).join('') : ''}
    </div>`;
}

/* ============================================================
   GOAL DESIGNER CARD — pick a goal, get the best design for it.
   ============================================================ */
function renderGoalDesigner(){
  const view = state.solar_view || 'mine';
  const busy = !!state._goal_busy;
  const ck = goalSweepCk();
  const haveResults = CACHE._goalSweep_ck === ck && CACHE._goalSweep;
  const goalBtn = (g, icon, title, sub) => {
    const active = view === g;
    return `<div onclick="${g === 'mine' ? "setSolarView('mine')" : "startGoalDesign('" + g + "')"}" style="flex:1;padding:12px 10px;border-radius:12px;cursor:pointer;border:1.5px solid ${active ? 'var(--accent)' : 'var(--line)'};background:${active ? 'var(--accent-soft)' : 'var(--well)'}">
      <div style="margin-bottom:4px">${ic(icon,17)}</div>
      <div style="font-size:12px;font-weight:700;color:${active ? 'var(--accent)' : 'var(--ink)'};line-height:1.25">${title}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;line-height:1.4">${sub}</div>
    </div>`;
  };

  const selIdx = (state._goal_sel && state._goal_sel[view]) || 0;
  let body = '';
  if (busy){
    body = `<div style="margin-top:12px;padding:14px;background:var(--well);border-radius:12px;text-align:center">
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);letter-spacing:.04em">Simulating ${GOAL_PANELS.length * GOAL_BATTS.length} system designs × ${TARIFFS.filter(t=>!t.discontinued).length} plans on your usage…</div>
      <div style="height:4px;background:var(--track-soft);border-radius:999px;margin-top:10px;overflow:hidden"><div style="height:100%;width:55%;background:var(--accent);border-radius:999px;animation:pulse 1.1s ease infinite"></div></div>
    </div>`;
  } else if (view !== 'mine' && haveResults){
    const goal = view;
    const sweep = CACHE._goalSweep;
    const ranked = goal === 'npv' ? sweep.byNpv : sweep.byPayback;
    const win = ranked[Math.min(selIdx, ranked.length - 1)];
    const other = goal === 'npv' ? sweep.byPayback[0] : sweep.byNpv[0];
    const same = other.panels === win.panels && other.batt === win.batt;
    body = `
      <div style="margin-top:12px;margin-left:-16px;margin-right:-16px;padding:14px 16px;background:var(--accent-faint);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);border-left:3px solid var(--accent)">
        <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px">${goal === 'npv' ? 'Most value over 20 years' : 'Fastest payback'} — best design</div>
        <div style="font-size:17px;font-weight:800;color:var(--ink);font-family:var(--display)">${win.panels} panels (${win.kwp} kWp)${win.batt ? ' · ' + win.batt + ' kWh battery' : ' · no battery'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px">
          <div><div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">Payback</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${win.payback} yr</div></div>
          <div><div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">20-yr profit (NPV)</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">€${win.npv.toLocaleString()}</div></div>
          <div><div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">Est. cost after grant</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">~€${win.net.toLocaleString()}</div></div>
        </div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin-top:8px;line-height:1.6">€${win.benefit.toLocaleString()}/yr benefit on ${win.planLabel} · ~€${win.cost.toLocaleString()} <b>estimated</b> install − €${win.grant.toLocaleString()} SEAI grant · estimated from 2026 Irish market prices, not an installer quote</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--accent);margin-top:9px;letter-spacing:.04em">● LIVE PREVIEW — every card on this screen now shows this design</div>
        <button onclick="commitGoalDesign()" class="switch-cta" style="margin:10px 0 0;padding:13px;font-size:13px">Make this my system →</button>
      </div>
      ${!same ? `<div style="margin-top:10px;padding:0 2px;font-size:12px;color:var(--ink-soft);line-height:1.6">
        ${goal === 'npv'
          ? `The fastest-payback design (${other.panels} panels${other.batt ? ' + ' + other.batt + ' kWh' : ''}) breaks even in <b>${other.payback} yr</b> but earns <b>€${(win.npv - other.npv).toLocaleString()} less</b> over 20 years.`
          : `The value-maximising design (${other.panels} panels${other.batt ? ' + ' + other.batt + ' kWh' : ''}) takes <b>${other.payback} yr</b> to break even but earns <b>€${(other.npv - win.npv).toLocaleString()} more</b> over 20 years.`}
      </div>` : `<div style="margin-top:10px;padding:0 2px;font-size:12px;color:var(--ink-soft)">Both goals point to the same design for your home — an easy decision.</div>`}
      <div style="margin-top:8px;font-family:var(--display);font-size:12px;color:var(--ink-dim);line-height:1.6;letter-spacing:.02em">~ Prices are 2026 install estimates + auto SEAI grant — not quotes · benefit is electricity-only · 20-yr value discounted at 3%</div>`;
  }

  const isEstD = !!state.solar_is_estimate;
  return `
    <div class="card" style="margin-bottom:14px${isEstD ? ';border:1.5px dashed var(--blue)' : ''}">
      <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('target',12,'vertical-align:-2px')} Design my system</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.5;margin-bottom:10px">${view !== 'mine' ? `You're previewing an optimised design — your own setup is safe under <b style="color:var(--ink)">My system</b>.` : isEstD ? `The numbers below use an <b style="color:var(--ink)">estimated system</b> — our model, not your confirmed setup. Pick a goal to preview ${GOAL_PANELS.length * GOAL_BATTS.length} optimised designs, or set your exact panels below.` : `Switch views any time — the whole screen re-simulates instantly. Your own setup always lives under My system.`}</div>
      <div style="display:flex;gap:7px">
        ${goalBtn('mine', 'home', 'My system', view === 'mine' ? 'Your configuration — live now' : 'Back to your own setup')}
        ${goalBtn('payback', 'bolt', 'Fastest payback', 'Smallest spend, soonest break-even')}
        ${goalBtn('npv', 'chart', 'Most 20-yr value', 'Maximise total 20-yr profit')}
      </div>
      ${(() => {
        // P1.5: delta strip — only shown when a design preview is active and we have results + a "my system" snapshot
        if (view === 'mine' || !haveResults || !state.my_system) return '';
        const goal = view;
        const sweep = CACHE._goalSweep;
        const selIdxD = (state._goal_sel && state._goal_sel[view]) || 0;
        const ranked = goal === 'npv' ? sweep.byNpv : sweep.byPayback;
        const win = ranked[Math.min(selIdxD, ranked.length - 1)];
        const myPanels = (state.my_system.count_A || 0) + (state.my_system.count_B || 0);
        const myBatt = state.my_system.battery_kwh || 0;
        const panelDelta = win.panels - myPanels;
        const battDelta = win.batt - myBatt;
        const costDelta = win.net - (state.my_system.install_cost || 0) + (state.my_system.grant_seai || 0);
        const parts = [];
        if (panelDelta !== 0) parts.push(`${panelDelta > 0 ? '+' : ''}${panelDelta} panels`);
        if (battDelta !== 0) parts.push(`${battDelta > 0 ? '+' : ''}${battDelta.toFixed(1)} kWh battery`);
        if (Math.abs(costDelta) > 100) parts.push(`${costDelta > 0 ? '+' : ''}€${Math.abs(Math.round(costDelta)).toLocaleString()} install`);
        if (parts.length === 0) parts.push('same system');
        return `<div style="margin-top:8px;padding:8px 12px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;font-family:var(--mono);font-size:12px;color:var(--ink-soft);letter-spacing:.02em">
          <b style="color:var(--ink)">vs my system:</b> ${parts.join(' · ')}
        </div>`;
      })()}
      ${body}
      <div style="display:flex;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid var(--line-soft);align-items:center;justify-content:space-between">
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim)">${isEstD ? 'Install ~' + fmtCurrency(state.install_cost) + ' est. · grant −' + fmtCurrency(state.grant_seai) : 'Know your exact spec?'}</div>
        <button onclick="goRefineSolar()" style="flex-shrink:0;padding:8px 13px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--blue);background:transparent;color:var(--blue);cursor:pointer">Set my exact system →</button>
      </div>
      ${isEstD ? `<div onclick="markSolarAsMine()" style="margin-top:8px;text-align:center;font-size:12px;color:var(--ink-soft);text-decoration:underline;cursor:pointer">These match my real system — mark as confirmed</div>` : ''}
    </div>`;
}

/* ============================================================
   LOGIC BREAKDOWN — "show your working" for the power user.
   Transparent kWh accounting so Persona 1 can audit the engine.
   ============================================================ */
function renderLogicBreakdown(){
  if (!state.has_solar || !CACHE.solar || !CACHE.cons) return '';
  if (CACHE.dirty) rebuildBase();
  const bp = getBestPlan();
  if (!bp || !bp.sim || !bp.sim.grid_export) return '';
  const sim = bp.sim;
  const _sf = (arr) => arr && arr.length ? sumF(arr) : 0;
  const gen = Math.round(_sf(CACHE.solar && CACHE.solar.total));
  const exp = Math.round(_sf(sim.grid_export));
  const curt = Math.round(_sf(sim.curtailed));
  const selfUse = Math.max(0, gen - exp - curt);
  const battIn = Math.round(_sf(sim.battery_charge));
  const battOut = Math.round(_sf(sim.battery_discharge));
  const gridImp = Math.round(_sf(sim.grid_import));
  const selfPct = gen > 0 ? Math.round(selfUse/gen*100) : 0;
  const open = !!state._logic_open;
  return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px 0;margin:-12px 0" onclick="state._logic_open=!state._logic_open;renderApp()">
        <div style="font-family:var(--mono);font-size:12px;color:var(--blue);letter-spacing:.1em;text-transform:uppercase;font-weight:700;flex:1">${ic('flask',12,'vertical-align:-2px')} Energy flow breakdown</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim)">${open?'▴':'▾'}</div>
      </div>
      ${open ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:var(--accent-faint);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--accent);text-transform:uppercase;letter-spacing:.06em">Generated</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--accent);margin-top:2px">${gen.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh/yr</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">From your ${totalKwp().toFixed(1)} kWp array</div>
        </div>
        <div style="background:var(--well);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Used on-site</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${selfUse.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">${selfPct}% of generation</div>
        </div>
        <div style="background:var(--well);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Exported to grid</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${exp.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">Paid at ${fmtCent(getBestPlan().plan.export_rate||0)}/kWh</div>
        </div>
        <div style="background:var(--well);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Grid import</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${gridImp.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">From supplier (cheapest window)</div>
        </div>
      </div>
      ${(state.battery_kwh||0) > 0 ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <div style="background:var(--amber-soft);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em">Battery charged</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${battIn.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">Solar + grid ${state.charge_from_grid ? '(arbitrage)' : '(solar only)'}</div>
        </div>
        <div style="background:var(--amber-soft);border-radius:8px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:12px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em">Battery discharged</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${battOut.toLocaleString()}<span style="font-size:12px;font-weight:400"> kWh</span></div>
          <div style="font-size:12px;color:var(--ink-dim);margin-top:2px">Round-trip eff: ${Math.round(state.battery_eff*100*state.battery_eff*100)/100}%</div>
        </div>
      </div>` : ''}
      ${curt > 0 ? `<div style="margin-top:8px;padding:9px 12px;background:rgba(255,145,0,.06);border-radius:8px;font-size:12px;color:var(--ink-soft)">⚠ ${curt.toLocaleString()} kWh curtailed (export limit or export disabled) — enable export to capture this.</div>` : ''}
      ` : ''}
    </div>`;
}

/* ============================================================
   NIGHT RATE / ARBITRAGE VISIBILITY CARD
   Surfaces hidden savings from night-rate plans and battery
   arbitrage — shown prominently on the result screen.
   ============================================================ */
function renderNightRateCard(best, baseCost){
  // Find the best plan that has a genuine night rate (night < day * 0.6)
  const nightPlans = TARIFFS.filter(t => !t.discontinued && t.rates && t.rates.night && t.rates.night < (t.rates.day || 99) * 0.6);
  if (!nightPlans.length) return '';

  // What does the best night-rate plan cost at the user's current usage?
  // Use already-cached sim results (no extra computation)
  let bestNight = null, bestNightCost = Infinity;
  for (const p of nightPlans){
    try {
      const s = sim(p.id);
      const c = annualCost(s, p).net;
      if (c < bestNightCost){ bestNightCost = c; bestNight = p; }
    } catch(e){}
  }
  if (!bestNight) return '';

  const alreadyOnNight = best.plan.rates && best.plan.rates.night && best.plan.rates.night < (best.plan.rates.day || 99) * 0.6;
  if (alreadyOnNight) return ''; // user is already on a night rate plan, no need to prompt

  const extraSaving = best.net - bestNightCost;
  if (extraSaving < 80) return ''; // not worth showing unless meaningful uplift

  const nightRate = (bestNight.rates.night * 100).toFixed(1);
  const dayRate   = (bestNight.rates.day   * 100).toFixed(1);

  return `<div style="margin-top:14px;padding:14px 16px;background:var(--amber-faint);border:1.5px solid var(--amber);border-radius:12px">
    <div style="font-family:var(--mono);font-size:12px;color:var(--amber);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:6px">${ic('bolt',12,'vertical-align:-2px')} Night-rate savings unlocked</div>
    <div style="font-size:13px;font-weight:700;color:var(--ink);line-height:1.4">An extra <span style="color:var(--amber)">${fmtCurrency(Math.round(extraSaving))}/yr</span> if you shift loads to off-peak</div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin-top:6px;line-height:1.65">
      ${bestNight.supplier} — ${bestNight.plan} has a <b style="color:var(--ink)">${nightRate}c/kWh night rate</b> vs ${dayRate}c/kWh day.<br>
      Run dishwasher, washing machine &amp; hot water at <b style="color:var(--ink)">2am–8am</b> to capture this saving.
    </div>
  </div>`;
}

/**
 * Freshness as an object rather than a paragraph.
 *
 * This was a five-line amber banner sitting above the answer — the first thing
 * a new reader met was an apology about our data. The honesty is worth keeping;
 * it is the reason a stale-rate problem was ever visible. But a dot and four
 * words carry it, and they carry it *after* the answer instead of in front of
 * it. Tapping still opens the per-plan dates.
 */
function freshnessChip(plan){
  const flag = planDataFlag(plan);
  if (flag){
    const supplier = (plan && plan.supplier) || 'the supplier';
    const label = flag === 'disputed'
      ? `Confirm this plan's rates with ${supplier} \u2014 sources disagree`
      : `Confirm this plan's rates with ${supplier} \u2014 not re-checked`;
    return `<button class="fresh-chip is-stale" onclick="setScreen('plans')">
      <span class="fresh-dot" aria-hidden="true"></span>${label}<span class="fresh-chev">\u203a</span>
    </button>`;
  }
  const stale = checkTariffStaleness();
  const label = stale
    ? `Rates last checked ${stale.days} days ago`
    : `Rates verified ${fmtVerifiedDate(latestVerifiedDate())}`;
  return `<button class="fresh-chip ${stale ? 'is-stale' : ''}" onclick="setScreen('plans')">
    <span class="fresh-dot" aria-hidden="true"></span>${label}<span class="fresh-chev">\u203a</span>
  </button>`;
}

function latestVerifiedDate(){
  const dates = (TARIFFS || []).map(t => t.verified_date).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * A plan whose supplier has ANNOUNCED a price change that has not taken effect
 * yet. The rates shown are still today's; this warns the reader what is coming
 * and confirms it is already in the yearly figure (annualCost weights an
 * announced rise across the part of the contract it will apply to). Nothing is
 * shown once the date has passed — by then the rates themselves are updated.
 */
function priceChangeChip(plan){
  const pc = plan && plan.price_change;
  if (!pc || !pc.effective_date) return '';
  const eff = new Date(`${pc.effective_date}T00:00:00Z`);
  if (isNaN(eff.getTime()) || eff.getTime() <= Date.now()) return '';
  // The headline % is the biggest band move, since Irish rises are uneven (a
  // night rate can jump far more than the day rate); "up to" makes that honest.
  const bandPcts = pc.pct_bands ? Object.values(pc.pct_bands) : [];
  const worst = Math.max(Math.abs(pc.pct || 0), ...bandPcts.map((v) => Math.abs(v || 0)));
  const pct = Math.round(worst * 100);
  const uneven = bandPcts.length > 0 && Math.min(...bandPcts.map((v) => Math.abs(v || 0))) < worst - 0.005;
  const rising = (worst >= 0) && ((pc.pct || 0) >= 0 || bandPcts.some((v) => (v || 0) > 0));
  const when = eff.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  const verb = rising ? 'rises' : 'falls';
  return `<div class="price-change-note ${rising ? 'is-rise' : 'is-fall'}">
    <span class="fresh-dot" aria-hidden="true"></span>
    <span>${(plan.supplier || 'The supplier')} ${verb} this plan's rates
    ${uneven ? 'by up to ' : ''}${pct}% on ${when}
    — already counted in the yearly figure above.</span>
  </div>`;
}

/**
 * The inputs behind the figure, and how they were turned into it — one card.
 *
 * This and "How we calculated this" sat one under the other and listed the
 * same usage, heating and system twice. The card now says each input once,
 * adds the few only the other panel had (the area's sunshine, hot water,
 * battery strategy), and keeps the method behind a single "how it works".
 */
function renderAssumptions(setupLabel){
  const kwh = Math.round(Object.values(state.bills || {}).reduce((a,b)=>a+b,0));
  const region = IRISH_REGIONS[state.region || 'east'];
  const sun = region ? Math.round((region.ghi_multiplier - 1) * 100) : 0;
  const hw = state.hot_water_strategy && state.hot_water_strategy !== 'none' ? ` · ${state.hot_water_strategy} hot water` : '';
  const strat = state.battery_kwh > 0 && state.has_solar
    ? ` · battery ${({ auto: 'automatic', arbitrage: 'charges cheap, uses at peak', self: 'self-consume' })[state.strategy_mode] || state.strategy_mode}` : '';
  const dates = (TARIFFS || []).map(t => t.verified_date).filter(Boolean).sort();
  const latest = dates.length ? dates[dates.length - 1] : null;
  return `<div class="card based-on" style="margin-bottom:14px">
    <div class="card-label">${ic('info',13)} What this is based on</div>
    <div class="based-on-line">
      ${region ? `${esc(region.name)} (${sun >= 0 ? '+' : ''}${sun}% sun) · ` : ''}${kwh.toLocaleString()} kWh a year · ${esc(state.heating_type)} heating${hw} · ${setupLabel}${strat}
    </div>
    <div class="based-on-src">
      ${state._csv_imported
        ? `Usage from the smart-meter data you imported.`
        : `Usage estimated from your €${state.bimonthly_bill_eur} two-month bill.
           <a href="#" onclick="event.preventDefault();setScreen('csv-import')">Import smart-meter data</a> for exact figures.`}
    </div>
    ${configChips()}
    <div class="based-on-links">
      <a href="#" onclick="event.preventDefault();openMyHome()">Change my home</a>
      <a href="#" onclick="event.preventDefault();openMySystem()">Change my system</a>
    </div>
    <details class="based-on-how">
      <summary>How the figure is worked out</summary>
      <p>Every plan is simulated hour by hour, all 8,760 hours of a year, against your usage and your panels' output: sunshine calibrated per region (PVGIS), the sun's position for your roof, and panel heat losses. The battery follows the strategy above. Dynamic plans follow wholesale prices with the CRU 50c cap.</p>
      <p><b>Not modelled:</b> real weather (a typical year, ±5–8% against any actual one), shading on your roof, future price changes, and EV charging smarter than cheap-window timing. Check big decisions with an installer.</p>
      <p class="based-on-data">Data: PVGIS · SEMOpx · CRU${latest ? ` · prices verified ${fmtVerifiedDate(latest)}` : ''}</p>
    </details>
  </div>`;
}

// Typical 2026 Irish install price for a spec — same benchmarks the quote
// auditor uses (midpoint of €950-1,200/kWp + €350-480/kWh + €1,100-1,300 fixed).
// Calibrated against real Cork-market quotes: 12 panels + 9 kWh ≈ €9.5k-12k gross.
// 20-yr NPV — same constants as the NPV breakdown card (3% discount, 0.5%/yr
// panel degradation, battery replacement at year 12 priced €400/kWh).
function computeNpv20(annualBenefit, sysCostNet, batteryKwh){
  const r = 0.03, deg = 0.005;
  let cumulative = -sysCostNet;
  for (let y = 1; y <= 20; y++){
    cumulative += (annualBenefit * Math.pow(1 - deg, y - 1)) / Math.pow(1 + r, y);
    if (batteryKwh > 0 && y === 12) cumulative -= 400 * batteryKwh / Math.pow(1 + r, 12);
  }
  return Math.round(cumulative);
}

// ════════════════════════════════════════════════════════════
// GOAL-DRIVEN SYSTEM DESIGNER
// Sweeps candidate designs (panels × battery) against all plans on the
// user's real load, ONCE, then both goals read from the same table:
//   'payback' → minimise net-cost / annual-benefit
//   'npv'     → maximise 20-yr discounted value
// Costs use the 2026 install benchmark + auto SEAI grant. Benefit is the
// electricity-only solar benefit — identical convention to the hero.
// ════════════════════════════════════════════════════════════
const GOAL_PANELS = [6, 9, 12, 15];
const GOAL_BATTS  = [0, 5, 10];

function goalSweepCk(){
  return JSON.stringify(['goalsweep', state.region, state.heating_type, state.bimonthly_bill_eur,
    JSON.stringify(state.bills), state.ev_active, state.ev_in_bill, state.ev_km_per_year,
    state.ev_kwh_per_100km, state.azimuth_A, state.tilt_A, state.panel_w, state.hot_water_strategy,
    // The roof as it is used: one face, or two and how the panels share them.
    state.count_B > 0 ? [state.azimuth_B, state.tilt_B, +(state.count_B / Math.max(1, totalPanels())).toFixed(2)] : 0]);
}

function sweepGoalDesigns(){
  const ck = goalSweepCk();
  if (CACHE._goalSweep_ck === ck && CACHE._goalSweep) return CACHE._goalSweep;

  // Eight fields by hand once. battery_kwh was in the list; strategy_mode was
  // not, and zeroing the battery below made the sanitiser rewrite it — which is
  // how arbitrage switched itself off while the reader was only looking at a
  // screen.
  const snap = snapshotSim();
  const az = state.azimuth_A || 180;
  const tilt = state.tilt_A || 30;
  const ev = !!state.ev_active;
  // Every size is laid out on the roof as the home uses it: on two faces,
  // shared in the same proportion. Sizing on one face dropped the second.
  const two = state.count_B > 0, azB = state.azimuth_B, tiltB = state.tilt_B;
  const shareB = two ? state.count_B / Math.max(1, totalPanels()) : 0;

  _scenarioDepth += 1;
  try {

  // Shared no-solar reference (one run for all 12 designs)
  state.count_A = 0; state.count_B = 0; state.battery_kwh = 0; state.has_solar = false;
  invalidate(); rebuildBase();
  const noSolarCost = getBestPlan().net;

  const designs = [];
  for (const p of GOAL_PANELS){
    for (const b of GOAL_BATTS){
      const nB = Math.round(p * shareB), nA = p - nB;
      state.count_A = nA; state.count_B = nB; state.azimuth_A = az; state.tilt_A = tilt;
      if (two){ state.azimuth_B = azB; state.tilt_B = tiltB; }
      state.battery_kwh = b; state.has_solar = true;
      const kwp = totalKwp();
      const cost = estimateInstallCost(kwp, b);
      const grant = calcSeaiGrant(kwp, b).total;
      const net = cost - grant;
      state.install_cost = cost; state.grant_seai = grant;
      invalidate(); rebuildBase();
      const best = getBestPlan();
      const benefit = Math.max(0, noSolarCost - best.net);
      const payback = benefit > 0 ? net / benefit : 999;
      designs.push({ panels: p, a: nA, b: nB, batt: b, kwp: +kwp.toFixed(1), cost, grant, net,
        benefit: Math.round(benefit), payback: +payback.toFixed(1),
        npv: computeNpv20(benefit, net, b), planId: best.plan.id,
        planLabel: best.plan.supplier + ' — ' + best.plan.plan });
    }
  }

  restoreSim(snap);
  invalidate(); rebuildBase();

  const byPayback = designs.slice().sort((a,b) => a.payback - b.payback || a.net - b.net);
  const byNpv     = designs.slice().sort((a,b) => b.npv - a.npv || a.payback - b.payback);
  const out = { designs, byPayback, byNpv, noSolarCost: Math.round(noSolarCost) };
  CACHE._goalSweep_ck = ck;
  CACHE._goalSweep = out;
  return out;

  } finally { _scenarioDepth -= 1; }
}

/**
 * The single best system for this household.
 *
 * The tab used to open on a chooser: "fastest payback" against "most 20-year
 * value", each with its own ranked list to page through. That is an analyst's
 * framing. A homeowner is not deciding between two objective functions, they
 * are deciding whether to spend twelve thousand euro, and asking them to pick a
 * metric first is asking them to do our job.
 *
 * One answer instead, defined so it can be defended in a sentence: of the
 * designs that come within 5% of the best twenty-year value, the cheapest.
 * Best value without spending more than you need to. Payback, saving and cost
 * are quoted alongside it, so anyone who does care about a faster return can
 * see exactly what they would be trading.
 */
function bestDesign(){
  const sweep = sweepGoalDesigns();
  if (!sweep || !sweep.designs || !sweep.designs.length) return null;
  const worthwhile = sweep.designs.filter(d => d.npv > 0 && d.payback < 25);
  const pool = worthwhile.length ? worthwhile : sweep.designs;
  const topNpv = Math.max(...pool.map(d => d.npv));
  if (!(topNpv > 0)) return null;
  const nearBest = pool.filter(d => d.npv >= topNpv * 0.95);
  return nearBest.reduce((a, b) => (b.net < a.net ? b : a));
}

/** Adopt the recommended design as the user's own system. */
function applyBestDesign(){
  const d = bestDesign();
  if (!d) return;
  state.solar_view = 'mine';
  applySystemConfig(designToConfig(d));
  state.considering_solar = true;
  state.solar_is_estimate = true;
  snapshotMySystem();
  saveState();
  renderApp();
  showToast(`${d.kwp} kWp${d.batt ? ' + ' + d.batt + ' kWh battery' : ''} — ${d.payback.toFixed(1)} yr payback`,
    { type:'accent', icon:ic('checkC',16) });
}

/**
 * The recommended system, as one card.
 *
 * Replaces a three-way chooser — "My system", "Fastest payback", "Most 20-yr
 * value" — that asked the reader to pick an objective function before they
 * could see a number. When the reader is already on the recommendation there is
 * nothing to switch to, so the card says so in one line instead of restating
 * the spec the hero below already carries.
 */
let _sweepScheduled = false;

/**
 * Run the design sweep off the critical path.
 *
 * Twelve designs, each a full year simulated against every tariff, is about two
 * and a half seconds — fine to wait for, unacceptable to block the first paint
 * with. The screen shows a working answer immediately and this upgrades it.
 */
function scheduleGoalSweep(){
  if (_sweepScheduled) return;
  _sweepScheduled = true;
  const run = () => {
    try { sweepGoalDesigns(); } catch (e) { /* additive */ }
    _sweepScheduled = false;
    // Swap the placeholder for the result rather than re-rendering the screen.
    // A full repaint a second after landing detaches whatever the reader was
    // reaching for — it broke a click on the day inspector mid-gesture.
    try {
      const slot = document.querySelector('.opt-note.is-working');
      if (slot){
        const html = renderOptimisedSuggestion();
        const holder = document.createElement('div');
        holder.innerHTML = html;
        const node = holder.firstElementChild;
        if (node) slot.replaceWith(node); else slot.remove();
        enhanceA11y();
      }
    } catch (e) { /* the placeholder simply stays */ }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 60);
}

function renderOptimisedSuggestion(){
  const ready = CACHE._goalSweep_ck === goalSweepCk() && CACHE._goalSweep;
  if (!ready){
    scheduleGoalSweep();
    return `<div class="opt-note is-working">
      ${ic('spark',14)} <span>Checking whether a different size would suit you better…</span>
    </div>`;
  }
  const goals = designGoals();
  if (!goals.length) return '';
  const sel = goals.find((g) => g.keys.includes(state._opt_sel)) || goals[0];
  const mine = (d) => totalPanels() === d.panels && (state.battery_kwh || 0) === d.batt;
  const hasNow = state.has_solar && totalPanels() > 0;
  let curPb = null;
  try { const scen = computeSolarPaybackScenarios(); const c = state.ev_active ? scen.withEv : scen.withoutEv; if (c && c.payback < 50) curPb = c.payback; } catch (e) {}

  /*
   * Systems by what they're for. One suggestion against yours hid the choice
   * people actually make: spend less, get it back sooner, make the most over
   * the years, or rely least on the grid. Each tile is one of the twelve
   * designs simulated for this home, labelled by the goal it wins.
   */
  return `<div class="opt-card opt-goals">
    <div class="opt-card-head">${ic('spark',15)} <span>Systems for your roof, by what matters to you</span></div>
    ${hasNow ? `<div class="opt-yours">Yours now: <b>${totalPanels()} panels${state.battery_kwh ? ` · ${state.battery_kwh} kWh battery` : ' · no battery'}</b>${curPb ? ` · ${curPb.toFixed(1)} yr payback` : ''}</div>` : ''}
    <div class="opt-tiles" role="radiogroup" aria-label="Choose a system">
      ${goals.map((g) => `<button class="opt-tile ${g === sel ? 'on' : ''}" role="radio" aria-checked="${g === sel}" onclick="state._opt_sel='${g.keys[0]}';renderApp()">
        <span class="opt-tile-k">${ic(g.icon, 16)} ${g.labels.join(' · ')}${mine(g.d) ? '<i>yours</i>' : ''}</span>
        <span class="opt-tile-why">${g.why}</span>
        <span class="opt-tile-spec">${g.d.panels} panels · ${g.d.batt ? `${g.d.batt} kWh battery` : 'no battery'}</span>
        <span class="opt-tile-figs"><span><b>${fmtCurrency(g.d.net)}</b>after grant</span><span><b>${g.d.payback.toFixed(1)} yrs</b>payback</span><span><b>${fmtCurrency(g.d.npv)}</b>over 20 yrs</span></span>
      </button>`).join('')}
    </div>
    ${mine(sel.d) ? `<div class="opt-note">${ic('checkC',14)} <span>That’s the system you have now.</span></div>`
      : `<button class="opt-card-btn" onclick="useGoalDesign('${sel.keys[0]}')">Use this system: ${sel.d.panels} panels${sel.d.batt ? ` + ${sel.d.batt} kWh` : ''}</button>`}
  </div>`;
}

/** The simulated designs, one per goal; a design that wins two goals is shown once. */
function designGoals(){
  const sweep = sweepGoalDesigns();
  if (!sweep || !sweep.designs || !sweep.designs.length) return [];
  const ok = sweep.designs.filter((d) => d.npv > 0 && d.payback < 25);
  const pool = ok.length ? ok : sweep.designs;
  const pick = [
    { key: 'value', icon: 'trendUp', label: 'Best value', why: 'Most back over 20 years, without overspending', d: bestDesign() },
    { key: 'payback', icon: 'clock', label: 'Fastest payback', why: 'Pays for itself soonest', d: pool.slice().sort((a, b) => a.payback - b.payback || a.net - b.net)[0] },
    { key: 'cost', icon: 'euro', label: 'Lowest cost', why: 'Smallest outlay that still pays off', d: pool.slice().sort((a, b) => a.net - b.net || a.payback - b.payback)[0] },
    { key: 'own', icon: 'battery', label: 'Most of your own power', why: 'Biggest system: least bought from the grid', d: sweep.designs.slice().sort((a, b) => (b.panels - a.panels) || (b.batt - a.batt))[0] },
  ].filter((g) => g.d);
  const out = [];
  for (const g of pick){
    const same = out.find((o) => o.d.panels === g.d.panels && o.d.batt === g.d.batt);
    if (same){ same.labels.push(g.label); same.keys.push(g.key); }
    else out.push({ keys: [g.key], labels: [g.label], icon: g.icon, why: g.why, d: g.d });
  }
  return out;
}

/** Adopt the design shown for a goal as the household's own system. */
function useGoalDesign(key){
  const g = designGoals().find((x) => x.keys.includes(key));
  if (!g) return;
  const d = g.d;
  state.solar_view = 'mine';
  applySystemConfig(designToConfig(d));
  state.considering_solar = true;
  state.solar_is_estimate = true;
  snapshotMySystem();
  saveState();
  renderApp();
  showToast(`${d.panels} panels${d.batt ? ' + ' + d.batt + ' kWh battery' : ''}: ${d.payback.toFixed(1)} yr payback`, { type: 'accent', icon: ic('checkC', 16) });
}

function startGoalDesign(goal){
  state._goal = goal;
  setSolarView(goal);
}

// ── Solar view switcher ──────────────────────────────────────
// state.solar_view: 'mine' | 'payback' | 'npv'. The whole dashboard always
// renders whatever view is active; 'mine' is the user's own configuration,
// snapshotted before any design preview so it can never be lost.
const SYS_KEYS = ['has_solar','count_A','count_B','azimuth_A','azimuth_B','tilt_A','tilt_B',
                  'battery_kwh','install_cost','grant_seai','solar_is_estimate','solar_planned'];

function snapshotMySystem(){
  const s = {};
  SYS_KEYS.forEach(k => s[k] = state[k]);
  state.my_system = s;
}

function applySystemConfig(cfg){
  SYS_KEYS.forEach(k => { if (cfg[k] !== undefined) state[k] = cfg[k]; });
  invalidate();
}

function designToConfig(d){
  return { has_solar: true, count_A: d.a ?? d.panels, count_B: d.b ?? 0,
    azimuth_A: state.azimuth_A || 180, tilt_A: state.tilt_A || 30,
    battery_kwh: d.batt, install_cost: d.cost, grant_seai: d.grant,
    solar_is_estimate: true, solar_planned: state.my_system && state.my_system.has_solar ? !!state.my_system.solar_planned : true };
}

function setSolarView(view, idx){
  if (view === 'mine'){
    state.solar_view = 'mine';
    if (state.my_system) applySystemConfig(state.my_system);
    saveState(); renderApp(); return;
  }
  // entering a design view: protect the user's own config first
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  state.solar_view = view;
  if (idx !== undefined) state._goal_sel = Object.assign({}, state._goal_sel, { [view]: idx });
  const ck = goalSweepCk();
  if (!(CACHE._goalSweep_ck === ck && CACHE._goalSweep)){
    state._goal_busy = true;
    renderApp();
    setTimeout(() => {
      try { sweepGoalDesigns(); } catch(e){}
      state._goal_busy = false;
      _applyViewDesign();
    }, 60);
    return;
  }
  _applyViewDesign();
}

function _applyViewDesign(){
  const sweep = CACHE._goalSweep;
  const view = state.solar_view;
  if (!sweep || view === 'mine'){ saveState(); renderApp(); return; }
  const ranked = view === 'npv' ? sweep.byNpv : sweep.byPayback;
  const idx = (state._goal_sel && state._goal_sel[view]) || 0;
  const d = ranked[Math.min(idx, ranked.length - 1)];
  applySystemConfig(designToConfig(d));
  saveState(); renderApp();
}

// Commit: the previewed design becomes the user's own system everywhere.
function commitGoalDesign(){
  if ((state.solar_view || 'mine') === 'mine') return;
  snapshotMySystem();   // current live values ARE the design — save them as mine
  state.solar_view = 'mine';
  if (!state.considering_solar) state.considering_solar = true;
  saveState(); renderApp();
  showToast('This design is now your system — shown across the whole app', { type:'accent', icon:ic('sun',16) });
}

// Back-compat shim (older onclick strings in cached DOM)
function applyGoalDesign(idx){ setSolarView(state._goal || 'payback', idx || 0); }

function estimateInstallCost(kwp, battKwh){
  // Non-linear: a fixed base (inverter, scaffolding, labour baseline) is paid
  // regardless of array size, then panels get cheaper per kWp at scale.
  //   base €2,900 · first 3 kWp at €950/kWp · beyond 3 kWp at €750/kWp
  //   battery: €800 hybrid-inverter/install premium + €380/kWh
  // Sanity: 5.5 kWp + 9 kWh ≈ €11,800 (real 2026 Cork quote: €11,400).
  const panelCost = kwp <= 3 ? kwp * 950 : 3 * 950 + (kwp - 3) * 750;
  const battCost = (battKwh || 0) > 0 ? 800 + battKwh * 380 : 0;
  return Math.round((2900 + panelCost + battCost) / 100) * 100;
}

function applyEstimatedSolarCost(){
  const kwp = totalKwp();
  // Respect manual overrides: a user-typed cost or grant (including €0 — e.g.
  // not grant-eligible) must survive toggles, cycles and re-onboarding.
  // A typed €0 grant is real (not eligible); a €0 installation never is — it
  // is the reset left by choosing "no solar", and kept as a "manual" price it
  // gave every newly modelled system a 0-year payback.
  if (!state.cost_is_manual || !(state.install_cost > 0)) {
    state.install_cost = estimateInstallCost(kwp, state.battery_kwh || 0);
    state.cost_is_manual = false;
  }
  if (!state.grant_is_manual) state.grant_seai = calcSeaiGrant(kwp, state.battery_kwh || 0).total;
}

/* ── SOLAR, STEP BY STEP ──────────────────────────────────────
 * The first look at solar is four small decisions and a reveal, not a
 * dashboard. Each step changes one thing in the model (the same values
 * My system edits) and starts on a sensible suggestion, so "Next" four
 * times gives a good estimate. The reveal shows the payback, and the full
 * analysis is one tap after it. */
const SG_STEPS = 5;
let _sgBefore = null;
function startSolarGuide(){
  // Nothing the guide changes counts until its answer is accepted: leaving
  // early puts the home back exactly as it was.
  _sgBefore = structuredClone(state);
  try { localStorage.setItem('pk_sg_before', JSON.stringify(_sgBefore)); } catch (e) {}
  // Start from the same suggested system as before: sized to the usage.
  exploreSolar();
  state.solar_planned = true;            // explored here, not bought: never "installed"
  state.current_screen = 'solar-guide';
  state._sg = 0;
  guidePush('solar-guide', 0);
  saveState();
  renderApp();
}
function sgCancel(){
  if (!_sgBefore){ try { _sgBefore = JSON.parse(localStorage.getItem('pk_sg_before') || 'null'); } catch (e) {} }
  try { localStorage.removeItem('pk_sg_before'); } catch (e) {}
  if (_sgBefore){ for (const k of Object.keys(state)) if (!(k in _sgBefore)) delete state[k]; Object.assign(state, _sgBefore); }
  _sgBefore = null;
  state._sg = null; state._sheet = null;
  // Back where it was opened (Home, or the Solar screen), never a bare screen.
  if (NO_SHEET_SCREENS.includes(state.current_screen) || !state.current_screen) state.current_screen = 'result';
  invalidate(); saveState(); renderApp(); window.scrollTo(0, 0);
}
function sgGo(step, fromHistory){
  const was = state._sg;
  state._sg = Math.max(0, Math.min(SG_STEPS, step));
  if (!fromHistory && state._sg > (was || 0)) guidePush('solar-guide', state._sg);
  renderApp();
  window.scrollTo(0, 0);
}
function sgDone(){
  state._sg = null; _sgBefore = null;
  try { localStorage.removeItem('pk_sg_before'); } catch (e) {}
  state._an_from = 'result';
  state._an_tab = 'solar';
  state.current_screen = 'solar';
  saveState();
  renderApp();
}
function sgKeep(){
  state._sg = null; _sgBefore = null;
  try { localStorage.removeItem('pk_sg_before'); } catch (e) {}
  state.current_screen = 'result';
  saveState(); renderApp(); window.scrollTo(0, 0);

}
function sgRoof(face){
  const map = { S: [180, 0, 0], SE: [135, 0, 0], SW: [225, 0, 0], EW: [90, 270, 1], E: [90, 0, 0], W: [270, 0, 0] };
  const [a, b, split] = map[face] || map.S;
  state.azimuth_A = a;
  if (split){ const t = totalPanels(); state.count_A = Math.ceil(t / 2); state.count_B = Math.floor(t / 2); state.azimuth_B = b; }
  else { state.count_A = totalPanels(); state.count_B = 0; }
  state._sg_face = face;
  if (face !== 'unsure') (state.fine = state.fine || {}).roof = true;
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState();
  sgGo(2);
}
/** Two roof faces in the guide: any pair of directions, panels split evenly to start. */
const SG_DIRS = [['S', 'South', 180], ['SE', 'South-east', 135], ['SW', 'South-west', 225], ['E', 'East', 90], ['W', 'West', 270]];
function sgTwo(face, dir){
  const t = Math.max(2, totalPanels());
  const az = Object.fromEntries(SG_DIRS.map(([k, , a]) => [k, a]));
  if (!state._sg_two) state._sg_two = { a: 'E', b: 'W' };
  if (face) state._sg_two[face] = dir;
  state.azimuth_A = az[state._sg_two.a]; state.azimuth_B = az[state._sg_two.b];
  state.count_A = Math.ceil(t / 2); state.count_B = Math.floor(t / 2);
  state._sg_face = '2F';
  (state.fine = state.fine || {}).roof = true;
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState(); renderApp();
}
function sgBattery(k){ sysSet('battery_kwh', k); }
function sgGrant(){
  if ((state.grant_seai || 0) > 0){ state.grant_seai = 0; state.grant_is_manual = true; }
  else { state.grant_is_manual = false; applyEstimatedSolarCost(); }
  invalidate(); saveState(); renderApp();
}

function renderSolarGuide(){
  const step = state._sg ?? 1;
  const kwh = Math.round(v7AnnualKwh());
  const suggest = Math.max(6, Math.min(16, Math.round(kwh / 450)));
  const head = (k, title, sub) => `
    <div class="sg-top">
      <button class="sg-back" onclick="${step === 0 ? 'sgCancel()' : `sgGo(${step - 1})`}" aria-label="Back">${ic('chevL', 18)}</button>
      <div class="sg-progress" aria-label="Step ${step} of ${SG_STEPS}"><i style="width:${step / SG_STEPS * 100}%"></i></div>
      <span class="sg-count">${step}/${SG_STEPS}</span>
    </div>
    <div class="sg-k">${k}</div>
    <h1 class="sg-h">${title}</h1>
    ${sub ? `<p class="sg-sub">${sub}</p>` : ''}`;
  const next = (label = 'Next') => `<button class="fp-cta sg-next" onclick="sgGo(${step + 1})">${label} ${ic('chevR', 18)}</button>`;
  let body = '';

  if (step === 0){
    body = `<div class="sg-top"><button class="sg-back" onclick="sgCancel()" aria-label="Back">${ic('chevL', 18)}</button></div>
      <div class="sg-intro-ico">${ic('sun', 34)}</div>
      <h1 class="sg-h">Would solar pay off here?</h1>
      <p class="sg-sub">Four quick questions: which way your roof faces, how many panels, a battery, and the price. Each starts on a sensible guess, so you can just tap Next.</p>
      <ul class="sg-promise"><li>${ic('check', 14)} About a minute</li><li>${ic('check', 14)} Nothing changes on your Home unless you keep the answer</li><li>${ic('check', 14)} Leave any time with Back</li></ul>
      <button class="fp-cta sg-next" onclick="sgGo(1)">Start ${ic('chevR', 18)}</button>
      <button class="sg-link sg-skip" onclick="sgCancel()">Not now</button>`;
  } else if (step === 1){
    const faces = [['S', 'South', 'Best all day'], ['SE', 'South-east', 'Strong mornings'], ['SW', 'South-west', 'Strong afternoons'],
      ['E', 'East', 'Mornings'], ['W', 'West', 'Evenings'], ['2F', 'Two roof faces', 'Panels on two sides']];
    const az = (f) => ({ S: 0, SE: -45, SW: 45, E: -90, W: 90 })[f];
    const two = state._sg_face === '2F' && state._sg_two;
    const dirRow = (face, label) => `<div class="sg-two-row"><span>${label}</span><div class="sg-chips">${SG_DIRS.map(([k, l]) =>
      `<button class="sg-chip ${two[face] === k ? 'on' : ''}" aria-pressed="${two[face] === k}" onclick="sgTwo('${face}','${k}')">${l}</button>`).join('')}</div></div>`;
    body = `${head('Step 1 · Your roof', 'Which way does your roof face?', 'The side that gets the sun. A compass app helps.')}
      <div class="sg-tiles">${faces.map(([f, l, s]) => `<button class="sg-tile ${state._sg_face === f ? 'on' : ''}" onclick="${f === '2F' ? 'sgTwo()' : `sgRoof('${f}')`}">
        <svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="26" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/>
          ${f === '2F' ? '<path d="M30 30 L14 18 M30 30 L46 18" stroke="var(--brand-gold)" stroke-width="5" stroke-linecap="round"/>'
            : `<path d="M30 30 L30 13" stroke="var(--brand-gold)" stroke-width="5" stroke-linecap="round" transform="rotate(${az(f) + 180} 30 30)"/>`}
          <text x="30" y="56" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">S</text></svg>
        <b>${l}</b><small>${s}</small></button>`).join('')}</div>
      ${two ? `<div class="sg-two">${dirRow('a', 'First face')}${dirRow('b', 'Second face')}
        <p class="sg-sub">Panels are split evenly to start; set the exact numbers in My system.</p>${next()}</div>` : ''}
      <button class="sg-link" onclick="sgRoof('unsure')">Not sure: assume south</button>
      <button class="sg-link sg-skip" onclick="sgGo(5)">Skip: just estimate it for me</button>`;
  } else if (step === 2){
    const n = totalPanels();
    body = `${head('Step 2 · Panels', 'How many panels?', `For ${kwh.toLocaleString('en-IE')} kWh a year we suggest <b>${suggest}</b>. Most Irish roofs fit 8 to 16.`)}
      <div class="sg-big"><b id="sg-n">${n}</b><span>panels</span></div>
      <input class="sg-range" type="range" min="4" max="24" step="1" value="${n}" aria-label="Number of panels"
        oninput="document.getElementById('sg-n').textContent=this.value" onchange="sysSet('count_A', ${state.count_B > 0 ? 'Math.ceil(this.value/2)' : 'this.value'}); ${state.count_B > 0 ? "sysSet('count_B', Math.floor(this.value/2));" : ''}">
      <div class="sg-scale"><span>4</span><span>Suggested ${suggest}</span><span>24</span></div>
      ${next()}`;
  } else if (step === 3){
    const b = +state.battery_kwh || 0;
    const opts = [[0, 'No battery', 'Cheapest to install. Spare solar is sold to the grid.'],
      [5, '5 kWh', 'Covers a typical evening. The usual choice.'],
      [10, '10 kWh', 'Covers most evenings, and can charge on cheap night rates.']];
    body = `${head('Step 3 · Battery', 'Add a battery?', 'It stores the day’s solar for the evening, when power costs most.')}
      <div class="sg-opts">${opts.map(([k, l, s]) => `<button class="sg-opt ${b === k ? 'on' : ''}" onclick="sgBattery(${k})"><b>${l}</b><small>${s}</small></button>`).join('')}</div>
      <label class="sg-own ${b && ![5, 10].includes(b) ? 'on' : ''}"><span>Another size</span>
        <input type="number" inputmode="decimal" min="0" max="${SYS_MAX_BATTERY}" step="0.5" placeholder="e.g. 7.5" value="${b && ![5, 10].includes(b) ? b : ''}" onchange="sgBattery(this.value)" aria-label="Battery size in kWh"><em>kWh</em></label>
      ${next()}`;
  } else if (step === 4){
    const net = Math.max(0, (state.install_cost || 0) - (state.grant_seai || 0));
    body = `${head('Step 4 · Price', 'What would it cost?', 'A typical 2026 Irish price for this system, with the SEAI grant taken off.')}
      <div class="sg-big"><b>${eur(net)}</b><span>after the ${eur(state.grant_seai || 0)} grant</span></div>
      <label class="sg-own ${state.cost_is_manual ? 'on' : ''}"><span>Price including VAT, before the grant</span>
        <em>€</em><input type="number" inputmode="numeric" min="0" step="100" value="${Math.round(state.install_cost || 0)}" onchange="sysSet('install_cost', this.value)" aria-label="Price including VAT"></label>
      <button class="v7-switch-row sg-grant" role="switch" aria-checked="${(state.grant_seai || 0) > 0}" onclick="sgGrant()">
        <span class="v7-switch-text"><b>SEAI grant</b><small>${(state.grant_seai || 0) > 0 ? `${eur(state.grant_seai)} taken off` : 'Not included: not eligible, or already claimed'}</small></span>
        <span class="v7-switch ${(state.grant_seai || 0) > 0 ? 'on' : ''}" aria-hidden="true"><i></i></span></button>
      <button class="sg-link" onclick="v7Sheet('quote')">${ic('clip', 14)} I have a quote: read it for me</button>
      ${next('Show me the answer')}`;
  } else {
    let d = null; try { d = v7SolarData(); } catch (e) {}
    const pb = d && d.cur.payback < 50 ? d.cur.payback : null;
    body = `${head('Your answer', pb ? `It pays for itself in` : 'Here is what it does', '')}
      <div class="sg-reveal">
        <div class="sg-reveal-fig"><b>${pb ? pb.toFixed(1) : '—'}</b><span>years</span></div>
        <div class="sg-facts">
          <div><b>${eur(d ? d.cur.solarBenefit : 0)}</b><small>back every year</small></div>
          <div><b>${eur(d ? d.sysCost : 0)}</b><small>to install, after the grant</small></div>
          <div><b class="${d && d.npv >= 0 ? 'is-gain' : ''}">${eur(d ? d.npv : 0)}</b><small>ahead over 20 years</small></div>
        </div>
        ${d && d.best && d.best.plan ? `<div class="sg-found">${ic('spark', 14)}<span>Found for you: with panels, your best plan is <b>${esc(d.best.plan.supplier)} ${esc(d.best.plan.plan)}</b>. This answer assumes you switch to it, and counts only what the panels add.</span></div>` : ''}
        <div class="sg-sys">${totalPanels()} panels${state.battery_kwh > 0 ? ` · ${state.battery_kwh} kWh battery` : ' · no battery'} · ${({ S: 'south', SE: 'south-east', SW: 'south-west', EW: 'east and west', E: 'east', W: 'west' })[state._sg_face] || 'south'}-facing</div>
      </div>
      <button class="fp-cta sg-next" onclick="sgKeep()">Add to my Home as a plan ${ic('checkC', 18)}</button>
      <button class="sg-link sg-skip" onclick="sgCancel()">Not now: leave my Home as it was</button>`;
  }
  return `<div class="fp-wrap sg">${body}</div>${V7.sheet()}`;
}

/* ── AN ELECTRIC CAR, STEP BY STEP ────────────────────────────
 * Same shape as the solar guide: four one-tap decisions, each starting on
 * a typical Irish value, then the reveal — what the car costs to run here,
 * what it saves against petrol, and the cheapest hours to charge. Backing
 * out of step one leaves the home exactly as it was. */
const EG_STEPS = 5;
let _egBefore = null;
function startEvGuide(){
  _egBefore = { ev_active: state.ev_active, ev_km_per_year: state.ev_km_per_year, ev_in_bill: state.ev_in_bill,
    ev_kwh_per_100km: state.ev_kwh_per_100km, ev_charger_kw: state.ev_charger_kw, current_screen: state.current_screen };
  if (!state.ev_active) toggleEv();
  if (!(state.ev_km_per_year > 0)) state.ev_km_per_year = 16000;
  state._sheet = null;
  state.current_screen = 'ev-guide';
  state._eg = 1;
  guidePush('ev-guide', 1);
  invalidate(); saveState(); renderApp();
}
function egCancel(){
  if (_egBefore){ const back = _egBefore.current_screen; delete _egBefore.current_screen; Object.assign(state, _egBefore); state.current_screen = NO_SHEET_SCREENS.includes(back) || back === 'ev-guide' ? 'result' : back; }
  else state.current_screen = 'result';
  state._eg = null; _egBefore = null;
  invalidate(); saveState(); renderApp();
}
function egGo(step, fromHistory){
  const was = state._eg;
  state._eg = Math.max(1, Math.min(EG_STEPS, step));
  if (!fromHistory && state._eg > (was || 0)) guidePush('ev-guide', state._eg);
  renderApp(); window.scrollTo(0, 0);
}
function egSet(key, v, next){
  state[key] = typeof v === 'string' && key !== 'ev_in_bill' ? +v : v;
  invalidate(); saveState();
  if (next) egGo(next); else renderApp();
}
function egDone(){
  delete state._ev_left_out;
  state._eg = null; _egBefore = null;
  state._an_from = 'result';
  state._an_tab = 'car';
  state.current_screen = 'analytics';
  saveState(); renderApp(); window.scrollTo(0, 0);
}

function renderEvGuide(){
  const step = state._eg || 1;
  const hhmm = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  const head = (k, title, sub) => `
    <div class="sg-top">
      <button class="sg-back" onclick="${step === 1 ? 'egCancel()' : `egGo(${step - 1})`}" aria-label="Back">${ic('chevL', 18)}</button>
      <div class="sg-progress" aria-label="Step ${step} of ${EG_STEPS}"><i style="width:${step / EG_STEPS * 100}%"></i></div>
      <span class="sg-count">${step}/${EG_STEPS}</span>
    </div>
    <div class="sg-k">${k}</div>
    <h1 class="sg-h">${title}</h1>
    ${sub ? `<p class="sg-sub">${sub}</p>` : ''}`;
  const next = (label = 'Next') => `<button class="fp-cta sg-next" onclick="egGo(${step + 1})">${label} ${ic('chevR', 18)}</button>`;
  const opt = (on, click, title, sub) => `<button class="sg-opt ${on ? 'on' : ''}" onclick="${click}"><b>${title}</b><small>${sub}</small></button>`;
  let body = '';

  if (step === 1){
    body = `${head('Step 1 · Your car', 'Do you have an electric car?', 'We’ll add it to your home and find the cheapest way to charge it.')}
      <div class="sg-opts">
        ${opt(state.ev_in_bill, "egSet('ev_in_bill', true, 2)", 'Yes, I have one', 'Its charging is already in my electricity bill.')}
        ${opt(!state.ev_in_bill, "egSet('ev_in_bill', false, 2)", 'I’m thinking about one', 'Show me what it would add, and what it would save on petrol.')}
      </div>
      <button class="sg-link sg-skip" onclick="egCancel()">Not now</button>`;
  } else if (step === 2){
    const km = state.ev_km_per_year || 16000;
    body = `${head('Step 2 · Driving', 'How far do you drive in a year?', 'The Irish average is about 16,000 km. Your NCT cert or service record shows it.')}
      <div class="sg-big"><b id="eg-km">${Math.round(km).toLocaleString('en-IE')}</b><span>km</span></div>
      <input class="sg-range" type="range" min="3000" max="40000" step="500" value="${km}" aria-label="Kilometres a year"
        oninput="document.getElementById('eg-km').textContent=(+this.value).toLocaleString('en-IE')" onchange="egSet('ev_km_per_year', this.value)">
      <div class="sg-chips">${[8000, 12000, 16000, 25000].map((v) => `<button class="sy-stop ${Math.round(km) === v ? 'on' : ''}" onclick="egSet('ev_km_per_year', ${v})">${(v / 1000)}k</button>`).join('')}</div>
      ${next()}`;
  } else if (step === 3){
    const e = state.ev_kwh_per_100km || 17;
    body = `${head('Step 3 · The car', 'What kind of car?', 'Bigger cars use more electricity for each kilometre.')}
      <div class="sg-opts">
        ${opt(e <= 15, "egSet('ev_kwh_per_100km', 14, 4)", 'Small', 'Like a Renault Zoe or a Fiat 500e · about 14 kWh per 100 km')}
        ${opt(e > 15 && e < 19, "egSet('ev_kwh_per_100km', 17, 4)", 'Family car', 'Like a Tesla Model 3, Kia Niro or VW ID.3 · about 17')}
        ${opt(e >= 19, "egSet('ev_kwh_per_100km', 20, 4)", 'SUV or large', 'Like a Model Y, Enyaq or ID.4 · about 20')}
      </div>`;
  } else if (step === 4){
    const kw = state.ev_charger_kw || 7;
    body = `${head('Step 4 · Charging', 'How do you charge at home?', 'This decides how much of the charging fits into the cheapest hours.')}
      <div class="sg-opts">
        ${opt(kw >= 6, "egSet('ev_charger_kw', 7.4, 5)", 'A wall charger', '7.4 kW · a full charge overnight in a few cheap hours')}
        ${opt(kw < 6, "egSet('ev_charger_kw', 2.3, 5)", 'A normal plug', '2.3 kW · slower, so some charging spills into dearer hours')}
      </div>
      <div class="sg-note">No charger yet? Pick the wall charger: the SEAI grant helps with one.</div>`;
  } else {
    let ev = null, plan = null, cheap = null;
    try {
      const rec = getRecommendation(); plan = rec.best.plan; ev = evEconomics(plan.id);
      cheap = plan.windows && plan.windows.ev ? `${hhmm(plan.windows.ev[0])}–${hhmm(plan.windows.ev[1])}` : plan.windows && plan.windows.night ? `${hhmm(plan.windows.night[0])}–${hhmm(plan.windows.night[1])}` : null;
    } catch (e) {}
    const save = ev ? ev.evVsPetrolNet : 0;
    body = `${head('Your answer', save > 0 ? 'Against petrol, you save' : 'Here is what it costs', '')}
      <div class="sg-reveal">
        <div class="sg-reveal-fig"><b>${eur(Math.abs(save))}</b><span>a year</span></div>
        <div class="sg-facts">
          <div><b>${eur(ev ? ev.evElectricityCost : 0)}</b><small>to charge it, a year</small></div>
          <div><b>${eur(ev ? ev.petrolCost : 0)}</b><small>of petrol you don’t buy</small></div>
          <div><b>${ev ? Math.round(ev.evKwh).toLocaleString('en-IE') : 0}</b><small>kWh a year</small></div>
        </div>
        <div class="sg-sys">${plan ? `On ${esc(plan.supplier)} ${esc(plan.plan)}${cheap ? `, charging ${cheap}` : ''}` : ''}</div>
      </div>
      <button class="fp-cta sg-next" onclick="egDone()">See my EV in full ${ic('chevR', 18)}</button>
      <button class="sg-link" onclick="egGo(1)">Change my answers</button>`;
  }
  return `<div class="fp-wrap sg">${body}</div>`;
}

/* ── THE FIRST VISIT: ONE PAGE THAT REVEALS ITSELF ─────────────
 * Five questions, each answered with a tap and each applied to the model
 * at once: the bill, the current plan, heating, solar, a car. Solar and the
 * car open their own short branch in place. An answered question folds
 * into a line that can be reopened with "Change", so the person always sees
 * what the answer is built on. The end is the answer itself, then one offer
 * to keep the home in an account. */
const FLOW_Q = ['bill', 'plan', 'heat', 'solar', 'ev'];
function flowSteps(){
  const f = state._flow || {}, out = [];
  for (const q of FLOW_Q){
    out.push(q);
    if (q === 'solar' && (f.solar === 'have' || f.solar === 'thinking')) out.push('roof', 'panels', 'battery');
    if (q === 'ev' && (f.ev === 'have' || f.ev === 'thinking')) out.push('km', 'car');
  }
  return out;
}
/* Guides keep their own history entries, so the phone's Back gesture steps
   back through them instead of leaving the app or skipping two screens. */
function guidePush(kind, step){ try { history.pushState({ guide: kind, step }, '', '#' + kind); } catch (e) {} }

function startFlow(){
  guidePush('flow', 0);
  state._flow = {}; state._flow_edit = null;
  if (!state.region) state.region = 'east';
  state.usage_input_mode = 'bill';
  if (!state.baseline){ state.baseline = 'EI-24'; state.baseline_known = false; }
  state.current_screen = 'flow';
  saveState(); renderApp();
}
const _flowSuggest = () => Math.max(6, Math.min(16, Math.round(v7AnnualKwh() / 450)));
function flowAnswer(q, v){
  const f = state._flow = state._flow || {};
  const was = f[q]; f[q] = v;
  const clear = (keys) => keys.forEach((k) => delete f[k]);
  if (q === 'bill'){ state.usage_input_mode = 'bill'; state.bimonthly_bill_eur = Math.max(30, Math.round(+v) || 250); }
  if (q === 'plan') state._flow_sup = null;
  if (q === 'plan' && String(v).startsWith('guess:')){
    const g = getPlanById(String(v).slice(6));
    if (g && !['ev', 'dynamic'].includes(g.type)){ state.baseline = g.id; state.baseline_known = false; }
    else { state.baseline = 'EI-24'; state.baseline_known = false; }
  } else if (q === 'plan'){ if (v === 'unsure'){ state.baseline = 'EI-24'; state.baseline_known = false; } else { state.baseline = v; state.baseline_known = true; } }
  if (q === 'heat'){ state.heating_type = v; state.hot_water_strategy = DEFAULT_HW_FOR_HEATING[v] || 'none'; }
  if (q === 'bill' || q === 'heat') applyUsageInput();
  if (q === 'solar'){
    if (was !== v) clear(['roof', 'panels', 'battery']);
    if (v === 'no'){ state.has_solar = false; state.considering_solar = false; state.count_A = 0; state.count_B = 0; state.battery_kwh = 0; }
    else {
      state.has_solar = true; state.considering_solar = true; state.solar_is_estimate = false;
      state.solar_planned = v === 'thinking';
      if (!(totalPanels() > 0)) { state.count_A = _flowSuggest(); state.count_B = 0; }
      state.cost_is_manual = false; state.grant_is_manual = false;
    }
  }
  if (q === 'roof'){
    const m = { S: [180, 0], SE: [135, 0], SW: [225, 0], EW: [90, 270], SESW: [135, 225] }[v] || [180, 0];
    const t = totalPanels() || _flowSuggest();
    state.azimuth_A = m[0];
    if (m[1]){ state.azimuth_B = m[1]; state.count_A = Math.ceil(t / 2); state.count_B = Math.floor(t / 2); } else { state.count_A = t; state.count_B = 0; }
    if (v !== 'unsure') (state.fine = state.fine || {}).roof = true;
  }
  if (q === 'panels'){ const n = +v; if (state.count_B > 0){ state.count_A = Math.ceil(n / 2); state.count_B = Math.floor(n / 2); } else state.count_A = n; }
  if (q === 'battery'){ state.battery_kwh = +v; if (+v > 0) state.charge_from_grid = true; }
  if (q === 'ev'){
    if (was !== v) clear(['km', 'car']);
    state.ev_active = v !== 'no'; state.ev_in_bill = v === 'have';
    if (state.ev_active && !(state.ev_km_per_year > 0)) state.ev_km_per_year = 16000;
    if (!state.ev_active) state.ev_km_per_year = 0;
  }
  if (q === 'km') state.ev_km_per_year = +v;
  if (q === 'car') state.ev_kwh_per_100km = +v;
  if (state.has_solar && totalPanels() > 0) applyEstimatedSolarCost();
  state._flow_edit = null;
  try { applyRegion(state.region || 'east'); } catch (e) {}
  invalidate(); saveState(); renderApp();
  setTimeout(() => { const b = document.querySelector('.fl-body'); if (b) b.scrollTop = b.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }, 30);
}
function flowSupplier(i){
  const sups = [...new Set(activeTariffsSorted().map((p) => p.supplier))].sort((a, b) => a.localeCompare(b));
  state._flow_sup = sups[i] || null; renderApp();
}
function flowEdit(q){ state._flow_edit = q; renderApp(); }
function flowFinish(then){
  state.onboarding_complete = true;
  state.seen_intro = true;
  state._flow = null; state._flow_edit = null;
  if (state.has_solar && totalPanels() > 0) snapshotMySystem();
  state.current_screen = 'result';
  saveState();
  fireEvent('flow_complete', { bill: state.bimonthly_bill_eur, solar: !!state.has_solar, ev: !!state.ev_active });
  if (then === 'save') meOpenAuth('signup'); else renderApp();
}

function renderFlow(){
  const f = state._flow || {};
  const steps = flowSteps();
  const open = state._flow_edit || steps.find((s) => !(s in f));
  const plan = getPlanById(state.baseline);
  const label = {
    bill: ['What’s your electricity bill?', 'Every two months, electricity only.'],
    plan: ['Who do you pay now?', 'Not sure is fine: we’ll estimate.'],
    heat: ['How is the home heated?', ''],
    solar: ['Solar panels?', ''],
    roof: ['Which way does the roof face?', 'The side that gets the sun.'],
    panels: ['How many panels?', `For your usage we suggest ${_flowSuggest()}.`],
    battery: ['A battery?', 'It stores the day’s solar for the evening.'],
    ev: ['An electric car?', ''],
    km: ['How far do you drive in a year?', 'The Irish average is about 16,000 km.'],
    car: ['What kind of car?', ''],
  };
  const shown = {
    bill: (v) => v === 'meter' ? 'Smart-meter data' : `€${v} / 2 months`,
    plan: (v) => v === 'unsure' ? 'Plan not sure' : String(v).startsWith('guess:') ? `${(getPlanById(String(v).slice(6)) || {}).supplier}, plan not sure` : (() => { const p = getPlanById(v); return `${p.supplier} ${p.plan}`; })(),
    heat: (v) => ({ gas: 'Gas or oil', heatpump: 'Heat pump', storage: 'Storage heaters', direct: 'Electric heaters' })[v],
    solar: (v) => ({ no: 'No solar', have: 'Solar', thinking: 'Solar planned' })[v],
    roof: (v) => ({ S: 'South', SE: 'South-east', SW: 'South-west', EW: 'East and west', SESW: 'South-east and south-west', unsure: 'Not sure, south assumed' })[v],
    panels: (v) => `${v} panels`, battery: (v) => +v ? `${v} kWh` : 'No battery',
    ev: (v) => ({ no: 'No EV', have: 'EV', thinking: 'EV planned' })[v],
    km: (v) => `${(+v).toLocaleString('en-IE')} km a year`, car: (v) => ({ 14: 'Small', 17: 'Family car', 20: 'SUV or large' })[v],
  };
  const optIco = { heat: { gas: 'flame', heatpump: 'waves', storage: 'layers', direct: 'bolt' }, solar: { no: 'x', have: 'sun', thinking: 'spark' },
    ev: { no: 'x', have: 'car', thinking: 'spark' }, battery: { 0: 'x', 5: 'battery', 10: 'battery' }, car: { 14: 'car', 17: 'car', 20: 'car' }, km: { 8000: 'pin', 16000: 'pin', 25000: 'pin' } };
  const compass = (v) => `<svg class="fl-compass" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/>${v === 'EW'
    ? '<path d="M20 20H6M20 20h14" stroke="var(--brand-gold)" stroke-width="4" stroke-linecap="round"/>'
    : v === 'SESW' ? '<path d="M20 20l9 9M20 20l-9 9" stroke="var(--brand-gold)" stroke-width="4" stroke-linecap="round"/>'
    : `<path d="M20 20V8" stroke="var(--brand-gold)" stroke-width="4" stroke-linecap="round" transform="rotate(${({ S: 180, SE: 135, SW: 225 })[v] || 180} 20 20)"/>`}</svg>`;
  const opt = (q, v, title, sub = '') => {
    const icn = q === 'roof' ? compass(v) : optIco[q] && optIco[q][v] ? `<span class="fl-ico">${ic(optIco[q][v], 20)}</span>` : '';
    return `<button class="fl-opt ${icn ? 'has-ico' : ''} ${String(f[q]) === String(v) ? 'on' : ''}" onclick="flowAnswer('${q}', '${v}')">${icn}<span><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  };
  const body = (q) => {
    if (q === 'bill') return `<div class="fl-bill"><span>€</span><input id="flow-bill" inputmode="numeric" value="${f.bill || state.bimonthly_bill_eur || 250}" aria-label="Two-month bill in euro"></div>
      <div class="fl-row">${[150, 250, 420].map((v) => `<button class="sy-stop" onclick="document.getElementById('flow-bill').value=${v}">€${v}</button>`).join('')}</div>
      <button class="fl-next" onclick="flowAnswer('bill', document.getElementById('flow-bill').value)">Next</button>
      <div class="fl-or"><span>or, most accurate</span></div>
      <label class="fl-upload">${ic('csv', 20)}<span><b>Upload your ESB smart-meter file</b><small>Every half hour of your real year. Download it free at esbnetworks.ie → My account → Download data.</small></span>
        <input type="file" accept=".csv,.CSV" onchange="handleCsvFile(event)" hidden></label>
      <div id="csv-parse-result"></div>`;
    if (q === 'plan'){
      const plans = activeTariffsSorted();
      const sups = [...new Set(plans.map((p) => p.supplier))].sort((a, b) => a.localeCompare(b));
      const sup = state._flow_sup;
      if (sup){
        // Most homes are on a standard plan: list those first, and "not sure"
        // assumes one. EV and dynamic plans only suit some homes, so they go last.
        const order = { flat: 0, tou: 1, ev: 2, dynamic: 3 };
        const mine = plans.filter((p) => p.supplier === sup).sort((a, b) => (order[a.type] ?? 1) - (order[b.type] ?? 1));
        return `<button class="fl-crumb" onclick="state._flow_sup=null;renderApp()">${ic('chevL', 14)} All suppliers</button>
          <div class="fl-k">${esc(sup)}: which plan? It’s on your bill, near the top.</div>
          <div class="fl-opts">${mine.map((p) => opt('plan', p.id, esc(p.plan))).join('')}
          ${!['ev', 'dynamic'].includes(mine[0].type)
            ? opt('plan', 'guess:' + mine[0].id, 'Not sure which plan', `We’ll assume ${esc(mine[0].plan)}`)
            : opt('plan', 'unsure', 'Not sure which plan', 'We’ll assume a standard plan')}</div>`;
      }
      return `<div class="fl-sups">${sups.map((n, i) => `<button class="fl-sup ${f.plan && f.plan !== 'unsure' && (getPlanById(f.plan) || {}).supplier === n ? 'on' : ''}" onclick="flowSupplier(${i})"><span class="fl-sup-mark">${esc(n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2))}</span>${esc(n)}</button>`).join('')}</div>
        <button class="sg-link" onclick="flowAnswer('plan', 'unsure')">I’m not sure: assume a standard plan</button>`;
    }
    if (q === 'heat') return `<div class="fl-opts fl-two fl-tiles">${opt('heat', 'gas', 'Gas or oil')}${opt('heat', 'heatpump', 'Heat pump')}${opt('heat', 'storage', 'Storage heaters')}${opt('heat', 'direct', 'Electric heaters')}</div>`;
    if (q === 'solar') return `<div class="fl-opts">${opt('solar', 'no', 'No')}${opt('solar', 'have', 'I have them', 'We’ll add what they make')}${opt('solar', 'thinking', 'Thinking about it', 'We’ll show the payback')}</div>`;
    if (q === 'roof') return `<div class="fl-opts fl-two fl-tiles">${opt('roof', 'S', 'South')}${opt('roof', 'EW', 'East and west')}${opt('roof', 'SE', 'South-east')}${opt('roof', 'SW', 'South-west')}${opt('roof', 'SESW', 'South-east and south-west')}</div>
      <button class="sg-link" onclick="flowAnswer('roof', 'unsure')">Not sure: assume south</button>`;
    if (q === 'panels'){ const s = _flowSuggest(); return `<div class="fl-opts fl-three">${[s - 4, s, s + 4].map((n) => opt('panels', n, `${n}`, n === s ? 'suggested' : '')).join('')}</div>`; }
    if (q === 'battery') return `<div class="fl-opts fl-three">${opt('battery', 0, 'None')}${opt('battery', 5, '5 kWh', 'typical')}${opt('battery', 10, '10 kWh')}</div>`;
    if (q === 'ev') return `<div class="fl-opts">${opt('ev', 'no', 'No')}${opt('ev', 'have', 'I have one', 'Its charging is in my bill')}${opt('ev', 'thinking', 'Thinking about one', 'We’ll show the cost and petrol saved')}</div>`;
    if (q === 'km') return `<div class="fl-opts fl-three">${[8000, 16000, 25000].map((k) => opt('km', k, `${k / 1000}k km`)).join('')}</div>`;
    if (q === 'car') return `<div class="fl-opts fl-three">${opt('car', 14, 'Small')}${opt('car', 17, 'Family')}${opt('car', 20, 'SUV')}</div>`;
    return '';
  };
  let h = '';
  for (const s of steps){
    const branch = ['roof', 'panels', 'battery', 'km', 'car'].includes(s);
    if (s === open){
      h += `<section class="fl-q ${branch ? 'fl-branch' : ''}" aria-label="${label[s][0]}">
        <h2>${label[s][0]}</h2>${label[s][1] ? `<p>${label[s][1]}</p>` : ''}${body(s)}</section>`;
      break;
    }
  }
  // What's answered so far, as one row of chips: tap one to change it.
  const answered = steps.filter((s) => s in f && s !== open);
  if (answered.length) h = `<div class="fl-chips" aria-label="Your answers, tap to change">${answered.map((s) => `<button class="fl-chip" onclick="flowEdit('${s}')" aria-label="Change ${esc(label[s][0])}">${esc(shown[s](f[s]))}</button>`).join('')}</div>` + h;
  const finished = !open;
  if (finished){
    let rec = null, sd = null, ev = null;
    try { rec = getRecommendation(); } catch (e) {}
    try { if (state.has_solar && totalPanels() > 0) sd = v7SolarData(); } catch (e) {}
    try { if (state.ev_active && rec) ev = evEconomics(rec.best.plan.id); } catch (e) {}
    // The switch alone, never mixed with panels: a planned system is left out
    // (it isn't bought), an installed one is on both sides of the comparison.
    // The same figure Home shows: the switch alone, on the home as it is.
    let save = 0, mine = 0, pl = null;
    try {
      // Planned solar: the most this home could save, as Home leads with it.
      pl = state.has_solar && totalPanels() > 0 && state.solar_planned ? plannedLadder() : null;
      mine = pl ? pl.today : state.has_solar && totalPanels() > 0 ? myPlanCost() : rec.baseCost;
      save = Math.max(0, mine - rec.best.net);
    } catch (e) {}
    const bp = getPlanById(state.baseline);
    const bars = rec && save > 10 ? `<div class="fl-bars">
        <div><span>Now${state.baseline_known && bp ? `, ${esc(bp.supplier)}` : ''}</span><b>${eur(mine)}</b><i style="width:100%"></i></div>
        <div><span>On ${esc(rec.best.plan.supplier)}${pl ? ', with the solar' : ''}</span><b>${eur(rec.best.net)}</b><i class="is-best" style="width:${Math.max(8, Math.round(rec.best.net / mine * 100))}%"></i></div>
      </div>` : '';
    const acc = modelAccuracy().pct;
    h += `<section class="fl-reveal">
      <div class="fl-r-k">Your answer</div>
      ${save > 10 ? `<div class="fl-r-big is-saving">${eur(save)}<span> less a year</span></div>
        <div class="fl-r-line">${pl ? `switching plan and adding the solar: <b>${eur(Math.max(0, pl.today - pl.noSolar.net))}</b> from switching now, <b>${eur(Math.max(0, pl.noSolar.net - pl.best.net))}</b> more once the panels are in` : `by switching to <b>${esc(rec.best.plan.supplier)} ${esc(rec.best.plan.plan)}</b>`}</div>${bars}`
        : `<div class="fl-r-line"><b>You’re already on a good plan.</b> Nothing on sale beats it for your home.</div>`}
      <div class="fl-r-list">
        ${sd ? `<span>${state.solar_planned ? 'Solar would pay back in' : 'Your panels bring back'} <b>${state.solar_planned ? `${sd.cur.payback < 50 ? sd.cur.payback.toFixed(1) : '—'} years` : `${eur(sd.cur.solarBenefit)} a year`}</b></span>` : ''}
        ${ev ? `<span>Your car costs <b>${eur(ev.evElectricityCost)} a year</b> to charge, <b>${eur(ev.evVsPetrolNet)}</b> less than petrol</span>` : ''}
        <span>Built on 8,760 hours of your year · ±${acc}%</span>
      </div>
      <button class="fl-go" onclick="flowFinish()">See my home</button>
    </section>
    ${sbInitialized() && !_sbUser ? `<section class="fl-save">
      <span class="fl-save-ico">${ic('shield', 20)}</span>
      <div><b>Optional: a free account</b>
        <span>Right now your home is saved on this phone only. An account keeps it safe, opens it on any device, and tells you when a cheaper plan appears.</span>
        <button class="fl-save-link" onclick="flowFinish('save')">Create a free account ${ic('chevR', 14)}</button></div></section>` : ''}`;
  }
  const done = steps.filter((s) => s in f).length;
  return `<div class="fl">
    <div class="fl-top">
      <button class="sg-back" onclick="${state.onboarding_complete ? "state._flow=null;setScreen('result')" : 'goLanding()'}" aria-label="Back">${ic('chevL', 18)}</button>
      <span class="fl-word">${wordmarkHtml('pk-word-top')}</span>
    </div>
    <div class="sg-progress fl-prog"><i style="width:${finished ? 100 : Math.round(done / steps.length * 100)}%"></i></div>
    <div class="fl-body">${h}</div>
  </div>`;
}

function exploreSolar(){
  state.considering_solar = true;
  state.solar_is_estimate = true;
  state.has_solar = true;
  state.current_screen = 'solar';

  // Size something sensible instantly. Working out the genuinely best design
  // means simulating twelve of them across a full year, which is two and a half
  // seconds — far too long to hold the first paint. The recommendation arrives
  // a moment later and offers itself; see renderOptimisedSuggestion().
  const annualKwh = Object.values(state.bills).reduce((a,b)=>a+b,0);
  state.count_A = Math.max(6, Math.min(16, Math.round(annualKwh / 450))); state.count_B = 0;
  state.battery_kwh = annualKwh > 6000 ? 10 : annualKwh > 3500 ? 5 : 0;
  applyEstimatedSolarCost();
  snapshotMySystem();
  invalidate();
  saveState();
  renderApp();
}

// Estimate-banner chip cyclers — tap to step through common configs.
// Cost + grant re-estimate automatically so the payback stays honest.
function solarEstCycle(which){
  if (which === 'panels'){
    const steps = [6, 8, 10, 12, 14, 16];
    const i = steps.indexOf(state.count_A);
    state.count_A = steps[(i + 1) % steps.length] || 10;
  } else if (which === 'battery'){
    const steps = [0, 5, 10, 13.5];
    const i = steps.indexOf(state.battery_kwh);
    state.battery_kwh = steps[(i + 1) % steps.length];
  }
  applyEstimatedSolarCost();
  invalidate();
  saveState();
  renderApp();
}

function markSolarAsMine(){
  state.solar_is_estimate = false;
  saveState();
  showToast('Marked as your installed system', { type:'accent', icon:ic('checkC',16) });
  renderApp();
}

function goRefineSolar(){
  // One place to change the system: the My system sheet, over the Solar tab.
  if (NO_SHEET_SCREENS.includes(state.current_screen)) state.current_screen = 'solar';
  trackPageView('my-system');
  openMySystem();
}

// Growth loop: a share-ready savings card. Brand-styled canvas PNG with the
// headline saving — no personal data, no usage details. Web Share API with
// download fallback.
function makeShareCardCanvas(savings){
  const cv = document.createElement('canvas');
  if (!cv || typeof cv.getContext !== 'function') return null;
  const W = 1080, H = 1350;
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  if (!x || typeof x.fillRect !== 'function') return null;
  const F = '"Inter Tight", -apple-system, "Segoe UI", sans-serif';
  const rr = (X, Y, w, h, r, c) => { x.fillStyle = c; x.beginPath(); if (x.roundRect) x.roundRect(X, Y, w, h, r); else x.rect(X, Y, w, h); x.fill(); };
  const t = (s, X, Y, size, c, weight = 400, align = 'left') => { x.font = `${weight} ${size}px ${F}`; x.fillStyle = c; x.textAlign = align; x.fillText(s, X, Y); };
  const fit = (s, max, size, weight) => { x.font = `${weight} ${size}px ${F}`; let o = s; while (o.length > 3 && x.measureText(o).width > max) o = o.slice(0, -2); return o === s ? s : o + '…'; };
  const eurS = (v) => '€' + Math.round(v).toLocaleString('en-IE');

  // Ground: the brand navy, a soft glow behind the figure.
  x.fillStyle = '#0F1311'; x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(300, 330, 40, 300, 330, 700);
  g.addColorStop(0, 'rgba(76,203,140,0.20)'); g.addColorStop(1, 'rgba(76,203,140,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  // Mark and name.
  rr(72, 70, 76, 76, 18, '#16343d');
  x.strokeStyle = '#8fb0b8'; x.lineWidth = 3; x.setLineDash([4, 7]);
  x.beginPath(); x.moveTo(84, 122); x.bezierCurveTo(100, 122, 104, 88, 110, 88); x.bezierCurveTo(116, 88, 120, 122, 136, 122); x.stroke();
  x.setLineDash([]); x.strokeStyle = '#ffd166'; x.lineWidth = 6; x.lineCap = 'round';
  x.beginPath(); x.moveTo(84, 124); x.lineTo(136, 124); x.stroke();
  t('peakless', 168, 124, 46, '#EEF1EE', 700);
  t('My home energy analysis', W - 72, 122, 28, '#A2ACA6', 500, 'right');

  // The answer.
  t('THE MOST I COULD SAVE', 72, 250, 28, '#ffd166', 700);
  t(eurS(Math.max(0, savings)), 64, 420, 190, '#4CCB8C', 800);
  t('less a year', 72, 480, 40, '#A2ACA6', 600);

  // The four bars, as Home shows them.
  let rungs = [];
  try {
    const pl = (state.solar_planned || state.solar_is_estimate) ? plannedLadder() : null;
    const mine = getPlanById(state.baseline);
    const rec = getRecommendation();
    if (pl) rungs = [
      ['Current plan', mine.supplier, pl.today, '#7A847E'],
      ['Best plan', pl.noSolar.plan.supplier, pl.noSolar.net, '#2F7A56'],
      ['Current plan + solar', mine.supplier, pl.mine, '#2F7A56'],
      ['Best plan + solar', pl.best.plan.supplier, pl.best.net, '#4CCB8C'],
    ];
    else rungs = [['Current plan', mine.supplier, rec.baseCost, '#7A847E'], ['Best plan', rec.best.plan.supplier, rec.best.net, '#4CCB8C']];
  } catch (e) { rungs = []; }
  rr(56, 530, W - 112, 110 + rungs.length * 86, 36, '#171C19');
  t('What I’d pay a year', 96, 588, 28, '#A2ACA6', 600);
  const max = Math.max(1, ...rungs.map((r) => r[2]));
  rungs.forEach(([label, sup, v, c], i) => {
    const y = 650 + i * 86;
    t(label, 96, y, 30, '#EEF1EE', 700);
    x.font = `700 30px ${F}`; const lw = x.measureText(label + '  ').width;
    t(fit(sup, 560 - lw, 26, 400), 96 + lw, y, 26, '#A2ACA6', 400);
    t(eurS(v), W - 96, y, 32, i === rungs.length - 1 ? '#4CCB8C' : '#EEF1EE', 800, 'right');
    rr(96, y + 18, W - 192, 22, 11, '#262D29');
    rr(96, y + 18, Math.max(22, (W - 192) * (v / max)), 22, 11, c);
  });

  // Three facts.
  const facts = [];
  try {
    const best = getBestPlan();
    facts.push(['Best plan', best.plan.supplier]);
    if (state.has_solar && totalPanels() > 0){ const d = v7SolarData(); if (d.cur.payback < 50) facts.push(['Solar pays back', d.cur.payback.toFixed(1) + ' years']); }
    if (state.ev_active){ const ev = evEconomics(best.plan.id); if (ev) facts.push(['Car vs petrol', eurS(ev.evVsPetrolNet) + ' less']); }
    facts.push(['Accuracy', '±' + modelAccuracy().pct + '%']);
  } catch (e) {}
  const fy = 664 + rungs.length * 86;
  const fw = (W - 112 - 24 * (Math.min(3, facts.length) - 1)) / Math.min(3, facts.length);
  facts.slice(0, 3).forEach(([k, v], i) => {
    const fx = 56 + i * (fw + 24);
    rr(fx, fy, fw, 136, 28, '#171C19');
    t(k, fx + 30, fy + 52, 26, '#A2ACA6', 600);
    t(fit(v, fw - 60, 40, 800), fx + 30, fy + 104, 40, '#EEF1EE', 800);
  });

  // Footer.
  let live = 0; try { live = getRecommendation().ranked.length; } catch (e) { live = TARIFFS.filter(tt => !tt.discontinued).length; }
  t('Every hour of my year, priced on all ' + live + ' Irish plans.', 72, H - 96, 28, '#A2ACA6', 500);
  t('Check yours free at peakless', 72, H - 52, 34, '#ffd166', 700);
  return cv;
}

function shareSavingsCard(){
  // The card shows the whole comparison, so its headline is the whole of it.
  let savings = publishableSavings();
  try { const pl = (state.solar_planned || state.solar_is_estimate) ? plannedLadder() : null; if (pl) savings = pl.today - pl.best.net; } catch (e) {}
  const cv = makeShareCardCanvas(savings);
  if (!cv){ copyShareUrl(); return; }
  const text = 'My home energy analysis: \u20ac' + Math.round(savings).toLocaleString('en-IE') + ' a year less. Check yours free: ' + location.origin;
  cv.toBlob((blob) => {
    if (!blob){ copyShareUrl(); return; }
    const file = new File([blob], 'peakless-analysis.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({ files: [file], text }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'peakless-analysis.png';
      a.click();
      showToast('Savings card saved \u2014 share it anywhere', { type:'accent', icon:ic('spark',16) });
    }
  }, 'image/png');
}

function handleSwitchClick(planId, planName, savings){
  trackSwitchClick(planId, planName, savings);
  // Retention ledger: record the switch intent + projected value
  const today = new Date().toISOString().slice(0, 10);
  state.switch_history = state.switch_history || [];
  const last = state.switch_history[state.switch_history.length - 1];
  if (!last || last.planId !== planId || last.date !== today){
    state.switch_history.push({ date: today, planId, planName, savings: Math.round(savings) });
    if (state.switch_history.length > 20) state.switch_history.shift();
    saveState();
  }
  // A click ID ties this click to a confirmed switch a partner reports back.
  const clickId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 36);
  trackEvent('switch_click', { plan_id: planId, partner: isPartnerPlan(planId), savings_eur: Math.round(savings) }, clickId);
  const base = getAffiliateUrl(planId);
  const url = base ? base + (base.includes('?') ? '&' : '?') + 'sawed_click=' + encodeURIComponent(clickId) : null;
  if (url && !url.includes('example.com')){
    window.open(url, '_blank');
  } else {
    // Show toast for now (since affiliate not wired in this build)
    showToast(`Tracked. In production, this opens the affiliate link for ${planName}.`);
  }
}

/* ============================================================
   PLAN CATEGORY — for the filter pills on the Plans tab
   ============================================================ */
function planCategory(plan){
  if (!plan) return 'flat';
  if (plan.type === 'dynamic') return 'dynamic';
  if (plan.type === 'ev') return 'ev';
  if (isFlatPlan(plan)) return 'flat';
  return 'tou';
}
function planCategoryLabel(cat){
  return ({ all:'All', flat:'One price', tou:'Cheaper at night', ev:'For EVs', dynamic:'Changes hourly' })[cat] || cat;
}

/* ============================================================
   TRUST PANEL — methodology disclosure for the Home hero
   ============================================================ */
function renderTrustPanel(){
  if (!state.onboarding_complete) return '';
  const open = !!state._trust_open;
  const region = IRISH_REGIONS[state.region || 'east'];
  const annualKwh = Math.round(Object.values(state.bills || {}).reduce((a,b)=>a+b,0));
  const setup = state.has_solar
    ? `${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ' · ' + state.battery_kwh + ' kWh battery' : ' · no battery'}`
    : 'no solar (not modelled)';
  const evLine = state.ev_active
    ? `${(state.ev_km_per_year || 0).toLocaleString()} km/yr · ${state.ev_kwh_per_100km || 17} kWh/100km`
    : 'no EV';
  const dates = (TARIFFS || []).map(t => t.verified_date).filter(Boolean).sort();
  const latestVerified = dates.length ? dates[dates.length-1] : null;

  return `<div class="trust-panel ${open ? 'open' : ''}">
    <div class="trust-header" onclick="toggleTrust()">
      <div class="trust-title">How we calculated this</div>
      <div class="trust-icon">${open ? 'hide ▴' : 'show ▾'}</div>
    </div>
    <div class="trust-body">
      <div class="trust-body-inner">
        <div class="trust-grid">
          <div>Region</div><div>${ic('pin',12)} ${region.name} (${region.ghi_multiplier > 1 ? '+' : ''}${Math.round((region.ghi_multiplier - 1) * 100)}% sun vs national average)</div>
          <div>Usage</div><div>${annualKwh.toLocaleString()} kWh/yr</div>
          <div>Heating</div><div>${state.heating_type}${state.hot_water_strategy && state.hot_water_strategy !== 'none' ? ' · ' + state.hot_water_strategy + ' HW' : ''}</div>
          <div>System</div><div>${setup}</div>
          <div>EV</div><div>${evLine}</div>
          <div>Strategy</div><div>${state.battery_kwh > 0 ? (state.strategy_mode || 'arbitrage') : '—'}${state.charge_from_grid && state.battery_kwh > 0 ? ' · grid-charge ON' : ''}</div>
        </div>
        <div class="trust-method">
          <b>How the engine works</b>
          Every plan is simulated hour-by-hour (8,760 hours/yr) against your usage and solar generation. PVGIS-calibrated GHI per region, NOAA solar position for your roof orientation, Erbs model for diffuse/direct split, NOCT thermal derating on the panels. Battery dispatch follows your chosen strategy. Dynamic plans use SEMOpx-tracking wholesale curves with the CRU 50c/kWh cap.
        </div>
        <div class="trust-method" style="margin-top:8px">
          <b>What we don't model</b>
          Real weather (we use TMY = typical met year, ±5-8% vs actual), micro-shading on your specific roof, future rate changes by suppliers, smart EV-charging optimization beyond cheap-window scheduling. Always validate big decisions with an installer.
        </div>
        <div class="trust-sources">Data: PVGIS · SEMOpx · CRU${latestVerified ? ' · Tariffs verified ' + fmtVerifiedDate(latestVerified) : ''}</div>
      </div>
    </div>
  </div>`;
}

function toggleTrust(){
  state._trust_open = !state._trust_open;
  renderApp();
}

/* ============================================================
   SETTINGS COLLAPSIBLE SECTIONS
   ============================================================ */
function toggleSettingsSection(id){
  state._settings_open = state._settings_open === id ? 'none' : id;
  saveState();
  renderApp();
}

/* ============================================================
   PLANS FILTER PILLS
   ============================================================ */
/** Sort order for the ranked list. Cost is the default. */
function setPlansSort(key){
  state._plans_sort = key;
  saveState();
  renderApp();
}

/**
 * Two-plan comparison.
 *
 * The plans screen is five viewports of near-identical rows, and its actual job
 * — holding two tariffs side by side — had no support at all. Two is the limit
 * on purpose: three columns of rates on a 390px screen is a table nobody reads.
 */
function toggleCompare(planId){
  const sel = Array.isArray(state._cmp_plans) ? state._cmp_plans.slice() : [];
  const at = sel.indexOf(planId);
  if (at >= 0) sel.splice(at, 1);
  else { sel.push(planId); while (sel.length > 2) sel.shift(); }
  state._cmp_plans = sel;
  saveState();
  renderApp();
}

function clearCompare(){
  state._cmp_plans = [];
  saveState();
  renderApp();
}

function openCompare(){
  const sel = (state._cmp_plans || []).map(getPlanById).filter(Boolean);
  if (sel.length < 2) return;
  const old = document.getElementById('cmp-modal');
  if (old) old.remove();
  if (CACHE.dirty) rebuildBase();

  const cols = sel.map(plan => {
    const c = annualCost(sim(plan.id), plan);
    return { plan, c };
  });
  const cheaper = cols[0].c.net <= cols[1].c.net ? 0 : 1;

  const row = (label, pick, opts = {}) => {
    const vals = cols.map(pick);
    const best = opts.lowerIsBetter === false
      ? (vals[0] >= vals[1] ? 0 : 1)
      : (vals[0] <= vals[1] ? 0 : 1);
    const same = opts.fmt ? opts.fmt(vals[0]) === opts.fmt(vals[1]) : vals[0] === vals[1];
    return `<tr>
      <th scope="row">${label}</th>
      ${vals.map((v, i) => `<td class="${!same && i === best ? 'cmp-best' : ''}">${opts.fmt ? opts.fmt(v) : v}</td>`).join('')}
    </tr>`;
  };
  const cent = (v) => (v == null ? '—' : fmtCent(v));

  const modal = document.createElement('div');
  modal.id = 'cmp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-height:88vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3 style="margin-bottom:2px">Side by side</h3>
      <p style="margin-bottom:12px">Both priced on your usage, hour by hour. The better figure in each row is marked.</p>
      <div style="overflow-x:auto">
      <table class="cmp-table">
        <thead><tr><th></th>${cols.map(c => `<th scope="col"><span class="cmp-sup">${c.plan.supplier}</span><span class="cmp-plan">${c.plan.plan}</span></th>`).join('')}</tr></thead>
        <tbody>
          ${row('Annual cost', c => Math.round(c.c.net), { fmt: fmtCurrency })}
          ${row('Energy', c => Math.round(c.c.energy_cost), { fmt: fmtCurrency })}
          ${row('Standing charge', c => Math.round(c.plan.standing || 0), { fmt: fmtCurrency })}
          ${state.has_solar ? row('Export income', c => Math.round(c.c.export_revenue || 0), { fmt: fmtCurrency, lowerIsBetter: false }) : ''}
          ${row('Day rate', c => c.plan.rates.day, { fmt: cent })}
          ${row('Night rate', c => c.plan.rates.night ?? null, { fmt: cent })}
          ${row('EV window', c => c.plan.rates.ev ?? null, { fmt: cent })}
          ${row('Export rate', c => c.plan.export_rate ?? null, { fmt: cent, lowerIsBetter: false })}
          ${row('Contract', c => c.plan.length ? c.plan.length + ' months' : 'None', { fmt: v => v })}
        </tbody>
      </table>
      </div>
      <div class="cmp-verdict">${
        Math.abs(cols[0].c.net - cols[1].c.net) < 1
          ? 'On your usage these cost the same. Choose on contract length or service.'
          : `<b>${cols[cheaper].plan.supplier}</b> is ${fmtCurrency(Math.abs(cols[0].c.net - cols[1].c.net))}/yr cheaper for your home.`
      }</div>
      <button class="modal-btn" style="margin-top:12px" onclick="document.getElementById('cmp-modal').remove(); pickPlan('${cols[cheaper].plan.id}')">Use ${cols[cheaper].plan.supplier}</button>
      <button class="modal-skip" onclick="document.getElementById('cmp-modal').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function setPlansFilter(cat){
  state._plans_filter = cat;
  saveState();
  renderApp();
}

/**
 * Transient confirmation.
 *
 * Announced through a polite live region: without one, every confirmation the
 * app gives — plan chosen, report downloaded, settings saved — was invisible to
 * anyone not looking at the screen.
 */
function announce(message){
  try {
    let el = document.getElementById('a11y-live');
    if (!el){
      el = document.createElement('div');
      el.id = 'a11y-live';
      el.className = 'sr-only';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = '';
    setTimeout(() => { el.textContent = String(message || '').replace(/<[^>]*>/g, ''); }, 60);
  } catch(e){ /* announcement is additive */ }
}

function showToast(message, opts){
  announce(message);
  opts = opts || {};
  const type  = opts.type  || 'accent';
  const icon  = opts.icon  || ic('checkC',16);
  const title = opts.title || null;
  let stack = document.getElementById('toast-stack');
  if (!stack){
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + (type !== 'accent' ? type : '');
  t.innerHTML = `<span class="toast-icon">${icon}</span>
    <span class="toast-body">${title ? `<b>${title}</b>` : ''}${message}</span>`;
  stack.appendChild(t);
  // Remove the old single-toast pattern if it's there
  const existing = document.getElementById('toast');
  if (existing) existing.remove();
  setTimeout(() => {
    t.classList.add('removing');
    setTimeout(() => t.remove(), 250);
  }, 3000);
}

/** The solar maths: generation, self-use, export, battery and the 20-year
 *  value, behind one toggle. Shown in Accuracy, beside the bill's own sum. */
function renderSolarWorking(){
  if (CACHE.dirty) rebuildBase();
  if (!state.has_solar || !(totalPanels() > 0)) return '';
  const best = getBestPlan();
  const totalGen = sumF(CACHE.solar.total);
  const totalExport = sumF(best.sim.grid_export);
  const selfConsumed = Math.max(0, totalGen - totalExport - sumF(best.sim.curtailed));
  const selfConsumPct = totalGen > 0 ? Math.round(selfConsumed / totalGen * 100) : 0;
  const sysCost = state.install_cost - state.grant_seai;
  const kwp = totalPanels() * state.panel_w / 1000;
  const scen = computeSolarPaybackScenarios();
  const currentScen = state.ev_active ? scen.withEv : scen.withoutEv;
  const npv20 = calcNPV20(currentScen.solarBenefit, sysCost, state.battery_kwh || 0, state.panel_degradation);
  return `
    <div class="working">
      <button class="working-toggle" aria-expanded="${!!state._solar_detail_open}" onclick="state._solar_detail_open=!state._solar_detail_open;saveState();renderApp()">
        <span class="working-toggle-label">${ic('sun',18)} The solar working</span>
        <span class="working-toggle-hint">${state._solar_detail_open ? 'Hide' : 'Generation, self-use, export and the 20-year maths'}</span>
        <span class="working-toggle-chev" style="transform:rotate(${state._solar_detail_open ? '90' : '0'}deg)">›</span>
      </button>
      ${!state._solar_detail_open ? '' : `<div class="working-body">

    <div class="grid-2">
      <div class="card">
        <div class="card-label">${ic('bolt',13)} Solar electricity benefit</div>
        <div class="card-value accent">${fmtCurrency(currentScen.solarBenefit)}<span class="unit">/yr</span></div>
        <div class="card-delta">vs no solar, ${state.ev_active ? 'with EV' : 'no EV'}</div>
      </div>
      <div class="card" onclick="toggleNpvBreakdown()" style="cursor:pointer">
        <div class="card-label">∑ 20-yr NPV (3%) <span style="float:right;color:var(--accent);font-size:12px">tap for math ↓</span></div>
        <div class="card-value ${npv20 > 0 ? 'accent' : 'red'}">${fmtCurrency(npv20)}</div>
        <div class="card-delta">After Y12 battery swap</div>
      </div>
      <div class="card">
        <div class="card-label">${ic('sun',13)} Solar produced</div>
        <div class="card-value">${Math.round(totalGen).toLocaleString()}<span class="unit"> kWh/yr</span></div>
        <div class="card-delta">${(totalGen/Math.max(kwp,0.01)).toFixed(0)} kWh per kWp</div>
      </div>
      <div class="card">
        <div class="card-label">${ic('rotate',13)} Solar used on-site</div>
        <div class="card-value">${selfConsumPct}<span class="unit">%</span></div>
        <div class="card-delta">${Math.round(selfConsumed).toLocaleString()} of ${Math.round(totalGen).toLocaleString()} kWh</div>
      </div>
      ${state.battery_kwh > 0 ? `
      <div class="card">
        <div class="card-label">${ic('battery',13)} Battery cycled</div>
        <div class="card-value amber">${Math.round(sumF(best.sim.battery_charge))}<span class="unit"> kWh/yr</span></div>
        <div class="card-delta">${state.battery_kwh} kWh cap</div>
      </div>` : ''}
      <div class="card">
        <div class="card-label">${ic('export',13)} Export income</div>
        <div class="card-value">${fmtCurrency(totalExport * best.plan.export_rate)}<span class="unit">/yr</span></div>
        <div class="card-delta">${Math.round(totalExport)} kWh @ ${fmtCent(best.plan.export_rate)}</div>
      </div>
    </div>

    ${state._show_npv_breakdown ? renderNpvBreakdown(currentScen.solarBenefit, sysCost, state.battery_kwh || 0, state.panel_degradation || 0.005) : ''}

      </div>`}
    </div>`;
}

// Quick what-if toggle on the Solar screen — flips EV modelling without touching
// the saved km/efficiency or the ev_in_bill reality flag, and reports the
// payback effect immediately.
// ── Tariff popup — read-only rate card for any plan, shown as a bottom sheet.
// Used on the Solar screen's recommended-plan row so the user can sanity-check
// the tariff without losing their place.
function openTariffPopup(planId){
  const plan = getPlanById(planId);
  if (!plan) return;
  const old = document.getElementById('tariff-popup');
  if (old) old.remove();
  const bands = ['day','night','peak','ev','wfh'].filter(b => plan.rates[b] != null);
  const labels = { day:'Day', night:'Night', peak:'Peak', ev:'EV window', wfh:'Work-from-home' };
  const flat = isFlatPlan(plan);
  const isCurrent = planId === state.baseline && state.baseline_known;
  const rows = flat
    ? `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line-soft)">
         <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Flat rate</div><div style="font-size:12px;color:var(--ink-dim);font-family:var(--mono)">All hours, every day</div></div>
         <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${fmtCent(plan.rates.day)}/kWh</div>
       </div>`
    : bands.map(b => {
        const w = plan.windows && plan.windows[b];
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line-soft)">
          <div><div style="font-size:13px;font-weight:600;color:var(--ink)">${labels[b] || b}</div><div style="font-size:12px;color:var(--ink-dim);font-family:var(--mono)">${w ? w[0] + 'h–' + w[1] + 'h' : b === 'day' ? 'All remaining hours' : ''}</div></div>
          <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:${b === 'peak' ? 'var(--amber)' : b === 'ev' || b === 'night' ? 'var(--accent)' : 'var(--ink)'}">${fmtCent(plan.rates[b])}/kWh</div>
        </div>`;
      }).join('');
  const modal = document.createElement('div');
  modal.id = 'tariff-popup';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-height:82vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${plan.type === 'dynamic' ? 'Dynamic wholesale tariff' : flat ? 'Flat tariff' : 'Time-of-use tariff'}${isCurrent ? ' · your current plan' : ''}</div>
      <h3 style="margin-bottom:2px">${plan.supplier} — <em>${plan.plan}</em></h3>
      <p style="margin-bottom:10px">Rates incl. VAT — exactly what the simulation uses.</p>
      ${rows}
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line-soft)">
        <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Export (CEG)</div><div style="font-size:12px;color:var(--ink-dim);font-family:var(--mono)">Paid for surplus solar</div></div>
        <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">${fmtCent(plan.export_rate || 0)}/kWh</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0">
        <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Standing charge</div><div style="font-size:12px;color:var(--ink-dim);font-family:var(--mono)">Fixed yearly; the €19.10 PSO levy is added on top</div></div>
        <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${fmtCurrency(plan.standing)}/yr</div>
      </div>
      ${plan.type === 'dynamic' ? `<div style="padding:9px 12px;background:var(--blue-soft);border-radius:8px;font-size:12px;color:var(--ink-soft);line-height:1.5;margin-top:4px">Half-hourly wholesale pricing on top of the base rates above — hourly prices move with the market.</div>` : ''}
      ${plan.notes ? `<div style="padding:9px 12px;background:var(--well);border-radius:8px;font-size:12px;color:var(--ink-soft);line-height:1.55;margin-top:8px"><b style="color:var(--ink)">Supplier note.</b> ${plan.notes}</div>` : ''}
      <button class="modal-btn" style="margin-top:14px" onclick="document.getElementById('tariff-popup').remove(); openPlanDetail('${planId}')">Full details &amp; edit rates →</button>
      <button class="modal-skip" onclick="document.getElementById('tariff-popup').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/**
 * Pick the plan the whole app runs on.
 *
 * The choice existed on the plan-detail screen, which is three taps deep — so
 * from the two places the plan is actually shown (the result screen and the
 * solar payback screen) there was no way to change it. This is that control:
 * every rankable plan, its cost, and what choosing it costs against the
 * cheapest, selectable in one tap from wherever the plan is quoted.
 */
function openPlanPicker(){
  const rec = getRecommendation();
  if (!rec.cheapest) return;
  const old = document.getElementById('plan-picker');
  if (old) old.remove();

  const rows = rec.ranked.map((r, i) => {
    const id = r.plan.id;
    const chosen = state.chosen_plan ? id === state.chosen_plan : i === 0;
    const delta = r.net - rec.cheapest.net;
    return `<div class="pp-row ${chosen ? 'on' : ''}" onclick="pickPlan('${id}')">
      <div class="pp-tick">${chosen ? ic('checkC',15) : `<span class="pp-rank">${i + 1}</span>`}</div>
      <div class="pp-main">
        <div class="pp-name">${r.plan.supplier}</div>
        <div class="pp-sub">${r.plan.plan}</div>
      </div>
      <div class="pp-cost">
        <div class="pp-amount">${fmtCurrency(r.net)}<span>/yr</span></div>
        <div class="pp-delta" style="color:${delta > 0.5 ? 'var(--amber)' : 'var(--accent)'}">${
          delta > 0.5 ? '+' + fmtCurrency(delta) : i === 0 ? 'cheapest' : 'same cost'
        }</div>
      </div>
    </div>`;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'plan-picker';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-height:86vh;display:flex;flex-direction:column">
      <div class="modal-handle"></div>
      <h3 style="margin-bottom:2px">Choose your plan</h3>
      <p style="margin-bottom:10px">Used for every figure in the app and your report. Ranked by cost on your usage.</p>
      <div style="overflow-y:auto;margin:0 -4px;padding:0 4px;flex:1">${rows}</div>
      ${state.chosen_plan ? `<button class="modal-btn" style="margin-top:12px" onclick="document.getElementById('plan-picker').remove(); clearChosenPlan()">Use the cheapest instead</button>` : ''}
      <button class="modal-skip" onclick="document.getElementById('plan-picker').remove()">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

/** Select from the picker, then close it — choosePlan() re-renders behind. */
function pickPlan(planId){
  const modal = document.getElementById('plan-picker');
  if (modal) modal.remove();
  choosePlan(planId);
}

function setEvMode(m){
  state.ev_in_bill = m === 'have';
  invalidate();
  calibrateBillsToBaseline();
  saveState();
  showToast(m === 'have'
    ? 'Charging counted inside your bill — base load carved accordingly'
    : 'Charging added on top of your bill', { type:'accent', icon:ic('car',16) });
  renderApp();
}

function toggleEv(){
  state.ev_active = !state.ev_active;
  if (state.ev_active){
    if (!state.ev_km_per_year) state.ev_km_per_year = 15000;
    if (state.battery_kwh > 0){
      state.charge_from_grid = true;
      if (state.strategy_mode !== 'auto') state.strategy_mode = 'arbitrage';
    }
  } else {
    state.ev_km_per_year = 0;
  }
  invalidate();
  saveState();
  renderApp();
}

function requestInstallerQuotes(){
  if (!state.email_captured){
    openEmailModal('installer_quotes');
    return;
  }
  // Email already captured — log the lead request
  dlog('LEAD', 'installer_quote', {
    email: state.user_email,
    spec: {
      panels: totalPanels(),
      panel_w: state.panel_w,
      battery_kwh: state.battery_kwh,
      inverter_kw: state.inverter_kw,
      ev: state.ev_active,
      address: state.address
    }
  });
  showToast('Saved on this device. Installer matching isn\u2019t live yet — you can copy these details into a quote request.', { type:'blue', icon:ic('info',16) });
}

/* ============================================================
   PLANS SCREEN — full ranking of all 14 Irish tariffs
   ============================================================ */

/**
 * States whether the app is following the ranking or a hand-picked plan.
 *
 * Shown wherever the recommendation is acted on, because a figure computed on a
 * plan the user chose for non-price reasons must never read as our advice.
 */
function renderChoiceStrip(){
  const rec = getRecommendation();
  if (!rec.best) return '';
  if (!rec.isManualChoice){
    return `<div class="choice-strip hint">
      Tap a plan for detail, or to go with it.
    </div>`;
  }
  const premium = rec.choicePremium;
  return `<div class="choice-strip">
    <div>
      <b>${ic('checkC',13)} ${rec.best.plan.supplier} — ${rec.best.plan.plan}</b>
      <div class="choice-strip-sub">Your plan · #${rec.chosenRank}${
        premium > 1 ? ` · ${fmtCurrency(premium)}/yr more than the cheapest` : ''
      }</div>
    </div>
    <button class="chosen-banner-undo" onclick="clearChosenPlan()">Use cheapest</button>
  </div>`;
}

function showPlanDetail(planId){
  state._detail_plan_id = planId;
  state.current_screen = 'plan-detail';
  saveState();
  renderApp();
}

function renderPlanDetail(){
  const planId = state._detail_plan_id;
  if (!planId) return V7.plans();
  const plan = getPlanById(planId);
  const baseTariff = TARIFFS.find(t => t.id === planId);  // original (un-edited) rates
  const isEdited = !!(state.plan_overrides && state.plan_overrides[planId]);
  if (CACHE.dirty) rebuildBase();
  const s = sim(planId);
  const c = annualCost(s, plan);
  const isCurrent = state.baseline === planId;
  const flat = isFlatPlan(plan);
  const planType = plan.type || 'flat';

  return `${topbar('Plan details', 'blue', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="setScreen('plans')">← All plans</button>
    </div>

    <div class="pd-hero">
      <div class="pd-hero-supplier">${plan.supplier}${plan.discontinued ? ' · DISCONTINUED' : ''}</div>
      <div class="pd-hero-plan">${plan.plan}</div>
      <div class="pd-hero-tags">
        <span class="pd-hero-tag ${planType}">${planType === 'flat' ? 'One price all day' : planType === 'tou' ? 'Cheaper at night' : planType === 'ev' ? 'Cheap EV-charging hours' : planType === 'dynamic' ? 'Price changes hourly' : planType}</span>
        ${plan.green ? '<span class="pd-hero-tag tou">Green</span>' : ''}
        ${plan.length ? `<span class="pd-hero-tag">${plan.length}-month contract</span>` : ''}
        ${isCurrent ? '<span class="pd-hero-tag tou">Your baseline</span>' : ''}
        ${isEdited ? '<span class="pd-hero-tag edited">EDITED</span>' : ''}
        ${baseTariff.verified_date ? `<span class="pd-hero-tag" style="color:var(--accent);border-color:var(--accent)">✓ Verified ${fmtVerifiedDate(baseTariff.verified_date)}</span>` : ''}
      </div>
    </div>

    <div class="pd-cost-card">
      <div class="pd-cost-label">Your annual cost on this plan</div>
      <div class="pd-cost-value">${fmtCurrency(c.net)}<span style="font-size:13px;color:var(--ink-soft);font-weight:500;margin-left:4px">/yr</span></div>
      <div class="pd-cost-sub">
        ${fmtCurrency(c.energy_cost)} energy · ${fmtCurrency(c.standing)} standing
        ${c.export_revenue > 0 ? ` · −${fmtCurrency(c.export_revenue)} export` : ''}
      </div>
    </div>

    <div class="pd-section-title">
      <span>Rates (€/kWh, incl. VAT)</span>
      ${isEdited ? `<button onclick="resetPlanOverride('${planId}')">↺ Reset to default</button>` : ''}
    </div>
    <div class="pd-rate-card">
      ${flat ? `
        <div class="pd-rate-row">
          <div class="pd-rate-label">Flat rate
            <small>All hours, every day</small>
          </div>
          <div>
            <input class="pd-rate-input ${baseTariff.rates.day !== plan.rates.day ? 'edited' : ''}" type="number" inputmode="decimal" step="0.001" min="0" max="2" value="${plan.rates.day.toFixed(4)}" onchange="editPlanRate('${planId}', 'day', this.value); editPlanRate('${planId}', 'night', this.value); editPlanRate('${planId}', 'peak', this.value); editPlanRate('${planId}', 'ev', this.value);">
            <span class="pd-rate-unit">€/kWh</span>
          </div>
        </div>
      ` : `
        ${['day','night','peak','ev','wfh'].filter(b => baseTariff.rates[b] != null && baseTariff.rates[b] !== undefined).map(band => {
          const isModified = baseTariff.rates[band] !== plan.rates[band];
          const window = plan.windows && plan.windows[band];
          const windowText = window ? `${window[0]}h–${window[1]}h` : '';
          const labels = { day:'Day', night:'Night', peak:'Peak', ev:'EV window', wfh:'Work-from-home' };
          const subs = {
            day:'Standard daytime hours',
            night:'Cheap off-peak (typically 23h–8h)',
            peak:'Most expensive (typically 17h–19h)',
            ev:'Ultra-cheap EV charging window',
            wfh:'Daytime work-from-home discount band'
          };
          return `<div class="pd-rate-row">
            <div class="pd-rate-label">${labels[band] || band.toUpperCase()}
              <small>${windowText || subs[band] || ''}</small>
            </div>
            <div>
              <input class="pd-rate-input ${isModified ? 'edited' : ''}" type="number" inputmode="decimal" step="0.001" min="0" max="2" value="${plan.rates[band].toFixed(4)}" onchange="editPlanRate('${planId}', '${band}', this.value)">
              <span class="pd-rate-unit">€/kWh</span>
            </div>
          </div>`;
        }).join('')}
      `}
    </div>

    <div class="pd-section-title"><span>Export &amp; charges</span></div>
    <div class="pd-rate-card">
      <div class="pd-rate-row">
        <div class="pd-rate-label">CEG export rate
          <small>Paid for surplus solar exported to grid</small>
        </div>
        <div>
          <input class="pd-rate-input ${baseTariff.export_rate !== plan.export_rate ? 'edited' : ''}" type="number" inputmode="decimal" step="0.001" min="0" max="1" value="${plan.export_rate.toFixed(4)}" onchange="editPlanField('${planId}', 'export_rate', this.value)">
          <span class="pd-rate-unit">€/kWh</span>
        </div>
      </div>
      <div class="pd-rate-row">
        <div class="pd-rate-label">Annual standing charge
          <small>Fixed daily fee; the PSO levy is added on top</small>
        </div>
        <div>
          <input class="pd-rate-input ${baseTariff.standing !== plan.standing ? 'edited' : ''}" type="number" inputmode="decimal" step="0.01" min="0" max="2000" value="${plan.standing.toFixed(2)}" onchange="editPlanField('${planId}', 'standing', this.value)">
          <span class="pd-rate-unit">€/yr</span>
        </div>
      </div>
    </div>

    ${plan.notes ? `
      <div class="pd-notes-card">
        <b>Supplier note</b>
        ${plan.notes}
      </div>
    ` : ''}

    <div class="pd-section-title"><span>Actions</span></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${!isCurrent && !plan.discontinued ? `
        <button class="switch-cta" style="margin-bottom:0" onclick="v7Sheet('switch','${planId}')">
          Switch to ${plan.supplier} →
        </button>
      ` : ''}
      ${!plan.discontinued ? `
        <button class="btn-secondary" onclick="openHowToSwitch('${planId}')" style="border-color:var(--blue);color:var(--blue)">${ic('clip',14)} How to switch to ${plan.supplier}</button>
      ` : ''}
      ${chooseAction(planId, plan, c.net)}
      ${!isCurrent ? `
        <button class="btn-secondary" onclick="setAsBaseline('${planId}')">Use as comparison baseline</button>
      ` : '<div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);text-align:center;padding:10px;letter-spacing:.04em">✓ This is your current baseline</div>'}
    </div>

    <p class="disclaimer">
      <b>Editing rates:</b> Changes you make here override the supplier's official rate for this analysis only. Useful for "what if my rate goes up 10%?" scenarios or to enter a custom contract rate. Tap "Reset to default" to restore the original verified-2026 rates. All edits persist on this device only.
    </p>
  </div>
  ${bottomNav()}`;
}

/**
 * "Go with this plan" control for the detail screen.
 *
 * States it has to express: this is already what we recommend; this is what you
 * picked; or you could pick it, and here is what that costs you a year. The
 * price of the choice is stated up front rather than discovered afterwards.
 */
function chooseAction(planId, plan, netCost){
  if (!isRankablePlan(plan)) return '';
  const rec = getRecommendation();
  const isChosen = state.chosen_plan === planId;
  const isCheapest = !!rec.cheapest && rec.cheapest.plan.id === planId;

  if (isChosen){
    return `<div class="chosen-banner">
      <div>${ic('checkC',14)} <b>Your plan</b><div class="chosen-banner-sub">Used for every figure in the app and your report.</div></div>
      <button class="chosen-banner-undo" onclick="clearChosenPlan()">Undo</button>
    </div>`;
  }
  if (isCheapest && !rec.isManualChoice){
    return `<div style="font-family:var(--mono);font-size:12px;color:var(--accent);text-align:center;padding:10px;letter-spacing:.04em">★ Cheapest for your usage</div>`;
  }
  const premium = rec.cheapest ? netCost - rec.cheapest.net : 0;
  const note = premium > 1 ? `+${fmtCurrency(premium)}/yr` : 'same cost';
  return `<button class="btn-secondary" onclick="choosePlan('${planId}')">
    Use this plan<span style="opacity:.7;font-weight:400"> · ${note}</span>
  </button>`;
}

function editPlanRate(planId, band, value){
  const v = parseFloat(value);
  if (!isFinite(v) || v < 0) return;
  if (!state.plan_overrides) state.plan_overrides = {};
  if (!state.plan_overrides[planId]) state.plan_overrides[planId] = {};
  if (!state.plan_overrides[planId].rates) state.plan_overrides[planId].rates = {};
  state.plan_overrides[planId].rates[band] = v;
  invalidate();
  saveState();
  renderApp();
}

function editPlanField(planId, field, value){
  const v = parseFloat(value);
  if (!isFinite(v) || v < 0) return;
  if (!state.plan_overrides) state.plan_overrides = {};
  if (!state.plan_overrides[planId]) state.plan_overrides[planId] = {};
  state.plan_overrides[planId][field] = v;
  invalidate();
  saveState();
  renderApp();
}

function resetPlanOverride(planId){
  if (!confirm('Reset all edits to ' + getPlanById(planId).supplier + '\u2019s default rates?')) return;
  if (state.plan_overrides && state.plan_overrides[planId]){
    delete state.plan_overrides[planId];
    invalidate();
    saveState();
    renderApp();
  }
}

/**
 * Adopt a plan as the one every figure is computed on.
 *
 * Choosing the plan that already tops the ranking is stored as "no choice" —
 * otherwise the pick would silently freeze as rates move and the app would keep
 * recommending a plan that is no longer cheapest.
 */
function choosePlan(planId){
  const plan = getPlanById(planId);
  if (!isRankablePlan(plan)) return;
  const rec = getRecommendation();
  if (rec.cheapest && rec.cheapest.plan.id === planId){
    return clearChosenPlan();
  }
  state.chosen_plan = planId;
  invalidate();
  saveState();
  renderApp();
  const premium = getRecommendation().choicePremium;
  showToast(
    premium > 1
      ? `${plan.supplier} · ${fmtCurrency(premium)}/yr more than the cheapest`
      : `${plan.supplier} — ${plan.plan}`,
    { type: 'accent', icon: ic('checkC', 16) });
}

function clearChosenPlan(){
  if (!state.chosen_plan) return;
  state.chosen_plan = null;
  invalidate();
  saveState();
  renderApp();
  showToast('Using the cheapest plan');
}

function setAsBaseline(planId){
  state.baseline = planId;
  invalidate();
  saveState();
  setScreen('plans');
}

function openPlanDetail(planId){
  showPlanDetail(planId);
}

/* ============================================================
   DETAILS SECTION — for Solar tab, expandable engine deep-dive
   ============================================================ */
function renderDetailsBlock(){
  if (!state.has_solar) return '';
  if (CACHE.dirty) rebuildBase();
  const best = getBestPlan();
  const s = best.sim;
  const totalGen = sumF(s.gen);
  const totalCons = sumF(s.cons);
  const totalImport = sumF(s.grid_import);
  const totalExport = sumF(s.grid_export);
  const totalSelfUse = sumF(s.self_use);
  const totalBatteryCharge = sumF(s.battery_charge);
  const totalBatteryDischarge = sumF(s.battery_discharge);
  const totalCurtailed = sumF(s.curtailed);

  // Monthly buckets for chart
  const HOURS_PER_MONTH = HOURS_IN_YEAR / 12;
  const monthlyGen = new Array(12).fill(0);
  const monthlyCons = new Array(12).fill(0);
  const monthlyImport = new Array(12).fill(0);
  const monthlyExport = new Array(12).fill(0);
  for (let i = 0; i < HOURS_IN_YEAR; i++){
    const m = Math.floor(i / HOURS_PER_MONTH);
    monthlyGen[m] += s.gen[i];
    monthlyCons[m] += s.cons[i];
    monthlyImport[m] += s.grid_import[i];
    monthlyExport[m] += s.grid_export[i];
  }
  const maxMonthly = Math.max(...monthlyGen, ...monthlyCons);

  return `
    <div class="section-title">Engine details</div>

    <div class="details-section" onclick="this.classList.toggle('open')">
      <div class="details-header">
        <div class="details-title">Energy flow breakdown</div>
        <div class="details-icon">+</div>
      </div>
      <div class="details-body">
        <div class="details-row"><span>Solar generated</span><b class="accent">${Math.round(totalGen).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Used directly (self-use)</span><b>${Math.round(totalSelfUse).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Stored in battery</span><b>${Math.round(totalBatteryCharge).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Discharged from battery</span><b>${Math.round(totalBatteryDischarge).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Exported to grid</span><b class="accent">${Math.round(totalExport).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Curtailed (lost — over export limit)</span><b class="amber">${Math.round(totalCurtailed).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Imported from grid</span><b class="amber">${Math.round(totalImport).toLocaleString()} kWh</b></div>
        <div class="details-row"><span>Total household consumption</span><b>${Math.round(totalCons).toLocaleString()} kWh</b></div>
      </div>
    </div>

    <div class="details-section open" onclick="this.classList.toggle('open')">
      <div class="details-header">
        <div class="details-title">Monthly generation vs consumption</div>
        <div class="details-icon">+</div>
      </div>
      <div class="details-body">
        <div style="display:flex;gap:18px;font-family:var(--mono);font-size:12px;letter-spacing:.04em;margin-bottom:8px">
          <span style="color:var(--accent)">■ Solar generated</span>
          <span style="color:var(--amber)">■ Consumed</span>
        </div>
        <div class="month-bars">
          ${monthlyGen.map((g, i) => `
            <div class="month-bar gen" style="height:${(g/maxMonthly*100).toFixed(0)}%" title="${Math.round(g)} kWh"></div>
          `).join('')}
        </div>
        <div class="month-bars" style="margin-top:0">
          ${monthlyCons.map((c, i) => `
            <div class="month-bar cons" style="height:${(c/maxMonthly*100).toFixed(0)}%" title="${Math.round(c)} kWh"></div>
          `).join('')}
        </div>
        <div class="month-labels">
          ${['J','F','M','A','M','J','J','A','S','O','N','D'].map(m => `<div>${m}</div>`).join('')}
        </div>
      </div>
    </div>

    <div class="details-section" onclick="this.classList.toggle('open')">
      <div class="details-header">
        <div class="details-title">System configuration</div>
        <div class="details-icon">+</div>
      </div>
      <div class="details-body">
        <div class="details-row"><span>Roof A — panels</span><b>${state.count_A}</b></div>
        <div class="details-row"><span>Roof A — orientation</span><b>${sectorFromAzimuth(state.azimuth_A)} (${state.azimuth_A}°)</b></div>
        <div class="details-row"><span>Roof A — tilt</span><b>${state.tilt_A}°</b></div>
        ${state.count_B > 0 ? `
          <div class="details-row"><span>Roof B — panels</span><b>${state.count_B}</b></div>
          <div class="details-row"><span>Roof B — orientation</span><b>${sectorFromAzimuth(state.azimuth_B)} (${state.azimuth_B}°)</b></div>
          <div class="details-row"><span>Roof B — tilt</span><b>${state.tilt_B}°</b></div>
        ` : ''}
        <div class="details-row"><span>Panel rating</span><b>${state.panel_w} W (${state.panel_tech})</b></div>
        <div class="details-row"><span>Total system size</span><b class="accent">${totalKwp().toFixed(2)} kWp</b></div>
        <div class="details-row"><span>Inverter</span><b>${state.inverter_kw} kW</b></div>
        <div class="details-row"><span>Battery</span><b>${state.battery_kwh > 0 ? state.battery_kwh + ' kWh' : 'none'}</b></div>
        ${state.battery_kwh > 0 ? `<div class="details-row"><span>Round-trip efficiency</span><b>${(state.battery_eff*100).toFixed(0)}%</b></div>` : ''}
        <div class="details-row"><span>Export limit</span><b>${state.export_enabled ? state.export_limit_kw + ' kW' : 'disabled'}</b></div>
      </div>
    </div>

    <div class="details-section" onclick="this.classList.toggle('open')">
      <div class="details-header">
        <div class="details-title">Best-plan summary</div>
        <div class="details-icon">+</div>
      </div>
      <div class="details-body">
        <div class="details-row"><span>Plan</span><b>${best.plan.supplier} ${best.plan.plan}</b></div>
        <div class="details-row"><span>Plan type</span><b>${best.plan.type}</b></div>
        <div class="details-row"><span>Day rate</span><b>${fmtCent(best.plan.rates.day)}/kWh</b></div>
        ${best.plan.rates.night && best.plan.rates.night !== best.plan.rates.day ? `<div class="details-row"><span>Night rate</span><b>${fmtCent(best.plan.rates.night)}/kWh</b></div>` : ''}
        ${best.plan.rates.peak && best.plan.rates.peak !== best.plan.rates.day ? `<div class="details-row"><span>Peak rate</span><b class="amber">${fmtCent(best.plan.rates.peak)}/kWh</b></div>` : ''}
        ${best.plan.rates.ev && best.plan.rates.ev !== best.plan.rates.night ? `<div class="details-row"><span>EV rate (2-6am)</span><b class="accent">${fmtCent(best.plan.rates.ev)}/kWh</b></div>` : ''}
        <div class="details-row"><span>Export rate</span><b class="accent">${fmtCent(best.plan.export_rate)}/kWh</b></div>
        <div class="details-row"><span>Standing charge</span><b>${fmtCurrency(best.plan.standing)}/yr</b></div>
        <div class="details-row"><span>Energy cost</span><b class="amber">${fmtCurrency(best.energy_cost)}/yr</b></div>
        <div class="details-row"><span>Export revenue</span><b class="accent">${fmtCurrency(best.export_revenue)}/yr</b></div>
        <div class="details-row"><span>Net annual cost</span><b>${fmtCurrency(best.net)}/yr</b></div>
      </div>
    </div>
  `;
}

/* ============================================================
   REGION PICKER — six Irish zones with PVGIS-calibrated multipliers
   ============================================================ */

// Simplified Ireland silhouette + zone-position SVG.
// Coordinates are an approximation; intent is recognisable shape + zone hint.
function renderIrelandMap(selectedRegion){
  // Zones are placed to match real Irish geography within the silhouette:
  // North-West top, West down the left, Dublin/East on the right, South-East
  // lower-right, South across the bottom, Midlands in the centre.
  const zones = {
    northwest: { d: 'M 32,18 Q 54,14 76,21 L 82,38 Q 68,40 52,38 Q 40,38 31,33 Q 28,25 32,18 Z' },
    west:      { d: 'M 22,40 Q 32,38 45,40 L 50,70 Q 41,80 31,79 Q 23,71 20,60 Q 18,50 22,40 Z' },
    east:      { d: 'M 82,38 Q 94,45 101,66 Q 97,77 89,80 L 78,72 Q 76,55 78,41 Q 79,38 82,38 Z' },
    midlands:  { d: 'M 45,40 Q 61,38 78,41 Q 76,55 78,72 Q 64,76 53,74 L 50,70 Q 47,55 45,40 Z' },
    southeast: { d: 'M 89,80 Q 97,84 99,95 Q 93,101 84,99 L 79,89 Q 82,82 89,80 Z' },
    south:     { d: 'M 31,79 Q 42,77 53,79 L 79,89 Q 84,99 76,103 Q 56,107 41,103 Q 31,98 29,89 Q 28,83 31,79 Z' }
  };
  return `<svg class="region-map-svg" viewBox="0 0 130 130" xmlns="http://www.w3.org/2000/svg">
    <path class="region-map-outline" d="M 32,18 Q 54,14 76,21 Q 93,28 101,52 Q 109,72 99,98 Q 90,106 76,104 Q 56,108 41,104 Q 28,99 24,84 Q 16,64 20,46 Q 23,27 32,18 Z"/>
    ${Object.entries(zones).map(([id, z]) => `
      <path class="region-map-zone ${id === selectedRegion ? 'active' : ''}" d="${z.d}" onclick="setRegion('${id}')"></path>
    `).join('')}
  </svg>`;
}

// Reading order matches a map on a 2-column grid: west on the left, east on
// the right, north at the top. (The IRISH_REGIONS object keeps its own order
// for the engine; this is purely how the tiles are laid out on screen.)
const REGION_GRID_ORDER = ['northwest','east','west','midlands','south','southeast'];
function renderRegionPicker(currentRegion){
  return `<div class="region-grid">
    ${REGION_GRID_ORDER.map(id => {
      const r = IRISH_REGIONS[id];
      const pct = Math.round((r.ghi_multiplier - 1) * 100);
      const cls = pct > 0 ? 'positive' : pct === 0 ? 'baseline' : 'negative';
      // Every tile now reads as the same kind of thing: a percentage against the
      // national average. The zero case said "baseline", a word twice the width
      // of "-6%", and the badge is laid out in the row rather than floated over
      // it — so on the first screen after the front door it covered the region
      // name it was describing.
      const label = pct === 0 ? '0%' : pct > 0 ? `+${pct}%` : `${pct}%`;
      return `<div class="region-tile ${id === currentRegion ? 'active' : ''}" onclick="setRegion('${id}')">
        <div class="region-tile-head">
          <div class="region-tile-icon">${ic('pin',16)}</div>
          <div class="region-tile-name">${r.name}</div>
          <div class="region-tile-multi ${cls}">${label}</div>
        </div>
        <div class="region-tile-counties">${r.counties}</div>
      </div>`;
    }).join('')}
  </div>
  <div class="region-map-wrap">
    ${renderIrelandMap(currentRegion)}
    <div class="region-map-info">
      <div class="region-map-info-label">Selected zone</div>
      <div class="region-map-info-name">${ic('pin',13)} ${IRISH_REGIONS[currentRegion].name}</div>
      <div class="region-map-info-sub">
        ${IRISH_REGIONS[currentRegion].ghi_multiplier === 1 ? 'Irish national baseline' : (IRISH_REGIONS[currentRegion].ghi_multiplier > 1 ? '+' + Math.round((IRISH_REGIONS[currentRegion].ghi_multiplier - 1) * 100) + '% solar yield vs national avg' : Math.round((IRISH_REGIONS[currentRegion].ghi_multiplier - 1) * 100) + '% solar yield vs national avg')} ·
        avg ${(LOCATION_BASE.temp_c.reduce((a,b)=>a+b,0)/12 + IRISH_REGIONS[currentRegion].temp_offset).toFixed(1)}°C
      </div>
    </div>
  </div>`;
}

function setRegion(regionId){
  if (state.current_screen === 'onboarding'){
    _ob.region = regionId;
    renderApp();
    return;
  }
  const wasRegion = state.region;
  state.region = regionId;
  invalidate();
  saveState();
  renderApp();
  if (wasRegion !== regionId){
    const r = IRISH_REGIONS[regionId];
    const pct = Math.round((r.ghi_multiplier - 1) * 100);
    const delta = pct > 0 ? `+${pct}% sun` : pct === 0 ? 'baseline' : `${pct}% sun`;
    showToast(`Now modelling for ${r.name} (${delta} vs national avg)`, { type:'blue', icon:ic('pin',16), title:'Region updated' });
  }
}

/* ============================================================
   EV INDICATOR CHIP — shows "EV: X km/yr" wherever EV is active
   ============================================================ */
// Tiny configuration chips for hero cards — instantly shows what's in the model
function configChips(){
  const chip = (icon, on, label) => `
    <span style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:999px;font-family:var(--mono);font-size:12px;letter-spacing:.02em;border:1px solid ${on ? 'var(--accent)' : 'var(--line)'};background:${on ? 'var(--accent-soft)' : 'transparent'};color:${on ? 'var(--accent)' : 'var(--ink-dim)'}">${icon}${label}</span>`;
  const pvOn = state.has_solar && totalPanels() > 0;
  const battOn = state.has_solar && (state.battery_kwh || 0) > 0;
  const evOn = !!state.ev_active;
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
    ${chip(ic('sun',12), pvOn, pvOn ? totalKwp().toFixed(1)+' kWp' : 'no PV')}
    ${chip(ic('battery',12), battOn, battOn ? state.battery_kwh+' kWh' : 'no battery')}
    ${chip(ic('car',12), evOn, evOn ? Math.round((state.ev_km_per_year||15000)/1000)+'k km EV' : 'no EV')}
  </div>`;
}

/* ============================================================
   ANALYTICS SCREEN — day inspector + annual flows
   Built to match the engineering tool's detail/costs views.
   ============================================================ */

// ─── Day Inspector (solar screen) ─────────────────────────────────────────────
function renderDayInspector(){
  if (CACHE.dirty) rebuildBase();
  const best = getBestPlan();
  const plan = best.plan;
  const s = sim(plan.id);

  // Summer = Jun 21 (idx 172), Winter = Jan 19 (idx 18)
  const season = state._di_season || 'summer';
  const dayIdx = season === 'summer' ? 172 : 18;
  const start = dayIdx * 24;

  // Build 24-hour arrays
  const gen = [], cons = [], imp = [], exp = [], ch = [], dis = [], soc = [];
  for (let h = 0; h < 24; h++){
    const i = start + h;
    gen.push(s.gen[i]);
    cons.push(s.cons[i]);
    imp.push(s.grid_import[i]);
    exp.push(s.grid_export[i]);
    ch.push(s.battery_charge[i]);
    // battery_discharge is what leaves the cells; the home receives it after
    // the inverter's one-way loss. Draw what the home actually gets.
    dis.push(s.battery_discharge[i] * Math.sqrt(state.battery_eff || 0.9));
    soc.push(s.soc ? s.soc[i] : 0);
  }

  // Chart dimensions
  const W = 320, H = 160, PAD_L = 28, PAD_R = 8, PAD_T = 12, PAD_B = 28;
  const CW = W - PAD_L - PAD_R;
  const CH = H - PAD_T - PAD_B;
  const barW = CW / 24;

  const hasBattery = state.battery_kwh > 0;

  // Power-flow convention (as inverter apps draw it): what SUPPLIES the home
  // is above zero, what USES or TAKES energy is below. Each flow keeps one
  // colour; its side of the line is its direction.
  //   solar  = +gen
  //   battery = +discharge  / −charge
  //   grid   = +import     / −export
  //   home   = −use
  // Above and below balance every hour.
  const flows = {
    solar: gen.map(v => v),
    battery: hasBattery ? dis.map((v, h) => v - ch[h]) : null,
    grid: imp.map((v, h) => v - exp[h]),
    home: cons.map(v => -v),
  };
  let top = 0.5, bot = 0.5;
  for (const k in flows){ const a = flows[k]; if (!a) continue; for (const v of a){ top = Math.max(top, v); bot = Math.max(bot, -v); } }
  const M = Math.ceil(Math.max(top, bot) * 2) / 2;   // symmetric, like the reference
  const zeroY = PAD_T + CH / 2;
  const yScale = v => zeroY - (v / M) * (CH / 2);
  const xPos = h => PAD_L + h * barW;
  const xMid = h => PAD_L + (h + 0.5) * barW;
  const pathOf = (arr) => arr.map((v, h) => `${h === 0 ? 'M' : 'L'}${xMid(h).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
  const areaOf = (arr) => `${pathOf(arr)} L${xMid(23).toFixed(1)},${zeroY.toFixed(1)} L${xMid(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const C = { solar: '#e0a800', battery: '#14a3a3', grid: '#4f6fe0', home: '#9b59d0' };
  const NAME = { solar: 'Solar', battery: 'Battery', grid: 'Grid', home: 'Home use' };

  const label = season === 'summer' ? 'Summer · Jun 21' : 'Winter · Jan 19';
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const totalExport = sum(exp), totalImport = sum(imp), totalGen = sum(gen);
  const selfUse = Math.max(0, totalGen - totalExport);

  // The plan's own cheap and peak windows, shaded behind the lines.
  const w = plan.windows || {};
  const cheap = w.ev || w.night;
  const bands = [];
  if (cheap) bands.push({ win: cheap, fill: 'rgba(79,111,224,.07)', text: C.grid, label: w.ev ? 'EV rate' : 'night rate' });
  if (w.peak) bands.push({ win: w.peak, fill: 'rgba(224,80,60,.08)', text: '#e0503c', label: 'peak' });
  const bandRects = bands.flatMap(b => {
    const [a, z] = b.win;
    const spans = a < z ? [[a, z]] : [[a, 24], [0, z]];
    return spans.map(([x0, x1], i) => `<rect x="${xPos(x0).toFixed(1)}" y="${PAD_T}" width="${(xPos(x1) - xPos(x0)).toFixed(1)}" height="${CH}" fill="${b.fill}"/>
      ${i === 0 ? `<text x="${((xPos(x0) + xPos(x1)) / 2).toFixed(1)}" y="${(PAD_T + 9).toFixed(1)}" text-anchor="middle" fill="${b.text}" font-size="10">${b.label}</text>` : ''}`);
  }).join('');

  // Tap an hour: a marker, and the hour said in words.
  const sel = Number.isInteger(state._di_hour) ? state._di_hour : null;
  const hitRects = Array.from({ length: 24 }, (_, h) =>
    `<rect x="${xPos(h).toFixed(1)}" y="${PAD_T}" width="${barW.toFixed(1)}" height="${CH}" fill="transparent" style="cursor:pointer" onclick="state._di_hour=${sel === h ? 'null' : h};renderApp()"><title>${String(h).padStart(2, '0')}:00</title></rect>`).join('');
  const kw = (v) => `${Math.abs(v).toFixed(1)} kWh`;
  const readout = sel == null ? `<div style="font-size:12px;color:var(--ink-dim);margin-top:6px">Tap any hour to see where the power came from and went.</div>` : (() => {
    const h = sel, parts = [];
    if (gen[h] > 0.05) parts.push(`solar made ${kw(gen[h])}`);
    if (hasBattery && dis[h] > 0.05) parts.push(`the battery gave ${kw(dis[h])}`);
    if (hasBattery && ch[h] > 0.05) parts.push(`the battery took in ${kw(ch[h])}`);
    if (imp[h] > 0.05) parts.push(`${kw(imp[h])} was bought from the grid`);
    if (exp[h] > 0.05) parts.push(`${kw(exp[h])} was sold to the grid`);
    return `<div style="font-size:13px;color:var(--ink);margin-top:8px;padding:8px 10px;background:var(--well);border-radius:8px;line-height:1.5">
      <b>${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00</b> · the home used ${kw(cons[h])}${parts.length ? '; ' + parts.join(', ') : ''}.</div>`;
  })();

  const yLabels = [M, 0, -M].map(v => ({ v, y: yScale(v) }));
  const xLabels = [0, 4, 8, 12, 16, 20].map(h => ({ x: xPos(h), label: String(h).padStart(2, '0') + ':00' }));
  const order = ['home', 'grid', 'battery', 'solar'].filter(k => flows[k]);
  const legend = [
    ['solar', 'Solar', 'made by the panels'],
    hasBattery ? ['battery', 'Battery', '↑ powering the home · ↓ charging'] : null,
    ['grid', 'Grid', '↑ buying · ↓ selling'],
    ['home', 'Home use', 'always below the line'],
  ].filter(Boolean);

  return `
  <div class="section-title" style="margin-top:20px">A summer and a winter day</div>
  <div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 12px 10px;margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700;color:var(--ink)">${label}</div>
      <div style="display:inline-flex;gap:4px;padding:3px;background:var(--well);border:1px solid var(--line);border-radius:999px">
        ${['summer','winter'].map(s2 => {
          const active = season === s2;
          return `<button onclick="state._di_season='${s2}';state._di_hour=null;renderApp();" style="padding:4px 11px;font-size:12px;font-weight:700;border:none;cursor:pointer;border-radius:999px;background:${active ? 'var(--accent)' : 'transparent'};color:${active ? 'var(--accent-ink, #fff)' : 'var(--ink-soft)'};">${s2 === 'summer' ? 'Summer' : 'Winter'}</button>`;
        }).join('')}
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:6px">
      ${legend.map(([k, n, d]) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft)"><i style="width:9px;height:9px;border-radius:50%;background:${C[k]};display:inline-block"></i><b style="color:var(--ink);font-weight:600">${n}</b> ${d}</span>`).join('')}
    </div>
    <svg viewBox="0 0 ${W} ${H + 14}" width="100%" style="display:block;color:var(--ink-dim)" role="img" aria-label="${label}: where the home's power came from and went, hour by hour">
      ${bandRects}
      ${yLabels.map(l => `<line x1="${PAD_L}" y1="${l.y.toFixed(1)}" x2="${W - PAD_R}" y2="${l.y.toFixed(1)}" stroke="currentColor" stroke-opacity="${l.v === 0 ? '.5' : '.15'}" stroke-dasharray="${l.v === 0 ? '' : '3,3'}"/>`).join('')}
      ${order.map(k => `<path d="${areaOf(flows[k])}" fill="${C[k]}" fill-opacity=".16"/>`).join('')}
      ${order.map(k => `<path d="${pathOf(flows[k])}" fill="none" stroke="${C[k]}" stroke-width="1.8" stroke-linejoin="round"/>`).join('')}
      ${sel != null ? `<line x1="${xMid(sel).toFixed(1)}" y1="${PAD_T}" x2="${xMid(sel).toFixed(1)}" y2="${PAD_T + CH}" stroke="currentColor" stroke-opacity=".6"/>
        ${order.map(k => `<circle cx="${xMid(sel).toFixed(1)}" cy="${yScale(flows[k][sel]).toFixed(1)}" r="3" fill="${C[k]}"/>`).join('')}` : ''}
      ${yLabels.map(l => `<text x="${(PAD_L - 4).toFixed(1)}" y="${(l.y + 3).toFixed(1)}" text-anchor="end" fill="currentColor" font-size="10">${l.v === 0 ? '0' : (l.v > 0 ? '' : '−') + Math.abs(l.v)}</text>`).join('')}
      ${xLabels.map(l => `<text x="${l.x.toFixed(1)}" y="${(PAD_T + CH + 18).toFixed(1)}" text-anchor="middle" fill="currentColor" font-size="10">${l.label}</text>`).join('')}
      ${hitRects}
    </svg>
    <div style="font-size:12px;color:var(--ink-dim)">Above the line: what supplies the home. Below: what the home uses, and what is sold or stored.</div>
    ${readout}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">
      ${[
        { label: 'Solar made', val: totalGen.toFixed(1) + ' kWh', color: C.solar },
        { label: 'Bought', val: totalImport.toFixed(1) + ' kWh', color: C.grid },
        { label: 'Sold', val: totalExport.toFixed(1) + ' kWh', color: C.grid },
      ].map(st => `
        <div style="background:var(--well);border-radius:8px;padding:7px 8px;text-align:center">
          <div style="font-size:12px;color:var(--ink-dim);margin-bottom:2px">${st.label}</div>
          <div style="font-size:13px;font-weight:700;color:${st.color}">${st.val}</div>
        </div>`).join('')}
    </div>
    <div style="font-size:12px;color:var(--ink-dim);margin-top:6px">kWh in each hour. ${selfUse.toFixed(1)} kWh of the solar was used at home${hasBattery ? ', directly or through the battery' : ''}.</div>
  </div>`;
}

/** Show one month's bill on the Bill tab. Hover and tap both land here, so it swaps the shown month in place rather than redrawing the page. */
function anMonth(i){
  state._an_mon = Math.max(0, Math.min(11, i | 0));
  document.querySelectorAll('[data-mon]').forEach((el) => el.classList.toggle('on', +el.dataset.mon === state._an_mon));
  try { saveState(); } catch (e) { /* the month shown is a convenience */ }
}

function setAnalyticsDay(idx){
  state._an_day = Math.max(0, Math.min(364, idx));
  saveState();
  renderApp();
}

/**
 * jsPDF is a real dependency, code-split into its own chunk by the dynamic
 * import below. It used to be fetched from cdnjs at click time, which meant
 * the feature depended on a third-party host being reachable and on a CSP that
 * permits it — and failed on restricted networks. Now it ships with the app,
 * is version-pinned, works offline, and still costs nothing until a user
 * actually asks for a report.
 */
let _jspdfPromise = null;
function ensureJsPdf(){
  if (window.jspdf || window.jsPDF) return Promise.resolve(true);
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = import('jspdf')
    .then((mod) => { window.jspdf = { jsPDF: mod.jsPDF }; return true; })
    .catch(() => { _jspdfPromise = null; return false; });
  return _jspdfPromise;
}

/* ============================================================
   PDF REPORT GENERATION
   Client-side jsPDF report. Covers: plan comparison, solar
   payback, SEAI grant, battery strategy, switching guide.
   ============================================================ */
/* NOTE: a second, dead openPdfReportModal() lived here. It built a
 * client-side-only modal and was silently shadowed by the later
 * declaration in the email-report section, which is the one that ran.
 * Removed during the module migration; doGeneratePdf() below is still
 * live and is invoked from that later modal. */

// async because delivering the file can involve the share sheet, which is a
// promise the reader interacts with. The catch below still owns every failure.
async function doGeneratePdf(email){
  if (!email) {
    const emailEl = document.getElementById('pdf-email-input');
    email = emailEl ? emailEl.value.trim() : '';
  }
  const modal = document.getElementById('pdf-modal');
  if (modal) modal.remove();

  if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined'){
    showToast('Preparing your report\u2026', { type:'accent', icon:ic('doc',16) });
    ensureJsPdf().then(ok => {
      if (ok) doGeneratePdf(email);   // fire and forget: the retry owns its own errors
      else showToast('Couldn\u2019t start the PDF engine \u2014 please reload and try again', { type:'amber', icon:ic('warn',16) });
    });
    return;
  }

  try {
    if (CACHE.dirty) rebuildBase();
    const best         = getBestPlan();
    const baselinePlan = getPlanById(state.baseline);
    const baseSim      = baselineSim(state.baseline);
    const baseCost     = sumF(baseSim.cost) + baselinePlan.standing + PSO_LEVY;
    const saving       = Math.max(0, baseCost - best.net);
    const annualKwh    = Object.values(state.bills).reduce((a,b)=>a+b,0);
    const econ         = state.ev_active ? evEconomics(best.plan.id) : null;

    // Full ranking, same filter the app's recommendation uses.
    const rec = getRecommendation();

    // Solar scenario + 20-year cumulative curve for the cash-flow chart.
    let scenario = null, npvSeries = [], breakevenYear = null;
    if (state.has_solar && totalPanels() > 0){
      try {
        const range = computeScenarioRange();
        const sc = range.realistic;
        const bp = best.sim || sim(best.plan.id);
        const gen = sumF(CACHE.solar && CACHE.solar.total);
        const exported = sumF(bp && bp.grid_export);
        scenario = {
          generated: gen,
          exported,
          selfConsumed: Math.max(0, gen - exported),
          gridImport: sumF(bp && bp.grid_import),
          solarBenefit: sc ? Math.round(sc.solarBenefit || 0) : 0,
          payback: sc && sc.payback != null && sc.payback < 50 ? sc.payback : null,
          npv20: 0,
        };
        const netCost = Math.max(0, (state.install_cost||0) - (state.grant_seai||0));
        const r = 0.03, deg = state.panel_degradation || 0.005;
        let cum = -netCost;
        npvSeries.push(cum);
        for (let yv = 1; yv <= 20; yv++){
          cum += (scenario.solarBenefit * Math.pow(1-deg, yv-1)) / Math.pow(1+r, yv);
          if ((state.battery_kwh||0) > 0 && yv === 12) cum -= (400*state.battery_kwh)/Math.pow(1+r,12);
          npvSeries.push(cum);
          if (breakevenYear === null && cum >= 0) breakevenYear = yv;
        }
        scenario.npv20 = Math.round(cum);
      } catch(e){ scenario = null; }
    }

    const vdates = (TARIFFS||[]).map(t => t.verified_date).filter(Boolean).sort();
    const guide = (typeof SWITCH_GUIDES !== 'undefined' && getSupplierKey)
      ? SWITCH_GUIDES[getSupplierKey(best.plan.id)] : null;
    const switchSteps = (guide && guide.steps ? guide.steps : [
      { title:'Find your MPRN', body:'The 11-digit Meter Point Reference Number is printed on your current electricity bill. You need it to switch.' },
      { title:'Check the rates still match', body:'Rates change. Confirm the unit rates and standing charge on the supplier\u2019s own site before signing up.' },
      { title:'Sign up with the new supplier', body:'Complete the switch online \u2014 it takes about ten minutes. They notify your current supplier for you.' },
      { title:'Wait for the changeover', body:'Completion takes 10\u201315 working days. Your supply is never interrupted and no one visits the property.' },
    ]).map(s => ({ title: s.title, body: s.body }));

    // Hour-of-day unit rates, so the report can show WHY one plan wins
    // rather than only asserting that it does.
    const profileFor = (plan) => {
      try { return Array.from({ length: 24 }, (_, h) => engineRateAt(h, plan, null, null)); }
      catch(e){ return null; }
    };

    // Consumption from a bill carries real uncertainty; show whether the
    // recommendation survives being wrong about it.
    let sensitivity = null;
    try {
      const scale = (f) => {
        const saved = state.bills;
        state.bills = Object.fromEntries(Object.entries(saved).map(([k,v]) => [k, v*f]));
        invalidate(); rebuildBase();
        const b = getBestPlan();
        const bs = baselineSim(state.baseline);
        const cur = sumF(bs.cost) + baselinePlan.standing + PSO_LEVY;
        state.bills = saved;
        return { best: b.net, current: cur };
      };
      const lo = scale(0.8), hi = scale(1.2);
      invalidate(); rebuildBase();
      sensitivity = [
        { label: 'If your usage is 20% lower', best: lo.best, current: lo.current },
        { label: 'As modelled in this report', best: best.net, current: baseCost },
        { label: 'If your usage is 20% higher', best: hi.best, current: hi.current },
      ];
    } catch(e){ sensitivity = null; }

    // Levers: each one re-runs the full 8,760-hour simulation with a single
    // input changed. Nothing here is estimated — a lever that cannot be
    // simulated is not offered, because a plausible-looking number the engine
    // never produced is worse than no number at all.
    const levers = [];
    try {
      const baseNet = best.net;
      /**
       * Run one what-if and put everything back.
       *
       * The lever's own restore is not enough and never was: rebuilding runs
       * the state sanitiser, which can rewrite fields the lever never touched.
       * This used to keep its own three-field guard list; it now shares the one
       * list every other hypothetical uses, so a field added to state is
       * covered here without anyone remembering to come and add it.
       *
       * `mutate`/`restore` are kept because several levers reach outside state
       * entirely — the export-rate lever edits the tariff object.
       */
      const trial = (mutate, restore) => {
        const snap = snapshotSim();
        try {
          mutate();
          invalidate(); rebuildBase();
          return baseNet - getBestPlan().net;   // positive = better off
        } finally {
          restore();
          restoreSim(snap);
          invalidate(); rebuildBase();
        }
      };

      if (state.has_solar && totalPanels() > 0){
        const savedBatt = state.battery_kwh;
        levers.push({
          label: 'Add 5 kWh more battery storage',
          effect: 'More evening demand met from store',
          value: trial(() => { state.battery_kwh = savedBatt + 5; },
                       () => { state.battery_kwh = savedBatt; }),
          note: 'Energy benefit only — before the cost of the battery itself.',
        });
        if (savedBatt > 0){
          levers.push({
            label: 'Remove the battery entirely',
            effect: 'All evening demand bought from the grid',
            value: trial(() => { state.battery_kwh = 0; },
                         () => { state.battery_kwh = savedBatt; }),
          });
        }
        const savedPanels = state.count_A;
        levers.push({
          label: 'Add four more panels',
          effect: 'More generation, more of it exported',
          value: trial(() => { state.count_A = savedPanels + 4; },
                       () => { state.count_A = savedPanels; }),
        });

        // Grid-charging arbitrage fills the battery overnight, which can leave
        // no room for the day's generation. Worth showing what it is actually
        // earning rather than assuming it helps.
        if (savedBatt > 0 && state.charge_from_grid){
          const savedMode = state.strategy_mode, savedCfg = state.charge_from_grid;
          levers.push({
            label: 'Stop charging the battery from the grid',
            effect: 'Battery kept free for the day\u2019s solar',
            value: trial(() => { state.strategy_mode = 'self-consume'; state.charge_from_grid = false; },
                         () => { state.strategy_mode = savedMode; state.charge_from_grid = savedCfg; }),
          });
        }
      }

      const savedExport = getPlanById(best.plan.id).export_rate;
      if (savedExport != null){
        const plan = getPlanById(best.plan.id);
        levers.push({
          label: 'Export rate falls by a third',
          effect: 'Less earned on unused surplus',
          value: trial(() => { plan.export_rate = savedExport * (2 / 3); },
                       () => { plan.export_rate = savedExport; }),
          note: 'Export rates are set by suppliers and are not guaranteed.',
        });
      }
    } catch(e){ /* levers are additive; a failure must not block the report */ }

    // The same four-step comparison Home shows, so the report opens on it.
    let ladder = null;
    try {
      const pl = (state.solar_planned || state.solar_is_estimate) ? plannedLadder() : null;
      const mine = getPlanById(state.baseline);
      if (pl) ladder = [
        { label: 'Current plan', plan: `${mine.supplier} · ${mine.plan}`, value: pl.today, solar: false },
        { label: 'Best plan', plan: `${pl.noSolar.plan.supplier} · ${pl.noSolar.plan.plan}`, value: pl.noSolar.net, solar: false },
        { label: 'Current plan + panels', plan: `${mine.supplier} · ${mine.plan}`, value: pl.mine, solar: true },
        { label: 'Best plan + panels', plan: `${pl.best.plan.supplier} · ${pl.best.plan.plan}`, value: pl.best.net, solar: true, best: true },
      ];
      else ladder = [
        { label: 'Current plan', plan: `${mine.supplier} · ${mine.plan}`, value: baseCost, solar: false },
        ...(state.has_solar && totalPanels() > 0 ? [{ label: 'Current plan, with your panels', plan: `${mine.supplier} · ${mine.plan}`, value: annualCost(sim(mine.id), mine).net, solar: true }] : []),
        { label: rec.isManualChoice ? 'Your chosen plan' : 'Best plan', plan: `${best.plan.supplier} · ${best.plan.plan}`, value: best.net, solar: !!(state.has_solar && totalPanels() > 0), best: true },
      ];
    } catch(e){ ladder = null; }
    let accuracy = null;
    try {
      const a = modelAccuracy();
      accuracy = { pct: a.pct, withMeter: state._csv_imported ? null : accuracyWithMeter(),
        parts: a.parts.map(p => ({ label: p.label, err: p.err, open: !!p.tip, tip: p.tip || '' })) };
    } catch(e){ accuracy = null; }
    const bandsFor = (plan) => { try { return Array.from({ length: 24 }, (_, h) => bandAt(h, plan)); } catch(e){ return null; } };

    const data = buildReportData({
      ladder, accuracy,
      bestBands: bandsFor(best.plan), currentBands: bandsFor(baselinePlan),
      hourly: (best.sim || sim(best.plan.id)),
      levers: levers.filter(l => Number.isFinite(l.value) && Math.abs(l.value) >= 1)
                    .map(l => ({ ...l, value: Math.round(l.value) })),
      state, best, baselinePlan, baseCost, saving, annualKwh, econ,
      ranked: rec.ranked,
      // A plan the reader picked themselves must be reported as their decision,
      // not as our recommendation.
      choice: rec.isManualChoice ? {
        rank: rec.chosenRank,
        premium: rec.choicePremium,
        cheapestName: rec.cheapest ? `${rec.cheapest.plan.supplier} — ${rec.cheapest.plan.plan}` : '',
        cheapestCost: rec.cheapest ? rec.cheapest.net : 0,
      } : null,
      bestDayProfile: profileFor(best.plan),
      currentDayProfile: profileFor(baselinePlan),
      sensitivity,
      supplierUrl: (typeof getAffiliateUrl === 'function' ? getAffiliateUrl(best.plan.id) : null) || null,
      baseEnergy: sumF(baseSim.cost),
      bestEnergy: best.energy_cost,
      bestExport: best.export_revenue,
      scenario, npvSeries, breakevenYear,
      regionName: (IRISH_REGIONS[state.region] || IRISH_REGIONS.east).name,
      usageBasis: state._csv_imported
        ? 'Your real ESB smart-meter data (HDF)'
        : (state.usage_input_mode === 'kwh'
            ? 'Your stated annual kWh, shaped by heating profile'
            : 'Estimated from your bill, calibrated to your current plan'),
      switchSteps,
      tariffCount: rec.rankedCount,
      verifiedDate: vdates.length ? fmtVerifiedDate(vdates[vdates.length-1]) : null,
    });

    const { jsPDF } = window.jspdf || window;
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    renderReport(doc, data);
    const how = await deliverPdf(doc, 'solar-optimiser-report-' + new Date().toISOString().slice(0,10) + '.pdf');
    if (how === 'cancelled') return;
    showToast(
      how === 'shared' ? 'Report ready — choose where to save it'
        : how === 'opened' ? 'Report opened in a new tab — use Share to save it'
        : 'Report downloaded',
      { type:'accent', icon:ic('checkC',16) });
    fireEvent('pdf_generated', { has_solar: !!state.has_solar, ev: !!state.ev_active });
    if (email) submitPdfRequest(email);
  } catch (err){
    console.error('PDF generation failed', err);
    showToast('Couldn\u2019t build the report \u2014 a plain-text summary was downloaded instead',
      { type:'amber', icon:ic('warn',16) });
    try { downloadTextReport(email); } catch(_){}
  }
}

/**
 * Get the finished PDF onto the reader's device.
 *
 * jsPDF's own doc.save() builds a blob URL and clicks an <a download>. On iOS
 * Safari that is not a download: the attribute is ignored for blob URLs, and
 * inside an installed PWA there is no download UI at all. Nothing happens, and
 * nothing throws — so the app cheerfully said "Report downloaded" while no file
 * existed. Which is precisely how this was reported: the download not working,
 * with no error to go on.
 *
 * The share sheet is the supported route to Files on iOS, and it is the native
 * one, so it is tried first wherever it can carry a file. Everything else keeps
 * the ordinary download. Opening the blob in a tab is the last resort, because
 * it at least puts the document somewhere the reader can act on.
 *
 * Returns what actually happened, so the confirmation can tell the truth.
 */
async function deliverPdf(doc, filename){
  const blob = doc.output('blob');

  // Only where the ordinary download is genuinely broken. Android and desktop
  // can both share a file, but a download is the better outcome there — it
  // lands in Downloads instead of asking which app should receive it.
  const iOS = /iP(hone|ad|od)/.test(navigator.platform || '')
    || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1)
    || /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  const standalone = !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches)
    || navigator.standalone === true;

  try {
    if ((iOS || standalone) && typeof File === 'function' && navigator.canShare){
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })){
        try {
          await navigator.share({ files: [file], title: `${BRAND.name} report` });
          return 'shared';
        } catch (e) {
          // Dismissing the sheet is a decision, not a failure — do not then
          // shove a second copy at them through another route.
          if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return 'cancelled';
        }
      }
    }
  } catch (e) { /* fall through to the download path */ }

  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    if ('download' in a){
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return 'downloaded';
    }
    const w = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (!w) throw new Error('the browser blocked opening the report');
    return 'opened';
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

// Plain-text report fallback (no jsPDF). Small, always works, downloads as .txt.
function downloadTextReport(email){
  const best = getBestPlan();
  if (!best || !best.plan) { showToast('No plan data to export yet', { type:'amber' }); return; }
  const saving = Math.max(0, (best.baseCost || 0) - best.net);
  const kwp = totalKwp();
  const L = [];
  L.push(`${BRAND.name.toUpperCase()} — SUMMARY REPORT`);
  L.push(new Date().toLocaleDateString('en-IE'));
  L.push('========================================');
  L.push('');
  L.push('BEST PLAN: ' + best.plan.supplier + ' — ' + best.plan.plan);
  L.push('Net annual cost: €' + Math.round(best.net).toLocaleString());
  L.push('Estimated saving vs your current plan: €' + Math.round(saving).toLocaleString() + '/yr');
  L.push('');
  L.push('YOUR SETUP');
  L.push('Region: ' + ((IRISH_REGIONS[state.region] || {}).name || state.region || 'n/a'));
  L.push('Heating: ' + (state.heating_type || 'n/a'));
  L.push('Solar: ' + (state.has_solar ? kwp.toFixed(1) + ' kWp' + (state.battery_kwh > 0 ? ' + ' + state.battery_kwh + ' kWh battery' : '') : 'none'));
  if (state.ev_active) L.push('EV: ' + (state.ev_km_per_year || 0).toLocaleString() + ' km/yr');
  L.push('');
  L.push('Generated at solarjune.replit.app');
  L.push('(Text fallback — the full PDF could not be produced on this device.)');
  const blob = new Blob([L.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'solar-optimiser-' + new Date().toISOString().slice(0,10) + '.txt'; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { document.body.removeChild(a); } catch(_){} URL.revokeObjectURL(url); }, 5000);
  showToast('PDF unavailable on this device — saved a text summary to Downloads instead', { type:'blue', icon:ic('doc',16), title:'Text report saved' });
}

/* ============================================================
   STRATEGY + CONSUMPTION SHAPE — for Settings tab
   ============================================================ */

function renderStrategyControls(){
  const hasBatt = (state.battery_kwh || 0) > 0;
  const mode = state.strategy_mode || 'auto';
  const isAuto = mode === 'auto';
  const isArb = !isAuto && mode === 'arbitrage' && state.charge_from_grid !== false;
  return `
    <div class="strat-row" style="grid-template-columns:1fr 1fr 1fr">
      <div class="strat-opt ${isAuto ? 'active' : ''}" onclick="setStrategy('auto', true)" style="${!hasBatt ? 'opacity:0.4;pointer-events:none' : ''}">
        <div class="strat-opt-icon">${ic('spark',18)}</div>
        <div class="strat-opt-title">Automatic</div>
        <div class="strat-opt-sub">Recommended. Each plan is costed with the setting that suits it.</div>
      </div>
      <div class="strat-opt ${isArb ? 'active' : ''}" onclick="setStrategy('arbitrage', true)" style="${!hasBatt ? 'opacity:0.4;pointer-events:none' : ''}">
        <div class="strat-opt-icon">${ic('bolt',18)}</div>
        <div class="strat-opt-title">Arbitrage</div>
        <div class="strat-opt-sub">Fills in cheap windows, discharges at peak. Best on TOU/EV plans.</div>
      </div>
      <div class="strat-opt ${!isAuto && !isArb ? 'active' : ''}" onclick="setStrategy('self-consume', false)" style="${!hasBatt ? 'opacity:0.4;pointer-events:none' : ''}">
        <div class="strat-opt-icon">${ic('sun',18)}</div>
        <div class="strat-opt-title">Self-consume</div>
        <div class="strat-opt-sub">Fills from solar only. Use if your plan has no cheap window.</div>
      </div>
    </div>
    ${!hasBatt ? `<p style="font-size:12px;color:var(--ink-dim);margin:6px 0 0;font-family:var(--display);letter-spacing:.02em">Add a battery to choose a strategy.</p>` : ''}

    <div style="margin-top:14px">
      <div style="font-size:12px;color:var(--ink-soft);font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:8px">Hot water strategy</div>
      <div class="strat-row" style="grid-template-columns:1fr 1fr 1fr">
        ${[['none','None','HW from gas/oil boiler — no electric load'],
           ['smart','Smart','15% of load shifted to 2-5am window'],
           ['legacy','Legacy','Immersion timer boost at peak hours']].map(([v,lbl,sub]) => `
          <div class="strat-opt ${state.hot_water_strategy === v ? 'active' : ''}" onclick="setHotWater('${v}')">
            <div class="strat-opt-title">${lbl}</div>
            <div class="strat-opt-sub">${sub}</div>
          </div>`).join('')}
      </div>
      <p style="font-size:12px;color:var(--ink-dim);margin:8px 0 0;font-family:var(--mono);letter-spacing:.02em">
        Gas/oil heating auto-resets to "None" (combi boiler handles HW). Override here if you have separate electric immersion.
      </p>
    </div>`;
}

/**
 * Throw away the cached page and reload onto the current build.
 *
 * The service worker serves the document network-first, but falls back to its
 * cached copy when a fetch fails — and that copy names the old hashed bundles,
 * which are still on the CDN and load quite happily. The result is an app that
 * looks current and is not.
 */
async function hardRefreshApp(){
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) { /* best effort — the reload below still helps */ }
  location.reload(true);
}

function setStrategy(mode, chargeFromGrid){
  state.strategy_mode = mode;
  state.charge_from_grid = chargeFromGrid;
  invalidate();
  saveState();
  renderApp();
}
function setHotWater(v){
  state.hot_water_strategy = v;
  // Don't run invalidate's HW sanitization on user override — they know what they have
  CACHE.dirty = true;
  saveState();
  renderApp();
}

function renderShapeControls(){
  // 4-bucket consumption shape override
  const b = state._shape_buckets || { night: 22, morning: 18, day: 18, evening: 42 };
  const sum = b.night + b.morning + b.day + b.evening;
  return `
    <p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px;line-height:1.5">
      Override the heating-type default if you have smart-meter data showing your actual pattern. Sliders distribute your daily kWh across four time blocks. Must sum to 100%.
    </p>

    <div class="shape-bucket">
      <div class="shape-bucket-label">
        <span>${ic('moon',13)} Overnight (22h–6h)</span>
        <b id="shape-night-val">${b.night}%</b>
      </div>
      <input type="range" class="shape-bucket-range" min="0" max="60" step="1" value="${b.night}"
             oninput="updateShapeBucket('night', +this.value)">
    </div>

    <div class="shape-bucket">
      <div class="shape-bucket-label">
        <span>${ic('clock',13)} Morning (6h–10h)</span>
        <b id="shape-morning-val">${b.morning}%</b>
      </div>
      <input type="range" class="shape-bucket-range" min="0" max="60" step="1" value="${b.morning}"
             oninput="updateShapeBucket('morning', +this.value)">
    </div>

    <div class="shape-bucket">
      <div class="shape-bucket-label">
        <span>${ic('sun',13)} Daytime (10h–17h)</span>
        <b id="shape-day-val">${b.day}%</b>
      </div>
      <input type="range" class="shape-bucket-range" min="0" max="60" step="1" value="${b.day}"
             oninput="updateShapeBucket('day', +this.value)">
    </div>

    <div class="shape-bucket">
      <div class="shape-bucket-label">
        <span>${ic('flame',13)} Evening (17h–22h)</span>
        <b id="shape-evening-val">${b.evening}%</b>
      </div>
      <input type="range" class="shape-bucket-range" min="0" max="60" step="1" value="${b.evening}"
             oninput="updateShapeBucket('evening', +this.value)">
    </div>

    <div class="shape-sum ${sum < 95 || sum > 105 ? 'bad' : ''}">
      Sum: <b>${sum}%</b>
      ${sum < 95 || sum > 105 ? ` <span style="color:var(--amber);margin-left:6px">should equal ~100%</span>` : ''}
    </div>

    <div class="shape-presets">
      <div class="shape-preset" onclick="setShapePreset('gas')">Gas/oil home</div>
      <div class="shape-preset" onclick="setShapePreset('heatpump')">Heat pump home</div>
      <div class="shape-preset" onclick="setShapePreset('storage')">Storage heat</div>
    </div>
    <div style="text-align:center;margin-top:10px">
      <button onclick="clearShapeOverride()" style="background:transparent;border:1px solid var(--line);color:var(--ink-soft);padding:8px 14px;border-radius:8px;font-family:var(--mono);font-size:12px;letter-spacing:.04em;cursor:pointer">Reset to heating-type default</button>
    </div>`;
}

function updateShapeBucket(which, val){
  if (!state._shape_buckets) state._shape_buckets = { night: 22, morning: 18, day: 18, evening: 42 };
  // Clamp and set the slider being moved
  state._shape_buckets[which] = Math.min(val, 100);
  // Auto-balance: the "other" buckets share whatever remains so sum always = 100
  const keys = ['night','morning','day','evening'];
  const rest = keys.filter(k => k !== which);
  const used = state._shape_buckets[which];
  const remaining = Math.max(0, 100 - used);
  const otherTotal = rest.reduce((a,k) => a + state._shape_buckets[k], 0);
  if (otherTotal > 0){
    // Scale the others proportionally, then fix rounding on the last one
    let assigned = 0;
    rest.forEach((k, i) => {
      if (i < rest.length - 1){
        const v = Math.max(1, Math.round(remaining * state._shape_buckets[k] / otherTotal));
        state._shape_buckets[k] = v;
        assigned += v;
      } else {
        state._shape_buckets[k] = Math.max(0, remaining - assigned);
      }
    });
  } else {
    // If all others were 0, distribute equally
    const each = Math.floor(remaining / rest.length);
    rest.forEach((k,i) => { state._shape_buckets[k] = i < rest.length-1 ? each : Math.max(0,remaining-(each*(rest.length-1))); });
  }
  invalidate();
  saveState();
  // Update all four labels without full re-render (keeps slider focus)
  keys.forEach(k => {
    const el = document.getElementById('shape-' + k + '-val');
    if (el) el.textContent = state._shape_buckets[k] + '%';
    // Also sync the slider position so it visually matches
    const sl = document.querySelector('input[oninput*="updateShapeBucket(\''+k+'\',"]');
    if (sl) sl.value = state._shape_buckets[k];
  });
  const sumEl = document.querySelector('.shape-sum b');
  if (sumEl) sumEl.textContent = '100%';
  const warnEl = document.querySelector('.shape-sum span');
  if (warnEl) warnEl.remove();
}

function setShapePreset(type){
  const presets = {
    gas:      { night: 18, morning: 18, day: 16, evening: 48 },
    heatpump: { night: 26, morning: 18, day: 20, evening: 36 },
    storage:  { night: 50, morning: 14, day: 14, evening: 22 }
  };
  state._shape_buckets = { ...presets[type] };
  invalidate();
  saveState();
  renderApp();
}

function clearShapeOverride(){
  delete state._shape_buckets;
  invalidate();
  saveState();
  renderApp();
}

/* ============================================================
   QUOTE AUDITOR — viral standalone tool
   ============================================================ */
let _aud_quote = 14000, _aud_panels = 12, _aud_battery = 5, _aud_result = null;

function renderAuditor(){
  return `${topbar('Quote auditor', 'blue', true)}
  <div class="screen">
    <div class="qr-hero" style="border-color:var(--blue);box-shadow:var(--hero-shadow),0 0 32px -10px var(--blue-glow)">
      <div class="qr-eyebrow" style="color:var(--blue)">Solar quote auditor</div>
      <div style="font-family:var(--display);font-size:20px;font-weight:700;color:var(--ink);line-height:1.3;letter-spacing:-.015em;margin-top:4px">Paste an installer quote.<br>Get an objective verdict.</div>
      <div class="qr-sub">Compared against 2026 Irish market benchmarks. We have no affiliations with installers.</div>
    </div>

    <button class="v7-tile v7-tile-wide" style="margin-bottom:14px" onclick="v7Sheet('quote')">
      <span class="v7-tile-ico">${ic('clip', 18)}</span>
      <span class="v7-tile-big">Upload the quote instead</span>
      <span class="v7-tile-sub">We read the figures from the PDF or a photo, and model your home with it</span>
    </button>
    <div class="card" style="padding:18px">
      <div class="aud-input-row">
        <label>Total quoted price (€)</label>
        <input id="aud-price" type="number" inputmode="numeric" min="0" max="100000" step="100" value="${_aud_quote}">
      </div>
      <div class="aud-input-row">
        <label>Number of panels proposed</label>
        <input id="aud-panels" type="number" inputmode="numeric" min="0" max="50" step="1" value="${_aud_panels}">
      </div>
      <div class="aud-input-row">
        <label>Battery size proposed (kWh, 0 if none)</label>
        <input id="aud-battery" type="number" inputmode="decimal" min="0" max="50" step="0.5" value="${_aud_battery}">
      </div>
      <button class="aud-btn" onclick="runAudit()">Run audit →</button>
    </div>

    <div id="audit-result"></div>

    <div class="card" style="background:rgba(41,182,246,.04);border-color:var(--blue);margin-top:14px">
      <div class="card-label" style="color:var(--blue)">How we benchmark</div>
      <div style="font-size:13px;color:var(--ink-soft);line-height:1.8">
        Panels + inverter: €950-€1,200/kWp installed<br>
        Battery: €350-€480/kWh capacity<br>
        Scaffolding + SEAI cert + wiring: €1,100-€1,300 fixed<br>
        SEAI grant: −€1,800 (auto, if 3.55+ kWp with battery)
      </div>
    </div>

    <p class="disclaimer">
      <b>Note.</b> Benchmarks are estimates. Premium quotes can be justified (complex roofs, EV charger included, high-end inverters). Use this as a negotiation aid, not a final verdict.
    </p>
  </div>
  ${bottomNav()}`;
}

function bindAuditor(){
  ['aud-price','aud-panels','aud-battery'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      _aud_quote   = +document.getElementById('aud-price').value || 0;
      _aud_panels  = +document.getElementById('aud-panels').value || 0;
      _aud_battery = +document.getElementById('aud-battery').value || 0;
    });
  });
}

function runAudit(){
  _aud_quote   = +document.getElementById('aud-price').value || 0;
  _aud_panels  = +document.getElementById('aud-panels').value || 0;
  _aud_battery = +document.getElementById('aud-battery').value || 0;
  if (_aud_quote <= 0 || _aud_panels <= 0){
    document.getElementById('audit-result').innerHTML = `<div class="verdict warning"><div class="v-label">Missing input</div>Enter a quote price and panel count to run the audit.</div>`;
    return;
  }
  _aud_result = auditQuote(_aud_quote, _aud_panels, _aud_battery);
  document.getElementById('audit-result').innerHTML = renderAuditResult(_aud_result);
  // Scroll to result
  setTimeout(() => document.getElementById('audit-result').scrollIntoView({behavior:'smooth', block:'start'}), 50);
}

function renderAuditResult(r){
  return `
    <div class="verdict ${r.verdict}">
      <div class="v-label">Verdict</div>
      <div class="v-headline">${r.headline}</div>
      <p style="line-height:1.6">${r.advice}</p>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <div class="card-label">System size</div>
        <div class="card-value">${r.kwp.toFixed(1)}<span class="unit"> kWp</span></div>
        <div class="card-delta">${_aud_panels} panels @ 440W</div>
      </div>
      <div class="card">
        <div class="card-label">€/kWp ratio</div>
        <div class="card-value ${r.perKwp > 2200 ? 'amber' : r.perKwp < 1400 ? 'accent' : ''}">${fmtCurrency(r.perKwp)}<span class="unit">/kWp</span></div>
        <div class="card-delta">Fair ~€1,150-€1,500 ex-battery</div>
      </div>
      <div class="card">
        <div class="card-label">Fair-market range</div>
        <div class="card-value blue" style="font-size:15px">${fmtCurrency(r.expLo)}–${fmtCurrency(r.expHi)}</div>
        <div class="card-delta">2026 Irish market</div>
      </div>
      <div class="card">
        <div class="card-label">After SEAI grant</div>
        <div class="card-value accent">${fmtCurrency(r.netQuoted)}</div>
        <div class="card-delta">−€${r.grant.toLocaleString()} grant</div>
      </div>
      <div class="card">
        <div class="card-label">Payback (your usage)</div>
        <div class="card-value ${r.payback < 8 ? 'accent' : r.payback < 15 ? 'amber' : 'red'}">${r.payback < 50 ? r.payback.toFixed(1) + ' yr' : '—'}</div>
        <div class="card-delta">€${r.totalAnnualBenefit.toFixed(0)}/yr benefit</div>
      </div>
      <div class="card">
        <div class="card-label">20-yr NPV</div>
        <div class="card-value ${r.npv20 > 5000 ? 'accent' : r.npv20 > 0 ? 'amber' : 'red'}">${fmtCurrency(r.npv20)}</div>
        <div class="card-delta">Lifetime gain after install</div>
      </div>
    </div>

    ${r.verdict === 'fair' || r.verdict === 'excellent' ? `
      <div class="secondary-card" style="margin-top:14px" onclick="openLeadForm()">
        <div class="secondary-card-icon" style="color:var(--accent)">${ic('checkC',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">Get a second opinion</div>
          <div class="secondary-card-sub">We'll match you with 2 more SEAI-registered installers to quote this spec</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>
    ` : `
      <div class="secondary-card amber" style="margin-top:14px" onclick="openLeadForm()">
        <div class="secondary-card-icon" style="color:var(--amber)">${ic('warn',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">Get competing quotes before signing</div>
          <div class="secondary-card-sub">We'll match you with 3 SEAI-registered installers to compare against this quote</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>
    `}
  `;
}

/* ============================================================
   REFINE — direct edit any field, no wizard
   ============================================================ */
function _refineSection(id, icon, title, summary, body){
  return `
    <div class="settings-section-card ${state._settings_open === id ? 'open' : ''}">
      <div class="settings-section-header" onclick="toggleSettingsSection('${id}')">
        <div class="settings-section-title">
          <div class="settings-section-title-icon">${icon}</div>
          ${title}
        </div>
        <div class="settings-section-chevron">›</div>
      </div>
      ${state._settings_open !== id ? `<div class="settings-section-summary">${summary}</div>` : ''}
      <div class="settings-section-body">
        <div class="settings-section-body-inner">${body}</div>
      </div>
    </div>`;
}

function sectionIf(cond, ...args){ return cond ? _refineSection(...args) : ''; }

function renderRefine(){
  // Advanced: only what My home and My system don't hold. The house, the
  // usage, the panels, battery, price and car are edited in those two sheets;
  // this screen keeps the settings most homes never need to touch.
  if (!state._settings_open) state._settings_open = 'strategy';
  const open = state._settings_open;
  const section = _refineSection;
  const region = IRISH_REGIONS[state.region || 'east'];
  const stratSummary = state.battery_kwh > 0
    ? `${({ auto: 'Automatic', arbitrage: 'Charge cheap, use at peak', self: 'Self-consume' })[state.strategy_mode] || state.strategy_mode}${state.charge_from_grid ? ' · charges from the grid' : ''}`
    : 'No battery modelled';
  const tariffDates = TARIFFS.map(t => t.verified_date).filter(Boolean).sort();
  const tariffSummary = tariffDates.length
    ? `${TARIFFS.length} plans · last verified ${fmtVerifiedDate(tariffDates[tariffDates.length-1])}`
    : `${TARIFFS.length} plans bundled`;
  const csvSummary = state._csv_imported
    ? `✓ Smart meter data imported · ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr`
    : 'Replace bill estimate with real 30-min interval data';
  const shapeSummary = 'Edit only if you have evidence — default profile is calibrated for Irish homes';
  const link = (onclick, icon, title, sub) => `<button class="adv-link" onclick="${onclick}">
      <span class="adv-link-ico">${icon}</span>
      <span class="adv-link-text"><b>${title}</b><small>${sub}</small></span>${ic('chevR', 16)}</button>`;

  return `${topbar('Advanced', 'sage', true)}
  <div class="screen">
    <div class="adv-links">
      ${link('openMyHome()', ic('home', 18), 'My home', `${esc(region ? region.name : '')} · ${esc(state.heating_type)} heating · ${Math.round(v7AnnualKwh()).toLocaleString('en-IE')} kWh a year${state.ev_active ? ' · EV' : ''}`)}
      ${link('openMySystem()', ic('sun', 18), 'My system', state.considering_solar && totalPanels() > 0
        ? `${totalPanels()} panels · ${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ` · ${state.battery_kwh} kWh battery` : ''} · ${eur(state.install_cost)}`
        : 'No solar modelled yet')}
    </div>
    <p class="adv-intro">Settings most homes never need. Each starts on a value that suits a typical Irish home.</p>

    ${section('strategy', ic('bolt',17), 'Battery strategy', stratSummary, renderStrategyControls())}

    ${section('tariffs', ic('radar',17), 'Tariff data freshness', tariffSummary, `
      <div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line-soft);margin-bottom:10px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--ink)">Include dynamic-price plans</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:2px;line-height:1.5">Wholesale-tracking plans (hourly market price) are excluded from rankings until pricing clarity improves. Their real cost depends on market swings nobody can predict.</div>
        </div>
        <div onclick="state.include_dynamic=!state.include_dynamic;invalidate();saveState();renderApp()" style="flex-shrink:0;width:44px;height:26px;border-radius:999px;cursor:pointer;background:${state.include_dynamic ? 'var(--accent)' : 'var(--track-soft)'};position:relative;transition:background .15s">
          <div style="position:absolute;top:3px;left:${state.include_dynamic ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .15s"></div>
        </div>
      </div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:1.7;margin-bottom:12px">
        ${(() => {
          const dates = TARIFFS.map(t => t.verified_date).filter(Boolean).sort();
          const latest = dates.length ? dates[dates.length-1] : null;
          const s = state._tariff_status;
          let html = '';
          if (latest){
            html += `<b style="color:var(--ink)">Rates last updated:</b> ${fmtVerifiedDate(latest)} (${TARIFFS.length} plans)`;
          }
          if (s && s.timestamp){
            const ts = new Date(s.timestamp).toLocaleString('en-IE', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
            html += `<br><span style="color:var(--ink-dim)">Last live check: ${ts}</span>`;
            const changes = (s.potential_changes || []).length;
            if (changes > 0) html += `<br><span style="color:var(--amber)">${changes} possible rate change${changes>1?'s':''} flagged</span>`;
          }
          return html || '<span style="color:var(--ink-dim)">Tariff data bundled with this release.</span>';
        })()}
      </div>
      <div style="padding:10px 12px;background:var(--well);border:1px solid var(--hair);border-radius:8px;font-size:12px;color:var(--ink-soft);line-height:1.6">
        Checked every morning: each supplier's own price page is read and every plan compared. A price change is reviewed by a person before it reaches the app, so a misread page can never change your figures. The date above is when the rates in the app were last updated.
      </div>
      ${(state._tariff_status?.potential_changes || []).length > 0 ? `
        <div style="margin-top:10px;padding:10px 12px;background:rgba(255,145,0,.08);border:1px solid rgba(255,145,0,.35);border-radius:8px;font-family:var(--mono);font-size:12px;line-height:1.7">
          <b style="color:var(--amber)">Possible rate changes detected:</b><br>
          ${(state._tariff_status.potential_changes || []).map(c =>
            `${c.id}: ${c.stored}c → ${c.found}c (${c.diff_c > 0 ? '+' : ''}${c.diff_c}c/kWh)`
          ).join('<br>')}
          <br><span style="color:var(--ink-dim)">Rates shown are our last verified figures. Edit any plan in the Plans tab.</span>
        </div>
      ` : ''}
    `)}

    ${section('csv', ic('csv',17), 'Smart meter data', csvSummary, `
      <div onclick="setScreen('csv-import')" style="padding:12px;background:rgba(90,156,255,.05);border:1px solid rgba(90,156,255,.3);border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:12px">
        <div>${ic('csv',18)}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:var(--ink)">${state._csv_imported ? 'Update or replace imported CSV' : 'Import ESB smart meter CSV'}</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">${state._csv_imported ? `Currently using real 30-min data — ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr` : 'Use real data from esbnetworks.ie instead of a bill estimate'}</div>
        </div>
        <div style="color:var(--ink-soft);font-size:17px">›</div>
      </div>
    `)}

    ${section('shape', ic('chart',17), 'Advanced — consumption shape', shapeSummary, renderShapeControls())}

    <div style="margin-top:18px;padding:12px 14px;background:var(--accent-faint);border:1px solid var(--accent);border-radius:8px;font-size:12px;color:var(--ink-soft);line-height:1.55;text-align:center">
      <b style="color:var(--accent);font-family:var(--mono);letter-spacing:.08em">✓ AUTOSAVE</b><br>
      Every change saves immediately. Tap any tab to see new results.
    </div>

    <div style="margin-top:14px;display:flex;gap:10px">
      <button class="btn-secondary" style="flex:1" onclick="restartOnboarding()">Restart onboarding</button>
      <button class="btn-secondary" style="flex:1" onclick="confirmResetAll()">Reset everything</button>
    </div>

    <div onclick="setScreen('auditor')" style="margin-top:14px;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:12px">
      <div>${ic('clip',18)}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">Audit an installer quote</div>
        <div style="font-size:12px;color:var(--ink-soft);margin-top:2px">Benchmark vs 2026 Irish prices</div>
      </div>
      <div style="color:var(--ink-soft);font-size:17px">›</div>
    </div>

    <div style="margin-top:8px">
      <button class="btn-secondary" style="width:100%;color:var(--ink-soft)" onclick="setScreen('methodology')">ℹ Methodology &amp; about</button>
    </div>

    <p class="disclaimer">
      <b>Disclaimer.</b> Calculations are estimates. Actual generation, degradation, and grid behaviour will vary. We are not regulated financial advisors.
    </p>
  </div>
  ${bottomNav()}`;
}

function refineRow(label, help, inputHtml){
  return `<div class="refine-row">
    <div class="refine-row-label">
      <div>${label}</div>
      ${help ? `<div>${help}</div>` : ''}
    </div>
    <div>${inputHtml}</div>
  </div>`;
}
function refineNum(id, val, min, max, step, unit){
  return `<div style="display:flex;align-items:center;gap:6px">
    <input type="number" inputmode="decimal" id="${id}" value="${val}" min="${min}" max="${max}" step="${step}">
    ${unit ? `<span style="font-size:12px;color:var(--ink-soft);font-family:var(--mono)">${unit}</span>` : ''}
  </div>`;
}
function refineSel(id, val, options){
  return `<select id="${id}">${options.map(([v,l]) => `<option value="${v}" ${String(v)===String(val)?'selected':''}>${l}</option>`).join('')}</select>`;
}
function refineToggle(id, val){
  return `<button id="${id}" data-on="${val}" onclick="this.dataset.on = (this.dataset.on==='true'?'false':'true'); refineChanged();" style="padding:8px 16px;font-size:12px;font-weight:700;background:${val?'var(--accent)':'transparent'};color:${val?'var(--well)':'var(--ink-soft)'};border:1px solid ${val?'var(--accent)':'var(--line)'};border-radius:8px;font-family:var(--mono);cursor:pointer;min-width:60px">${val?'ON':'OFF'}</button>`;
}
function sectorFromAzimuth(az){
  // Full 8-point compass, 45° sectors centred on each point — every azimuth
  // maps to a sector that actually exists in the dropdowns.
  az = ((az % 360) + 360) % 360;
  if (az < 22.5 || az >= 337.5) return 'N';
  if (az < 67.5)  return 'NE';
  if (az < 112.5) return 'E';
  if (az < 157.5) return 'SE';
  if (az < 202.5) return 'S';
  if (az < 247.5) return 'SW';
  if (az < 292.5) return 'W';
  return 'NW';
}
function azimuthFromSector(s){ return {'N':0,'NE':45,'E':90,'SE':135,'S':180,'SW':225,'W':270,'NW':315,'EW':180}[s] !== undefined ? {'N':0,'NE':45,'E':90,'SE':135,'S':180,'SW':225,'W':270,'NW':315,'EW':180}[s] : 180; }
function batteryTierFromKwh(k){ if (k <= 0) return '0'; if (k <= 7) return '5'; if (k <= 12) return '10'; return '15'; }

// Tap-first setters for the Settings screen. Mirrors refineChanged():
// touching panels/battery means the user is entering THEIR spec, so the
// auto-estimate label comes off; everything re-simulates immediately.
function rfSet(key, v, min, max){
  v = Math.min(max, Math.max(min, Math.round(v * 10) / 10));
  if (v === state[key]) return;
  if (state.solar_is_estimate && (key === 'count_A' || key === 'count_B' || key === 'battery_kwh')){
    state.solar_is_estimate = false;
    showToast('Saved as your installed system — the estimate label is removed', { type:'accent', icon:ic('checkC',16), title:'Your system' });
  }
  state[key] = v;
  invalidate();
  saveState();
  renderApp();
}
function rfAdj(key, delta, min, max){
  let v = Math.min(max, Math.max(min, Math.round(((+state[key] || 0) + delta) * 10) / 10));
  if (v === state[key]) return;
  if (state.solar_is_estimate && (key === 'count_A' || key === 'count_B' || key === 'battery_kwh')){
    state.solar_is_estimate = false;
  }
  state[key] = v;
  invalidate();
  saveState();
  renderAppDebounced();
}
function rfStepper(key, val, min, max, unit, step){
  const s = step || 1;
  const btn = (d, sym) => `<button onclick="rfAdj('${key}',${d},${min},${max})" style="width:38px;height:38px;border-radius:8px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink);font-size:17px;font-weight:700;font-family:var(--mono);cursor:pointer;flex-shrink:0">${sym}</button>`;
  return `<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
    ${btn(-s, '−')}
    <div style="min-width:64px;text-align:center;font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${val}<span style="font-size:12px;font-weight:400;color:var(--ink-soft)">${unit ? ' ' + unit : ''}</span></div>
    ${btn(s, '+')}
  </div>`;
}
function rfBatteryControl(){
  const val = +state.battery_kwh || 0;
  const opts = [[0,'None'],[5,'5'],[8,'8'],[9.5,'9.5'],[10,'10'],[13.5,'13.5']];
  if (!opts.some(([v]) => Math.abs(v - val) < 0.001)) opts.push([val, String(val)]);
  return `<div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end">${opts.map(([v, l]) => `
      <div onclick="rfSet('battery_kwh',${v},0,50)" style="padding:7px 11px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--line)'};background:${Math.abs(v - val) < 0.001 ? 'var(--accent-soft)' : 'transparent'};color:${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--ink-soft)'}">${l}</div>`).join('')}</div>
    <div style="margin-top:8px;display:flex;justify-content:flex-end">${rfStepper('battery_kwh', val, 0, 50, 'kWh', 0.5)}</div>
  </div>`;
}

function bindRefine(){
  const ids = ['rf-heat','rf-bill','rf-kwh','rf-disc','rf-base','rf-cA','rf-azA','rf-tiltA','rf-cB','rf-azB','rf-tiltB','rf-pw','rf-inv','rf-batt','rf-cost','rf-grant','rf-evkm','rf-eveff','rf-evchg','rf-dod','rf-deg'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', refineChanged);
  });
}

function refineChanged(){
  const get = id => document.getElementById(id);
  const numIf = (id, key) => { const el = get(id); if (el && !isNaN(+el.value)) state[key] = +el.value; };
  const valIf = (id, key) => { const el = get(id); if (el) state[key] = el.value; };
  // Consumption
  valIf('rf-heat', 'heating_type');
  numIf('rf-bill', 'bimonthly_bill_eur');
  numIf('rf-kwh', 'annual_kwh');
  numIf('rf-disc', 'baseline_discount_pct');
  valIf('rf-base', 'baseline');
  if (!state._csv_imported) applyUsageInput();
  // Solar — Roof A + B + precise battery
  // Touching solar fields in Settings means the user is entering THEIR spec —
  // it's no longer our auto-estimated example system
  if (state.solar_is_estimate){
    const changed = [['rf-cA','count_A'],['rf-cB','count_B'],['rf-batt','battery_kwh'],
                     ['rf-cost','install_cost'],['rf-grant','grant_seai']]
      .some(([id,key]) => { const el = get(id); return el && el.value !== '' && +el.value !== state[key]; });
    if (changed){
      state.solar_is_estimate = false;
      showToast('Saved as your installed system — the estimate label is removed', { type:'accent', icon:ic('checkC',16), title:'Your system' });
    }
  }
  // Manual cost/grant edits lock those fields against auto-recalculation
  const _gEl = get('rf-grant');
  if (_gEl && _gEl.value !== '' && +_gEl.value !== state.grant_seai) state.grant_is_manual = true;
  const _cEl = get('rf-cost');
  if (_cEl && _cEl.value !== '' && +_cEl.value !== state.install_cost) state.cost_is_manual = true;
  numIf('rf-cA', 'count_A');
  numIf('rf-cB', 'count_B');
  numIf('rf-tiltA', 'tilt_A');
  numIf('rf-tiltB', 'tilt_B');
  const azAEl = get('rf-azA');
  if (azAEl) state.azimuth_A = azimuthFromSector(azAEl.value);
  const azBEl = get('rf-azB');
  if (azBEl) state.azimuth_B = azimuthFromSector(azBEl.value);
  numIf('rf-pw', 'panel_w');
  numIf('rf-inv', 'inverter_kw');
  const dodEl = get('rf-dod'); if (dodEl && !isNaN(+dodEl.value)) state.battery_dod = +dodEl.value / 100;
  const degEl = get('rf-deg'); if (degEl && !isNaN(+degEl.value)) state.panel_degradation = +degEl.value / 100;
  const _battWas = state.battery_kwh || 0;
  numIf('rf-batt', 'battery_kwh');
  // Battery added from zero: a prior no-battery state forces self-consume, which
  // would otherwise leave a freshly-added battery stuck on self-consume. Default
  // a newly-added battery to arbitrage (the better choice for most owners).
  if (_battWas === 0 && (state.battery_kwh || 0) > 0){
    if (state.strategy_mode !== 'auto') state.strategy_mode = 'arbitrage';
    state.charge_from_grid = true;
  }
  // Auto-set has_solar based on whether they have any panels
  state.has_solar = (state.count_A + state.count_B) > 0;
  numIf('rf-cost', 'install_cost');
  numIf('rf-grant', 'grant_seai');
  // EV
  const evEl = get('rf-ev');
  if (evEl){
    const wasActive = !!state.ev_active;
    state.ev_active = (evEl.dataset.on === 'true');
    if (state.ev_active && !wasActive){
      // Just turned ON — show confirmation prompt + toast
      state._ev_just_enabled = true;
      // Set sensible defaults if first time
      if (!state.ev_km_per_year) state.ev_km_per_year = 15000;
      if (!state.ev_kwh_per_100km) state.ev_kwh_per_100km = 17;
      if (!state.ev_charger_kw) state.ev_charger_kw = 7;
      showToast(`Using defaults: ${state.ev_km_per_year.toLocaleString()} km/yr, ${state.ev_kwh_per_100km} kWh/100km. Edit below.`, { type:'amber', icon:ic('car',16), title:'EV added to model' });
    }
    if (!state.ev_active && wasActive){
      state.ev_km_per_year = 0;
      state._ev_just_enabled = false;
      showToast('EV removed from the model. Headline figures reflect house only.', { type:'blue', icon:ic('car',16), title:'EV removed' });
    }
  }
  // If user actually edits an EV field, clear the just-enabled prompt
  const evKmEl = get('rf-evkm');
  const evEffEl = get('rf-eveff');
  const evChgEl = get('rf-evchg');
  if (evKmEl || evEffEl || evChgEl){
    if (state._ev_just_enabled) state._ev_just_enabled = false;
  }
  numIf('rf-evkm', 'ev_km_per_year');
  numIf('rf-eveff', 'ev_kwh_per_100km');
  numIf('rf-evchg', 'ev_charger_kw');
  // Auto-arbitrage if battery + EV
  if (state.ev_active && state.battery_kwh > 0){
    state.charge_from_grid = true;
    if (state.strategy_mode !== 'auto') state.strategy_mode = 'arbitrage';
  }
  invalidate();
  saveState();
  renderApp();
}

function restartOnboarding(){
  // Pre-fill the onboarding object from saved state so user doesn't lose data.
  // Start from the full factory so every field exists (prevents undefined-field
  // crashes in later steps), then overlay what we know.
  _ob = makeOb();
  _ob.region = state.region || 'east';
  _ob.address = state.address || '';
  _ob.baseline = state.baseline || 'EI-24';
  _ob.baseline_known = !!state.baseline_known;
  _ob.heating = state.heating_type || 'gas';
  _ob.bill = state.bimonthly_bill_eur || 200;
  _ob.usage_mode = state._csv_imported ? 'csv' : (state.usage_input_mode || 'bill');
  _ob.annual_kwh = state.annual_kwh || 0;
  _ob.baseline_discount = state.baseline_discount_pct || 0;
  _ob.has_solar = !!state.has_solar;
  _ob.solar_status = state.has_solar ? (state.considering_solar ? 'have' : 'plan') : false;
  _ob.count_A = state.count_A || 8;
  _ob.azimuth_A = state.azimuth_A != null ? state.azimuth_A : 180;
  _ob.tilt_A = state.tilt_A != null ? state.tilt_A : 30;
  _ob.count_B = state.count_B || 0;
  _ob.azimuth_B = state.azimuth_B != null ? state.azimuth_B : 270;
  _ob.tilt_B = state.tilt_B != null ? state.tilt_B : 30;
  _ob.battery_kwh = state.battery_kwh || 0;
  _ob.install_cost = state.install_cost || 9500;
  _ob.has_ev = !!state.ev_active;
  _ob.ev_in_bill = state.ev_in_bill !== false;
  _ob.ev_km = state.ev_km_per_year || 15000;
  _ob.ev_eff = state.ev_kwh_per_100km || 17;
  state.current_screen = 'welcome';
  state.onboarding_complete = false;
  saveState();
  renderApp();
}

function confirmResetAll(){
  if (confirm('Reset everything?\n\nThis clears your address, heating, bills, and any solar/EV settings. You\'ll start fresh.')){
    try { localStorage.removeItem('solarAppState_v2'); } catch(e){}
    // Reset the live in-memory objects too, so the app is in a clean state
    // immediately — not dependent on the reload succeeding. (A flaky reload was
    // leaving a half-cleared state that could crash on the next render.)
    try {
      state = structuredClone(DEFAULT_STATE);
      _ob = makeOb();
      if (typeof CACHE === 'object'){ CACHE.dirty = true; }
      invalidate();
    } catch(e){}
    try { location.reload(); }
    catch(e){
      // Reload blocked/failed — render the fresh welcome screen in place.
      try { state.current_screen = 'welcome'; renderApp(); } catch(_){}
    }
  }
}

/* ============================================================
   EMAIL CAPTURE MODAL
   ============================================================ */
function openEmailModal(source){
  if (state.email_captured){
    showToast('Already on the list — thanks!');
    return;
  }
  const m = document.createElement('div');
  m.id = 'email-modal';
  m.className = 'modal-overlay';
  m.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-handle"></div>
      <h3>Get your <em>report</em> by email</h3>
      <p>${source === 'installer_quotes' ? 'We\'ll send you 3 SEAI-registered installer quotes for your exact spec within 48 hours.' : 'Save a copy of your analysis. Get a monthly update if the best plan changes.'}</p>
      <input id="modal-email" class="modal-input" type="email" placeholder="you@example.com" autocomplete="email">
      <button class="modal-btn" onclick="submitModalEmail('${source}')">${source === 'installer_quotes' ? 'Request quotes →' : 'Email me the report →'}</button>
      <button class="modal-skip" onclick="closeEmailModal()">No thanks · skip</button>
      <div class="modal-privacy">We never sell your data. Unsubscribe anytime.</div>
    </div>`;
  m.onclick = closeEmailModal;
  document.body.appendChild(m);
  setTimeout(() => document.getElementById('modal-email').focus(), 100);
}
function closeEmailModal(){
  const m = document.getElementById('email-modal');
  if (m) m.remove();
}
function submitModalEmail(source){
  const email = document.getElementById('modal-email').value.trim();
  if (!email || !email.includes('@')){
    document.getElementById('modal-email').focus();
    return;
  }
  captureEmail(email, source);
  closeEmailModal();
  if (source === 'installer_quotes'){
    showToast('Saved on this device. Installer matching isn\u2019t live yet.');
  } else {
    showToast('Got it — we\'ll email you the report.');
  }
}

/* ============================================================
   TOP BAR + BOTTOM NAV + RENDER ROUTER
   ============================================================ */
function applyTheme(){
  const t = (state && state.theme) === 'dark' ? 'dark' : 'light';
  // Literal palette applied three independent ways. The final line of defence
  // is a fixed underlay DIV painted behind all content — no body/canvas/
  // color-scheme quirk in any WebView can make the page background wrong.
  const pal = t === 'light'
    ? { bg:'#F4F2EC', ink:'#16201A' }   // V7 paper and ink — see styles/v7.css
    : { bg:'#0F1311', ink:'#EEF1EE' };
  const de = document.documentElement;
  de.setAttribute('data-theme', t);
  de.style.setProperty('background', pal.bg, 'important');
  de.style.colorScheme = t;
  if (document.body){
    document.body.style.setProperty('background', pal.bg, 'important');
    document.body.style.setProperty('color', pal.ink, 'important');
    let lay = document.getElementById('bg-underlay');
    if (!lay){
      lay = document.createElement('div');
      lay.id = 'bg-underlay';
      document.body.insertBefore(lay, document.body.firstChild);
    }
    lay.setAttribute('style',
      'position:fixed;top:-25vh;left:0;right:0;height:150vh;z-index:-1;pointer-events:none;background:' + pal.bg);
  }
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta){ meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = pal.bg;
}
// Accessibility layer — runs after every render. Makes every non-native
// clickable element (mostly <div onclick>) keyboard- and screen-reader-
// operable without hand-editing ~180 call sites: adds role, tabindex, and
// Enter/Space activation, and a label derived from its text. Idempotent.
function enhanceA11y(){
  try {
    const root = document.getElementById('app-root');
    if (!root) return;
    const nodes = root.querySelectorAll('[onclick]');
    nodes.forEach(el => {
      const tag = el.tagName;
      // Native controls are already accessible — skip.
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (el.getAttribute('data-a11y') === '1') return;   // already done this render cycle
      el.setAttribute('data-a11y', '1');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('aria-label')){
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g,' ').slice(0, 80);
        if (label) el.setAttribute('aria-label', label);
      }
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar'){
          e.preventDefault();
          el.click();
        }
      });
    });
  } catch(e){}
}

function setTheme(t){
  state.theme = t === 'dark' ? 'dark' : 'light';
  applyTheme();
  saveState();
  renderApp();
}

/**
 * Screen chrome.
 *
 * Carries the page's only h1 and the banner landmark. There was no heading
 * element anywhere in the app and no landmarks at all, so a screen reader had
 * no structure to navigate by and no way to answer "what page am I on?".
 * The title is visible when there is one and visually hidden otherwise, since
 * every screen needs a name even when the design doesn't show it.
 */
function topbar(title, accent, showBack){
  return V7.topbar(title, { back: !!showBack });
}

/* ============================================================
   COMPANION LAYER — Market Monitor, Independence, Quotes, More
   (product-vision additions: calculator → companion)
   ============================================================ */

function rankOfPlan(planId){
  // Mirror getRecommendation() filter exactly so counts are always consistent
  const rec = getRecommendation();
  const ranked = rec.ranked.map(r => ({ id: r.plan.id, cost: r.net }));
  const idx = ranked.findIndex(r => r.id === planId);
  return { rank: idx < 0 ? null : idx + 1, total: rec.rankedCount, ranked };
}

function fmtShortDate(iso){
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-IE', {day:'numeric', month:'short', year:'numeric'}); }
  catch(e){ return iso; }
}

/* ── MARKET MONITOR ───────────────────────────────────────── */
function renderMonitor(){
  if (CACHE.dirty) rebuildBase();
  const rec = getRecommendation();
  const best = rec.best;
  const baselinePlan = getPlanById(state.baseline);
  const baseCost = rec.baseCost;
  const savings = rec.annualSavings;
  const onBest = best.plan.id === state.baseline;
  const rank = rec.baselineRank;
  const total = rec.rankedCount;
  const countLabel = rec.countLabel;
  const on = state.monitoring_on !== false;
  // Honest freshness: we re-run the comparison every time this screen opens,
  // against tariff data that is refreshed upstream. There is no background
  // job and no push channel — don't imply one.
  const _vd = (TARIFFS || []).map(t => t.verified_date).filter(Boolean).sort();
  const dataDate = _vd.length ? fmtVerifiedDate(_vd[_vd.length - 1]) : null;
  const freshLine = dataDate ? `Re-checked just now · rates last verified ${dataDate}` : 'Re-checked just now';

  // status block
  let statusHtml;
  if (!on){
    statusHtml = `<div class="mon-status off">
      <div class="mon-status-eyebrow" style="color:var(--ink-soft)">○ Monitoring paused</div>
      <div class="mon-status-line">Market checks are off. Turn them on to re-rank tariffs on every visit.</div>
    </div>`;
  } else if (onBest || savings < 1){
    statusHtml = `<div class="mon-status good">
      <div class="mon-status-eyebrow">✓ You're on your best plan</div>
      <div class="mon-status-line">Checked against ${countLabel} for your exact home. Nothing currently beats <b>${baselinePlan.supplier} — ${baselinePlan.plan}</b>.</div>
      <div class="mon-status-meta">${freshLine} · open the app any time for a fresh check</div>
    </div>`;
  } else {
    statusHtml = `<div class="mon-status action">
      <div class="mon-status-eyebrow">${ic('bolt',12,'vertical-align:-2px')} A better plan is available</div>
      <div class="mon-status-line">Switching to <b>${best.plan.supplier} — ${best.plan.plan}</b> would save you about <b style="color:var(--amber)">${fmtCurrency(savings)}/yr</b> versus your current plan.</div>
      <!-- countLabel already reads "22 of 25 — 3 dynamic plans excluded", so
           interpolating it after "of" produced "ranks #20 of 22 of 25". -->
      <div class="mon-status-meta">${rank ? `Your current plan ranks #${rank} of ${rec.rankedCount} for your usage` : `Your current plan isn’t in the ranking (dynamic plans are left out unless you turn them on in Settings)`}</div>
      <button class="switch-cta" style="margin-top:13px;margin-bottom:0;font-size:13px;padding:13px"
        onclick="v7Sheet('switch','${best.plan.id}')">
        Review the switch →</button>
    </div>`;
  }

  const contractAlert = renderContractAlert();
  // contract reminder
  let contractHtml;
  if (state.contract_end_date){
    const d = new Date(state.contract_end_date);
    const days = Math.round((d - new Date()) / 86400000);
    contractHtml = `<div class="mon-toggle">
      <div><div class="mon-toggle-label">Contract review</div>
        <div class="mon-toggle-sub">${fmtShortDate(state.contract_end_date)} · ${days > 0 ? days + ' days away' : 'due now'}</div></div>
      <div style="display:flex;gap:12px"><span style="font-family:var(--mono);font-size:12px;color:var(--blue);cursor:pointer" onclick="setContractReminder()">edit</span><span style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);cursor:pointer" onclick="clearContractDate()">clear</span></div>
    </div>`;
  } else if (state._contract_edit){
    contractHtml = `<div class="mon-toggle" style="flex-wrap:wrap;gap:10px">
      <div style="width:100%"><div class="mon-toggle-label">When does your contract end?</div>
        <div class="mon-toggle-sub">It's on your bill or in your sign-up email — roughly is fine</div></div>
      <input type="date" id="contract-date-input" style="flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--well);color:var(--ink);font-family:var(--mono);font-size:13px"/>
      <button onclick="saveContractDate()" style="padding:10px 16px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent)">Save</button>
      <button onclick="cancelContractEdit()" style="padding:10px 12px;border-radius:999px;font-size:12px;font-weight:600;font-family:var(--display);border:1px solid var(--line);background:transparent;color:var(--ink-soft)">Cancel</button>
    </div>`;
  } else {
    contractHtml = `<div class="mon-toggle" onclick="setContractReminder()" style="cursor:pointer">
      <div><div class="mon-toggle-label">Add a contract-end reminder</div>
        <div class="mon-toggle-sub">Set your contract end date — we'll flag it here from 30 days out</div></div>
      <div style="font-family:var(--mono);font-size:17px;color:var(--accent)">+</div>
    </div>`;
  }

  // activity timeline — built from real, computed facts (clearly the user's own analysis)
  const top3 = rankOfPlan(state.baseline).ranked.slice(0,3);
  const events = [];
  events.push({ c:'var(--accent)', when:'Just now',
    title: onBest ? 'Re-checked the whole market' : `Found a cheaper plan for you`,
    sub: onBest ? `${countLabel} plans simulated against your usage — you're still best off where you are.`
                : `${best.plan.supplier} ${best.plan.plan} now leads for your home.` });
  events.push({ c:'var(--blue)', when:'Your ranking',
    title: rank ? `Your plan sits #${rank} of ${countLabel}` : `Your plan is outside the ranking of ${countLabel}`,
    sub:`Top 3 for your profile: ${top3.map(t => { const p = getPlanById(t.id); return `${p.supplier} ${p.plan}`; }).join('; ')}.` });
  if (state.switched_to){
    const sp = getPlanById(state.switched_to);
    events.push({ c:'var(--accent)', when: state.switched_date ? fmtShortDate(state.switched_date) : 'Earlier',
      title:`You switched to ${sp.supplier}`, sub:`We'll keep watching in case something better appears.` });
  }
  events.push({ c:'var(--ink-dim)', when:'Ongoing',
    title:'Watching '+rec.rankedCount+' tariffs for rate changes',
    sub:'New EV and dynamic plans are checked the day they launch.' });

  const timelineHtml = events.map((e,i) => `<div class="mon-event">
    <div class="mon-event-rail"><div class="mon-event-dot" style="background:${e.c}"></div>${i < events.length-1 ? '<div class="mon-event-line"></div>' : ''}</div>
    <div class="mon-event-body">
      <div class="mon-event-when">${e.when}</div>
      <div class="mon-event-title">${e.title}</div>
      <div class="mon-event-sub">${e.sub}</div>
    </div></div>`).join('');

  return `${topbar('Price watch', 'blue', true)}
  <div class="screen">
    <div style="font-size:12px;color:var(--ink-soft);line-height:1.5;margin:2px 2px 14px">We watch every Irish tariff and flag what's worth acting on.</div>
    ${contractAlert}
    <div class="mon-toggle">
      <div>
        <div class="mon-toggle-label">Market monitoring</div>
        <div class="mon-toggle-sub">${on ? 'Active · we watch every Irish tariff for you' : 'Paused · tap to resume'}</div>
      </div>
      <div class="mon-switch ${on ? 'on' : 'off'}" onclick="toggleMonitoring()"><div class="mon-switch-knob"></div></div>
    </div>

    ${statusHtml}
    ${contractHtml}

    ${(state.switch_history || []).length ? `
    <div class="card" style="margin-bottom:14px">
      <div style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:8px">${ic('check',12,'vertical-align:-2px')} Your switching record</div>
      ${state.switch_history.slice(-3).reverse().map(h => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:12px">
          <div style="color:var(--ink)">${h.planName}<div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-top:2px">${fmtShortDate(h.date)}</div></div>
          <div style="font-family:var(--mono);font-weight:700;color:var(--accent);white-space:nowrap">€${(h.savings||0).toLocaleString()}/yr</div>
        </div>`).join('')}
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-top:8px;letter-spacing:.03em">Projected savings at the moment you started each switch</div>
    </div>` : ''}
    <div class="section-title">Recent activity</div>
    <div class="mon-timeline">${timelineHtml}</div>

    <div class="section-title">What we check for you</div>
    <div class="mon-watch">
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('bolt',14)}</span><div><b>A better plan appeared.</b> A new or repriced tariff now beats your current one for your usage.</div></div>
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('bell',14)}</span><div><b>Your contract is ending.</b> Before you roll onto a default rate, we flag it here so you can re-check.</div></div>
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('sun',14)}</span><div><b>Seasonal solar insight.</b> If you have panels, how your roof performed and what it saved.</div></div>
    </div>
    <div style="font-size:12px;color:var(--ink-soft);text-align:center;margin-top:12px;line-height:1.6;padding:0 6px">
      These checks run here, in the app — we don't email you or send push notifications, and there's no account required. Open Price watch whenever you want a fresh read.
    </div>

    <div class="secondary-card blue" onclick="setScreen('independence')" style="margin-top:16px">
      <div class="secondary-card-icon">${ic('shield',19)}</div>
      <div class="secondary-card-body">
        <div class="secondary-card-title">How we make money</div>
        <div class="secondary-card-sub">Our independence, in plain English</div>
      </div>
      <div class="secondary-card-arrow">›</div>
    </div>
  </div>
  ${bottomNav()}`;
}

function toggleMonitoring(){
  state.monitoring_on = !(state.monitoring_on !== false);
  saveState();
  showToast(state.monitoring_on ? 'Market checks on' : 'Market checks off',
    { type: state.monitoring_on ? 'accent' : 'blue', icon: state.monitoring_on ? ic('checkC',16) : ic('radar',16) });
  renderApp();
}
function setContractReminder(){
  state._contract_edit = true;
  renderApp();
}
function saveContractDate(){
  const el = document.getElementById('contract-date-input');
  const v = el && el.value;
  if (!v){ showToast('Pick a date first', { type:'amber', icon:ic('bell',16) }); return; }
  state.contract_end_date = v;
  state._contract_edit = false;
  saveState();
  showToast('We\'ll flag it here from 30 days out', { type:'blue', icon:ic('bell',16), title:'Review set · ' + fmtShortDate(v) });
  renderApp();
}
function cancelContractEdit(){ state._contract_edit = false; renderApp(); }
function clearContractDate(){ state.contract_end_date = ''; state._contract_edit = false; saveState(); renderApp(); }
// What rolling over actually costs: simulate the user's load on their
// supplier's STANDARD plan (where discounts typically land you) vs today.
function rolloverProjection(){
  const cur = getPlanById(state.baseline);
  if (!cur) return null;
  if (cur.id.endsWith('-24')) return { std: null, delta: 0, onStandard: true };
  const std = TARIFFS.find(t => !t.discontinued && t.supplier === cur.supplier && t.id.endsWith('-24'));
  if (!std) return null;
  if (CACHE.dirty) rebuildBase();
  const baseCons = (state.ev_active && state.ev_in_bill) ? CACHE.cons : CACHE.consNoEv;
  const curCost = sumF(baselineSim(state.baseline).cost) + cur.standing + PSO_LEVY;
  const stdCost = sumF(simulateBaseline(std, baseCons).cost) + std.standing + PSO_LEVY;
  return { std, delta: stdCost - curCost, onStandard: false };
}

function contractDaysLeft(){
  if (!state.contract_end_date) return null;
  return Math.round((new Date(state.contract_end_date) - new Date()) / 86400000);
}
// Amber alert shown on Monitor + Home when the review window opens (≤30 days)
function renderContractAlert(){
  const days = contractDaysLeft();
  if (days === null || days > 30) return '';
  const proj = rolloverProjection();
  let projLine = '';
  if (proj && proj.std && proj.delta > 20){
    projLine = ` Rolling onto ${proj.std.supplier} standard rates would cost about <b>+${fmtCurrency(Math.round(proj.delta))}/yr</b> on your usage.`;
  } else if (proj && proj.onStandard){
    projLine = ` You're already on standard rates — the gap to the best plan is the cost of staying put.`;
  }
  return `<div class="mon-status action" style="margin-bottom:12px">
    <div class="mon-status-title">${ic('bell',14)} Contract review ${days > 0 ? 'due in ' + days + ' day' + (days === 1 ? '' : 's') : 'overdue'}</div>
    <div class="mon-status-meta">Suppliers count on you rolling over without looking.${projLine} Re-check before ${fmtShortDate(state.contract_end_date)} — switching takes 10–15 working days.</div>
  </div>`;
}

/* ── INDEPENDENCE / TRUST ─────────────────────────────────── */
function renderIndependence(){
  const cards = [
    ['green', ic('plans',19), 'We rank by your cost','The plan that saves you the most is always #1 — even when it earns us nothing. A commission never changes a ranking.'],
    ['blue', ic('swap',19), 'We earn on switches','When you switch through us, the supplier pays a referral fee (typically €20–50). We show you whenever a plan earns us a commission.'],
    ['blue', ic('sun',19), 'We earn on solar leads','If you ask us to introduce you to installers, they pay us per introduction — never for a better ranking or a kinder review.'],
    ['green', ic('shield',19), 'We never sell your data','Your usage stays on your device. We share your contact details with a third party only at the moment you explicitly tap to ask.'],
  ];
  return `${topbar('Our independence', 'blue', true)}
  <div class="screen">
    <div class="qr-hero" style="border-color:var(--blue);box-shadow:var(--hero-shadow),0 0 32px -10px var(--blue-glow);text-align:left;padding:20px">
      <div class="qr-eyebrow" style="color:var(--blue)">The catch, stated plainly</div>
      <div style="font-family:var(--display);font-size:17px;font-weight:600;color:var(--ink);line-height:1.35;margin-top:6px">We only make money when you actually save money. Here's exactly how.</div>
    </div>
    ${cards.map(([cls,ic,t,b]) => `<div class="indep-card ${cls}">
      <div class="indep-ic">${ic}</div>
      <div><div class="indep-title">${t}</div><div class="indep-body">${b}</div></div>
    </div>`).join('')}
    <p class="disclaimer"><b>Why we show this.</b> Most apps bury "how we make money" in a help page. For an independent advisor, it belongs in the open — so you can judge our advice knowing exactly what's behind it.</p>
  </div>
  ${bottomNav()}`;
}

/* ── SOLAR QUOTE COMPARISON ───────────────────────────────── */
function assessQuote(q){
  // Irish installed-price benchmark (gross, pre-grant), rough 2026 figures
  const kwp = Math.max(0.5, +q.kwp || 0);
  const batt = Math.max(0, +q.battery || 0);
  const fairLow  = kwp*950 + batt*350 + 1100;
  const fairHigh = kwp*1200 + batt*480 + 1300;
  const mid = (fairLow + fairHigh)/2;
  const price = +q.price || 0;
  const recKwp = Math.max(2, state.has_solar || state.considering_solar ? totalKwp() : 4.5);
  const pct = mid > 0 ? (price - mid)/mid : 0;

  if (kwp < recKwp*0.65){
    return { cls:'under', verdict:'Underspec',
      take:`At ${kwp.toFixed(1)} kWp this is small for your roof — we'd model around ${recKwp.toFixed(1)} kWp for your usage. Cheaper upfront, but you'd under-build and leave savings on the table.` };
  }
  if (pct > 0.15){
    return { cls:'high', verdict:`${Math.round(pct*100)}% high`,
      take:`This is above our independent estimate of ${fmtCurrency(fairLow)}–${fmtCurrency(fairHigh)} for ${kwp.toFixed(1)} kWp${batt>0?` + ${batt} kWh battery`:''}. Worth asking them to itemise, or get one more quote.` };
  }
  if (pct < -0.18){
    return { cls:'under', verdict:'Below market',
      take:`Notably cheaper than our ${fmtCurrency(fairLow)}–${fmtCurrency(fairHigh)} estimate. That can be a great deal — just confirm panel/inverter brands and the workmanship warranty before signing.` };
  }
  return { cls:'fair', verdict:'Fair price',
    take:`Sits inside our independent estimate of ${fmtCurrency(fairLow)}–${fmtCurrency(fairHigh)} for this system. A reasonable, well-matched quote for your home.` };
}

function renderQuotes(){
  const quotes = state.solar_quotes || [];
  const list = quotes.map(q => {
    const a = assessQuote(q);
    return `<div class="quote-card ${a.cls}">
      <div class="quote-head">
        <div><div class="quote-name">${(q.installer||'Installer').replace(/</g,'&lt;')}</div>
          <div class="quote-spec">${(+q.kwp||0).toFixed(1)} kWp${+q.battery>0?` · ${q.battery} kWh battery`:' · no battery'}</div>
          <div class="quote-verdict ${a.cls}">${a.verdict}</div>
        </div>
        <div style="text-align:right">
          <div class="quote-price">${fmtCurrency(+q.price||0)}</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);cursor:pointer;margin-top:6px" onclick="removeQuote('${q.id}')">remove</div>
        </div>
      </div>
      <div class="quote-take"><b>Our take</b>${a.take}</div>
    </div>`;
  }).join('');

  return `${topbar('Compare quotes', 'amber', true)}
  <div class="screen">
    <div class="qr-hero" style="border-color:var(--amber);text-align:left;padding:18px">
      <div class="qr-eyebrow" style="color:var(--amber)">Independent second opinion</div>
      <div style="font-family:var(--display);font-size:17px;font-weight:600;color:var(--ink);line-height:1.35;margin-top:6px">Add an installer quote and we'll check it against our own model — not theirs.</div>
    </div>

    <div class="refine-panel" style="padding:16px">
      <div class="quote-form-row">
        <input class="quote-input" id="q-name" placeholder="Installer name" />
      </div>
      <div class="quote-form-row">
        <input class="quote-input" id="q-price" inputmode="numeric" placeholder="Price €" />
        <input class="quote-input" id="q-kwp" inputmode="decimal" placeholder="kWp" />
        <input class="quote-input" id="q-batt" inputmode="decimal" placeholder="Battery kWh" />
      </div>
      <button class="switch-cta" style="margin:6px 0 0;font-size:13px;padding:13px" onclick="addQuote()">Add &amp; assess quote</button>
    </div>

    ${quotes.length ? `<div class="section-title">Your quotes, assessed</div>${list}` : `
      <div style="text-align:center;padding:30px 16px;color:var(--ink-soft);font-family:var(--mono);font-size:12px;line-height:1.7">
        No quotes yet.<br>Add one above to see how it stacks up.
      </div>`}

    <div class="refine-panel" style="padding:13px 15px;background:rgba(90,156,255,.04);border-color:rgba(90,156,255,.2);margin-top:8px">
      <div style="font-family:var(--mono);font-size:12px;letter-spacing:.08em;color:var(--blue);font-weight:700;margin-bottom:5px">WHY YOU CAN TRUST THIS</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.5">Installers pay us per introduction — never to rank higher or to soften a verdict. The benchmark is our own model of Irish 2026 prices.</div>
    </div>
  </div>
  ${bottomNav()}`;
}

function addQuote(){
  const name = (document.getElementById('q-name')||{}).value || '';
  const price = parseFloat((document.getElementById('q-price')||{}).value) || 0;
  const kwp = parseFloat((document.getElementById('q-kwp')||{}).value) || 0;
  const batt = parseFloat((document.getElementById('q-batt')||{}).value) || 0;
  if (!price || !kwp){ showToast('Add at least a price and kWp', { type:'amber', icon:ic('warn',16) }); return; }
  if (!Array.isArray(state.solar_quotes)) state.solar_quotes = [];
  state.solar_quotes.push({ id:'q'+Date.now(), installer:name||'Installer', price, kwp, battery:batt });
  saveState();
  fireEvent('quote_added', { kwp, has_battery: batt>0 });
  renderApp();
}
function removeQuote(id){
  state.solar_quotes = (state.solar_quotes||[]).filter(q => q.id !== id);
  saveState(); renderApp();
}

/* ── MORE hub ─────────────────────────────────────────────── */
function renderCompare(){
  const scenarios = state.scenarios || [];
  const sel = (state._compare_sel || []).filter(id => scenarios.some(s => s.id === id));

  // ── Save-current bar ───────────────────────────────────────────────
  const liveSummary = computeScenarioSummary();
  const saveBar = `
    <div class="card" style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:3px">Save this configuration</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.5;margin-bottom:10px">Snapshots your current setup — ${liveSummary.hasSolar ? liveSummary.panels + ' panels' : 'no solar'}${liveSummary.battery > 0 ? ' · ' + liveSummary.battery + ' kWh' : ''}${liveSummary.ev ? ' · EV' : ''}, best plan ${liveSummary.bestPlanName}. Load or compare it later.</div>
      <div style="display:flex;gap:8px">
        <input id="scenario-name-input" class="modal-input" style="flex:1;margin:0" type="text" placeholder="Name it (optional)" maxlength="40">
        <button class="switch-cta" style="margin:0;white-space:nowrap;padding:12px 18px;width:auto;flex:0 0 auto" onclick="saveCurrentScenario()">${ic('plus',15)} Save</button>
      </div>
    </div>`;

  if (!scenarios.length){
    return `${topbar('Compare setups', 'blue', false)}
    <div class="screen">
      <div class="qr-hero" style="border-color:var(--blue);box-shadow:var(--hero-shadow),0 0 32px -10px var(--blue-glow);text-align:left;padding:20px;margin-bottom:14px">
        <div class="qr-eyebrow" style="color:var(--blue)">Scenarios</div>
        <div style="font-family:var(--display);font-size:17px;font-weight:600;color:var(--ink);line-height:1.35;margin-top:6px">Design a case, save it, compare them side by side.</div>
        <div style="font-size:12px;color:var(--ink-soft);line-height:1.55;margin-top:8px">Panels, battery, EV, plan — save a few setups and see them ranked on cost, payback, best plan and more.</div>
      </div>
      ${saveBar}
      <div class="card" style="text-align:center;padding:28px 20px;opacity:.85">
        <div style="margin-bottom:8px">${ic('layers',28)}</div>
        <div style="font-size:13px;color:var(--ink-soft);line-height:1.6">No saved scenarios yet.<br>Save your current setup above to get started.</div>
      </div>
    </div>
    ${bottomNav()}`;
  }

  // ── Scenario list (each row: load / compare-toggle / delete) ───────
  const list = scenarios.map(s => {
    const sm = s.summary || {};
    const picked = sel.includes(s.id);
    return `<div class="card" style="margin-bottom:10px;border-color:${picked ? 'var(--accent)' : 'var(--line)'};${picked ? 'background:var(--accent-faint)' : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin-top:3px;line-height:1.5">
            ${sm.hasSolar ? sm.kwp + ' kWp · ' + sm.panels + ' panels' : 'no solar'}${sm.battery > 0 ? ' · ' + sm.battery + ' kWh' : ''}${sm.ev ? ' · EV' : ''}<br>
            ${sm.bestPlanName} · €${(sm.bestNet||0).toLocaleString()}/yr${sm.payback != null ? ' · ' + sm.payback.toFixed(1) + 'yr payback' : ''}
          </div>
        </div>
        <label style="display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;flex-shrink:0">
          <div onclick="toggleCompareSelect('${s.id}')" style="width:26px;height:26px;border-radius:8px;border:2px solid ${picked ? 'var(--accent)' : 'var(--line)'};background:${picked ? 'var(--accent)' : 'transparent'};display:grid;place-items:center">${picked ? '<span style="color:#fff;font-size:15px">' + ic('check',14,'stroke:#fff') + '</span>' : ''}</div>
          <span style="font-size:12px;color:var(--ink-dim);font-family:var(--mono)">compare</span>
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-secondary" style="flex:1;padding:9px;font-size:12px" onclick="loadScenario('${s.id}')">${ic('rotate',13)} Load</button>
        <button class="btn-secondary" style="padding:9px 12px;font-size:12px;border-color:var(--line);color:var(--ink-dim)" onclick="deleteScenario('${s.id}')">${ic('x',13)}</button>
      </div>
    </div>`;
  }).join('');

  return `${topbar('Compare setups', 'blue', false)}
  <div class="screen">
    ${saveBar}
    ${sel.length >= 2 ? renderCompareTable(sel) : `<div class="card" style="padding:14px 16px;background:var(--blue-soft);border-color:var(--blue);margin-bottom:14px"><div style="font-size:12px;color:var(--ink);line-height:1.55">${ic('info',14,'vertical-align:-2px')} Tick <b>2 or more</b> scenarios below to see them side by side.</div></div>`}
    <div class="section-title" style="margin-top:6px">Saved scenarios · ${scenarios.length}/12</div>
    ${list}
  </div>
  ${bottomNav()}`;
}

// Side-by-side comparison table across all meaningful metrics.
function renderCompareTable(selIds){
  const cols = selIds.map(id => (state.scenarios || []).find(s => s.id === id)).filter(Boolean);
  if (cols.length < 2) return '';

  // Each metric: label, accessor, formatter, and which direction is "better"
  // (for highlighting the winning cell). null better = no winner highlight.
  const fmtEur = v => v == null ? '—' : '€' + Math.round(v).toLocaleString();
  const metrics = [
    { k:'Region',        get:s=>s.region,                      fmt:v=>v||'—',                  better:null },
    { k:'Solar',         get:s=>s.hasSolar?(s.kwp+' kWp'):'none', fmt:v=>v,                    better:null },
    { k:'Panels',        get:s=>s.panels||0,                   fmt:v=>v||'0',                  better:'high' },
    { k:'Battery',       get:s=>s.battery||0,                  fmt:v=>v?v+' kWh':'none',       better:null },
    { k:'Strategy',      get:s=>s.strategy||'—',               fmt:v=>v,                       better:null },
    { k:'EV',            get:s=>s.ev?'yes':'no',               fmt:v=>v,                       better:null },
    { k:'System cost (net)', get:s=>s.sysCostNet,              fmt:fmtEur,                     better:'low' },
    { k:'Best plan',     get:s=>s.bestPlanName||'—',           fmt:v=>v,                       better:null },
    { k:'Annual bill',   get:s=>s.bestNet,                     fmt:fmtEur,                     better:'low' },
    { k:'Saving vs current', get:s=>s.savings,                 fmt:fmtEur,                     better:'high' },
    { k:'Solar benefit/yr', get:s=>s.solarBenefit,             fmt:fmtEur,                     better:'high' },
    { k:'Payback',       get:s=>s.payback,                     fmt:v=>v==null?'—':v.toFixed(1)+' yr', better:'low' },
    { k:'20-yr NPV',     get:s=>s.npv20,                       fmt:fmtEur,                     better:'high' },
    { k:'Annual kWh',    get:s=>s.annualKwh,                   fmt:v=>v?Math.round(v).toLocaleString():'—', better:null }
  ];

  const colW = `minmax(0,1fr)`;
  const headCells = cols.map(s => `<div style="font-size:12px;font-weight:700;color:var(--ink);text-align:center;padding:6px 4px;line-height:1.3;overflow:hidden;text-overflow:ellipsis">${s.name}</div>`).join('');

  const rows = metrics.map(m => {
    const vals = cols.map(s => m.get(s.summary || {}));
    // Determine winner index for numeric metrics
    let winIdx = -1;
    if (m.better){
      const nums = vals.map(v => (typeof v === 'number' && isFinite(v)) ? v : null);
      const valid = nums.filter(v => v != null);
      if (valid.length){
        const target = m.better === 'high' ? Math.max(...valid) : Math.min(...valid);
        // only highlight if there's a real spread
        if (Math.max(...valid) !== Math.min(...valid)) winIdx = nums.indexOf(target);
      }
    }
    const cells = vals.map((v, i) => {
      const win = i === winIdx;
      return `<div style="font-family:var(--mono);font-size:12px;text-align:center;padding:7px 4px;${win ? 'color:var(--accent);font-weight:700' : 'color:var(--ink-soft)'}">${m.fmt(v)}${win ? ' ★' : ''}</div>`;
    }).join('');
    return `<div style="display:grid;grid-template-columns:96px repeat(${cols.length}, ${colW});border-top:1px solid var(--line-soft);align-items:center">
      <div style="font-size:12px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:.03em;padding:7px 6px 7px 0">${m.k}</div>
      ${cells}
    </div>`;
  }).join('');

  return `<div class="card" style="margin-bottom:14px;overflow-x:auto">
    <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:8px">Side by side · ★ = best</div>
    <div style="display:grid;grid-template-columns:96px repeat(${cols.length}, ${colW});border-bottom:2px solid var(--line)">
      <div></div>${headCells}
    </div>
    ${rows}
    <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-top:10px;line-height:1.5">Best plan & payback computed at save time. Re-save a scenario to refresh against current tariffs.</div>
  </div>`;
}

/* ── MY PEAKLESS ───────────────────────────────────────────────
 * The household in one place: the home, the system and the car it was
 * built from, what the app found, the quotes kept and the requests sent.
 * A guest gets the same page, saved on this phone, with the one thing an
 * account adds said plainly. */
/** What the home's current plan costs it as modelled — panels, battery and
 *  car included, export credited. The same figure the Plans tab shows, so
 *  every comparison is like with like. */
function myPlanCost(){
  const plan = getPlanById(state.baseline);
  return annualCost(sim(plan.id), plan).net;
}

/* ── ALERTS AND THE SAVINGS TALLY ─────────────────────────────
 * Alerts are worked out from the household and the price data whenever the
 * app opens, so they are always current: a price change on the plan this
 * home is on, a plan that would save real money, a contract about to end.
 * Each has a stable id; reading it marks it seen, and a new situation (a
 * different cheaper plan, a new price change) is a new alert.
 *
 * The tally is what the household has actually done — switched, installed
 * — each with the yearly saving the model gave at that moment, counted up
 * by the days since. It is an estimate, and says so; smart-meter data is
 * what will check it. */
const ALERT_MIN_SAVING = 50;   // €/yr: below this a switch is not worth a message

function todayIso(){ return new Date().toISOString().slice(0, 10); }
function fmtDay(iso){ return new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }); }

function computeAlerts(){
  if (!state.onboarding_complete) return [];
  const out = [];
  const today = todayIso();
  try {
    const plan = getPlanById(state.baseline);
    const pc = plan && plan.price_change;
    if (pc && pc.effective_date && pc.effective_date >= addDays(today, -14)){
      const up = pc.direction !== 'decrease';
      const pct = Math.round(Math.max(pc.pct || 0, ...Object.values(pc.pct_bands || {})) * 100);
      out.push({ id: `price:${plan.id}:${pc.effective_date}`, kind: 'price', level: up ? 'warn' : 'info',
        title: `${esc(plan.supplier)} ${up ? 'raises' : 'lowers'} your plan's prices${pct ? ` by up to ${pct}%` : ''}`,
        body: `${pc.effective_date > today ? 'From' : 'Since'} ${fmtDay(pc.effective_date)}${pc.standing_pct ? `, standing charge ${up ? '+' : '−'}${Math.round(pc.standing_pct * 100)}%` : ''}. Your figures already include it.`,
        go: "setScreen('plans')", cta: 'Compare plans' });
    }
    const rec = getRecommendation();
    const save = myPlanCost() - rec.best.net;
    if (rec.best.plan.id !== state.baseline && save >= ALERT_MIN_SAVING){
      out.push({ id: `cheaper:${rec.best.plan.id}`, kind: 'cheaper', level: 'gain',
        title: `${esc(rec.best.plan.supplier)} ${esc(rec.best.plan.plan)} would save you ${eur(save)} a year`,
        body: 'Against what your plan costs this home today. Switching takes about ten minutes and there is nothing to cancel.',
        go: "setScreen('result')", cta: 'See the switch' });
    }
    const old = (state.journey || []).filter((e) => (Date.now() - Date.parse(e.at)) / 864e5 > 30);
    const lastDay = Object.keys(meterDays()).sort().pop() || '';
    if (old.length && old.some((e) => lastDay < addDays(e.at, 14))){
      out.push({ id: `meter:${quarterKey()}`, kind: 'meter', level: 'info',
        title: 'Check your savings against your meter',
        body: 'Download your smart-meter file from esbnetworks.ie (My Account → Downloads) and upload it. We will re-price what you actually used and show what you really saved.',
        go: "v7Sheet('meter')", cta: 'Upload meter data' });
    }
    if (state.contract_end){
      const days = Math.round((Date.parse(state.contract_end) - Date.parse(today)) / 864e5);
      if (days <= 45 && days >= -60) out.push({ id: `contract:${state.contract_end}`, kind: 'contract', level: 'warn',
        title: days >= 0 ? `Your contract ends in ${days} day${days === 1 ? '' : 's'}` : 'Your contract has ended',
        body: `${fmtDay(state.contract_end)}. ${days >= 0 ? 'After it' : 'Since then'} you are usually moved to the supplier's standard rate, which costs more. A new plan can be lined up now.`,
        go: "setScreen('plans')", cta: 'Find a new plan' });
    }
  } catch (e) {}
  return out;
}

function addDays(iso, n){ const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function unseenAlerts(){ const seen = state.alerts_seen || {}; return computeAlerts().filter((a) => !seen[a.id]); }
function markAlertsSeen(){
  const seen = state.alerts_seen = state.alerts_seen || {};
  computeAlerts().forEach((a) => { if (!seen[a.id]) seen[a.id] = Date.now(); });
  saveState();
}

/* The tally. */
function journeyTotal(){
  const now = Date.now();
  let total = 0;
  for (const e of state.journey || []){
    const days = Math.max(0, (now - Date.parse(e.at + 'T00:00:00')) / 864e5);
    total += (e.per_year || 0) * days / 365;
  }
  return total;
}

/** "I switched": the plan becomes the home's plan, and the saving goes on the tally. */
function recordSwitch(planId, when){
  const to = getPlanById(planId);
  if (!to) return;
  const at = when || todayIso();
  let per = 0;
  // A second switch within two weeks of the last is a correction (the first
  // was the wrong plan, or changed before it began), not a further saving:
  // it replaces that entry, priced from the plan before it.
  const j = state.journey = state.journey || [];
  const lastIdx = j.map((e) => e.type).lastIndexOf('switch');
  const last = lastIdx >= 0 ? j[lastIdx] : null;
  const correcting = last && Math.abs(Date.parse(at) - Date.parse(last.at)) <= 14 * 864e5;
  if (correcting){ j.splice(lastIdx, 1); state.baseline = last.from; }
  try {
    const from = getPlanById(state.baseline);
    const fromCost = sumF(sim(state.baseline).cost) + from.standing + PSO_LEVY;
    const toCost = annualCost(sim(to.id), to).net;
    per = Math.max(0, fromCost - toCost);
    (state.journey = state.journey || []).push({ type: 'switch', at, from: from.id, to: to.id,
      label: `Switched to ${to.supplier} ${to.plan}`, per_year: Math.round(per) });
  } catch (e) {}
  state.baseline = to.id;
  state.baseline_known = true;
  state.baseline_discount_pct = 0;
  state.chosen_plan = null;
  if (to.length > 0) state.contract_end = addDays(at, Math.round(to.length * 30.44));
  invalidate(); saveState();
  state._sheet = null;
  showToast(`On the tally: ${eur(per)} a year from ${fmtDay(at)}`, { type: 'accent', icon: ic('checkC', 16) });
  renderApp();
}

/** "It's installed": the panels' yearly saving goes on the tally. */
function recordInstall(when){
  const at = when || todayIso();
  let per = 0;
  try {
    const plan = getPlanById(state.baseline);
    per = Math.max(0, sumF(baselineSim(state.baseline).cost) - sumF(sim(state.baseline).cost));
    void plan;
  } catch (e) {}
  (state.journey = state.journey || []).push({ type: 'install', at, label: `Installed ${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ` + ${state.battery_kwh} kWh` : ''}`, per_year: Math.round(per) });
  state.solar_planned = false; state.solar_is_estimate = false;
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState();
  state._sheet = null;
  showToast(`On the tally: ${eur(per)} a year from ${fmtDay(at)}`, { type: 'accent', icon: ic('checkC', 16) });
  renderApp();
}

function removeJourney(i){
  (state.journey || []).splice(i, 1);
  saveState(); renderApp();
}

function journeyCommit(kind){
  const d = (document.getElementById('jr-date') || {}).value || todayIso();
  if (kind === 'install') return recordInstall(d);
  const p = (document.getElementById('jr-plan') || {}).value;
  recordSwitch(p, d);
}

/** The sheet that asks what happened and when. */
function renderJourneySheet(kind){
  const today = todayIso();
  if (kind === 'install'){
    return `<div class="v7-sheet-head"><div class="v7-eyebrow">The tally</div><h2 class="v7-h">When were the panels switched on?</h2></div>
      <p class="me-p">The system becomes your installed system, and its yearly saving is counted from this date.</p>
      <label class="sy-field"><span><b>Date</b></span><input type="date" id="jr-date" value="${today}" max="${today}"></label>
      <button class="v7-cta-2" onclick="journeyCommit('install')">Add to my tally</button>`;
  }
  // The plans ranked best for this home come first, the top one chosen: that
  // is almost always the one the person just switched to. Every other plan
  // follows. The current plan is not offered: a switch is to something else.
  // The plan the app recommends everywhere else comes first: the one the
  // person chose by hand if they did, otherwise the cheapest. The ranking's
  // next two follow it.
  const rec = getRecommendation();
  const ranked = (rec.ranked || []).map((r) => r.plan).filter((p) => p && p.id !== state.baseline);
  const lead = rec.best && rec.best.plan && rec.best.plan.id !== state.baseline ? [rec.best.plan] : [];
  const top = [...lead, ...ranked.filter((p) => !lead.some((l) => l.id === p.id))].slice(0, 3);
  const rest = activeTariffsSorted().filter((p) => p.id !== state.baseline && !top.some((t) => t.id === p.id));
  const opt = (p, i) => `<option value="${p.id}" ${i === 0 ? 'selected' : ''}>${esc(p.supplier)} — ${esc(p.plan)}</option>`;
  return `<div class="v7-sheet-head"><div class="v7-eyebrow">The tally</div><h2 class="v7-h">Which plan did you switch to?</h2></div>
    <p class="me-p">It becomes your plan here, and the yearly saving against your old one is counted from the date.</p>
    <label class="sy-field sy-field-stack"><span><b>Plan</b></span><select id="jr-plan">
      <optgroup label="${rec.isManualChoice ? 'Your chosen plan, then the cheapest' : 'Best for your home'}">${top.map(opt).join('')}</optgroup>
      <optgroup label="All other plans">${rest.map((p) => opt(p, -1)).join('')}</optgroup>
    </select></label>
    <label class="sy-field"><span><b>Date</b></span><input type="date" id="jr-date" value="${today}" max="${today}"></label>
    <button class="v7-cta-2" onclick="journeyCommit('switch')">Add to my tally</button>`;
}

function renderAlertsBlock(){
  const list = computeAlerts();
  const seen = state.alerts_seen || {};
  const cls = { warn: 'is-warn', gain: 'is-gain', info: '' };
  const body = list.length ? list.map((a) => `<div class="al ${cls[a.level] || ''} ${seen[a.id] ? '' : 'is-new'}">
      <div class="al-dot" aria-hidden="true"></div>
      <div class="al-text"><b>${a.title}</b><small>${a.body}</small>
        <button class="al-go" onclick="${a.go}">${a.cta} ${ic('chevR', 14)}</button></div>
    </div>`).join('') : `<div class="me-empty">Nothing needs you right now. We check every time prices change.</div>`;
  const email = _sbUser
    ? `<label class="sy-toggle al-email"><span><b>Email me these</b><small>Price changes on my plan and my contract ending. Never marketing.</small></span>
        <input type="checkbox" role="switch" ${state.alerts_email ? 'checked' : ''} onchange="state.alerts_email=this.checked;saveState();renderApp()"></label>`
    : `<div class="al-email-guest">Sign in to get these by email too.</div>`;
  return `<section class="me-list al-list">${body}${email}</section>`;
}

function renderTallyBlock(){
  const j = state.journey || [];
  const sysPlanned = state.has_solar && totalPanels() > 0 && (state.solar_planned || state.solar_is_estimate);
  const total = journeyTotal();
  const perYear = j.reduce((a, e) => a + (e.per_year || 0), 0);
  return `<section class="me-tally">
    ${j.length ? `<div class="me-tally-fig">${eur(total)}<small>saved so far</small></div>
      <div class="me-tally-sub">About ${eur(perYear)} a year from what you've done · estimated from the model</div>
      <div class="me-tally-list">${j.map((e, i) => `<div class="me-tally-row"><span><b>${esc(e.label)}</b><small>${fmtDay(e.at)} · ${eur(e.per_year)} a year</small></span>
        <button class="me-mini me-x" aria-label="Remove" onclick="removeJourney(${i})">${ic('x', 14)}</button></div>`).join('')}</div>`
      : `<div class="me-tally-empty"><b>Your savings tally</b><small>Tell us when you switch plan or your panels go in, and we'll keep count of what it's saving you.</small></div>`}
    <div class="me-tally-actions">
      <button class="me-mini" onclick="v7Sheet('journey','switch')">${ic('swap', 14)} I switched plan</button>
      ${sysPlanned ? `<button class="me-mini" onclick="v7Sheet('journey','install')">${ic('sun', 14)} My panels are in</button>` : ''}
    </div>
    ${j.length ? `<div class="me-fine">The tally uses the model's figure for each step. Importing your ESB smart-meter data will check it against what really happened.</div>` : ''}
  </section>`;
}

/* ── WHAT REALLY HAPPENED ──────────────────────────────────────
 * With the meter's own readings the app can check itself. Each switch on
 * the tally is re-priced on the real recorded use — the old plan against
 * the new, from the switch date — and the panels are checked by how much
 * less the home bought from the grid than the same days the year before
 * (or than the model expected, when there is no year before). */
function meterDays(){ return (state.meter && state.meter.days) || {}; }

function realityChecks(){
  const days = meterDays();
  if (!Object.keys(days).length) return [];
  const out = [];
  for (const e of state.journey || []){
    if (e.type === 'switch'){
      const from = getPlanById(e.from), to = getPlanById(e.to);
      if (!from || !to) continue;
      const r = checkSwitch(days, e, from, to);
      out.push({ e, r, kind: 'switch' });
    } else if (e.type === 'install'){
      // Grid bought per day after the install, against the model's own
      // expectation for those calendar days with the panels in.
      const after = Object.entries(days).filter(([d]) => d >= e.at);
      if (after.length < 14){ out.push({ e, r: null, kind: 'install' }); continue; }
      let real = 0, modelled = 0;
      try {
        const s = sim(state.baseline);
        for (const [d, v] of after){
          const doy = Math.min(364, Math.max(0, Math.floor((Date.parse(d + 'T00:00:00Z') - Date.UTC(+d.slice(0, 4), 0, 1)) / 864e5)));
          for (let h = 0; h < 24; h++){ real += v[h] || 0; modelled += s.grid_import[doy * 24 + h] || 0; }
        }
      } catch (err) {}
      out.push({ e, r: { days: after.length, realKwh: real, modelKwh: modelled, ratio: real > 0 ? modelled / real : null }, kind: 'install' });
    }
  }
  return out;
}

/**
 * The household's score, out of 100, played as a game.
 *
 * Four parts, each something the household can move: being on a plan close
 * to the cheapest (40), how much of the home the model knows rather than
 * assumes (20), use falling in the plan's cheap hours (20, from the meter),
 * and installed panels doing what they should (20, from the meter). A part
 * not yet measurable scores nothing and shows as a challenge to unlock it,
 * so the score always has somewhere to go and says how to get there.
 */
const SCORE_LEVELS = [[0, 'Starter'], [40, 'Saver'], [65, 'Smart saver'], [85, 'Peakless']];
const PLAN_GAP_OK = 50;   // €/yr: closer than this to the cheapest counts as the best plan

function householdScore(){
  const parts = [], quests = [], done = [];
  try {
    const rec = getRecommendation();
    const plan = getPlanById(state.baseline);
    const cheapest = rec.cheapest || rec.best;
    const gap = Math.max(0, myPlanCost() - cheapest.net);
    const planPts = gap <= PLAN_GAP_OK ? 40 : Math.round(40 * Math.max(0, 1 - (gap - PLAN_GAP_OK) / 550));
    parts.push({ key: 'plan', label: 'Right plan', max: 40, pts: planPts });
    if (gap <= PLAN_GAP_OK) done.push(gap > 1 && cheapest.plan.id !== plan.id
      ? `On a plan within ${eur(gap)} of the cheapest` : 'On the cheapest plan for your home');
    else quests.push({ pts: 40 - planPts, eur: gap, icon: 'swap', title: `Switch to ${esc(cheapest.plan.supplier)} ${esc(cheapest.plan.plan)}`,
      sub: `${planKindText(cheapest.plan)} · ${eur(cheapest.net)} a year against ${eur(myPlanCost())} on yours`, go: `v7Sheet('plan','${cheapest.plan.id}')` });

    const acc = modelAccuracy();
    const knowPts = Math.round(20 * Math.max(0, Math.min(1, (15 - acc.pct) / 12)));
    parts.push({ key: 'know', label: 'Home known', max: 20, pts: knowPts });
    if (acc.tip && !/smart-meter|meter data/i.test(acc.tip.tip)) quests.push({ pts: Math.max(2, Math.round((20 - knowPts) / 2)), icon: 'spark',
      title: acc.tip.tip, sub: `Tightens every figure, now ±${acc.pct}%`, go: acc.tip.go });
    if (knowPts >= 16) done.push(`Figures accurate to ±${acc.pct}%`);

    const days = meterDays();
    const hasMeter = Object.keys(days).length > 0;
    const since = (state.journey || []).filter((e) => e.type === 'switch').map((e) => e.at).sort().pop() || '0000';
    const fit = hasMeter ? timingFit(days, plan, since) : null;
    const timePts = fit ? Math.round(20 * fit.fit) : 0;
    parts.push({ key: 'timing', label: 'Cheap-hour habits', max: 20, pts: timePts });
    const installed = state.has_solar && totalPanels() > 0 && !(state.solar_planned || state.solar_is_estimate);
    const inst = installed ? realityChecks().find((c) => c.kind === 'install' && c.r && c.r.ratio) : null;
    const panelPts = inst ? Math.round(20 * Math.min(1, inst.r.ratio)) : 0;
    // Panels only count once the meter can check them; until then they are a
    // challenge to unlock, not a zero that drags the score down.
    if (installed && inst) parts.push({ key: 'panels', label: 'Panels working', max: 20, pts: panelPts });
    if (installed && !inst && hasMeter && !(state.journey || []).some((e) => e.type === 'install'))
      quests.push({ pts: 0, icon: 'sun', title: 'Tell us when your panels went in', sub: 'So your meter readings can check they’re doing what they should', go: "v7Sheet('journey','install')" });

    // Meter data also replaces the usage estimate, so it lifts "home known" too.
    const knowAfter = state._csv_imported ? knowPts : Math.round(20 * Math.max(0, Math.min(1, (15 - Math.max(2, acc.pct - 6)) / 12)));
    if (!hasMeter) quests.push({ pts: 20 + (installed ? 20 : 0) + Math.max(0, knowAfter - knowPts), icon: 'csv', title: 'Upload your ESB meter file',
      sub: `Unlocks cheap-hour habits${installed ? ' and panel checks' : ''}, sharpens every figure, and checks your savings for real`, go: "v7Sheet('meter')" });
    else {
      done.push(`Meter data in · ${Object.keys(days).length} days`);
      const habitsDone = (state.quests_done || {}).habits && (Date.now() - Date.parse(state.quests_done.habits)) < 60 * 864e5;
      if (habitsDone) done.push('Timers set for the cheap hours');
      if (fit && fit.fit < 0.8 && !isFlatPlan(plan) && !habitsDone) quests.push({ pts: 20 - timePts, icon: 'clock', title: 'Move use out of the dear hours',
        sub: `You pay ${fmtCent(fit.avgRate)} a kWh on average${fit.peakShare > 0.02 ? `, ${Math.round(fit.peakShare * 100)}% of it at peak` : ''}`, go: "v7Sheet('habits')" });
      else if (fit) done.push('Good cheap-hour habits');
      if (installed && inst && inst.r.ratio < 0.85) quests.push({ pts: 20 - panelPts, icon: 'battery', title: 'Get more from your panels',
        sub: `You bought ${Math.round(inst.r.realKwh).toLocaleString('en-IE')} kWh; the model expected ${Math.round(inst.r.modelKwh).toLocaleString('en-IE')}`, go: 'openMySystem()' });
    }
    if (!state.contract_end) quests.push({ pts: 0, icon: 'calendar', title: 'Add your contract end date', sub: "So we can remind you before you're moved to a dearer rate", go: 'openMyHome()' });
    if ((state.journey || []).length) done.push('Keeping a savings tally');
  } catch (e) {}
  const max = parts.reduce((a, p) => a + p.max, 0);
  const score = max ? Math.round(parts.reduce((a, p) => a + p.pts, 0) / max * 100) : 0;
  quests.sort((a, b) => b.pts - a.pts || (b.eur || 0) - (a.eur || 0));
  return { score, parts, quests, done };
}

/** A challenge, explained before it is started: what, why, what it is worth. */
function renderQuestSheet(i){
  const sc = householdScore();
  const q = sc.quests[+i];
  if (!q) return '';
  const lv = scoreLevel(sc.score), after = scoreLevel(Math.min(100, sc.score + (q.pts || 0)));
  return `<div class="v7-sheet-head"><div class="v7-eyebrow">Challenge</div><h2 class="v7-h">${q.title}</h2></div>
    <p class="me-p">${q.sub}</p>
    <div class="qs-worth">
      ${q.pts ? `<span><b>+${q.pts}</b>points</span>` : ''}
      ${q.eur ? `<span><b>${eur(q.eur)}</b>a year</span>` : ''}
      ${q.pts && after.name !== lv.name ? `<span><b>${after.name}</b>new level</span>` : ''}
      ${!q.pts && !q.eur ? `<span><b>Reminder</b>no points, just peace of mind</span>` : ''}
    </div>
    <button class="v7-cta-2" onclick="${/^v7Sheet\(/.test(q.go) ? q.go : `v7Sheet(null);${q.go}`}">Do it now ${ic('chevR', 16)}</button>
    <div class="v7-fine">Your score updates as soon as it’s done.</div>`;
}

/** Mark a challenge that only the person can confirm (timers set) as done for 60 days. */
function questDone(key){
  (state.quests_done = state.quests_done || {})[key] = todayIso();
  state._sheet = null; state._quest_sel = 0;
  saveState();
  showToast('Marked done. Your next meter upload shows what moved.', { type: 'accent', icon: ic('checkC', 16), title: 'Challenge done' });
  renderApp();
}

/** Upload the ESB file without leaving the screen: the steps, the button, the result. */
function renderMeterSheet(){
  return `<div class="v7-sheet-head"><div class="v7-eyebrow">Your meter data</div><h2 class="v7-h">Upload your ESB smart-meter file</h2></div>
    <ol class="ms-steps">
      <li>Sign in at <b>myaccount.esbnetworks.ie</b> (free; your MPRN is on your bill).</li>
      <li>Open <b>My Meter</b>, then <b>Downloads</b>, and download <b>30-minute readings (kW)</b>.</li>
      <li>Come back and choose the file below.</li>
    </ol>
    <label class="v7-cta-2 ms-pick">${ic('csv', 16)} Choose the file
      <input id="csv-file-input" type="file" accept=".csv,.CSV" onchange="handleCsvFile(event)" hidden></label>
    <div id="csv-parse-result"></div>
    <div class="v7-fine">The file stays on this phone (and in your account if you're signed in). Less than a year of readings still works.</div>`;
}

/**
 * The cheap-hours habit, as moves with a price on each: what to run when,
 * on this home's own plan, and what moving it is worth over a year.
 */
function renderHabitsSheet(){
  const plan = getPlanById(state.baseline);
  const r = plan.rates, w = plan.windows || {};
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  const cheapBand = r.ev != null && w.ev ? 'ev' : r.night != null && w.night ? 'night' : null;
  const cheap = cheapBand ? r[cheapBand] : r.day;
  const dear = r.peak != null && w.peak ? r.peak : r.day;
  const cheapWin = cheapBand ? `${hh(w[cheapBand][0])}–${hh(w[cheapBand][1])}` : null;
  const dearWin = w.peak ? `${hh(w.peak[0])}–${hh(w.peak[1])}` : 'the day';
  const gap = Math.max(0, dear - cheap);
  if (!cheapBand || gap < 0.02){
    return `<div class="v7-sheet-head"><div class="v7-eyebrow">Cheap hours</div><h2 class="v7-h">Your plan has one price all day</h2></div>
      <p class="me-p">On ${esc(plan.supplier)} ${esc(plan.plan)} it doesn't matter when you use power, so there is nothing to move. A plan with cheap night hours could pay you to move it.</p>
      <button class="v7-cta-2" onclick="v7Sheet(null);setScreen('plans')">See plans with cheap hours ${ic('chevR', 16)}</button>`;
  }
  const moves = [
    ['Dishwasher', 'Set its delay timer', 1.1 * 5 * 52],
    ['Washing machine', 'Start it on a timer', 0.9 * 4 * 52],
    ['Tumble dryer', 'Run it overnight', 2.5 * 3 * 52],
    ...(state.ev_active ? [['Car charging', 'Schedule it in the car or charger app', (state.ev_km_per_year || 0) * (state.ev_kwh_per_100km || 17) / 100 * 0.5]] : []),
    ...(['storage', 'direct', 'heatpump'].includes(state.heating_type) || state.hot_water_strategy !== 'none' ? [['Hot water', 'Set the immersion timer', 3 * 365]] : []),
  ].map(([what, how, kwh]) => ({ what, how, kwh, eur: kwh * gap }));
  const total = moves.reduce((a, m) => a + m.eur, 0);
  return `<div class="v7-sheet-head"><div class="v7-eyebrow">Cheap hours</div><h2 class="v7-h">Move these to ${cheapWin}</h2></div>
    <div class="ms-rates">
      <span class="is-cheap"><b>${fmtCent(cheap)}</b>${cheapWin}</span>
      <span class="is-dear"><b>${fmtCent(dear)}</b>${dearWin}</span>
    </div>
    <div class="me-list">${moves.map((m) => `<div class="me-row"><span><b>${m.what}</b><small>${m.how}</small></span><b class="ms-eur">${eur(m.eur)}/yr</b></div>`).join('')}</div>
    <p class="me-p">All of them together: about <b>${eur(total)} a year</b>, on ${esc(plan.supplier)} ${esc(plan.plan)}. Your next meter upload shows how much moved, and your score goes up with it.</p>
    <button class="v7-cta-2" onclick="questDone('habits')">Done: I've set my timers</button>`;
}

/* Reward feedback: when something the person did raises the score, say so. */
let _scoreSeen = null, _scoreTimer = null;
function checkScoreRise(){
  if (!state.onboarding_complete || NO_SHEET_SCREENS.includes(state.current_screen)) return;
  clearTimeout(_scoreTimer);
  _scoreTimer = setTimeout(() => {
    let sc; try { sc = householdScore().score; } catch (e) { return; }
    // Only for someone who knows there is a score: a newcomer tapping around
    // was getting "+1 points" with no idea what it meant.
    if (_scoreSeen != null && sc > _scoreSeen && state.score_seen){
      const a = scoreLevel(_scoreSeen), b = scoreLevel(sc);
      showToast(b.name !== a.name ? `Level up: ${b.name}. Your score is ${sc}.` : `Your score is now ${sc}.`,
        { type: 'accent', icon: ic('spark', 16), title: `+${sc - _scoreSeen} points` });
    }
    _scoreSeen = sc;
  }, 600);
}

function scoreLevel(score){
  let i = 0;
  SCORE_LEVELS.forEach(([min], k) => { if (score >= min) i = k; });
  const next = SCORE_LEVELS[i + 1];
  return { name: SCORE_LEVELS[i][1], next: next ? next[1] : null, toNext: next ? next[0] - score : 0,
    within: next ? (score - SCORE_LEVELS[i][0]) / (next[0] - SCORE_LEVELS[i][0]) : 1 };
}

/** What kind of plan it is, in words: told apart when names look alike. */
function planKindText(p){
  if (!p) return '';
  if (p.type === 'dynamic') return 'price changes hourly';
  if (p.type === 'flat' || isFlatPlan(p)) return 'one price all day';
  if (p.type === 'ev' || (p.windows && p.windows.ev)) return 'cheap EV-charging hours';
  return p.windows && p.windows.peak ? 'day, night and peak prices' : 'day and night prices';
}

function renderScoreBlock(){
  state.score_seen = true;   // from here on, a rise in the score is news worth a toast
  const sc = householdScore();
  const lv = scoreLevel(sc.score);
  const tone = sc.score >= 85 ? 'is-gain' : sc.score >= 40 ? 'is-maybe' : 'is-warn';
  const checks = realityChecks();
  return `<section class="gm">
    <div class="gm-top">
      <div class="sc-ring ${tone}" style="--p:${Math.max(3, sc.score)}"><b>${sc.score}</b><small>points</small></div>
      <div class="gm-level">
        <span class="gm-level-name ${tone}">${lv.name}</span>
        ${lv.next ? `<small>${lv.toNext} point${lv.toNext === 1 ? '' : 's'} to <b>${lv.next}</b></small>
          <div class="gm-bar"><i style="width:${Math.round(lv.within * 100)}%"></i></div>` : '<small>The top level. Keep it there.</small>'}
      </div>
    </div>
    <div class="gm-parts">${sc.parts.map((p) => `<span class="gm-part"><b>${p.pts}</b>/${p.max} ${p.label.toLowerCase()}</span>`).join('')}</div>

    ${sc.quests.length ? `<div class="gm-h">Next challenges</div>
    ${sc.quests.map((q, qi) => `<button class="gm-q ${(state._quest_sel ?? 0) === qi ? 'is-sel' : ''}" onclick="state._quest_sel=${qi};v7Sheet('quest','${qi}')">
        <span class="gm-q-ico">${ic(q.icon, 18)}</span>
        <span class="gm-q-text"><b>${q.title}</b><small>${q.sub}</small></span>
        <span class="gm-q-gain">${q.pts ? `<b>+${q.pts}</b><small>points</small>` : `<small>reminder</small>`}${q.eur ? `<em>${eur(q.eur)}/yr</em>` : ''}</span>
      </button>`).join('')}` : ''}

    ${sc.done.length ? `<div class="gm-h">Done</div><div class="gm-done">${sc.done.map((d) => `<span>${ic('checkC', 14)} ${d}</span>`).join('')}</div>` : ''}

    ${checks.filter((c) => c.kind === 'switch').map(({ e, r }) => r
      ? `<div class="sc-check"><b>${esc(e.label)}</b><small>Checked on ${r.days} days of your meter: really ${eur(r.perYear)} a year, against ${eur(e.per_year)} expected${r.ratio != null ? ` (${Math.round(r.ratio * 100)}%)` : ''}.</small></div>`
      : `<div class="sc-check"><b>${esc(e.label)}</b><small>Not checked yet: needs two weeks of meter data from ${fmtDay(e.at)}.</small></div>`).join('')}
  </section>`;
}

/* ── THIS QUARTER'S SUGGESTIONS ─────────────────────────────────
 * Claude reads a short summary of the household — the plan and its prices,
 * the alternatives, the use by hour, the score — and suggests up to three
 * things to do, each grounded in those figures. Nothing personal is sent:
 * no name, address, email or meter number. Kept for the quarter. */
function quarterKey(d = new Date()){ return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`; }

function adviceSummary(){
  const rec = getRecommendation();
  const plan = getPlanById(state.baseline);
  const days = meterDays();
  const keys = Object.keys(days).sort().slice(-90);
  const hourly = new Array(24).fill(0);
  keys.forEach((d) => { for (let h = 0; h < 24; h++) hourly[h] += days[d][h] || 0; });
  const sc = householdScore();
  const p = (x) => ({ name: `${x.supplier} ${x.plan}`, type: x.type, rates_c: Object.fromEntries(Object.entries(x.rates).map(([k, v]) => [k, Math.round(v * 1000) / 10])),
    windows: x.windows, standing_eur: x.standing, export_c: Math.round((x.export_rate || 0) * 1000) / 10 });
  return {
    home: { region: state.region, heating: state.heating_type, kwh_year: Math.round(v7AnnualKwh()), hot_water: state.hot_water_strategy,
      ev_km_year: state.ev_active ? state.ev_km_per_year : 0,
      solar: state.has_solar && totalPanels() > 0 ? { kwp: +totalKwp().toFixed(1), battery_kwh: state.battery_kwh || 0, status: state.solar_planned || state.solar_is_estimate ? 'planned' : 'installed', battery_strategy: state.strategy_mode } : null,
      contract_end: state.contract_end || null },
    current_plan: { ...p(plan), yearly_cost_eur: Math.round(myPlanCost()), upcoming_change: plan.price_change ? plan.price_change.note || null : null },
    best_plans: rec.ranked.slice(0, 3).map((r) => ({ ...p(r.plan), yearly_cost_eur: Math.round(r.net) })),
    meter_last_90_days: keys.length ? { days: keys.length, kwh_by_hour: hourly.map((v) => Math.round(v)) } : null,
    score: sc.score, score_parts: sc.parts.map((x) => ({ part: x.label, points: x.pts, of: x.max, note: x.note })),
    done: (state.journey || []).map((e) => ({ what: e.label, when: e.at, per_year_eur: e.per_year })),
  };
}

let _adviceBusy = false;
async function getAdvice(){
  if (_adviceBusy) return;
  _adviceBusy = true; renderApp();
  try {
    const res = await fetch('/api/advice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: adviceSummary() }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.advice) throw new Error(out.error || 'Suggestions are not available just now.');
    state.advice = { quarter: quarterKey(), key: setupKey(state), at: new Date().toISOString(), items: out.advice.items || [] };
    saveState();
  } catch (e){
    showToast((e && e.message) || 'Suggestions are not available just now.', { type: 'warn', icon: ic('warn', 16) });
  }
  _adviceBusy = false; renderApp();
}

function renderAdviceBlock(){
  // Suggestions belong to the plan and setup they were written for: change
  // either and they are set aside rather than shown as if still true.
  const a0 = state.advice;
  const stale = !!(a0 && a0.items && a0.items.length && a0.key !== setupKey(state));
  const a = stale ? null : a0;
  const fresh = a && a.quarter === quarterKey();
  const effort = { easy: 'Easy', some: 'Some effort', big: 'A bigger step' };
  return `<section class="adv">
    ${stale ? `<div class="me-empty">Your plan or setup has changed since the last suggestions, so they no longer apply. Ask again for ones that fit.</div>` : ''}
    ${fresh && a.items.length ? a.items.map((x) => `<div class="adv-item">
        <div class="adv-item-top"><b>${esc(x.title)}</b>${x.saving_eur ? `<em>${eur(x.saving_eur)}/yr</em>` : ''}</div>
        <small>${esc(x.why)}</small>
        <span class="adv-tag">${effort[x.effort] || ''}</span>
      </div>`).join('') : `${stale ? '' : `<div class="me-empty">${fresh ? 'Nothing more to suggest this quarter: you are doing what saves most.' : 'Three things worth doing this quarter, worked out from your plan, your prices and how your home uses power.'}</div>`}`}
    <button class="me-add" ${_adviceBusy ? 'disabled' : ''} onclick="getAdvice()">${_adviceBusy ? 'Working it out…' : `${ic('spark', 16)} ${fresh ? 'Ask again' : "Get this quarter's suggestions"}`}</button>
    <div class="adv-fine">Written by AI (Anthropic's Claude) from the figures here, with no personal details sent. Check anything before acting on it.</div>
  </section>`;
}

/** The current system, filed as a saved entry so it can be brought back. */
function fileCurrentSystem(){
  if (!v7HasModelledSystem()) return null;
  const cfg = {};
  SYS_KEYS.forEach((k) => { cfg[k] = state[k]; });
  ['panel_w', 'battery_eff', 'battery_min', 'battery_discharge_kw', 'inverter_kw', 'cost_is_manual', 'grant_is_manual'].forEach((k) => { cfg[k] = state[k]; });
  const label = state.solar_planned || state.solar_is_estimate ? 'Your previous plan' : 'Your installed system';
  // One kept copy per kind is enough; a newer one replaces it.
  state.solar_quotes = (state.solar_quotes || []).filter((x) => !(x.source === 'previous' && x.installer === label));
  const rec = { id: 'p' + Date.now(), installer: label, price: state.install_cost || 0, kwp: +totalKwp().toFixed(2),
    battery: state.battery_kwh || 0, panels: totalPanels(), source: 'previous', cfg };
  state.solar_quotes.push(rec);
  return rec;
}

/** Make a saved quote (or a filed system) the modelled one. */
/**
 * The state a quote describes: the system it would put on this home. Used to
 * model the quote, and to compare quotes without modelling any of them.
 */
function quoteChanges(q){
  if (q.cfg){
    const c = {};
    SYS_KEYS.forEach((k) => { if (q.cfg[k] !== undefined) c[k] = q.cfg[k]; });
    ['panel_w', 'battery_eff', 'battery_min', 'battery_discharge_kw', 'inverter_kw', 'cost_is_manual', 'grant_is_manual'].forEach((k) => { if (q.cfg[k] !== undefined) c[k] = q.cfg[k]; });
    return c;
  }
  const w = q.watts > 0 ? q.watts : (state.panel_w || 440);
  // A quote is a system not yet bought.
  const c = { panel_w: w, has_solar: true, considering_solar: true, solar_is_estimate: false, solar_planned: true,
    count_A: q.panels > 0 ? q.panels : Math.max(1, Math.round((+q.kwp || 0) * 1000 / w)), count_B: 0,
    battery_kwh: +q.battery || 0, install_cost: Math.round(+q.price || 0), cost_is_manual: true };
  // A quote over two roof faces is modelled as two faces, each its own way.
  if (q.faces && q.faces.length === 2){
    Object.assign(c, { count_A: q.faces[0].panels, count_B: q.faces[1].panels, azimuth_A: q.faces[0].azimuth, azimuth_B: q.faces[1].azimuth,
      tilt_B: q.faces[1].tilt || q.faces[0].tilt || q.tilt || state.tilt_A });
    if (q.faces[0].tilt) c.tilt_A = q.faces[0].tilt;
  } else if (q.azimuth) c.azimuth_A = q.azimuth;
  if (q.tilt && !(q.faces && q.faces[0].tilt)) c.tilt_A = q.tilt;
  if (q.grant != null){ c.grant_seai = q.grant; c.grant_is_manual = true; }
  else { c.grant_is_manual = false; c.grant_seai = calcSeaiGrant(((c.count_A + c.count_B) * w) / 1000, c.battery_kwh).total; }
  return c;
}

/** What a system earns this home: payback, a year's return, and where 20 years leave it. Same sums as the Solar tab. */
function systemOutcome(){
  const d = v7SolarData();
  const ben = d.cur.solarBenefit, cost = d.sysCost, deg = state.panel_degradation || 0.005;
  let saved = 0; for (let y = 1; y <= 20; y++) saved += ben * Math.pow(1 - deg, y - 1);
  const batt = state.battery_kwh > 0 ? 400 * state.battery_kwh : 0;
  // Own power: the share of what the home uses that is not bought from the grid.
  let own = null;
  try { const b = getBestPlan(); const r = b.sim || sim(b.plan.id); const u = sumF(r.use || r.cons || []), i = sumF(r.imp || r.grid_import || []); if (u > 0) own = Math.max(0, Math.min(1, 1 - i / u)); } catch (e) { own = null; }
  return { payback: d.cur.payback, benefit: ben, cost, life: saved - cost - batt, own, plan: d.best && d.best.plan ? `${d.best.plan.supplier} ${d.best.plan.plan}` : '' };
}

/**
 * Every saved quote, run on this home. Each is a full year's simulation, so
 * the work happens after the screen paints and is kept until the home or the
 * quotes change.
 */
let _qoMemo = { k: null, v: null }, _qoPending = false;
function quoteOutcomes(){
  const k = modelKey();
  if (_qoMemo.k === k) return _qoMemo.v;
  if (!_qoPending){
    _qoPending = true;
    setTimeout(() => {
      const v = {};
      try {
        if (v7HasModelledSystem()) v.current = systemOutcome();
        for (const q of state.solar_quotes || []) v[q.id] = withSimState(quoteChanges(q), systemOutcome);
      } catch (e) { /* rows keep their placeholder */ }
      _qoMemo = { k: modelKey(), v }; _qoPending = false;
      if (state.current_screen === 'me') renderApp();
    }, 300);
  }
  return null;
}
/* ---- Systems: suggested, from quotes, and saved -------------------------
 * One list of every system this home could have, each run on the home: what
 * it costs, how soon it pays back, where 20 years leave it, and how much of
 * the home's power it makes. Tapping one makes it the modelled system, with
 * Undo. Saved systems keep only their specification; the figures are always
 * worked out fresh, so they never go stale as prices change. */
const SYS_EXTRA = ['panel_w', 'battery_eff', 'battery_min', 'battery_discharge_kw', 'inverter_kw', 'cost_is_manual', 'grant_is_manual'];
function currentSystemCfg(){
  const c = {};
  SYS_KEYS.concat(SYS_EXTRA).forEach((k) => { c[k] = state[k]; });
  return c;
}
function systemSpec(c){
  const a = +c.count_A || 0, b = +c.count_B || 0, bat = +c.battery_kwh || 0;
  const dir = (az) => sectorFromAzimuth(az);
  return `${a + b} panels${b > 0 ? ` (${a} ${dir(c.azimuth_A)} + ${b} ${dir(c.azimuth_B)})` : ` · ${dir(c.azimuth_A)}`} · ${bat > 0 ? `${bat} kWh battery` : 'no battery'}`;
}
/** Every system in the list, grouped; `ready` is false while the suggested sizes are still being worked out. */
function systemEntries(withSuggestions){
  const out = [];
  if (withSuggestions){
    for (const g of designGoals()) out.push({ key: 's:' + g.keys[0], group: 'suggested', name: g.labels.join(' · '), why: g.why,
      changes: { ...designToConfig(g.d), cost_is_manual: false, grant_is_manual: false } });
  }
  for (const q of state.solar_quotes || []){
    out.push({ key: 'q:' + q.id, group: q.source === 'previous' ? 'yours' : 'quotes', name: q.installer || 'Installer', quote: q, changes: quoteChanges(q),
      price: q.source === 'previous' ? null : q.price });
  }
  for (const y of state.saved_systems || []) out.push({ key: 'y:' + y.id, group: 'yours', name: y.name, changes: { ...y.cfg }, saved: y.id });
  out.forEach((e) => {
    const c = { ...state, ...e.changes };
    // No typed price: the typical price for this size, and the standard grant, as everywhere else.
    if (!c.cost_is_manual || !(+c.install_cost > 0)){
      const kwp = ((+c.count_A || 0) + (+c.count_B || 0)) * (c.panel_w || 440) / 1000;
      e.changes.install_cost = estimateInstallCost(kwp, +c.battery_kwh || 0); e.changes.cost_is_manual = false;
      if (!c.grant_is_manual) e.changes.grant_seai = calcSeaiGrant(kwp, +c.battery_kwh || 0).total;
    }
    e.spec = systemSpec(c);
  });
  return out;
}
/** Is this entry the system modelled now? */
function isInUse(e){
  const c = { ...state, ...e.changes };
  const k = ['count_A', 'count_B', 'battery_kwh'];
  if (k.some((x) => (+c[x] || 0) !== (+state[x] || 0))) return false;
  if ((+state.count_B || 0) > 0 && (c.azimuth_B !== state.azimuth_B)) return false;
  if (c.azimuth_A !== state.azimuth_A) return false;
  if (e.changes.cost_is_manual && Math.round(+e.changes.install_cost || 0) !== Math.round(+state.install_cost || 0)) return false;
  return true;
}
let _soMemo = { k: null, v: null }, _soPending = false;
function systemsOutcomes(){
  const k = modelKey() + '|' + goalSweepCk();
  if (_soMemo.k === k) return _soMemo.v;
  if (!_soPending){
    _soPending = true;
    setTimeout(() => {
      const v = {};
      try {
        if (v7HasModelledSystem()) v.current = systemOutcome();
        for (const e of systemEntries(true)) v[e.key] = withSimState(e.changes, systemOutcome);
      } catch (err) { console.warn('systems', err); }
      _soMemo = { k: modelKey() + '|' + goalSweepCk(), v }; _soPending = false;
      if (state._sheet && state._sheet.kind === 'system') renderApp();
    }, 250);
  }
  return null;
}

/**
 * Switch the home to a system, saying what is happening while it is worked
 * out: the switch re-simulates the year on every plan, which takes a moment,
 * and the reader should know Home and Analytics are about to change.
 */
function useSystem(key){
  const e = systemEntries(true).find((x) => x.key === key);
  if (!e) return;
  const steps = ['Building the system', 'Simulating your year on every plan', 'Updating Home and Analytics'];
  const ov = document.createElement('div');
  ov.className = 'sys-busy'; ov.setAttribute('role', 'status');
  ov.innerHTML = `<div class="sys-busy-card"><b>${esc(e.name)}</b>${steps.map((t, i) => `<div class="sys-busy-step" data-i="${i}"><i></i>${t}</div>`).join('')}</div>`;
  document.body.appendChild(ov);
  const mark = (i) => ov.querySelectorAll('.sys-busy-step').forEach((el) => { const n = +el.dataset.i; el.classList.toggle('done', n < i); el.classList.toggle('now', n === i); });
  mark(0);
  setTimeout(() => {
    mark(1);
    setTimeout(() => {
      rememberForUndo(`Now using ${e.name}`);
      Object.assign(state, e.changes);
      state.has_solar = true; state.considering_solar = true; state.solar_view = 'mine';
      if (e.group === 'suggested') state.solar_is_estimate = true;
      if (e.group === 'quotes'){ state.solar_is_estimate = false; state.solar_planned = true; }
      applyEstimatedSolarCost(); snapshotMySystem();
      invalidate(); saveState();
      mark(2);
      setTimeout(() => {
        mark(3); renderApp();
        setTimeout(() => { ov.remove(); showToast(`Now using ${esc(e.name)}. <button class="toast-undo" onclick="undoLast()">Undo</button>`, { type: 'accent', icon: ic('checkC', 16) }); }, 350);
      }, 40);
    }, 380);
  }, 380);
}
/** Keep the system as it is now, under a name. */
function saveSystemAs(){
  const el = document.getElementById('sys-name');
  const name = String((el && el.value) || '').trim().slice(0, 40) || `My system ${(state.saved_systems || []).length + 1}`;
  (state.saved_systems = state.saved_systems || []).push({ id: 's' + Date.now(), name, cfg: currentSystemCfg(), at: new Date().toISOString() });
  state._sys_saving = false;
  saveState(); renderApp();
  showToast(`Saved as ${esc(name)}`, { type: 'accent', icon: ic('checkC', 16) });
}
function removeSavedSystem(id){
  state.saved_systems = (state.saved_systems || []).filter((x) => x.id !== id);
  saveState(); renderApp();
}

function renderSystemsList(){
  const out = systemsOutcomes();
  const ready = CACHE._goalSweep_ck === goalSweepCk() && CACHE._goalSweep;
  const entries = systemEntries(!!ready);
  const k = (n) => (Math.abs(n) >= 10000 ? `€${(n / 1000).toFixed(1)}k` : eur(n));
  const metrics = (o) => o ? `<span class="sys-m"><b>${eur(o.cost)}</b><small>after grant</small></span>
      <span class="sys-m"><b>${o.payback < 50 ? `${o.payback.toFixed(1)} yrs` : 'never'}</b><small>payback</small></span>
      <span class="sys-m"><b class="${o.life >= 0 ? 'is-gain' : 'is-loss'}">${o.life >= 0 ? '+' : '−'}${k(Math.abs(o.life))}</b><small>after 20 yrs</small></span>
      <span class="sys-m"><b>${o.own != null ? Math.round(o.own * 100) + '%' : '—'}</b><small>own power</small></span>`
    : `<span class="sys-wait">Working it out…</span>`;
  const row = (e) => {
    const use = isInUse(e), ek = escAttr(e.key), sid = e.saved ? escAttr(e.saved) : '', qid = e.quote ? escAttr(e.quote.id) : '';
    return `<div class="sys-row ${use ? 'in-use' : ''} sys-g-${e.group}">
      <button class="sys-main" ${use ? 'aria-current="true"' : `onclick="useSystem('${ek}')"`}>
        <span class="sys-l"><b>${esc(e.name)}${use ? ' <i class="sys-tag">In use</i>' : ''}</b><small>${esc(e.spec)}${e.price ? ` · ${eur(e.price)}` : ''}</small>${e.why ? `<small class="sys-why">${esc(e.why)}</small>` : ''}</span>
        <span class="sys-r">${metrics(out && out[e.key])}</span>
      </button>
      ${e.saved ? `<button class="sys-x" aria-label="Remove ${escAttr(e.name)}" onclick="removeSavedSystem('${sid}')">${ic('x', 12)}</button>` : ''}
      ${e.quote ? `<button class="sys-x" aria-label="Remove ${escAttr(e.name)}" onclick="removeQuote('${qid}')">${ic('x', 12)}</button>` : ''}
    </div>`;
  };
  const group = (g, title, hint) => {
    const list = entries.filter((e) => e.group === g);
    if (!list.length && g !== 'suggested') return '';
    return `<div class="sys-group sys-g-${g}"><div class="sys-gh"><i></i>${title}</div>
      ${g === 'suggested' && !ready ? `<div class="sys-wait">Finding the best sizes for your roof…</div>` : list.map(row).join('') || `<div class="sys-wait">${hint}</div>`}</div>`;
  };
  if (!ready) scheduleGoalSweep();
  const anyUse = entries.some(isInUse);
  return `<section class="sys-list" aria-label="Systems">
    <div class="sys-head"><b>${ic('spark', 14)} Systems for your home</b><small>Tap one to use it. Figures are for this home, on the best plan for each.</small></div>
    ${!anyUse && v7HasModelledSystem() ? `<div class="sys-row in-use sys-g-current"><div class="sys-main"><span class="sys-l"><b>Your system now <i class="sys-tag">In use</i></b><small>${esc(systemSpec(state))}</small></span><span class="sys-r">${metrics(out && out.current)}</span></div></div>` : ''}
    ${group('suggested', 'Suggested by Peakless', '')}
    ${group('quotes', 'From your quotes', '')}
    ${group('yours', 'Saved by you', '')}
    ${state._sys_saving
      ? `<div class="sys-save"><input id="sys-name" type="text" maxlength="40" placeholder="Name it, e.g. Two roofs, small battery" aria-label="Name for this system"><button class="sy-stop" onclick="saveSystemAs()">Save</button><button class="v7-link" onclick="state._sys_saving=false;renderApp()">Cancel</button></div>`
      : `<button class="sy-add" onclick="state._sys_saving=true;renderApp();setTimeout(()=>document.getElementById('sys-name')?.focus(),40)">${ic('plus', 14)} Save this system under a name</button>`}
  </section>`;
}

/** Make a saved quote the modelled system, with Undo. */
function useQuote(id){
  const q = (state.solar_quotes || []).find((x) => x.id === id);
  if (!q) return;
  rememberForUndo(`Now modelling ${q.installer || 'the quote'}`);
  quoteToSystem(id);
}

function quoteToSystem(id){
  const q = (state.solar_quotes || []).find((x) => x.id === id);
  if (!q) return;
  const kept = fileCurrentSystem();
  if (q.cfg){
    applySystemConfig(q.cfg);
    ['panel_w', 'battery_eff', 'battery_min', 'battery_discharge_kw', 'inverter_kw', 'cost_is_manual', 'grant_is_manual'].forEach((k) => { if (q.cfg[k] !== undefined) state[k] = q.cfg[k]; });
    state.solar_quotes = state.solar_quotes.filter((x) => x.id !== q.id);
  } else {
    Object.assign(state, quoteChanges(q));
    const fine = state.fine = state.fine || {};
    if (q.watts > 0) fine.panels = true;
    if (q.tilt && q.azimuth) fine.roof = true;
  }
  applyEstimatedSolarCost();
  state.solar_view = 'mine';
  snapshotMySystem();
  invalidate(); saveState();
  showToast(`Now modelling ${esc(q.installer || 'the quote')}${kept ? `. ${esc(kept.installer)} is kept in My quotes` : ''}`, { type: 'accent', icon: ic('checkC', 16) });
  setScreen('solar');
}

async function loadMyLeads(){
  if (!_sb || !_sbUser) return;
  try {
    const { data, error } = await _sb.rpc('my_quote_requests');
    _myLeads = error ? [] : (data || []);
  } catch (e){ _myLeads = []; }
  if (state.current_screen === 'me') renderApp();
}

function meOpenAuth(view){
  _authModalOpen = true;
  window._authEmailOpen = view === 'signup' || view === 'login';
  _authEmailView = view === 'signup' ? 'signup' : 'login';
  renderApp();
}

/**
 * The household as a picture: the house, its roof, battery, car, hot water
 * and the grid, with the year's energy moving between them.
 *
 * Every figure is the simulated year for this home on the plan it is on, so
 * the picture is the model, not decoration. Each part opens the place it is
 * changed: the roof and battery open My system, the house My home, the car
 * the EV sheet, the grid the plans.
 */
function householdScene(){
  if (CACHE.dirty) rebuildBase();
  const sys = !!state.has_solar && totalPanels() > 0;
  const batt = sys && (state.battery_kwh || 0) > 0;
  const ev = !!state.ev_active;
  const hp = state.heating_type === 'heatpump';
  let gen = 0, use = 0, imp = 0, exp = 0, cyc = 0;
  try {
    const s = sim(state.baseline);
    gen = sys ? sumF(CACHE.solar.total) : 0;
    use = sumF(CACHE.cons);
    imp = sumF(s.grid_import);
    exp = sumF(s.grid_export);
    cyc = batt && s.battery_discharge ? sumF(s.battery_discharge) : 0;
  } catch (e) {}
  const evKwh = ev ? (state.ev_km_per_year || 0) * (state.ev_kwh_per_100km || 17) / 100 : 0;
  const k = (v) => `${Math.round(v).toLocaleString('en-IE')} kWh`;
  const hw = { smart: 'Hot water heated 2–5am', legacy: 'Hot water on an immersion timer', none: hp ? 'Hot water from the heat pump' : 'Hot water from the boiler' }[state.hot_water_strategy] || 'Hot water';
  const planned = sys && (state.solar_planned || state.solar_is_estimate);
  const tap = (go, label, x, y, w, h) => `<rect class="hs-hit" x="${x}" y="${y}" width="${w}" height="${h}" rx="12" onclick="${go}" role="button" tabindex="0" aria-label="${label}"><title>${label}</title></rect>`;

  const panels = sys ? Array.from({ length: 4 }, (_, i) => {
    const x0 = 196 + i * 16, y0 = 70 + i * 10.7;
    return `<polygon class="hs-panel" points="${x0},${y0} ${x0 + 14},${y0 + 9.4} ${x0 + 14},${y0 + 21} ${x0},${y0 + 11.6}"/>`;
  }).join('') : '';

  return `<section class="hs" aria-label="Your household and its energy over a year">
    <div class="hs-top">
      <span>${planned ? 'Your home with the planned system' : 'Your home'} · a typical year</span>
      <span class="hs-badge">${planned ? 'planned' : sys ? 'installed' : 'no solar'}</span>
    </div>
    <svg class="hs-svg" viewBox="0 0 360 300" role="img" aria-hidden="true">
      ${sys ? `<g class="hs-sun"><circle cx="318" cy="38" r="13"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = a * Math.PI / 180; return `<line x1="${318 + Math.cos(r) * 18}" y1="${38 + Math.sin(r) * 18}" x2="${318 + Math.cos(r) * 24}" y2="${38 + Math.sin(r) * 24}"/>`; }).join('')}</g>
        <path class="hs-flow hs-flow-sun" d="M300 52 L262 84"/>` : ''}

      <!-- grid -->
      <g class="hs-pylon"><path d="M44 120 L32 215 M44 120 L56 215 M28 140 H60 M24 165 H64 M36 190 L52 165 M52 190 L36 165 M40 140 L48 120"/></g>
      ${imp > 0 ? `<path class="hs-flow hs-flow-in" d="M62 176 C80 176 96 176 122 176"/>` : ''}
      ${exp > 0 ? `<path class="hs-flow hs-flow-out" d="M122 190 C96 190 80 190 62 190"/>` : ''}

      <!-- house -->
      <polygon class="hs-roof" points="104,124 190,58 276,124"/>
      ${panels}
      <rect class="hs-wall" x="120" y="122" width="140" height="110" rx="4"/>
      <rect class="hs-door" x="176" y="190" width="28" height="42" rx="3"/>
      <rect class="hs-win" x="134" y="140" width="26" height="22" rx="3"/>
      <g class="hs-tank"><rect x="226" y="140" width="20" height="40" rx="8"/><path d="M231 158 h10 M231 166 h10"/></g>

      ${batt ? `<g class="hs-batt"><rect x="292" y="140" width="34" height="56" rx="6"/><rect x="304" y="135" width="10" height="6" rx="2"/>
        <rect class="hs-batt-fill" x="297" y="168" width="24" height="23" rx="3"/></g>
        <path class="hs-flow hs-flow-batt" d="M262 168 H290"/>` : ''}
      ${hp ? `<g class="hs-hp"><rect x="82" y="214" width="32" height="24" rx="4"/><circle cx="98" cy="226" r="7"/></g>` : ''}
      ${ev ? `<g class="hs-car"><path d="M276 266 l8-16 h38 l10 16 v12 h-56 z"/><circle cx="290" cy="278" r="6"/><circle cx="320" cy="278" r="6"/></g>
        <path class="hs-flow hs-flow-ev" d="M246 232 C254 254 266 262 276 266"/>` : ''}

      <text class="hs-val" x="44" y="236" text-anchor="middle">Grid</text>
      <text class="hs-sub" x="44" y="252" text-anchor="middle">↓ ${k(imp)}</text>
      ${exp > 0 ? `<text class="hs-sub" x="44" y="268" text-anchor="middle">↑ ${k(exp)}</text>` : ''}
      <text class="hs-val" x="190" y="262" text-anchor="middle">Home uses ${k(use)}</text>
      <text class="hs-sub" x="190" y="280" text-anchor="middle">${esc(hw)}</text>
      ${sys ? `<text class="hs-val" x="190" y="30" text-anchor="middle">Solar makes ${k(gen)}</text>
        <text class="hs-sub" x="190" y="46" text-anchor="middle">${totalPanels()} panels · ${totalKwp().toFixed(1)} kWp</text>` : ''}
      ${batt ? `<text class="hs-sub" x="309" y="214" text-anchor="middle">${state.battery_kwh} kWh</text>
        <text class="hs-sub" x="309" y="229" text-anchor="middle">gives ${Math.round(cyc).toLocaleString("en-IE")} kWh</text>` : ''}
      ${ev ? `<text class="hs-sub" x="304" y="296" text-anchor="middle">EV ${k(evKwh)}</text>` : ''}

      ${tap('openMySystem()', 'My system: panels and battery', 100, 56, 180, 70)}
      ${tap('openMyHome()', 'My home', 118, 124, 144, 110)}
      ${tap("setScreen('plans')", 'Your plan and the grid', 14, 112, 64, 166)}
      ${batt ? tap('openMySystem()', 'Battery', 286, 130, 46, 104) : ''}
      ${ev ? tap('startEvGuide()', 'Your EV', 266, 244, 76, 54) : ''}
    </svg>
    <div class="hs-actions">
      ${sys ? '' : `<button class="me-mini" onclick="openMySystem()">${ic('sun', 14)} Add solar</button>`}
      ${batt || !sys ? '' : `<button class="me-mini" onclick="openMySystem()">${ic('battery', 14)} Add a battery</button>`}
      ${ev ? '' : `<button class="me-mini" onclick="startEvGuide()">${ic('car', 14)} Add an EV</button>`}
      <span class="hs-hint">Tap any part to change it</span>
    </div>
  </section>`;
}

function renderMe(){
  if (state.onboarding_complete && unseenAlerts().length) setTimeout(markAlertsSeen, 1500);
  const signedIn = !!_sbUser;
  if (signedIn && _myLeads === null){ _myLeads = []; loadMyLeads(); }
  const name = (_sbProfile && _sbProfile.display_name) || (signedIn ? (_sbUser.email || '').split('@')[0] : '');
  const region = IRISH_REGIONS[state.region || 'east'];
  const kwh = Math.round(v7AnnualKwh());
  const hasSys = state.considering_solar && totalPanels() > 0;
  const quotes = state.solar_quotes || [];
  const card = (onclick, icon, title, sub, cta) => `<button class="me-card" onclick="${onclick}">
      <span class="me-card-ico">${icon}</span><b>${title}</b><small>${sub}</small><span class="me-card-cta">${cta} ${ic('chevR', 14)}</span></button>`;

  const head = signedIn
    ? `<section class="me-head">
        <div class="me-avatar" aria-hidden="true">${esc((name || '?').slice(0, 1).toUpperCase())}</div>
        <div class="me-who"><b>${esc(name)}</b><small>${esc(_sbUser.email || '')}</small>
          <small class="me-sync" id="me-sync">${ic('checkC', 12)} ${esc(syncLine())}</small></div>
      </section>`
    : `<section class="me-head me-guest">
        <div class="me-guest-top">${wordmarkHtml('pk-word-top')}<span class="me-badge">Guest</span></div>
        <p class="me-p">Everything here is saved on this phone only. An account keeps it safe and opens the same home on any device. It is free, and nothing changes in how plans are ranked.</p>
        ${sbInitialized() ? `<div class="me-auth">
          <button class="v7-cta-2" onclick="meOpenAuth('signup')">Create a free account</button>
          <button class="me-ghost" onclick="meOpenAuth('login')">I have an account</button>
        </div>` : ''}
      </section>`;

  const requests = signedIn
    ? (_myLeads && _myLeads.length ? _myLeads.map((l) => `<div class="me-row">
          <span><b>${esc(l.spec?.panels ? `${l.spec.panels} panels` : 'Solar')}${l.spec?.battery_kwh ? ` · ${l.spec.battery_kwh} kWh` : ''} · ${esc(l.county)}</b>
          <small>${new Date(l.updated_at || l.created_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })} · ${l.installers
            ? `sent to ${l.installers} installer${l.installers > 1 ? 's' : ''}${l.responded ? ` · ${l.responded} responded` : ''}`
            : 'no partner installer in this county yet'}</small></span></div>`).join('')
        : `<div class="me-empty">No quote requests yet.</div>`)
    : (state._lead_form?.sent_at
        ? `<div class="me-row"><span><b>Request sent ${new Date(state._lead_form.sent_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })}</b><small>Sign in to follow it from any device</small></span></div>`
        : `<div class="me-empty">No quote requests yet.</div>`);

  return `${topbar('My ' + BRAND.name, 'sage', true)}
  <div class="screen me">
    ${head}
    ${_handover ? `<button class="me-warn" onclick="v7Sheet('handover')">${ic('warn', 16)} This phone and your account have different homes. Choose which to keep. Nothing is saved to your account until you do.</button>` : ''}

    ${state.onboarding_complete ? `<div class="section-title">Alerts${unseenAlerts().length ? ` <span class="al-count">${unseenAlerts().length} new</span>` : ''}</div>
    ${renderAlertsBlock()}
    <button class="me-row me-link me-pricewatch" onclick="setScreen('monitor')"><span><b>Price watch</b><small>Every Irish plan, watched daily: price rises, better plans, your contract end</small></span>${ic('chevR', 16)}</button>
    <div class="section-title">Savings</div>
    ${renderTallyBlock()}
    <div class="section-title">Your ${BRAND.name} score</div>
    ${renderScoreBlock()}
    <div class="section-title">This quarter</div>
    ${renderAdviceBlock()}` : ''}

    <div class="section-title">My household</div>
    ${state.onboarding_complete ? householdScene() : ''}
    <div class="me-cards">
      ${card('openMyHome()', ic('home', 18), 'My home', `${esc(region ? region.name : '')} · ${kwh.toLocaleString('en-IE')} kWh a year`, 'Edit')}
      ${card('openMySystem()', ic('sun', 18), 'My system', hasSys ? `${totalPanels()} panels · ${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ` · ${state.battery_kwh} kWh` : ''}` : 'No solar yet', hasSys ? 'Edit' : 'Model one')}
      ${card('startEvGuide()', ic('car', 18), 'My EV', state.ev_active ? `${(state.ev_km_per_year || 0).toLocaleString('en-IE')} km a year` : 'No EV', state.ev_active ? 'Edit' : 'Add one')}
    </div>

    <div class="section-title">Systems and quotes</div>
    <section class="me-list">
      <button class="me-row me-link" onclick="openMySystem()"><span><b>Compare systems</b><small>${(() => {
        const nq = quotes.filter((q) => q.source !== 'previous').length, ny = (state.saved_systems || []).length;
        return [nq ? `${nq} quote${nq > 1 ? 's' : ''}` : '', ny ? `${ny} saved` : '', 'Peakless suggestions'].filter(Boolean).join(' · ') + ', each run on your home';
      })()}</small></span>${ic('chevR', 16)}</button>
      <button class="me-add" onclick="v7Sheet('quote')">${ic('clip', 16)} Upload an installer's quote</button>
    </section>


    <div class="section-title">Settings and more</div>
    <section class="me-list">
      <button class="me-row me-link" onclick="reRunOnboarding()"><span><b>Re-run setup</b><small>Go through the setup questions again, starting from your answers</small></span>${ic('chevR', 16)}</button>
      <button class="me-row me-link" onclick="startFresh()"><span><b>Start fresh</b><small>For testing: signs out and clears this phone, back to the first screen</small></span>${ic('chevR', 16)}</button>
      <button class="me-row me-link" onclick="setScreen('more')"><span><b>Settings, help and more</b><small>Advanced settings, appearance, privacy, how to switch, methodology</small></span>${ic('chevR', 16)}</button>
    </section>

    ${signedIn ? `<div class="section-title">Account</div>
    <section class="me-list">
      <button class="me-row me-link" onclick="setScreen('privacy')"><span><b>Privacy and your data</b><small>What we keep, download or delete it</small></span>${ic('chevR', 16)}</button>
      <button class="me-row me-link" onclick="doSignOut()"><span><b>Sign out</b><small>Your setup stays on this phone and in your account</small></span>${ic('chevR', 16)}</button>
    </section>` : ''}

    <!-- Last on the page: when signed in it arrives a moment after the rest,
         and anything below it would move just as it was being tapped. -->
    <div class="section-title">Quote requests</div>
    <section class="me-list">${requests}</section>
  </div>
  ${bottomNav()}`;
}

function renderMore(){
  const nQuotes = (state.solar_quotes || []).length;
  // Up front: the analytics (the app's edge) and the two everyday actions.
  // Everything else is one tap away under "Settings and more".
  const groups = [
    ['Your data', [
      [ic('radar',19),'Price watch','Price changes, announced rises and alerts','monitor'],
      [ic('csv',19),'Import smart-meter data','Your ESB file: the most accurate result','csv-import'],
    ]],
    ['Do it', [
      [ic('clip',19),"Upload an installer's quote",'We read it, check it and model it', null, "v7Sheet('quote')"],
      [ic('swap',19),'How to switch supplier','About ten minutes, nothing to cancel','how-to-switch'],
    ]],
  ];
  const folded = [
    [ic('tune',19),'Advanced','Battery strategy, tariff options, usage shape','refine'],
    [ic('sun',19),'Start page','Quick answer, full setup, quote check','welcome'],
    [ic('scales',19),'Saved quotes', nQuotes ? nQuotes + ' saved, compared side by side' : 'Compare quotes side by side','quotes'],
    [ic('clip',19),'Type a quote in by hand','Check it against 2026 Irish prices','auditor'],
    [ic('flask',19),'How the figures are worked out','Data sources and the method','methodology'],
    [ic('shield',19),'Our independence','How we make money, in plain English','independence'],
    [ic('shield',19),'Privacy and your data','What we keep, who sees it, delete your account','privacy'],
    [ic('home',19),'Installer portal','For installers: leads sent to your company','installer'],
  ];
  const th = state.theme === 'dark' ? 'dark' : 'light';
  return `${topbar('More', 'sage', true)}
  <div class="screen">
    <button class="me-entry" onclick="setScreen('me')">
      <span class="me-avatar" aria-hidden="true">${_sbUser ? esc(((_sbProfile && _sbProfile.display_name) || _sbUser.email || '?').slice(0, 1).toUpperCase()) : ic('home', 18)}</span>
      <span class="me-who"><b>My ${BRAND.name}</b><small>${(() => { const n = unseenAlerts().length; return n ? `${n} new alert${n > 1 ? 's' : ''} · ` : ''; })()}${_sbUser ? 'Your home, savings, alerts and quotes' : 'Your home, savings and quotes · saved on this phone'}</small></span>
      ${unseenAlerts().length ? `<i class="me-entry-badge" aria-hidden="true">${unseenAlerts().length}</i>` : ''}
      ${ic('chevR', 16)}
    </button>
    ${groups.map(([title, items]) => `
      <div class="section-title" style="margin-top:14px">${title}</div>
      ${items.map((([icon,t,sub,scr,go]) => `<div class="secondary-card" onclick="${go || `setScreen('${scr}')`}">
        <div class="secondary-card-icon">${icon}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">${t}</div>
          <div class="secondary-card-sub">${sub}</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>`)).join('')}
    `).join('')}
    <details class="more-fold">
      <summary>Settings and more</summary>
    <div class="secondary-card" style="cursor:default">
      <div class="secondary-card-icon">${ic(th === 'dark' ? 'moon' : 'sun', 19)}</div>
      <div class="secondary-card-body">
        <div class="secondary-card-title">Appearance</div>
        <div class="secondary-card-sub">${th === 'dark' ? 'Dark' : 'Light'} theme</div>
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="setTheme('light')" style="padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid ${th==='light'?'var(--accent)':'var(--hair)'};background:${th==='light'?'var(--accent-soft)':'transparent'};color:${th==='light'?'var(--accent)':'var(--ink-soft)'}">Light</button>
        <button onclick="setTheme('dark')" style="padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid ${th==='dark'?'var(--accent)':'var(--hair)'};background:${th==='dark'?'var(--accent-soft)':'transparent'};color:${th==='dark'?'var(--accent)':'var(--ink-soft)'}">Dark</button>
      </div>
    </div>
      ${folded.map((([icon,t,sub,scr,go]) => `<div class="secondary-card" onclick="${go || `setScreen('${scr}')`}">
        <div class="secondary-card-icon">${icon}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">${t}</div>
          <div class="secondary-card-sub">${sub}</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>`)).join('')}
    </details>
    <div style="font-size:13px;color:var(--ink-dim);text-align:center;margin-top:18px;line-height:1.7">
      ${BRAND.name} · Independent · Ireland<br>${_sbUser ? 'Your setup is saved on this phone and in your account.' : 'Your data stays on this device.'}
      <!-- Which build you are actually running. A fix can be deployed and
           verified and still not be what is on someone's phone: the installed
           app caches the page, and an offline or flaky load falls back to that
           cached copy, which points at the previous bundle. Without this there
           is no way to tell "the bug is back" from "you are on last week's
           code", and I spent a session unable to distinguish them. -->
      <span style="display:block;margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--ink-dim)"
            onclick="hardRefreshApp()" title="Tap to force the latest version">v${__APP_VERSION__} · build ${__BUILD_ID__}</span>
    </div>
    ${STRATEGY_TRACE.length ? `
      <details style="margin-top:10px">
        <summary style="font-size:13px;color:var(--ink-dim);cursor:pointer;padding:8px 0">
          Battery strategy — what changed it (${STRATEGY_TRACE.length})
        </summary>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:1.7;padding:8px 10px;background:var(--well);border-radius:var(--radius-md);overflow-x:auto">
          ${STRATEGY_TRACE.slice(-12).reverse().map(e =>
            `${e.t} · ${e.screen} · ${e.change}<br><span style="color:var(--ink-dim)">&nbsp;&nbsp;${e.where}</span>`
          ).join('<br>')}
        </div>
      </details>` : ''}
  </div>
  ${bottomNav()}`;
}

/* ── FAST-PATH ACTIVATION (the new welcome) ───────────────── */
function renderFastPath(){
  const bill = state.bimonthly_bill_eur || 250;
  const kwhMode = state.usage_input_mode === 'kwh';
  const kwh = state.annual_kwh || (state.bills && Object.keys(state.bills).length ? Object.values(state.bills).reduce((a,b)=>a+b,0) : Math.round(bill * 6 / AVG_MARKET_RATE));
  const region = IRISH_REGIONS[state.region || 'east'];
  const heatLabel = { gas:'Gas / oil', heatpump:'Heat pump', storage:'Storage', direct:'Direct electric' }[state.heating_type || 'gas'];
  return `<div class="fp-wrap">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:max(8px, env(safe-area-inset-top))">
      <button onclick="goLanding()" style="display:flex;align-items:center;gap:5px;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--line);background:var(--panel);color:var(--ink-soft);cursor:pointer">${ic('chevL',14)} Back</button>
      ${state.onboarding_complete ? `<button onclick="setScreen('result')" style="padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--line);background:var(--panel);color:var(--ink-soft);cursor:pointer">✕ Close</button>` : ''}
    </div>
    <div class="fp-eyebrow" style="margin-top:18px">Quick answer</div>
    <div class="fp-title">${state._csv_imported ? `Your usage is<br><em>already measured</em>` : state._fp_csv_mode ? `Import your<br><em>smart meter</em> data` : kwhMode ? `Your yearly<br><em>electricity</em> use?` : `What's your<br><em>electricity</em> bill?`}</div>
    <div class="fp-sub">One number. We'll work out the rest.</div>

    ${state._csv_imported ? `<div style="margin-bottom:14px">${csvLockCard()}</div>` : `<div class="fp-billbox">
      ${!kwhMode && !state._fp_csv_mode ? '' : `<div style="display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well);margin-bottom:12px">
        <button onclick="fpSetUsageMode('bill')" style="padding:7px 13px;font-size:12px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${!kwhMode && !state._fp_csv_mode?'var(--accent)':'transparent'};color:${!kwhMode && !state._fp_csv_mode?'#fff':'var(--ink-soft)'}">€ Bill</button>
        <button onclick="fpSetUsageMode('kwh')" style="padding:7px 13px;font-size:12px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${kwhMode && !state._fp_csv_mode?'var(--accent)':'transparent'};color:${kwhMode && !state._fp_csv_mode?'#fff':'var(--ink-soft)'}">kWh / year</button>
        <button onclick="fpSetUsageMode('csv')" style="padding:7px 13px;font-size:12px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${state._fp_csv_mode?'var(--accent)':'transparent'};color:${state._fp_csv_mode?'#fff':'var(--ink-soft)'}">Smart CSV</button>
      </div>`}
      ${state._fp_csv_mode ? `
      <div style="text-align:left">
        <div style="font-size:12px;color:var(--ink-soft);line-height:1.7">Most accurate — real 30-min readings. From <b>myaccount.esbnetworks.ie</b> → My Meter → <b>Download HDF Data</b>. Less than a year still works — we scale it to a full-year profile.</div>
        <label class="btn-secondary" style="display:block;text-align:center;cursor:pointer;margin-top:10px;padding:12px 16px;border:1px dashed var(--blue);color:var(--blue);border-radius:8px">
          Choose CSV file
          <input id="csv-file-input" type="file" accept=".csv,.CSV" style="display:none" onchange="handleCsvFile(event)">
        </label>
        <div id="csv-parse-result" style="margin-top:10px"></div>
      </div>` : kwhMode ? `
      <div class="fp-billrow">
        <input class="fp-billinput" id="fp-bill" inputmode="numeric" value="${kwh}" oninput="fpSync(this.value)" style="text-align:right"/>
        <span class="fp-cur" style="font-size:15px;align-self:center">kWh</span>
      </div>
      <div class="fp-billhint">total per year · from your annual statement or smart meter</div>
      <input class="fp-billslider" type="range" min="1500" max="15000" step="100" value="${Math.min(15000, Math.max(1500, kwh))}" oninput="document.getElementById('fp-bill').value=this.value"/>` : `
      <div class="fp-billrow">
        <span class="fp-cur">€</span>
        <input class="fp-billinput" id="fp-bill" inputmode="numeric" value="${bill}" oninput="fpSync(this.value)"/>
      </div>
      <div class="fp-billhint">electricity bill only · per two months · not gas</div>
      <input class="fp-billslider" type="range" min="60" max="700" step="10" value="${bill}" oninput="document.getElementById('fp-bill').value=this.value"/>
      <button class="fp-exact" onclick="fpSetUsageMode('kwh')">I know my yearly kWh, or have my ESB meter file</button>`}
    </div>`}

    <div class="fp-assume-label">We've assumed (tap to change)</div>
    <div class="fp-assume-grid">
      <div class="fp-assume" style="grid-column:span 2" onclick="fpTogglePlanPicker()">
        <span class="fp-assume-ic">${ic('bolt',16)}</span>
        <div style="flex:1;min-width:0"><div class="fp-assume-k">Current plan</div>
        <div class="fp-assume-v" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${state.baseline_known ? (getPlanById(state.baseline).supplier + ' — ' + getPlanById(state.baseline).plan) : "Not sure — we'll estimate"}</div></div>
        <span style="color:var(--ink-dim);font-family:var(--mono);font-size:12px">${state._fp_plan_open ? '▴' : '▾'}</span>
      </div>
      ${state._fp_plan_open ? `
      <div class="ob-plan-picker" style="grid-column:span 2;max-height:280px">
        <div class="ob-plan-notsure ${!state.baseline_known ? 'active' : ''}" onclick="fpPickPlan(null)">
          <span>Not sure — estimate for me</span>
        </div>
        ${TARIFFS.filter(t => !t.discontinued).map(p => `
          <div class="ob-plan-option ${state.baseline === p.id && state.baseline_known ? 'active' : ''}" onclick="fpPickPlan('${p.id}')">
            <div class="ob-plan-option-supplier">${p.supplier}</div>
            <div class="ob-plan-option-name">${p.plan}</div>
            <div class="ob-plan-option-rate">${fmtCent(p.rates.day)}/kWh day · Standing ${fmtCurrency(p.standing)}/yr</div>
          </div>`).join('')}
      </div>` : ''}
      ${state.baseline_known ? `
      <div class="fp-assume" style="grid-column:span 2" onclick="fpCycle('discount')">
        <span class="fp-assume-ic">${ic('spark',16)}</span>
        <div style="flex:1;min-width:0"><div class="fp-assume-k">Your discount on this plan</div>
        <div class="fp-assume-v">${(+state.baseline_discount_pct || 0) > 0 ? state.baseline_discount_pct + '% off unit rates' : 'None — sticker rates'}</div></div>
        <span style="color:var(--ink-dim);font-family:var(--mono);font-size:12px">tap</span>
      </div>` : ''}
      <div class="fp-assume" onclick="fpCycle('heating')"><span class="fp-assume-ic">${ic('flame',16)}</span><div><div class="fp-assume-k">Heating</div><div class="fp-assume-v">${heatLabel}</div></div></div>
      <div class="fp-assume" onclick="fpCycle('ev')"><span class="fp-assume-ic">${ic('car',16)}</span><div><div class="fp-assume-k">EV</div><div class="fp-assume-v">${state.ev_active ? Math.round((state.ev_km_per_year||15000)/1000)+'k km · ' + (state.ev_in_bill ? 'have it' : 'planning') : 'None'}</div></div></div>
    </div>

    <button class="fp-cta" onclick="fastPathGo()">See my savings →</button>
    <div class="fp-foot">No account needed · free</div>
  </div>`;
}
function fpSync(v){ /* keep slider loosely in sync; no-op guard */ }
function _fpCaptureBill(){
  if (state._csv_imported) return;
  const el = document.getElementById('fp-bill');
  if (!el) return;
  const v = parseFloat(el.value);
  if (!Number.isFinite(v) || v <= 0) return;
  if (state.usage_input_mode === 'kwh') state.annual_kwh = Math.round(v);
  else state.bimonthly_bill_eur = Math.round(v);
}
// Locked-usage notice shown wherever manual usage entry would normally be,
// while a smart-meter CSV is active. One source of truth — remove the CSV
// to unlock manual € / kWh entry.
function csvLockCard(compact){
  const kwh = state.bills && Object.keys(state.bills).length ? Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)) : 0;
  const cov = state._csv_days ? ` · ${state._csv_days} days of data${state._csv_periods && state._csv_periods < 6 ? `, ${6 - state._csv_periods} period${6 - state._csv_periods === 1 ? '' : 's'} extrapolated` : ''}` : '';
  return `<div style="padding:${compact ? '12px 14px' : '14px 16px'};background:var(--blue-soft);border:1.5px solid var(--blue);border-radius:12px">
    <div style="display:flex;align-items:center;gap:8px"><span>${ic('csv',16)}</span><div style="font-size:12px;font-weight:700;color:var(--ink)">Usage locked to your smart-meter CSV</div></div>
    <div style="font-size:12px;color:var(--ink-soft);margin-top:5px;line-height:1.55"><b style="color:var(--ink)">${kwh.toLocaleString()} kWh/yr</b> from ${state._csv_filename || 'your imported file'}${cov}. Manual € / kWh entry is disabled so it can't silently fight the real data.</div>
    <button onclick="clearCsvImport()" style="margin-top:9px;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--blue);background:transparent;color:var(--blue);cursor:pointer">Remove CSV & enter manually</button>
  </div>`;
}

function setUsageMode(mode){
  if (mode === state.usage_input_mode) return;
  state.usage_input_mode = mode;
  if (mode === 'kwh' && !(+state.annual_kwh > 0)){
    const fromBills = state.bills && Object.keys(state.bills).length ? Object.values(state.bills).reduce((a,b)=>a+b,0) : 0;
    state.annual_kwh = fromBills || Math.round((state.bimonthly_bill_eur || 250) * 6 / AVG_MARKET_RATE);
  }
  if (!state._csv_imported) applyUsageInput();
  invalidate();
  saveState();
  renderApp();
}
function fpSetUsageMode(mode){
  _fpCaptureBill();
  if (mode === 'csv'){
    state._fp_csv_mode = true;
    renderApp();
    return;
  }
  state._fp_csv_mode = false;
  if (mode === state.usage_input_mode){ renderApp(); return; }
  state.usage_input_mode = mode;
  if (mode === 'kwh' && !(+state.annual_kwh > 0)){
    // Seed from what we already know so the number isn't a cold start
    const fromBills = state.bills && Object.keys(state.bills).length ? Object.values(state.bills).reduce((a,b)=>a+b,0) : 0;
    state.annual_kwh = fromBills || Math.round((state.bimonthly_bill_eur || 250) * 6 / AVG_MARKET_RATE);
  }
  saveState();
  renderApp();
}
function fpTogglePlanPicker(){
  _fpCaptureBill();
  state._fp_plan_open = !state._fp_plan_open;
  renderApp();
  if (state._fp_plan_open){
    const el = document.querySelector('.ob-plan-option.active') || document.querySelector('.ob-plan-notsure.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block:'center' });
  }
}
function fpPickPlan(planId){
  _fpCaptureBill();
  if (planId === null){
    state.baseline = 'EI-24';
    state.baseline_known = false;
    state.baseline_discount_pct = 0;   // a discount only makes sense on a known plan
  } else {
    state.baseline = planId;
    state.baseline_known = true;
  }
  if (!state.heating_type) state.heating_type = 'gas';
  applyUsageInput();
  state._fp_plan_open = false;
  invalidate();
  saveState();
  renderApp();
}
function fpCycle(which){
  // Capture whatever the user has typed (€ or kWh, mode-aware) before re-rendering
  _fpCaptureBill();
  if (which === 'heating'){
    const order = ['gas','heatpump','storage','direct'];
    const i = order.indexOf(state.heating_type || 'gas');
    state.heating_type = order[(i + 1) % order.length];
    // Keep hot-water default in sync with heating type — same rule as onboarding,
    // so the optimisation advisor behaves identically on both entry paths
    state.hot_water_strategy = DEFAULT_HW_FOR_HEATING[state.heating_type] || 'none';
  } else if (which === 'solar'){
    state.has_solar = !state.has_solar;
    if (state.has_solar){
      if (!state.count_A || state.count_A <= 0) state.count_A = 10;
      state.considering_solar = true;
      state.solar_is_estimate = true;
      applyEstimatedSolarCost();
      showToast('Assumed ' + totalPanels() + ' panels · ' + (totalPanels()*state.panel_w/1000).toFixed(1) + ' kWp — refine anytime', { type:'accent', icon:ic('sun',16) });
    }
  } else if (which === 'ev'){
    // Three explicit states: None → Have one (charging already in the bill,
    // carved out of the base load) → Planning one (added on top of the bill)
    const mode = !state.ev_active ? 'none' : (state.ev_in_bill ? 'have' : 'plan');
    const next = mode === 'none' ? 'have' : mode === 'have' ? 'plan' : 'none';
    state.ev_active = next !== 'none';
    state.ev_in_bill = next === 'have';
    if (state.ev_active){
      if (!state.ev_km_per_year) state.ev_km_per_year = 15000;
      if (!state.ev_kwh_per_100km) state.ev_kwh_per_100km = 17;
      showToast(next === 'have'
        ? 'Your bill already covers its charging — we model it inside your usage'
        : "We'll add its charging on top of what your bill shows",
        { type:'amber', icon:ic('car',16), title: next === 'have' ? 'You have an EV' : 'Planning an EV' });
    }
  } else if (which === 'region'){
    const keys = Object.keys(IRISH_REGIONS);
    const i = keys.indexOf(state.region || 'east');
    state.region = keys[(i + 1) % keys.length];
    applyRegion(state.region);
  } else if (which === 'discount'){
    // Sign-up discount or equivalent older/legacy rates — % off unit rates
    const steps = [0, 5, 10, 15, 20, 25, 30, 40];
    const i = steps.indexOf(+state.baseline_discount_pct || 0);
    state.baseline_discount_pct = steps[(i + 1) % steps.length];
    applyUsageInput();   // re-calibrate: same € bill at cheaper rates = more kWh
    invalidate();
    if (state.baseline_discount_pct > 0){
      showToast(state.baseline_discount_pct + '% off unit rates on your current plan — on older cheaper rates? Pick the % that matches your bill', { type:'accent', icon:ic('spark',16), title:'Plan discount' });
    }
  }
  saveState();
  renderApp();
}
function fastPathGo(){
  if (state._fp_csv_mode && !state._csv_imported){
    showToast('Upload your HDF CSV first — or switch to € Bill / kWh above', { type:'amber', icon:ic('csv',16), title:'No file imported yet' });
    return;
  }
  if (!state._csv_imported){
    const el = document.getElementById('fp-bill');
    const kwhMode = state.usage_input_mode === 'kwh';
    let bill = el ? parseFloat(el.value) : (kwhMode ? (state.annual_kwh || 4200) : (state.bimonthly_bill_eur || 250));
    if (!Number.isFinite(bill) || bill <= 0) bill = kwhMode ? 4200 : 250;
    if (kwhMode && bill < 500) bill = 4200;   // guard against a stray € figure typed in kWh mode
    if (kwhMode) state.annual_kwh = Math.round(bill);
    else state.bimonthly_bill_eur = Math.round(bill);
  }
  if (!state.heating_type) state.heating_type = 'gas';
  if (!state.region) state.region = 'east';
  state.has_solar = state.has_solar || false;
  state.considering_solar = state.has_solar;
  if (!state.baseline){ state.baseline = 'EI-24'; state.baseline_known = false; }
  applyUsageInput();
  state.onboarding_complete = true;
  state.current_screen = 'result';
  applyRegion(state.region);
  invalidate();
  saveState();
  fireEvent('fastpath_complete', { bill: state.bimonthly_bill_eur, region: state.region });
  renderApp();
  // No toast: the answer is on screen, and 'Based on … Change' says how to adjust it.
}

function bottomNav(){
  return V7.nav();
}

/* ============================================================
   V7 — the presentation layer (src/ui/v7.js)
   ------------------------------------------------------------
   The view module computes no money. Everything it shows comes through this
   object, so a V7 screen and the engine tests can never disagree about a
   figure. Functions are hoisted, so the object can be built here even though
   most of what it points at is declared further down.
   ============================================================ */
function v7AnnualKwh(){ return Object.values(state.bills || {}).reduce((a, b) => a + b, 0); }
function v7SetupLabel(){
  return state.has_solar
    ? `${totalKwp().toFixed(1)} kWp ${state.solar_planned ? 'planned solar' : 'solar'}${state.battery_kwh > 0 ? ' + ' + state.battery_kwh + ' kWh battery' : ''}`
    : 'no solar yet';
}
/** The plans ranking, filtered and sorted exactly as the list has always been. */
function v7PlansData(){
  if (CACHE.dirty) rebuildBase();
  if (!state._plans_filter) state._plans_filter = 'all';
  const ranked = TARIFFS.filter(p => !p.discontinued).map(plan => {
    const s = sim(plan.id);
    const c = annualCost(s, plan);
    const onHold = plan.type === 'dynamic' && !state.include_dynamic;
    return { plan, cost: c.net, energy: c.energy_cost, standing: c.standing, exportRev: c.export_revenue, cat: planCategory(plan), onHold };
  }).sort((a, b) => (a.onHold - b.onHold) || (a.cost - b.cost));
  const f = state._plans_filter;
  const filtered = f === 'all' ? ranked : ranked.filter(r => r.cat === f);
  const counts = { all: ranked.length, flat: 0, tou: 0, ev: 0, dynamic: 0 };
  ranked.forEach(r => { if (counts[r.cat] !== undefined) counts[r.cat]++; });
  const sortBy = state._plans_sort || 'cost';
  if (sortBy === 'standing') filtered.sort((a, b) => (a.onHold - b.onHold) || (a.standing - b.standing));
  else if (sortBy === 'export') filtered.sort((a, b) => (a.onHold - b.onHold) || ((b.plan.export_rate || 0) - (a.plan.export_rate || 0)));
  const baselinePlan = getPlanById(state.baseline);
  const baseCost = sumF(baselineSim(state.baseline).cost) + baselinePlan.standing + PSO_LEVY;
  // The shortlist, then the rest on request — unchanged from the list it replaces.
  const SHORTLIST = 6;
  const showingAll = !!state._plans_all || f !== 'all' || sortBy !== 'cost';
  const visible = showingAll ? filtered : filtered.slice(0, SHORTLIST);
  return { ranked, filtered, visible, hidden: filtered.length - visible.length, counts, baseCost, sortBy, f,
    cmpSel: Array.isArray(state._cmp_plans) ? state._cmp_plans : [] };
}
function v7SolarData(){
  if (CACHE.dirty) rebuildBase();
  const best = getBestPlan();
  const baselinePlan = getPlanById(state.baseline);
  const baseCost = sumF(baselineSim(state.baseline).cost) + baselinePlan.standing + PSO_LEVY;
  const sysCost = state.install_cost - state.grant_seai;
  const view = 'realistic';
  if (!state.has_solar || totalPanels() === 0){
    return { scen: null, cur: { payback: 999, solarBenefit: 0 }, sysCost, npv: 0, range: null, view, best, baseCost };
  }
  const scen = computeSolarPaybackScenarios();
  const cur = state.ev_active ? scen.withEv : scen.withoutEv;
  let range = null;
  if (view !== 'realistic'){ try { range = computeScenarioRange(); } catch (e) { range = null; } }
  const npv = calcNPV20(cur.solarBenefit, sysCost, state.battery_kwh || 0, state.panel_degradation);
  return { scen, cur, sysCost, npv, range, view, best, baseCost };
}
/**
 * The year, month by month, from the simulation the app already ran.
 *
 * Calendar months, not twelve equal 730-hour slices: a card labelled March
 * has to cover March. For each month it carries the totals and an average day
 * — every hour-of-day averaged over that month's days — so the day drawn for
 * July is July's, not the year's.
 */
function v7MonthDetail(best){
  const s = best.sim;
  const out = [];
  let i = 0;
  for (let m = 0; m < 12; m++){
    const days = DAYS_IN_MONTH[m];
    const acc = { gen: 0, cons: 0, imp: 0, exp: 0, cost: 0, revenue: 0, days };
    const hours = Array.from({ length: 24 }, (_, h) => ({ cons: 0, gen: 0, imp: 0, band: (s.band && s.band[h]) || 'day' }));
    for (let d = 0; d < days && i < HOURS_IN_YEAR; d++){
      for (let h = 0; h < 24; h++, i++){
        const g = s.gen ? s.gen[i] : 0, c = s.cons ? s.cons[i] : 0;
        const im = s.grid_import ? s.grid_import[i] : 0, ex = s.grid_export ? s.grid_export[i] : 0;
        acc.gen += g; acc.cons += c; acc.imp += im; acc.exp += ex;
        acc.cost += s.cost ? s.cost[i] : 0;
        acc.revenue += s.revenue ? s.revenue[i] : 0;
        hours[h].cons += c; hours[h].gen += g; hours[h].imp += im;
      }
    }
    hours.forEach(x => { x.cons /= days; x.gen /= days; x.imp /= days; });
    acc.hours = hours;
    out.push(acc);
  }
  return out;
}
function v7MonthlyTotals(best){
  const d = v7MonthDetail(best);
  return { gen: d.map(m => m.gen), cons: d.map(m => m.cons) };
}
function v7ResultEmpty(){
  return `${topbar('No plans available')}
    <div class="screen v7"><section class="v7-hero">
      <div class="v7-headline">No plans to compare right now.</div>
      <button class="switch-cta v7-cta" onclick="location.reload()">Reload</button>
    </section></div>`;
}

const V7 = createV7({
  brand: BRAND.name, wordmark: wordmarkHtml,
  state: () => state,
  ic, IRISH_REGIONS, renderProfileNavBtn,
  annualKwh: v7AnnualKwh, setupLabel: v7SetupLabel,
  plansData: v7PlansData, solarData: v7SolarData, monthlyTotals: v7MonthlyTotals, monthDetail: v7MonthDetail,
  getBestPlan,
  renderResultEmpty: v7ResultEmpty,
  hasModelledSystem: v7HasModelledSystem,
  // What a plan costs this home as simulated — solar, battery and EV included.
  analyticsData: () => analyticsData(), analyticsDay, solarRange, anPlan: () => anPlan(), solarDataFor,
  accuracyWithMeter: () => accuracyWithMeter(),
  quoteFaces: (x) => quoteFaces(x),
  renderSolarWorking: () => renderSolarWorking(),
  isFlatPlan,
  tariffCounts: () => { const live = TARIFFS.filter((p) => !p.discontinued); const dyn = live.filter((p) => p.type === 'dynamic').length; return { live: live.length, dynamicLeftOut: state.include_dynamic ? 0 : dyn }; },
  plannedLadder: () => plannedLadder(),
  householdScore: () => householdScore(),
  sameHomeCost: (id) => { const p = getPlanById(id); return annualCost(sim(p.id), p).net; },
  getRecommendation, computeSolarPaybackScenarios, computeEnergyScore,
  getPlanById, sim, annualCost, bandAt, totalKwp, totalPanels, quoteRead, isPartnerPlan, renderConsentBar,
  fmtCurrency, fmtCent, fmtVerifiedDate, latestVerifiedLabel, planDataFlag, planCategoryLabel,
  freshnessChip, priceChangeChip, renderContractAlert, renderChoiceStrip, renderStalenessBanner,
  renderSavingsBreakdown, renderAssumptions,
  renderTrustPanel, renderLogicBreakdown, renderNightRateCard, renderEvSavingsCard, evEconomics,
  renderDayInspector,
  renderSystemSheet, renderHomeSheet, renderAccuracy, modelAccuracy, renderHandoverSheet, renderJourneySheet, renderQuestSheet, renderMeterSheet, renderHabitsSheet,
  alertCount: () => { try { return unseenAlerts().length; } catch (e) { return 0; } },
});

/**
 * Take solar in or out of every figure, in one tap.
 *
 * The system itself — panels, orientation, battery, price — is left exactly
 * as it was, because buildSolar() already gates generation on has_solar
 * alone. So "off" is a what-if, not a deletion: turning it back on restores
 * the same system, not an estimate.
 */
/** True once a system has actually been modelled — not the default placeholder. */
function v7HasModelledSystem(){ return !!state.considering_solar && totalPanels() > 0; }

function toggleSolarModel(){
  // Nothing of theirs to bring back: rather than invent a system, open the
  // short solar guide, which says what it will do and changes nothing unless kept.
  if (!state.has_solar && !v7HasModelledSystem()) return startSolarGuide();
  const on = !state.has_solar;
  state.has_solar = on;
  // The battery is part of the solar system: leaving solar out leaves it out
  // too (it kept charging on night rates and inflated the switching saving),
  // and bringing solar back brings it back.
  if (!on){ state._kept_battery = +state.battery_kwh || 0; state.battery_kwh = 0; }
  else if (state._kept_battery != null){ state.battery_kwh = state._kept_battery; delete state._kept_battery; }
  if (on && !v7HasModelledSystem()){
    // Nothing of theirs to restore. The panel count sitting in state is the
    // default placeholder, not a system anyone chose — so size one from usage,
    // exactly as "Model a system for this roof" does, and say it is estimated.
    const annualKwh = Object.values(state.bills).reduce((a, b) => a + b, 0);
    state.count_A = Math.max(6, Math.min(16, Math.round(annualKwh / 450))); state.count_B = 0;
    state.battery_kwh = annualKwh > 6000 ? 10 : annualKwh > 3500 ? 5 : 0;
    state.solar_is_estimate = true;
    applyEstimatedSolarCost();
    snapshotMySystem();
  }
  if (on) state.considering_solar = true;
  invalidate();
  saveState();
  renderApp();
  // No toast: the bars and the solar line change in front of you.
}

/* ---- Reading an installer's quote ---------------------------------------
 * The file goes to /api/extract-quote (a Vercel function holding the API
 * key), which returns what it read and the words it read it from. Nothing is
 * applied until the person presses "Model my home with this quote". Kept out
 * of `state` so a quote in progress is never written to storage. */
let _quoteRead = { status: 'idle' };
function quoteRead(){ return _quoteRead; }

/** A photo of a page is shrunk before upload: 2000px is plenty to read and
 *  keeps phone photos under the upload limit. */
async function _quoteImage(file){
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { media_type: 'image/jpeg', blob };
}
function _b64(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function v7QuoteFile(input){
  const file = input && input.files && input.files[0];
  if (!file) return;
  _quoteRead = { status: 'reading', name: file.name };
  renderApp();
  try {
    let media_type = file.type, blob = file;
    if (file.type.startsWith('image/')) ({ media_type, blob } = await _quoteImage(file));
    else if (file.type !== 'application/pdf') throw new Error('Send a PDF, or a photo of each page.');
    if (blob.size > 3_200_000) throw new Error('That file is too large. Under 3 MB, please — a photo of each page works too.');
    const res = await fetch('/api/extract-quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type, data: await _b64(blob) }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.quote) throw new Error(out.error || 'The quote could not be read.');
    _quoteRead = { status: 'review', quote: out.quote };
  } catch (e){
    _quoteRead = { status: 'error', error: (e && e.message) || 'The quote could not be read.' };
  }
  renderApp();
}

/** A direction in words ("south west", "SW", "s/e", "225°") as an azimuth; null when it is not one. */
function azFromWords(w){
  const t = String(w || '').toLowerCase().replace(/[^a-z0-9°]+/g, ' ').trim();
  const deg = t.match(/(\d{1,3})\s*°?/);
  if (deg && !/[a-z]/.test(t.replace(/\d|°|deg(rees)?/g, '').trim())) { const d = +deg[1]; return d >= 0 && d < 360 ? d : null; }
  const k = t.replace(/\s+/g, '').replace(/^s(?=[ew]$)/, 'south').replace(/^n(?=[ew]$)/, 'north').replace(/(south|north)e$/, '$1east').replace(/(south|north)w$/, '$1west');
  return { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315,
    n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[k] ?? null;
}
/**
 * The roof faces a read quote describes: as the quote splits them, or, when it
 * names two directions without saying how many panels go on each, an even
 * split marked as assumed so the person is asked to check it.
 */
function quoteFaces(x){
  const total = +x.panel_count || 0;
  const stated = (x.roof_faces || []).map((f) => ({ panels: +f.panels || null, azimuth: azFromWords(f.orientation), name: f.orientation || '', tilt: f.tilt_deg > 0 && f.tilt_deg < 70 ? Math.round(f.tilt_deg) : null }))
    .filter((f) => f.azimuth != null);
  let faces = stated.slice(0, 2), assumed = false;
  if (faces.length < 2){
    const parts = String(x.orientation || '').split(/\s*(?:\/|,|&|\+|\band\b)\s*/i).map((w) => ({ name: w.trim(), azimuth: azFromWords(w) })).filter((f) => f.azimuth != null);
    if (parts.length >= 2) faces = parts.slice(0, 2).map((f) => ({ ...f, panels: null, tilt: null }));
  }
  if (faces.length < 2) return null;
  if (faces.some((f) => !(f.panels > 0))){
    assumed = true;
    faces[0].panels = Math.ceil(total / 2); faces[1].panels = Math.floor(total / 2);
  }
  return { faces, assumed };
}

function v7QuoteReset(){ _quoteRead = { status: 'idle' }; renderApp(); }

/** Model the home with the confirmed quote: this becomes "your system". */
/**
 * A quote is kept, and only becomes the modelled system when the person says
 * so. Uploading one used to replace the household's system outright: an
 * installed system, or a plan someone had spent time on, was gone the moment
 * a quote was read. Now "save" keeps the system as it is, and "model" first
 * files the current system in Saved quotes so one tap brings it back.
 */
function v7ApplyQuote(mode){
  const v = (id) => { const el = document.getElementById(id); return el && el.value !== '' ? +el.value : null; };
  const panels = v('qf-panels'), watts = v('qf-watts'), batt = v('qf-batt'), price = v('qf-price'), grant = v('qf-grant');
  if (!(panels > 0) || !(price > 0)){
    showToast('Panels and price are needed to keep the quote.', { type: 'warn', icon: ic('warn', 16) });
    return;
  }
  const q = _quoteRead.quote || {};
  const w = watts > 0 ? Math.round(watts) : (state.panel_w || 440);
  const az = azFromWords(q.orientation);
  // Two roof faces, as confirmed in the form.
  const qf = quoteFaces(q);
  const fa = v('qf-fa'), fb = v('qf-fb');
  const faces = qf && fa > 0 && fb > 0 ? [{ panels: Math.round(fa), azimuth: qf.faces[0].azimuth, tilt: qf.faces[0].tilt }, { panels: Math.round(fb), azimuth: qf.faces[1].azimuth, tilt: qf.faces[1].tilt }] : null;
  const rec = { id: 'q' + Date.now(), installer: q.installer || 'Installer', price: Math.round(price),
    kwp: +((faces ? faces[0].panels + faces[1].panels : Math.round(panels)) * w / 1000).toFixed(2), battery: batt > 0 ? batt : 0,
    panels: faces ? faces[0].panels + faces[1].panels : Math.round(panels), faces,
    watts: watts > 0 ? Math.round(watts) : null, grant: grant != null ? Math.round(grant) : null,
    tilt: q.roof_pitch_deg > 0 && q.roof_pitch_deg < 70 ? Math.round(q.roof_pitch_deg) : null, azimuth: az || null,
    date: q.quote_date || null, source: 'upload' };
  state.solar_quotes = state.solar_quotes || [];
  state.solar_quotes.push(rec);
  _quoteRead = { status: 'idle' };
  state._sheet = null;
  if (mode !== 'model'){
    saveState();
    renderApp();
    showToast(`${rec.installer} saved to My quotes. Your system is unchanged.`, { type: 'accent', icon: ic('checkC', 16) });
    return;
  }
  quoteToSystem(rec.id);
}

/* ---- Privacy and your data ---------------------------------------------
 * Plain statement of what is kept where, plus the controls: analytics on or
 * off, clear this device, delete the account. DRAFT wording — to be reviewed
 * by a solicitor before launch. */
function renderPrivacy(){
  const a = analyticsConsent();
  const C = CONTROLLER;
  const who = C.name ? `${esc(C.name)}${C.address ? `, ${esc(C.address)}` : ''}` : '<i>[company name and address to be added]</i>';
  const mail = C.email ? `<a href="mailto:${escAttr(C.email)}">${esc(C.email)}</a>` : '<i>[privacy email to be added]</i>';
  const row = (what, why, keep) => `<tr><td>${what}</td><td>${why}</td><td>${keep}</td></tr>`;
  return `${topbar('Privacy', 'accent', true)}
  <div class="screen">
    <div class="card"><div class="privacy-copy">
      <p><b>Short version.</b> Your home's figures stay on this phone unless you sign in. We share your details with installers only when you ask for quotes. No ads. We never sell personal data.</p>

      <h3>Who we are</h3>
      <p>${BRAND.name} is run by ${who}. We are the controller of your personal data. Contact: ${mail}.</p>

      <h3>What we hold, why, and for how long</h3>
      <table class="privacy-table">
        <thead><tr><th>What</th><th>Why (legal basis)</th><th>Kept</th></tr></thead>
        <tbody>
          ${row('Your home answers and results, on this phone', 'To give you the answer. Never sent to us unless you sign in', 'Until you clear them')}
          ${row('Account: email, name, home answers', 'To keep your home on every device (contract)', 'Until you delete the account')}
          ${row('Quote request: name, email, phone, county, system', 'To get you installer quotes (your consent)', '24 months')}
          ${row('Alert emails', 'You turned them on (consent)', 'Until you turn them off')}
          ${row('Installer quote you upload', 'To read it for you (contract). Not stored', 'Not kept')}
          ${row('Anonymous usage counts', 'To improve the app (consent)', '26 months')}
          ${row('Record of your consent choices', 'To show we asked (legal obligation)', '36 months')}
          ${row('Scrambled internet address', 'To stop abuse (legitimate interest)', '1 day')}
        </tbody>
      </table>

      <h3>Who receives it</h3>
      <ul>
        <li><b>Installers</b>: up to three SEAI-registered installers, only if you ask for quotes. They pay us for the introduction.</li>
        <li><b>Supabase</b>: our database, in Ireland.</li>
        <li><b>Vercel</b>: hosts the app.</li>
        <li><b>Anthropic</b> (USA): reads uploaded quotes and writes quarterly suggestions. Suggestions get no personal details.</li>
        <li><b>Resend</b> (USA): sends our emails.</li>
        <li><b>Google</b>: only if you sign in with Google.</li>
      </ul>
      <p>Transfers to the USA are covered by the EU–US Data Privacy Framework or the EU's standard contractual clauses. Switching supplier happens on the supplier's own site: we send them nothing. Some suppliers pay us a commission; it never changes the ranking.</p>

      <h3>Your rights</h3>
      <p>You can see, download, correct or delete your data, object to its use, and withdraw consent at any time, using the buttons below or by emailing us. We reply within one month. You can also complain to the Data Protection Commission at <a href="https://www.dataprotection.ie" target="_blank" rel="noopener">dataprotection.ie</a>.</p>
      <p>Plan rankings are calculations to help you choose. Nothing is decided for you.</p>
      <p class="privacy-date">Updated ${esc(C.updated)}.</p>
    </div></div>
    <div class="secondary-card" style="cursor:default">
      <div class="secondary-card-body"><div class="secondary-card-title">Anonymous usage counts</div>
        <div class="secondary-card-sub">${a === 'yes' ? 'Allowed' : a === 'no' ? 'Off' : 'Not answered'}</div></div>
      <button class="v7-imp-btn" onclick="setAnalyticsConsent(${a === 'yes' ? 'false' : 'true'})">${a === 'yes' ? 'Turn off' : 'Allow'}</button>
    </div>
    <div class="secondary-card" onclick="downloadMyData()">
      <div class="secondary-card-body"><div class="secondary-card-title">Download my data</div>
        <div class="secondary-card-sub">Everything held about you, as a file</div></div><div class="secondary-card-arrow">›</div>
    </div>
    <div class="secondary-card" onclick="clearThisDevice()">
      <div class="secondary-card-body"><div class="secondary-card-title">Clear everything on this phone</div>
        <div class="secondary-card-sub">Your setup, saved quotes and settings</div></div><div class="secondary-card-arrow">›</div>
    </div>
    ${_sbUser ? `<div class="secondary-card" onclick="deleteMyAccount()">
      <div class="secondary-card-body"><div class="secondary-card-title" style="color:var(--loss)">Delete my account</div>
        <div class="secondary-card-sub">${escAttr(_sbUser.email || '')}: the account, its saved data and your quote requests</div></div><div class="secondary-card-arrow">›</div>
    </div>` : ''}
  </div>
  ${bottomNav()}`;
}

/** Right of access and portability: what this phone and the account hold, as one JSON file. */
async function downloadMyData(){
  const out = { exported_at: new Date().toISOString(), app: BRAND.name, on_this_phone: cloudCopy(state) };
  if (_sb && _sbUser){
    out.account = { email: _sbUser.email || null, created_at: _sbUser.created_at || null, profile: _sbProfile || null };
    try { const { data } = await _sb.rpc('my_quote_requests'); out.quote_requests = data || []; } catch (e) { out.quote_requests = 'could not be loaded'; }
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${BRAND.name.toLowerCase()}-my-data.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** Back to the very first screen: signs out (so the account can't restore it) and clears this device. */
async function startFresh(){
  if (!confirm('Start fresh? This signs you out and clears everything on this phone. Your account keeps its saved copy.')) return;
  try { if (_sb && _sbUser) await _sb.auth.signOut(); } catch (e) {}
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  location.replace(location.pathname);
}
function clearThisDevice(){
  if (!confirm('Clear your setup, quotes and settings from this device?')) return;
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  location.reload();
}
async function deleteMyAccount(){
  if (!_sb || !_sbUser) return;
  if (!confirm('Delete your account and everything saved to it? This cannot be undone.')) return;
  try {
    const { data } = await _sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    const res = await fetch('/api/delete-account', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Could not delete the account.');
    await _sb.auth.signOut();
    showToast('Your account has been deleted.', { type: 'accent', icon: ic('checkC', 16) });
    setScreen('result');
  } catch (e) {
    showToast((e && e.message) || 'Could not delete the account.', { type: 'warn', icon: ic('warn', 16) });
  }
}

/* ---- Installer portal ---------------------------------------------------
 * For installers who buy leads. Signed in, they see the leads offered to their
 * company: the system and its modelled economics always, the homeowner's
 * contact details once they accept. Row-level security in the database
 * enforces both; this screen only displays what it is allowed to read. */
let _portal = { status: 'idle', rows: [], error: null };
async function loadInstallerLeads(){
  if (!_sb || !_sbUser) return;
  _portal = { ..._portal, status: 'loading' };
  const { data, error } = await _sb.rpc('installer_leads_v2');
  _portal = error ? { status: 'error', rows: [], error: error.message } : { status: 'ready', rows: data || [], error: null };
  renderApp();
}
async function setLeadStatus(id, status){
  const { error } = await _sb.rpc('set_assignment_status', { p_assignment: id, p_status: status });
  if (error) showToast(error.message, { type: 'warn', icon: ic('warn', 16) });
  loadInstallerLeads();
}
function renderInstallerPortal(){
  if (!sbInitialized()) return `${topbar('Installer portal', 'accent', true)}<div class="screen"><p class="disclaimer">Accounts are not available.</p></div>${bottomNav()}`;
  if (!_sbUser){
    return `${topbar('Installer portal', 'accent', true)}
    <div class="screen"><div class="card">
      <p style="margin:0 0 12px;line-height:1.6">Installers partnered with ${BRAND.name} see the quote requests sent to them here. Sign in with the email your company registered with us.</p>
      <button class="switch-cta v7-cta" onclick="_authModalOpen=true;renderApp()">Sign in</button>
    </div></div>${bottomNav()}`;
  }
  if (_portal.status === 'idle') setTimeout(loadInstallerLeads, 0);
  const rows = _portal.rows;
  const STAGES = [['accepted', 'Accept'], ['contacted', 'Contacted'], ['quoted', 'Quoted'], ['won', 'Won'], ['lost', 'Lost']];
  const tl = { asap: 'ASAP', '3m': 'within 3 months', '6m': 'within 6 months', '12m': 'within a year', browsing: 'exploring' };
  return `${topbar('Installer portal', 'accent', true)}
  <div class="screen">
    ${_portal.status === 'loading' ? '<p class="disclaimer">Loading your leads…</p>' : ''}
    ${_portal.status === 'error' ? `<p class="disclaimer">${escAttr(_portal.error)}</p>` : ''}
    ${_portal.status === 'ready' && !rows.length ? `<div class="card"><p style="margin:0;line-height:1.6">No leads yet for ${escAttr(_sbUser.email || 'this account')}. If your company has just joined, ask us to link this email to it.</p></div>` : ''}
    ${rows.map((r) => {
      const sp = r.spec || {};
      const open = !['sent', 'declined'].includes(r.status);
      return `<div class="card portal-lead">
        <div class="portal-head"><b>${escAttr(r.county)}${r.eircode_area ? ' · ' + escAttr(r.eircode_area) : ''}</b><span>${r.details_updated ? '<span class="portal-status is-sent">updated</span> ' : ''}<span class="portal-status is-${r.status}">${r.status}</span></span></div>
        <div class="portal-spec">${sp.panels || '?'} panels · ${sp.kwp || '?'} kWp${sp.battery_kwh ? ` · ${sp.battery_kwh} kWh battery` : ''}${sp.ev ? ' · EV' : ''} · ${tl[r.timeline] || r.timeline}<br>
          ${sp.payback_years ? `Modelled payback ${sp.payback_years} yr · ` : ''}${sp.annual_kwh ? `${sp.annual_kwh.toLocaleString('en-IE')} kWh/yr · ` : ''}quality ${r.quality_score}/100 · €${Number(r.price_eur).toFixed(0)}</div>
        ${open ? `<div class="portal-contact">${escAttr(r.name || '')}<br><a href="mailto:${escAttr(r.email)}">${escAttr(r.email)}</a>${r.phone ? ` · <a href="tel:${escAttr(r.phone)}">${escAttr(r.phone)}</a>` : ''}</div>` : ''}
        <div class="portal-actions">
          ${r.status === 'sent' ? `<button class="v7-imp-btn" onclick="setLeadStatus('${r.assignment_id}','accepted')">Accept — show contact</button>
            <button class="v7-link" onclick="setLeadStatus('${r.assignment_id}','declined')">Decline</button>`
          : STAGES.slice(1).map(([v, t]) => `<button class="v7-link ${r.status === v ? 'is-on' : ''}" onclick="setLeadStatus('${r.assignment_id}','${v}')">${t}</button>`).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>
  ${bottomNav()}`;
}

/** Open a sheet over the current surface, or close it with null. */
/* ============================================================
   MY HOME · MY SYSTEM
   ============================================================
   Two things describe a household. The home — where it is, how it is
   heated, how much it uses, which way the roof faces — is set once and
   rarely changes. The system — panels, battery, price, grant — is what
   people try different versions of. Each gets one sheet, with the few
   controls that matter up front and the detail behind "Fine-tune" in the
   part it belongs to, instead of one global Simple/Expert switch.
   ============================================================ */

/** Battery sizes actually sold in Ireland, offered as one-tap stops. */
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eur = (n) => '€' + Math.round(n || 0).toLocaleString('en-IE');
const BATTERY_SIZES = [5, 7, 9.5, 10, 13.5, 15, 20];
const SYS_MAX_PANELS = 40;
const SYS_MAX_BATTERY = 30;

/**
 * How far the yearly figures could be off, given what has been confirmed.
 *
 * Each unconfirmed input carries a typical error from the default it falls
 * back on; they are combined as independent errors (root of the sum of
 * squares) over a floor for the weather and the tariff model itself. The
 * tip is the single change that would tighten the estimate most.
 */
function modelAccuracy(){
  const fine = state.fine || {};
  const sys = !!state.has_solar && totalPanels() > 0;
  const parts = [
    { label: 'Weather and the model itself', err: 3 },
    state._csv_imported
      ? { label: 'Usage from your smart-meter data', err: 1 }
      : state.usage_input_mode === 'kwh'
        ? { label: 'Usage from your yearly kWh', err: 5, tip: 'Import your ESB smart-meter file', go: "v7Sheet('meter')" }
        : { label: 'Usage worked out from your bill', err: 9, tip: 'Enter your yearly kWh from a bill, or import meter data', go: "v7Sheet('home')" },
  ];
  if (sys){
    parts.push(fine.roof ? { label: 'Roof direction and tilt confirmed', err: 1 }
      : { label: 'Roof direction and tilt assumed', err: 4, tip: 'Confirm which way the roof faces', go: "v7Sheet('home')" });
    parts.push(fine.panels ? { label: 'Panel spec confirmed', err: 0.5 }
      : { label: 'Typical panel spec assumed', err: 2, tip: 'Add the panel rating from your quote', go: "sysFine('panels',true)" });
    if (state.battery_kwh > 0) parts.push(fine.battery ? { label: 'Battery spec confirmed', err: 0.5 }
      : { label: 'Typical battery spec assumed', err: 2, tip: 'Confirm the battery details', go: "sysFine('battery',true)" });
  }
  const pct = Math.max(2, Math.round(Math.sqrt(parts.reduce((a, p) => a + p.err * p.err, 0))));
  const open = parts.filter((p) => p.tip).sort((a, b) => b.err - a.err);
  return { pct, parts, tip: open[0] || null, priceTypical: sys && !state.cost_is_manual };
}

function renderAccuracy(){
  const a = modelAccuracy();
  const fill = Math.max(8, Math.min(100, Math.round(100 - (a.pct - 2) * 6)));
  return `<div class="sy-acc">
    <div class="sy-acc-top"><span>Estimate accuracy</span><b>±${a.pct}%</b></div>
    <div class="sy-acc-bar" aria-hidden="true"><i style="width:${fill}%"></i></div>
    ${a.tip ? `<button class="sy-acc-tip" onclick="${a.tip.go}">${ic('spark', 14)} ${esc(a.tip.tip)}</button>` : `<div class="sy-acc-note">${state._csv_imported ? 'Built on your real meter readings: only the weather is left to vary.' : 'As close as a model gets without a year of your own data.'}</div>`}
    ${a.priceTypical ? `<div class="sy-acc-note">Payback uses a typical price for this system. Your quote's price makes it exact.</div>` : ''}
  </div>`;
}

/** Commit one system value: clamp, keep the price and grant in step, re-run. */
function sysSet(key, v){
  v = +v;
  if (isNaN(v)) return;
  const lim = { count_A: [0, SYS_MAX_PANELS], count_B: [0, SYS_MAX_PANELS], battery_kwh: [0, SYS_MAX_BATTERY],
    panel_w: [200, 700], install_cost: [0, 60000], grant_seai: [0, 5000], inverter_kw: [1, 20],
    battery_eff: [0.7, 1], battery_min: [0, 0.5], battery_discharge_kw: [1, 15], battery_charge_kw: [1, 15],
    panel_degradation: [0, 0.015], tilt_A: [0, 90], tilt_B: [0, 90], azimuth_A: [0, 359], azimuth_B: [0, 359] }[key];
  if (lim) v = Math.min(lim[1], Math.max(lim[0], v));
  if (key === 'battery_kwh') v = Math.round(v * 2) / 2;
  if (state[key] === v) return;
  const battWas = +state.battery_kwh || 0;
  state[key] = v;
  const fine = state.fine = state.fine || {};
  if (['panel_w', 'panel_degradation'].includes(key)) fine.panels = true;
  if (['battery_eff', 'battery_min', 'battery_discharge_kw', 'battery_charge_kw', 'inverter_kw'].includes(key)) fine.battery = true;
  if (['tilt_A', 'tilt_B', 'azimuth_A', 'azimuth_B'].includes(key)) fine.roof = true;
  if (key === 'install_cost') state.cost_is_manual = true;
  if (key === 'grant_seai') state.grant_is_manual = true;
  if (['count_A', 'count_B', 'battery_kwh', 'panel_w'].includes(key)){
    state.solar_is_estimate = false;
    state.considering_solar = true;
    state.has_solar = totalPanels() > 0;
    if (key === 'battery_kwh'){
      // The discharge rate follows the battery: a 5 kWh unit does not put out 5 kW.
      if (!fine.battery) state.battery_discharge_kw = Math.max(2.5, Math.min(6, v * 0.5));
      if (battWas === 0 && v > 0) state.charge_from_grid = true;
    }
  }
  applyEstimatedSolarCost();
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate();
  saveState();
  renderApp();
}

/** While a slider is dragged, update its readout only — the model runs on release. */
function sysPreview(el, fmt){
  const out = document.getElementById(el.id + '-out');
  if (!out) return;
  const v = +el.value;
  if (fmt === 'panels'){
    const other = el.id === 'sy-cA' ? (+state.count_B || 0) : el.id === 'sy-cB' ? (+state.count_A || 0) : 0;
    const total = el.id === 'sy-total' ? v : v + other;
    out.textContent = `${v} panels · ${(total * state.panel_w / 1000).toFixed(1)} kWp`;
    if (el.id !== 'sy-total') out.textContent = `${v} panels`;
  } else if (fmt === 'kwh') out.textContent = v > 0 ? `${v} kWh` : 'No battery';
  else out.textContent = v;
}

function sysFine(part, open){
  state._fine_open = state._fine_open || {};
  state._fine_open[part] = open === undefined ? !state._fine_open[part] : !!open;
  if (state._sheet?.kind !== 'system') state._sheet = { kind: 'system', id: null };
  renderApp();
  if (open) setTimeout(() => document.getElementById('sy-fine-' + part)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
}

/** Planned or installed: decides whether the panels count as today's home
 *  (their savings are already being made) or as a decision still to take. */
function setSolarInstalled(installed){
  state.solar_planned = !installed;
  state.solar_is_estimate = false;
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState(); renderApp();
}

function sysSplit(on){
  if (on){
    const t = totalPanels();
    state.count_A = Math.ceil(t / 2); state.count_B = Math.floor(t / 2);
    // The other face mirrored across south (south-east gives south-west, east
    // gives west). Opposite the main face was north for a south roof.
    if (!state.azimuth_B || state.azimuth_B === state.azimuth_A || !state._sys_split){
      const a = state.azimuth_A || 180;
      state.azimuth_B = a === 180 ? 270 : (360 - a) % 360;
      if (!state.tilt_B) state.tilt_B = state.tilt_A || 30;
    }
  } else {
    state.count_A = totalPanels(); state.count_B = 0;
  }
  state._sys_split = !!on;
  applyEstimatedSolarCost();
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState(); renderApp();
}

function sysGrant(on){
  if (on){ state.grant_is_manual = false; }
  else { state.grant_is_manual = true; state.grant_seai = 0; }
  applyEstimatedSolarCost();
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState(); renderApp();
}

function sysTypicalPrice(){
  state.cost_is_manual = false;
  applyEstimatedSolarCost();
  if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  invalidate(); saveState(); renderApp();
}

// Sheets open over whatever screen is showing, so closing one goes back there.
// Only the bare pre-setup screens, which cannot host a sheet, hand over to Home.
const NO_SHEET_SCREENS = ['welcome', 'fastpath', 'onboarding', 'intro', 'flow', 'solar-guide', 'ev-guide'];
function openMyHome(){
  if (NO_SHEET_SCREENS.includes(state.current_screen)) state.current_screen = 'result';
  v7Sheet('home');
}

function openMySystem(){
  if (NO_SHEET_SCREENS.includes(state.current_screen)) state.current_screen = 'solar';
  if ((state.solar_view || 'mine') !== 'mine'){ state.solar_view = 'mine'; snapshotMySystem(); }
  if (!state.considering_solar || totalPanels() === 0){
    state.considering_solar = true; state.has_solar = true;
    if (totalPanels() === 0) state.count_A = 10;
    applyEstimatedSolarCost(); invalidate(); saveState();
  }
  v7Sheet('system');
}

const _syRange = (id, key, val, min, max, step, fmt, label) =>
  `<div class="sy-range">
    <div class="sy-range-top"><span>${label}</span><output id="${id}-out">${val}</output></div>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${state[key] ?? 0}"
      aria-label="${label}" oninput="sysPreview(this,'${fmt}')" onchange="sysSet('${key}',this.value)">
  </div>`;
const _syNum = (key, val, min, max, step, unit, label, help) =>
  `<label class="sy-field"><span><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span>
    <span class="sy-num"><input type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${val}"
      onchange="sysSet('${key}',this.value)">${unit ? `<i>${unit}</i>` : ''}</span></label>`;
const _syFine = (part, title, body) => {
  const open = !!(state._fine_open || {})[part];
  return `<div class="sy-fine ${open ? 'open' : ''}" id="sy-fine-${part}">
    <button class="sy-fine-btn" onclick="sysFine('${part}')" aria-expanded="${open}">${ic('tune', 14)} Fine-tune ${title}
      ${(state.fine || {})[part] ? '<span class="sy-ok">confirmed</span>' : '<span class="sy-def">typical values</span>'}${ic(open ? 'chevU' : 'chevD', 14)}</button>
    ${open ? `<div class="sy-fine-body">${body}</div>` : ''}
  </div>`;
};
const _dirOpts = (az) => [['S','South'],['SE','South-east'],['SW','South-west'],['E','East'],['W','West'],['NE','North-east'],['NW','North-west'],['N','North']]
  .map(([v, l]) => `<option value="${azimuthFromSector(v)}" ${sectorFromAzimuth(az) === v ? 'selected' : ''}>${l}</option>`).join('');

function renderSystemSheet(){
  const t = totalPanels();
  const split = state.count_B > 0 || state._sys_split;
  const batt = +state.battery_kwh || 0;
  const g = calcSeaiGrant(totalKwp(), batt).total;
  const grantOn = !(state.grant_is_manual && !(state.grant_seai > 0));
  const net = Math.max(0, (state.install_cost || 0) - (grantOn ? state.grant_seai : 0));
  return `<div class="v7-sheet-head">
      <div class="v7-eyebrow">My system</div>
      <h2 class="v7-h">${t} panels · ${totalKwp().toFixed(1)} kWp${batt > 0 ? ` · ${batt} kWh` : ''}</h2>
    </div>
    <div class="v7-seg sy-status" role="tablist" aria-label="Is this system installed?">
      <button class="v7-seg-btn ${state.solar_planned || state.solar_is_estimate ? 'active on' : ''}" onclick="setSolarInstalled(false)">I'm planning it</button>
      <button class="v7-seg-btn ${!state.solar_planned && !state.solar_is_estimate ? 'active on' : ''}" onclick="setSolarInstalled(true)">It's installed</button>
    </div>
    <p class="sy-status-why">${state.solar_planned || state.solar_is_estimate
      ? 'Planning: Home shows what switching saves now and what the panels would add once bought. Payback counts the price.'
      : 'Installed: the panels are part of your home. Home shows what switching saves on top of them, and your meter readings can check they’re working.'}</p>
    ${renderAccuracy()}
    ${state.has_solar && totalPanels() > 0 ? renderSystemsList() : ''}

    <section class="sy-part" aria-label="Panels">
      <div class="sy-part-title">${ic('sun', 16)} Roof and panels ${(state.fine || {}).roof ? '<span class="sy-ok">roof confirmed</span>' : '<span class="sy-def">roof assumed</span>'}</div>
      ${(() => {
        // Each roof face: which way, how steep, how many panels. The roof's
        // layout belongs to the system: one quote uses one face, another two.
        const face = (k, n) => `<div class="sy-face">
            <div class="sy-face-head"><b>${split ? (k === 'A' ? 'First face' : 'Second face') : 'Panels'}</b>
              ${k === 'B' ? `<button class="v7-link" onclick="sysSplit(false)">Remove</button>` : ''}</div>
            <div class="sy-pair">
              <label class="sy-field"><span><b>Facing</b></span><select onchange="homeSet('azimuth_${k}',this.value)">${_dirOpts(state['azimuth_' + k])}</select></label>
              <label class="sy-field"><span><b>Tilt</b></span><span class="sy-num"><input type="number" inputmode="numeric" min="0" max="90" step="1" value="${state['tilt_' + k]}" onchange="homeSet('tilt_${k}',this.value)"><i>°</i></span></label>
            </div>
            ${_syRange('sy-c' + k, 'count_' + k, `${n} panels`, k === 'A' ? 1 : 0, SYS_MAX_PANELS, 1, 'panels', 'How many')}
          </div>`;
        return `${face('A', state.count_A)}${split ? face('B', state.count_B) : `<button class="sy-add" onclick="sysSplit(true)">${ic('plus', 14)} Add a second roof face</button>`}
          <div class="sy-fine-note">${t} panels · ${totalKwp().toFixed(1)} kWp in all. Most Irish roofs are pitched 30–40°.</div>`;
      })()}
      ${_syFine('panels', 'panels', `
        ${_syNum('panel_w', state.panel_w, 200, 700, 5, 'W', 'Rating of one panel', 'On the quote or the panel datasheet. Most new panels: 420–480 W.')}
        ${_syNum('panel_degradation', +(state.panel_degradation * 100).toFixed(2), 0, 1.5, 0.1, '%/yr', 'Yearly output loss', 'Typical 0.4%. The datasheet warranty gives it.').replace(`sysSet('panel_degradation',this.value)`, `sysSet('panel_degradation',this.value/100)`)}`)}
    </section>

    <section class="sy-part" aria-label="Battery">
      <div class="sy-part-title">${ic('battery', 16)} Battery</div>
      ${_syRange('sy-batt', 'battery_kwh', batt > 0 ? `${batt} kWh` : 'No battery', 0, SYS_MAX_BATTERY, 0.5, 'kwh', 'Usable size')}
      <div class="sy-stops" role="group" aria-label="Common sizes">
        <button class="sy-stop ${batt === 0 ? 'on' : ''}" onclick="sysSet('battery_kwh',0)">None</button>
        ${BATTERY_SIZES.map((k) => `<button class="sy-stop ${batt === k ? 'on' : ''}" onclick="sysSet('battery_kwh',${k})">${k}</button>`).join('')}
        <label class="sy-stop sy-stop-exact">Exact <input type="number" inputmode="decimal" min="0" max="${SYS_MAX_BATTERY}" step="0.1" value="${batt}" aria-label="Exact battery size in kWh" onchange="sysSet('battery_kwh',this.value)"></label>
      </div>
      ${batt > 0 ? _syFine('battery', 'battery', `
        ${_syNum('battery_eff', Math.round(state.battery_eff * 100), 70, 100, 1, '%', 'Round-trip efficiency', 'Energy you get back for each unit stored. Lithium: 90–95%.').replace(`sysSet('battery_eff',this.value)`, `sysSet('battery_eff',this.value/100)`)}
        ${_syNum('battery_min', Math.round(state.battery_min * 100), 0, 50, 5, '%', 'Kept in reserve', 'The battery never runs below this. Usually 10%.').replace(`sysSet('battery_min',this.value)`, `sysSet('battery_min',this.value/100)`)}
        ${_syNum('battery_discharge_kw', state.battery_discharge_kw, 1, 15, 0.5, 'kW', 'Most it can supply at once', 'Continuous power on the datasheet.')}
        ${_syNum('inverter_kw', state.inverter_kw, 1, 20, 0.5, 'kW', 'Inverter size', 'Usually 3.6–6 kW for a home.')}`) : ''}
    </section>

    <section class="sy-part" aria-label="Price">
      <div class="sy-part-title">${ic('euro', 16)} Price</div>
      ${state.cost_is_manual
        ? `${_syNum('install_cost', state.install_cost, 0, 60000, 50, '€', 'Price including VAT', 'Before the grant, as on your quote.')}
           <button class="v7-link" onclick="sysTypicalPrice()">Use a typical price instead</button>`
        : `<div class="sy-field"><span><b>Typical price ${eur(state.install_cost)}</b><small>What a system this size costs in Ireland in 2026, including VAT.</small></span>
           <button class="sy-stop" onclick="state.cost_is_manual=true;renderApp();setTimeout(()=>document.querySelector('.sy-part[aria-label=Price] input')?.focus(),40)">I have a price</button></div>`}
      <label class="sy-toggle">
        <span><b>SEAI grant</b><small>${grantOn ? `${eur(state.grant_seai)} off the price` : 'Not claimed — e.g. the home already had one'}</small></span>
        <input type="checkbox" role="switch" ${grantOn ? 'checked' : ''} onchange="sysGrant(this.checked)">
      </label>
      ${grantOn && state.grant_is_manual && state.grant_seai !== g ? `<div class="sy-fine-note">Using ${eur(state.grant_seai)} from your quote. The standard grant for this size is ${eur(g)}.</div>` : ''}
      <div class="sy-net">You pay <b>${eur(net)}</b></div>
    </section>

    <button class="v7-cta-2" onclick="v7Sheet('quote')">${ic('clip', 16)} Fill this in from an installer's quote</button>
    <div class="v7-sheet-links"><a href="#" onclick="event.preventDefault();v7Sheet('home')">My home — where it is, how it's heated, your plan</a></div>`;
}

function homeSet(key, v){
  if (['bimonthly_bill_eur', 'annual_kwh', 'baseline_discount_pct', 'ev_km_per_year', 'ev_kwh_per_100km', 'ev_charger_kw'].includes(key)) v = +v;
  if (state[key] === v) return;
  state[key] = v;
  if (['tilt_A', 'tilt_B', 'azimuth_A', 'azimuth_B'].includes(key)){
    state[key] = +v; (state.fine = state.fine || {}).roof = true;
    if ((state.solar_view || 'mine') === 'mine') snapshotMySystem();
  }
  if (['heating_type', 'bimonthly_bill_eur', 'annual_kwh'].includes(key) && !state._csv_imported) applyUsageInput();
  invalidate(); saveState(); renderApp();
}

function renderHomeSheet(){
  const kwhMode = state.usage_input_mode === 'kwh';
  const sel = (key, opts, val) => `<select onchange="homeSet('${key}',this.value)">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const field = (label, help, control) => `<label class="sy-field"><span><b>${label}</b>${help ? `<small>${help}</small>` : ''}</span>${control}</label>`;
  return `<div class="v7-sheet-head">
      <div class="v7-eyebrow">My home</div>
      <h2 class="v7-h">Your home</h2>
    </div>
    ${renderAccuracy()}

    <section class="sy-part" aria-label="Where and how">
      <div class="sy-part-title">${ic('home', 16)} The house</div>
      ${field('Area', '', sel('region', Object.entries(IRISH_REGIONS).map(([k, r]) => [k, r.name]), state.region || 'east'))}
      ${field('Heating', '', sel('heating_type', [['gas', 'Gas or oil boiler'], ['heatpump', 'Heat pump'], ['storage', 'Storage heaters'], ['direct', 'Direct electric']], state.heating_type))}
    </section>

    <section class="sy-part" aria-label="Electricity use">
      <div class="sy-part-title">${ic('bolt', 16)} Electricity use</div>
      ${state._csv_imported
        ? `<div class="sy-field"><span><b>From your smart meter</b><small>${Math.round(v7AnnualKwh()).toLocaleString('en-IE')} kWh a year, half-hour by half-hour</small></span>
           <button class="sy-stop" onclick="v7Sheet(null);setScreen('csv-import')">Replace</button></div>`
        : `<div class="v7-seg" role="tablist" aria-label="Usage from">
             <button class="v7-seg-btn ${!kwhMode ? 'active on' : ''}" onclick="setUsageMode('bill')">From my bill</button>
             <button class="v7-seg-btn ${kwhMode ? 'active on' : ''}" onclick="setUsageMode('kwh')">kWh a year</button>
           </div>
           ${kwhMode
             ? field('Yearly use', 'On your annual statement, or the last six bills added up.', `<span class="sy-num"><input type="number" inputmode="numeric" min="500" max="40000" step="100" value="${state.annual_kwh || Math.round(v7AnnualKwh())}" onchange="homeSet('annual_kwh',this.value)"><i>kWh</i></span>`)
             : field('Typical two-month bill', 'Including VAT.', `<span class="sy-num"><input type="number" inputmode="numeric" min="0" max="1500" step="5" value="${state.bimonthly_bill_eur}" onchange="homeSet('bimonthly_bill_eur',this.value)"><i>€</i></span>`)}
           <button class="v7-link" onclick="v7Sheet(null);setScreen('csv-import')">${ic('csv', 14)} Import ESB smart-meter data for exact figures</button>`}
      ${field('Current plan', '', sel('baseline', activeTariffsSorted().map((p) => [p.id, `${p.supplier} — ${p.plan}`]), state.baseline))}
      ${field('Contract ends', 'On your bill or welcome letter. We remind you before it does.', `<input type="date" value="${state.contract_end || ''}" onchange="homeSet('contract_end',this.value||null)">`)}
      ${field('Discount on it', 'A sign-up discount off the unit rates, if you have one.', `<span class="sy-num"><input type="number" inputmode="numeric" min="0" max="60" step="1" value="${state.baseline_discount_pct || 0}" onchange="homeSet('baseline_discount_pct',this.value)"><i>%</i></span>`)}
    </section>

    <button class="sy-pointer" onclick="v7Sheet('system')">${ic('sun', 16)}<span><b>The roof</b><small>Which way it faces and where the panels go are part of each system</small></span>${ic('chevR', 16)}</button>

    <section class="sy-part" aria-label="Electric car">
      <label class="sy-toggle sy-toggle-top">
        <span><b>${ic('car', 16)} Electric car</b><small>${state.ev_active ? `${(state.ev_km_per_year || 0).toLocaleString('en-IE')} km a year` : 'None at this home'}</small></span>
        <input type="checkbox" role="switch" ${state.ev_active ? 'checked' : ''} onchange="${state.ev_active ? 'toggleEv()' : 'startEvGuide()'}">
      </label>
      ${state.ev_active ? `
        <div class="v7-seg" role="tablist" aria-label="EV status">
          <button class="v7-seg-btn ${state.ev_in_bill ? 'active on' : ''}" onclick="setEvMode('have')">Have it — in my bill</button>
          <button class="v7-seg-btn ${!state.ev_in_bill ? 'active on' : ''}" onclick="setEvMode('plan')">Planning one</button>
        </div>
        ${field('Driving a year', 'Irish average about 16,500 km.', `<span class="sy-num"><input type="number" inputmode="numeric" min="0" max="100000" step="500" value="${state.ev_km_per_year}" onchange="homeSet('ev_km_per_year',this.value)"><i>km</i></span>`)}
        ${field('Car efficiency', 'Small car about 14, family 17, SUV 20.', `<span class="sy-num"><input type="number" inputmode="decimal" min="5" max="35" step="0.5" value="${state.ev_kwh_per_100km}" onchange="homeSet('ev_kwh_per_100km',this.value)"><i>kWh/100km</i></span>`)}
        ${field('Home charger', 'Most home chargers are 7.4 kW.', `<span class="sy-num"><input type="number" inputmode="decimal" min="1.4" max="22" step="0.1" value="${state.ev_charger_kw}" onchange="homeSet('ev_charger_kw',this.value)"><i>kW</i></span>`)}` : ''}
    </section>

    <button class="v7-cta-2" onclick="openMySystem()">${ic('sun', 16)} My system — panels, battery, price</button>
    <div class="v7-sheet-links"><a href="#" onclick="event.preventDefault();v7Sheet(null);setScreen('refine')">Advanced — battery strategy, usage shape, tariff options</a></div>`;
}

function v7Sheet(kind, id){
  const was = !!state._sheet;
  state._sheet = kind ? { kind, id: id || null } : null;
  // An open sheet is a step Back can undo. Without its own history entry, Back
  // changed the screen behind the sheet and the sheet came along to the next one.
  const cur = state.current_screen;
  if (kind && !was && !_sheetEntry && state.onboarding_complete && APP_SCREENS.indexOf(cur) >= 0){
    try { history.pushState({ screen: cur, depth: _histDepth() + 1, sheet: true }, '', '#' + cur); _sheetEntry = true; } catch(e){}
  }
  renderApp();
}
/** Open the month-by-month sheet at the bar that was tapped (or January). */
function v7OpenMonth(ev){
  const g = ev && ev.target && ev.target.closest ? ev.target.closest('[data-month]') : null;
  v7Sheet('months', g ? g.getAttribute('data-month') : '0');
}
/** Scroll the months track to a month (the letter strip above it). */
function v7GoMonth(i){
  const track = document.querySelector('.v7-months-track');
  const card = track && track.children[i];
  if (card) track.scrollTo({ left: card.offsetLeft - track.offsetLeft, behavior: 'smooth' });
}
/** Keep the letter strip in step with whichever month is on screen. */
function v7MonthScrolled(track){
  const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  document.querySelectorAll('.v7-month-dot').forEach((d, k) => d.classList.toggle('active', k === i));
  if (state._sheet && state._sheet.kind === 'months') state._sheet.id = String(i);
}
/** Adopt a plan from its sheet — the same rule as the picker. */
function v7Choose(planId){
  state._sheet = null;
  choosePlan(planId);
}

/* ============================================================
   BROWSER HISTORY — the platform Back gesture/button walks the
   in-app screen stack instead of leaving the app. Screens are
   pushed as hash entries; the ?s= share param is left untouched.
   ============================================================ */
const APP_SCREENS = ['result','plans','plan-detail','solar','analytics','monitor','privacy','installer','me',
                     'compare','more','independence','quotes','auditor','refine',
                     'how-to-switch','methodology','csv-import'];

// Set while we are reacting to a popstate, so restoring a screen doesn't
// push a fresh entry and trap the user in a loop.
let _suppressHistoryPush = false;
// The top history entry was added for a sheet (open, or since closed by its own button).
let _sheetEntry = false;

function _histDepth(){ return (history.state && +history.state.depth) || 0; }
function _hashScreen(){
  const h = (location.hash || '').replace(/^#/, '');
  return APP_SCREENS.indexOf(h) >= 0 ? h : null;
}

function pushScreenHistory(name){
  if (_suppressHistoryPush) return;
  if (APP_SCREENS.indexOf(name) < 0) return;
  // Leaving through a sheet (a link inside it): the new screen takes the
  // sheet's entry, so Back returns to the screen the sheet was opened on.
  if (_sheetEntry){
    _sheetEntry = false;
    try { history.replaceState({ screen: name, depth: _histDepth() }, '', '#' + name); } catch(e){}
    return;
  }
  try { history.pushState({ screen: name, depth: _histDepth() + 1 }, '', '#' + name); } catch(e){}
}

// Screens are also set by direct assignment in a few places (exploreSolar,
// onboarding exit). Keep the URL honest for those without inventing a back
// entry the user never created.
function syncScreenHistory(){
  if (_suppressHistoryPush || !state.onboarding_complete) return;
  const cur = state.current_screen;
  if (APP_SCREENS.indexOf(cur) < 0 || _hashScreen() === cur) return;
  try { history.replaceState({ screen: cur, depth: _histDepth() }, '', '#' + cur); } catch(e){}
}

window.addEventListener('popstate', function(e){
  // Back with a sheet open closes the sheet and stays put. If the sheet was
  // already closed by its own button, this Back only stepped off its entry:
  // take the step the reader meant.
  if (_sheetEntry){
    _sheetEntry = false;
    if (state._sheet){ state._sheet = null; renderApp(); return; }
    try { history.back(); } catch(err){}
    return;
  }
  // Inside a guide or the first-visit flow, Back steps back through it, and
  // past its first step closes it, landing where it was opened from.
  const g = state.current_screen;
  if (g === 'solar-guide' || g === 'ev-guide' || g === 'flow'){
    const st = e.state || {};
    if (st.guide === g && (st.step >= 1 || (g === 'solar-guide' && st.step === 0))){
      if (g === 'solar-guide') sgGo(st.step, true); else if (g === 'ev-guide') egGo(st.step, true);
      return;
    }
    if (g === 'flow' && st.guide === 'flow'){ renderApp(); return; }
    if (g === 'ev-guide') egCancel();
    else if (g === 'solar-guide') sgCancel();
    else { state._flow = null; state.current_screen = state.onboarding_complete ? 'result' : 'welcome'; saveState(); renderApp(); }
    return;
  }
  // An open overlay is the top-most thing on screen — Back should close it
  // rather than navigate the screen behind it. Re-push so the entry we just
  // consumed is restored and the user stays put.
  if (_authModalOpen){
    _authModalOpen = false;
    try { history.pushState({ screen: state.current_screen, depth: _histDepth() + 1 }, '', '#' + state.current_screen); } catch(err){}
    renderApp();
    return;
  }
  const target = (e.state && e.state.screen) || _hashScreen();
  // Nothing of ours left on the stack — let the browser leave the app.
  if (!target || !state.onboarding_complete) return;
  _suppressHistoryPush = true;
  try { setScreen(target); } finally { _suppressHistoryPush = false; }
});

function goBack(){
  const t = state._return_to;
  // Prefer real history so Back and the topbar arrow agree; _return_to is an
  // explicit override used when a screen was opened as a sub-view.
  if (!t && _histDepth() > 0){ history.back(); return; }
  delete state._return_to;
  setScreen(t || 'result');
}

function setScreen(name){
  if (name !== 'refine') delete state._return_to;
  // Design previews live on the Solar tab only; revert to the user's own
  // system before any other screen reads the numbers.
  if (state.current_screen === 'solar' && name !== 'solar' && (state.solar_view || 'mine') !== 'mine'){
    state.solar_view = 'mine';
    if (state.my_system) applySystemConfig(state.my_system);
    // P1.6: silent revert looked like a glitch — let the user know

  }
  // Opening the Solar tab never models anything by itself. It used to call
  // exploreSolar() here for anyone without a system, so a reader who had said
  // "no solar" found an estimated array switched on — and every figure on
  // Home changed — just for looking. The tab now says there is no system and
  // offers to model one; nothing happens until they ask.
  state.current_screen = name;
  saveState();
  pushScreenHistory(name);
  trackPageView(name);
  if (name === 'solar' && maybeAutoPaybackView()) return;
  renderApp();
}

// First visit to the Solar tab when no EXACT system was ever set: open
// straight in the fastest-payback designer, so the user starts from "what
// should I buy" instead of a pre-filled system they never configured.
// One-time — after that the tab remembers whatever the user was doing.
/**
 * Retired. This silently entered the "fastest payback" design view the first
 * time anyone opened the Solar tab, so the screen the reader landed on was a
 * preview of a design they had not asked for, labelled as such in small type.
 * The tab now simply opens on the recommendation.
 */
function maybeAutoPaybackView(){ return false; }

/* ============================================================
   SCENARIO SAVE / LOAD / COMPARE
   A scenario is a full config snapshot (the same fields used for sharing)
   plus a results summary computed at save time, so the Compare tab can show
   meaningful metrics side by side without re-running every saved case.
   ============================================================ */

// Config fields that fully define a simulation case.
const SCENARIO_FIELDS = [
  'region','heating_type','usage_input_mode','annual_kwh','bimonthly_bill_eur',
  'baseline','baseline_known','baseline_discount_pct','bills',
  'has_solar','considering_solar','solar_planned','solar_is_estimate',
  'count_A','azimuth_A','tilt_A','count_B','azimuth_B','tilt_B','panel_w',
  'battery_kwh','install_cost','grant_seai','grant_is_manual','cost_is_manual',
  'strategy_mode','charge_from_grid','hot_water_strategy','include_dynamic',
  'ev_active','ev_in_bill','ev_km_per_year','ev_kwh_per_100km',
  'plan_overrides','_csv_imported','_csv_filename','_csv_days','_csv_periods'
];

// Compute a full results summary for the CURRENT live state.
function computeScenarioSummary(){
  if (CACHE.dirty) rebuildBase();
  const best = getBestPlan();
  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = (baseSim ? sumF(baseSim.cost) : 0) + (baselinePlan ? baselinePlan.standing : 0);
  const annualKwh = Math.round(Object.values(state.bills || {}).reduce((a,b)=>a+b,0));
  const hasBatt = (state.battery_kwh || 0) > 0;
  const isArb = arbitrageOn();

  // Solar economics (payback / NPV / annual benefit) when a system exists
  let payback = null, npv20 = null, solarBenefit = null, sysCostNet = null;
  if (state.has_solar && totalPanels() > 0){
    try {
      const range = computeScenarioRange();
      const sc = range.realistic;
      if (sc){
        payback = (sc.payback != null && sc.payback < 50) ? sc.payback : null;
        solarBenefit = Math.round(sc.solarBenefit || 0);
      }
      sysCostNet = Math.max(0, (state.install_cost || 0) - (state.grant_seai || 0));
      if (solarBenefit != null) npv20 = Math.round(calcNPV20(solarBenefit, sysCostNet, state.battery_kwh || 0, state.panel_degradation));
    } catch(e){}
  }

  return {
    bestPlanId:   best && best.plan ? best.plan.id : null,
    bestPlanName: best && best.plan ? (best.plan.supplier + ' — ' + best.plan.plan) : '—',
    bestNet:      best ? Math.round(best.net) : null,
    baseCost:     Math.round(baseCost),
    savings:      best ? Math.round(Math.max(0, baseCost - best.net)) : 0,
    annualKwh,
    panels:       totalPanels(),
    kwp:          +totalKwp().toFixed(2),
    battery:      state.battery_kwh || 0,
    hasSolar:     !!state.has_solar,
    strategy:     hasBatt ? (isArb ? 'Arbitrage' : 'Self-consume') : '—',
    sysCostNet,
    payback,
    npv20,
    solarBenefit,
    ev:           !!state.ev_active,
    region:       (IRISH_REGIONS[state.region] || {}).name || state.region || '—'
  };
}

function captureScenario(name){
  const cfg = {};
  SCENARIO_FIELDS.forEach(k => { if (state[k] !== undefined) cfg[k] = structuredClone(state[k]); });
  return {
    id: 'sc_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name: name || ('Scenario ' + ((state.scenarios || []).length + 1)),
    created: Date.now(),
    cfg,
    summary: computeScenarioSummary()
  };
}

function saveCurrentScenario(){
  const input = document.getElementById('scenario-name-input');
  let name = input ? input.value.trim() : '';
  if (!name){
    // Auto-name from the most descriptive attributes
    const parts = [];
    parts.push(state.has_solar ? totalPanels() + 'p' : 'no solar');
    if ((state.battery_kwh || 0) > 0) parts.push(state.battery_kwh + 'kWh');
    if (state.ev_active) parts.push('EV');
    name = parts.join(' · ');
  }
  if (!state.scenarios) state.scenarios = [];
  if (state.scenarios.length >= 12){
    showToast('You can save up to 12 scenarios — delete one to add another', { type:'amber', icon:ic('warn',16) });
    return;
  }
  state.scenarios.push(captureScenario(name));
  saveState();
  renderApp();
  showToast('Saved "' + name + '" — load or compare it any time', { type:'accent', icon:ic('checkC',16), title:'Scenario saved' });
}

function loadScenario(id){
  const sc = (state.scenarios || []).find(s => s.id === id);
  if (!sc){ showToast('Scenario not found', { type:'amber' }); return; }
  // Apply the saved config over the live state
  SCENARIO_FIELDS.forEach(k => { if (sc.cfg[k] !== undefined) state[k] = structuredClone(sc.cfg[k]); });
  // The applied system is now the user's live "my system" baseline for the Solar tab
  state.solar_view = 'mine';
  state._solar_user_configured = state.has_solar;
  invalidate();
  if (state.has_solar) snapshotMySystem();
  saveState();
  showToast('Loaded "' + sc.name + '"', { type:'accent', icon:ic('checkC',16) });
  setScreen('result');
}

function deleteScenario(id){
  if (!confirm('Delete this saved scenario?')) return;
  state.scenarios = (state.scenarios || []).filter(s => s.id !== id);
  // also clear from the compare selection
  state._compare_sel = (state._compare_sel || []).filter(x => x !== id);
  saveState();
  renderApp();
}

function toggleCompareSelect(id){
  if (!state._compare_sel) state._compare_sel = [];
  const i = state._compare_sel.indexOf(id);
  if (i >= 0) state._compare_sel.splice(i, 1);
  else {
    if (state._compare_sel.length >= 4){
      showToast('Compare up to 4 at once', { type:'amber' });
      return;
    }
    state._compare_sel.push(id);
  }
  saveState();
  renderApp();
}

/* ============================================================
   SHAREABLE URL — Sprint 2 / H2 + H5
   Encodes key state fields as base64 URL param ?s=...
   On load, restores state from URL if present.
   ============================================================ */
const SHARE_FIELDS = [
  'region','heating_type','bimonthly_bill_eur','baseline','baseline_known',
  'has_solar','count_A','azimuth_A','tilt_A','count_B','azimuth_B','tilt_B',
  'battery_kwh','install_cost','grant_seai','ev_active','ev_km_per_year',
  'ev_kwh_per_100km','bills'
];

function buildShareUrl(){
  const snap = {};
  SHARE_FIELDS.forEach(k => { if (state[k] !== undefined) snap[k] = state[k]; });
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(snap))));
  const url = new URL(window.location.href);
  url.searchParams.set('s', encoded);
  return url.toString();
}

function copyShareUrl(){
  const url = buildShareUrl();
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(() => showToast('Link copied — paste it anywhere to share your analysis'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Link copied — paste it anywhere to share your analysis');
  }
  fireEvent('share_link_copied', { region: state.region, has_solar: state.has_solar });
}

function tryRestoreFromUrl(){
  try {
    const url = new URL(window.location.href);
    const encoded = url.searchParams.get('s');
    if (!encoded) return false;
    const snap = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (!snap || typeof snap !== 'object') return false;
    SHARE_FIELDS.forEach(k => { if (snap[k] !== undefined) state[k] = snap[k]; });
    if (!state.bills || !Object.keys(state.bills).length){
      state.bills = inferBillsFromEuro(state.bimonthly_bill_eur, state.heating_type);
    }
    state.onboarding_complete = true;
    state.current_screen = 'result';
    state.considering_solar = state.has_solar;
    invalidate();
    saveState();
    fireEvent('shared_link_opened', { region: state.region });
    return true;
  } catch(e){ return false; }
}

// Debounced re-render for rapid-fire inputs (tap steppers, sliders). Coalesces
// a burst of taps into a single paint so the UI stays fluid; the underlying
  // state is already updated synchronously, so numbers are never stale.
let _renderDebounceTimer = null;
function renderAppDebounced(){
  if (_renderDebounceTimer) clearTimeout(_renderDebounceTimer);
  _renderDebounceTimer = setTimeout(() => { _renderDebounceTimer = null; renderApp(); }, 110);
}

function runCountUps(root){
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('[data-countup]').forEach(el => {
    const target = parseFloat(el.getAttribute('data-countup'));
    if (!isFinite(target) || target <= 0) return;
    const prefix = el.getAttribute('data-prefix') || '';
    const suffix = el.getAttribute('data-suffix') || '';
    const span = el.querySelector('[data-countup-num]') || el;
    const keepKids = span !== el ? null : Array.from(el.childNodes).filter(n => n.nodeType === 1);
    const t0 = performance.now(), dur = 750;
    function frame(t){
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const txt = prefix + Math.round(target * e).toLocaleString() + suffix;
      if (keepKids){ el.textContent = txt; keepKids.forEach(k => el.appendChild(k)); }
      else span.textContent = txt;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

function renderApp(){
  // A pending debounced paint is now redundant — this synchronous one supersedes it.
  if (_renderDebounceTimer){ clearTimeout(_renderDebounceTimer); _renderDebounceTimer = null; }
  applyTheme();
  const root = document.getElementById('app-root');
  // Intro onboarding — first-time users only
  if (state.current_screen === 'intro'){
    // The intro exists only to offer an account. With no auth backend its
    // buttons are inert, so send the user somewhere that works rather than
    // rendering a screen where nothing responds.
    if (!sbInitialized()){
      // Same V6 rule as the first-run branch below: a reader with no answer yet
      // goes to the question, not to a pitch.
      state.current_screen = state.onboarding_complete ? 'result' : 'fastpath';
      saveState();
      return renderApp();
    }
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderIntro();
    paintAuthModal();
    return;
  }
  // Landing page — first thing new users see; also reachable via the logo
  if (state.current_screen === 'welcome'){
    root.innerHTML = renderWelcome();
    paintAuthModal();
    return;
  }
  // Fast-path activation (30-second simple setup)
  if (state.current_screen === 'flow'){
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderFlow();
    paintAuthModal();
    return;
  }
  if (state.current_screen === 'ev-guide' && state._eg){
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderEvGuide();
    return;
  }
  if (state.current_screen === 'solar-guide' && state._sg != null){
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderSolarGuide();
    return;
  }
  if (state.current_screen === 'fastpath'){
    root.innerHTML = renderFastPath();
    return;
  }
  // Onboarding flow — also re-enterable after completion (guided re-setup from Home)
  if (state.current_screen === 'onboarding'){
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderOnboarding();
    paintAuthModal();
    bindOnboarding();
    enhanceA11y();
    return;
  }
  // First-ever load — the quick answer is the front door.
  //
  // V6 leads with the answer instead of asking for it. The five-step guided
  // setup gated the one thing the reader came for behind location, usage,
  // current plan, solar and EV — five screens before a single figure. The quick
  // answer needs one number, states every assumption it made as a chip the
  // reader can tap, and produces the real ranking from the same engine. The
  // guided setup is still there, one link down, for anyone who wants to build
  // solar and EV up front; it is no longer the toll gate.
  if (!state.onboarding_complete){
    state.current_screen = 'fastpath';
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderFastPath();
    enhanceA11y();
    return;
  }
  // Post-onboarding screens
  let html = '';
  switch(state.current_screen){
    case 'result':       html = V7.home(); break;
    case 'plans':        html = V7.plans(); break;
    case 'plan-detail':  html = renderPlanDetail(); break;
    case 'solar':        state._an_tab = 'solar'; html = V7.analytics('solar'); break;
    case 'analytics':    html = V7.analytics(); break;
    case 'monitor':      html = renderMonitor(); break;
    case 'compare':      html = renderCompare(); break;
    case 'more':         html = renderMore(); break;
    case 'independence': html = renderIndependence(); break;
    case 'quotes':       html = renderQuotes(); break;
    case 'auditor':      html = renderAuditor(); break;
    case 'privacy':      html = renderPrivacy(); break;
    case 'me':           html = renderMe(); break;
    case 'installer':    html = renderInstallerPortal(); break;
    case 'refine':       html = renderRefine(); break;
    case 'how-to-switch':html = renderHowToSwitch(); break;
    case 'methodology':  html = renderMethodology(); break;
    case 'csv-import':   html = renderCsvImport(); break;
    default:
      // Falling through to the home screen made every broken link look like a
      // working one that went somewhere odd — a dead button shipped and
      // survived until it was found by hand. Say so, then recover.
      console.error(`[router] unknown screen "${state.current_screen}" — falling back to the result screen`);
      state.current_screen = 'result';
      html = V7.home();
  }
  // A re-render of the SAME screen is a state update, not navigation: keep the
  // user where they were and don't replay the entry animation. A different
  // screen is navigation: animate in and start at the top.
  // Scroll position is remembered per screen. Returning to a tab used to dump
  // the reader back at the top, so scrolling four viewports down the plans list
  // and tapping away to check something meant scrolling all the way back.
  const screenChanged = window.__lastScreen !== state.current_screen;
  const here = window.scrollY || window.pageYOffset || 0;
  window.__scrollMemory = window.__scrollMemory || {};
  if (window.__lastScreen) window.__scrollMemory[window.__lastScreen] = screenChanged ? here : 0;
  const keepScroll = screenChanged
    ? (window.__scrollMemory[state.current_screen] || 0)
    : here;

  // A sheet re-rendered for its own edit (a slider, a toggle) stays where it
  // was: same scroll, no second entrance.
  const prevSheet = root.querySelector('.v7-sheet');
  const sheetKey = state._sheet ? state._sheet.kind + ':' + (state._sheet.id || '') : '';
  const sameSheet = !!prevSheet && root.__sheetKey === sheetKey;
  const sheetScroll = sameSheet ? prevSheet.scrollTop : 0;
  root.__sheetKey = sheetKey;

  root.setAttribute('data-chrome','app');
  root.innerHTML = html;
  // A change tried on the system stays undoable from any screen until kept or undone.
  // Over an open sheet it goes in the sheet, where it can be reached.
  if (_undo){ const sc = root.querySelector('.screen'); if (sc) sc.insertAdjacentHTML('afterbegin', undoBar()); }
  // A sheet opens over whatever surface is showing. A plan's detail or the
  // home's assumptions used to be separate screens; each question cost a round
  // trip and lost the context behind it.
  const sheetHtml = V7.sheet();
  if (sheetHtml) root.insertAdjacentHTML('beforeend', sheetHtml);
  if (sheetHtml && _undo){ const head = root.querySelector('#v7-sheet .v7-sheet-head'); if (head) head.insertAdjacentHTML('beforebegin', undoBar()); }
  if (sheetHtml && sameSheet){
    const sh = root.querySelector('#v7-sheet');
    if (sh){ sh.classList.add('is-steady'); const box = sh.querySelector('.v7-sheet'); if (box) box.scrollTop = sheetScroll; }
  }
  if (sheetHtml && state._sheet && state._sheet.kind === 'months'){
    const track = root.querySelector('.v7-months-track');
    const card = track && track.children[+state._sheet.id || 0];
    if (card) track.scrollLeft = card.offsetLeft - track.offsetLeft;
    if (track) v7MonthScrolled(track);
  }
  root.classList.toggle('has-sheet', !!sheetHtml);
  // iOS (home-screen app especially) can leave a fixed bar where it was before
  // the page under it was replaced and scrolled; re-lay it out on the next frame.
  requestAnimationFrame(() => {
    const bar = root.querySelector('.v7-nav');
    if (bar){ bar.style.display = 'none'; void bar.offsetHeight; bar.style.display = ''; }
  });
  if (state.current_screen === 'auditor')    bindAuditor();
  if (state.current_screen === 'refine')     bindRefine();
  if (state.current_screen === 'csv-import') bindCsvImport();
  enhanceA11y();

  if (screenChanged){
    const sc = root.querySelector('.screen');
    if (sc) sc.classList.add('screen-enter');
    window.scrollTo(0, keepScroll);
    runCountUps(root);
    window.__lastScreen = state.current_screen;
  } else if (keepScroll){
    // Restore synchronously so the browser never paints the jumped position.
    window.scrollTo(0, keepScroll);
  }
  paintAuthModal();
  syncScreenHistory();
  checkScoreRise();
}

/**
 * Paint the account sheet over whatever screen is showing.
 *
 * Attached to document.body rather than the screen container, and called from
 * every branch of renderApp(). It used to be injected only at the very end of
 * the post-onboarding path, so any branch that returned early — welcome, intro,
 * onboarding — could set the modal flag and render nothing.
 */
function paintAuthModal(){
  const existing = document.getElementById('auth-modal-root');
  if (existing) existing.remove();
  const html = renderAuthModal();
  // Closing the sheet retires the message with it, so re-opening it later
  // never re-states a failure the reader has already dealt with.
  if (!html){ _authMsg = null; return; }
  const el = document.createElement('div');
  el.id = 'auth-modal-root';
  el.innerHTML = html;
  document.body.appendChild(el);
  // A repaint must not wipe the reason. The sheet is rebuilt from scratch on
  // every render, and several land shortly after boot — the session check, the
  // tariff refresh — so a message written at +60ms was routinely erased at
  // +300ms by a render that had nothing to do with it. The reader tapped
  // Google, came back, saw an explanation flash, and was left with a blank box.
  if (_authMsg) showAuthMsg(_authMsg.msg, _authMsg.type, _authMsg.detail);
}

/* ============================================================
   INIT — runs once on page load
   ============================================================ */
/** Fade the launch splash once the first screen is under it — after long
 *  enough for the mark to draw, never longer. Automated browsers skip it. */
function dismissSplash(){
  const el = document.getElementById('pk-splash');
  if (!el) return;
  const wait = navigator.webdriver ? 0 : Math.max(0, 1100 - performance.now());
  setTimeout(() => { el.classList.add('is-gone'); setTimeout(() => el.remove(), 400); }, wait);
}

document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  // The analysis on Home opens closed on every visit: the answer comes first.
  // Analytics' folds open closed too, and nothing claims you came from Home.
  state._solar_more = false;
  state._an_day_open = false;
  state._an_from = null;
  setTimeout(() => {
    const loader = document.getElementById('loader');
    if (loader) loader.remove();
    dismissSplash();
    // Sprint 2 H5 — try to restore shared URL state before anything else
    tryRestoreFromUrl();
    // Reopen the screen named in the URL hash (bookmark, refresh, or a Back
    // that landed on our first entry) rather than always dropping on Home.
    if (state.onboarding_complete){
      const _h = _hashScreen();
      if (_h) state.current_screen = _h;
    }
    // Apply saved region (or default east) so engine has the right GHI from boot
    applyRegion(state.region || 'east');
    // Recover onboarding state from saved state if mid-flow
    if (!state.onboarding_complete){
      _ob = makeOb();
      _ob.region = state.region || 'east';
      _ob.address = state.address || '';
      _ob.baseline = state.baseline || 'EI-24';
      _ob.baseline_known = !!state.baseline_known;
      _ob.heating = state.heating_type || 'gas';
      _ob.bill = state.bimonthly_bill_eur || 200;
      _ob.usage_mode = state._csv_imported ? 'csv' : (state.usage_input_mode || 'bill');
      _ob.annual_kwh = state.annual_kwh || 0;
      _ob.baseline_discount = state.baseline_discount_pct || 0;
      _ob.has_solar = !!state.has_solar;
      _ob.solar_status = state.has_solar ? (state.considering_solar ? 'have' : 'plan') : false;
      _ob.count_A = state.count_A || 8;
      _ob.azimuth_A = state.azimuth_A != null ? state.azimuth_A : 180;
      _ob.tilt_A = state.tilt_A != null ? state.tilt_A : 30;
      _ob.count_B = state.count_B || 0;
      _ob.azimuth_B = state.azimuth_B != null ? state.azimuth_B : 270;
      _ob.tilt_B = state.tilt_B != null ? state.tilt_B : 30;
      _ob.battery_kwh = state.battery_kwh || 0;
      _ob.install_cost = state.install_cost || 9500;
      _ob.has_ev = !!state.ev_active;
      _ob.ev_in_bill = state.ev_in_bill !== false;
      _ob.ev_km = state.ev_km_per_year || 15000;
      _ob.ev_eff = state.ev_kwh_per_100km || 17;
    } else {
      if (!state.bills || !Object.keys(state.bills).length){
        state.bills = inferBillsFromEuro(state.bimonthly_bill_eur, state.heating_type);
      }
      invalidate();
    }
    // Installed after the stored state is loaded and sanitised, so the trace
    // shows what changes the setting during use rather than during boot.
    traceStrategy();
    // Before the first render: the router owns the hash from here on.
    captureOAuthReturn();
    renderApp();
    // If we have just come back from Google refused, say so rather than
    // rendering a signed-out app as though nothing had happened.
    reportOAuthReturn();

    /*
     * Three async boot paths used to call renderApp() the moment they landed,
     * each replacing the entire DOM. Measured on a warm load that was two full
     * repaints between 240ms and 291ms after first paint — inside the window
     * where someone is already reaching for the screen. A tap in that window
     * lands on a node that is about to be detached, and scroll position, focus
     * and any open disclosure reset underneath the reader. It also made two
     * end-to-end tests intermittently fail with "element is not attached to the
     * DOM", which is the same defect seen from the outside.
     *
     * They are debounced now, so a burst collapses into one paint, and the two
     * that change nothing visible no longer paint at all.
     */
    const booted = [
      loadTariffs().then(refreshed => {
        // Rates actually changed — this one has to repaint. The app starts on
        // the copy embedded in the bundle and swaps to the served file, so on
        // a normal load this fires once and is correct.
        if (refreshed && state.onboarding_complete){
          invalidate();
          renderAppDebounced();
        }
      }),
      sbInit().then(() => { if (_sbUser) renderAppDebounced(); }),
      loadTariffStatus().then(() => {
        // Only the settings screen shows this. Repainting the home screen for a
        // value it never displays is pure cost.
        if (state._tariff_status && state.onboarding_complete && state.current_screen === 'more') renderAppDebounced();
      }),
    ];

    // Boot is finished once those have landed and the coalesced paint has run.
    // The end-to-end suite waits on this rather than racing it: two tests were
    // intermittently failing with "element is not attached to the DOM" because
    // they grabbed a node during the swap. That was the tests seeing the real
    // defect above, and it stays visible — the repaint is measured, not hidden.
    Promise.allSettled(booted).then(() => {
      // Only once the session has had its chance: a successful sign-in is a
      // session arriving slightly after first paint, and reporting silence
      // before that would call every success a failure.
      reportOAuthSilence();
      setTimeout(() => { window.__bootSettled = true; }, 160);
    });
  }, 50);
});

/* ============================================================
   SPRINT 3 — SEAI GRANT CALCULATOR (F5)
   2024 SEAI Home Solar Scheme — tiered structure
   ============================================================ */
function calcSeaiGrant(kwp, batteryKwh){
  // SEAI Home Solar Scheme — current structure (2024/2025):
  // First 2 kWp: €900/kWp  →  maximum grant = €1,800
  // Cap: €1,800 total (no battery bonus, no higher tiers as of 2025)
  if (kwp <= 0) return { panels: 0, battery: 0, total: 0 };
  const panelGrant = Math.min(kwp, 2) * 900;
  const total = Math.min(Math.round(panelGrant), 1800);
  return { panels: total, battery: 0, total };
}

/**
 * The grant is a number the reader claims, not a calculation they audit.
 *
 * This was four monospace lines showing the arithmetic behind a figure that is
 * fixed at €1,800 for almost every domestic system in the country — the working
 * for a constant. It is one sentence and a link.
 */
function renderSeaiGrantCard(kwp, batteryKwh){
  const g = calcSeaiGrant(kwp, batteryKwh);
  const capped = kwp > 2;
  return `<div class="card" style="background:rgba(0,230,118,.04);border-color:var(--accent);margin-bottom:14px">
    <div class="card-label" style="color:var(--accent)">SEAI home solar grant</div>
    <div class="card-value accent">€${g.total.toLocaleString()}</div>
    <div style="margin-top:6px;font-size:15px;color:var(--ink-soft);line-height:1.6">
      ${capped
        ? `The maximum for a domestic system, at ${kwp.toFixed(1)} kWp.`
        : `€900 per kWp on your first 2 kWp.`}
      Already filled into the grant field above, and taken off every price in the app — change it there if your installer quotes differently.
      <a href="https://www.seai.ie/grants/solar-electricity-grant/" target="_blank" style="color:var(--blue);white-space:nowrap">seai.ie ↗</a>
    </div>
  </div>`;
}

/* ============================================================
   SPRINT 3 — HOW TO SWITCH GUIDE (F7)
   Per-supplier step-by-step switching guide screen
   ============================================================ */
const SWITCH_GUIDES = {
  'EI': {
    name: 'Electric Ireland',
    color: 'var(--blue)',
    steps: [
      { icon: ic('globe',18), title: 'Go to Electric Ireland', body: 'Visit <b>electricireland.ie</b> → click "Switch" in the nav. Use the UTM-tagged link below to ensure they know you came via Peakless Optimiser.' },
      { icon: ic('clip',18), title: 'Get your MPRN', body: 'Your MPRN (Meter Point Reference Number) is on your current electricity bill — usually an 11-digit number starting with 10. You\'ll need it to switch.' },
      { icon: ic('clock',18), title: 'Allow 10–15 days', body: 'Electric Ireland processes switches in 10–15 working days. Your current supplier is notified automatically — you don\'t need to cancel.' },
      { icon: ic('phone',18), title: 'No engineer needed', body: 'Residential tariff switches require no engineer visit. Your meter stays the same — only the billing contract changes.' },
      { icon: '<b style="font-family:var(--mono)">€</b>', title: 'Exit fees?', body: 'If you\'re mid-contract (check your current bill), there may be exit fees. Electric Ireland will confirm during sign-up.' },
    ]
  },
  'BG': {
    name: 'Bord Gáis Energy',
    color: 'var(--amber)',
    steps: [
      { icon: ic('globe',18), title: 'Visit Bord Gáis Energy', body: 'Go to <b>bordgaisenergy.ie</b> → "Electricity Plans" → choose your plan. They often have online discounts not available by phone.' },
      { icon: ic('clip',18), title: 'Have your MPRN ready', body: 'The MPRN is on your current bill. Bord Gáis will use this to notify your current supplier.' },
      { icon: ic('clock',18), title: 'Switch takes ~2 weeks', body: 'The switching process is automated between suppliers and usually completes in 10–14 working days.' },
      { icon: ic('battery',18), title: 'Smart meter required for TOU', body: 'The Smart Homes or TOU tariff requires a smart meter. If you don\'t have one, request a free upgrade through CRU — this can add 2–4 weeks.' },
      { icon: '<b style="font-family:var(--mono)">€</b>', title: 'Bundle savings', body: 'If you also have Bord Gáis gas, check for bundle discounts — they often give 5–10% off when both fuels are with them.' },
    ]
  },
  'EN': {
    name: 'Energia',
    color: '#00E676',
    steps: [
      { icon: ic('globe',18), title: 'Go to Energia', body: 'Visit <b>energia.ie/energy-plans/electricity</b> and select your plan. Energia typically shows unit rates including VAT on plan pages.' },
      { icon: ic('clip',18), title: 'MPRN + bank details', body: 'You\'ll need your MPRN (from your bill) and a bank account for direct debit. Energia requires direct debit for monthly billing.' },
      { icon: ic('clock',18), title: 'Complete in ~15 days', body: 'Standard residential switches complete in 10–15 working days. Energia sends a welcome email with your account number.' },
      { icon: ic('sun',16), title: 'CEG export sign-up', body: 'If you have solar, ask to be registered on the CEG (Clean Export Guarantee) scheme when switching. Not all agents enable this automatically.' },
      { icon: ic('phone',18), title: 'Customer service', body: 'Energia customer service: 1850 ENERGIA (363 742) or via live chat on their website.' },
    ]
  },
  'SSE': {
    name: 'SSE Airtricity',
    color: '#00E676',
    steps: [
      { icon: ic('globe',18), title: 'Visit SSE Airtricity', body: 'Go to <b>sseairtricity.com/ie/home</b> → click "Get a Quote" → select electricity → choose your plan.' },
      { icon: ic('clip',18), title: 'Gather your details', body: 'You\'ll need your MPRN, current supplier name, and email address. SSE automates the rest of the switch.' },
      { icon: ic('clock',18), title: 'Allow 2 weeks', body: 'Switches typically take 10–15 working days. You\'ll receive a switch confirmation email and then a welcome pack.' },
      { icon: ic('leaf',18), title: '100% renewable option', body: 'SSE offers a 100% renewable tariff. The DNP (Day/Night/Peak) plan is particularly well-suited to EV owners.' },
      { icon: '<b style="font-family:var(--mono)">€</b>', title: 'Online discount', body: 'SSE usually offers €50–€100 online sign-up discount. Look for a promo code on their homepage before switching.' },
    ]
  },
  'YN': {
    name: 'Yuno Energy',
    color: 'var(--blue)',
    steps: [
      { icon: ic('globe',18), title: 'Visit Yuno', body: 'Go to <b>yuno.ie</b> → "Switch Now". Yuno is a newer, digital-first supplier with a smooth mobile sign-up process.' },
      { icon: ic('clip',18), title: 'Have your MPRN', body: 'As with all switches, you\'ll need your MPRN. Yuno\'s app-first approach means you can complete the entire switch on mobile.' },
      { icon: ic('clock',18), title: 'Faster switching', body: 'Yuno targets 7–10 working day switches. They\'ll notify you by app notification and email at each stage.' },
      { icon: ic('phone',18), title: 'App-based management', body: 'Yuno manages your account primarily via their app. Download it before or during sign-up for the best experience.' },
      { icon: ic('sun',16), title: 'CEG registration', body: 'Confirm CEG solar export is set up on sign-up if you have panels. Yuno supports CEG on all residential plans.' },
    ]
  },
  'FL': {
    name: 'Flogas',
    color: 'var(--amber)',
    steps: [
      { icon: ic('globe',18), title: 'Visit Flogas', body: 'Go to <b>flogas.ie/electricity/residential</b> → "Switch & Save". Flogas is one of Ireland\'s smaller suppliers — often offering competitive rates.' },
      { icon: ic('clip',18), title: 'MPRN from your bill', body: 'You\'ll need your MPRN. If you\'re currently a Flogas gas customer, the switch is faster — they already have your details.' },
      { icon: ic('clock',18), title: 'Standard 2-week switch', body: 'Flogas switches follow the standard CRU process — 10–15 working days. They handle the notice to your current supplier.' },
      { icon: ic('sun',16), title: 'CEG export', body: 'Flogas supports CEG export payments. Ensure it\'s activated when you sign up or call their team to add it post-switch.' },
      { icon: ic('phone',18), title: 'Customer support', body: 'Flogas support: 041 214 5000 · flogas.ie/contact. They\'re known for responsive Irish-based customer service.' },
    ]
  },
  'PIN': {
    name: 'Pinergy',
    color: 'var(--amber)',
    steps: [
      { icon: ic('globe',18), title: 'Visit Pinergy', body: 'Go to <b>pinergy.ie/home-electricity</b> and select your plan. Pinergy specialises in smart, PAYG-style plans for tech-savvy households.' },
      { icon: ic('phone',18), title: 'App required', body: 'Pinergy\'s plans are managed via their smartphone app. The app gives real-time usage data and lets you top up (for PAYG) or manage direct debit.' },
      { icon: ic('clip',18), title: 'Smart meter required', body: 'Most Pinergy plans require a smart meter (ESBN Smart Meter). If you don\'t have one, apply at <b>esbnetworks.ie</b> — upgrades are free and take 2–4 weeks.' },
      { icon: ic('clock',18), title: 'Switch timeline', body: 'Once your smart meter is confirmed, Pinergy switches in 10–15 working days via the standard CRU process.' },
      { icon: ic('sun',16), title: 'Solar & EV-friendly', body: 'Pinergy\'s Life and EV plans are particularly good for solar owners. The Life plan offers a boosted EV window and supports CEG export.' },
    ]
  }
};

function getSupplierKey(planId){
  if (planId.startsWith('EI-')) return 'EI';
  if (planId.startsWith('BG-')) return 'BG';
  if (planId.startsWith('EN-')) return 'EN';
  if (planId.startsWith('SSE-')) return 'SSE';
  if (planId.startsWith('YN-')) return 'YN';
  if (planId.startsWith('FL-')) return 'FL';
  if (planId.startsWith('PIN-')) return 'PIN';
  return null;
}

function openHowToSwitch(planId){
  state._switch_guide_plan = planId || state._detail_plan_id || null;
  setScreen('how-to-switch');
}

function renderHowToSwitch(){
  const planId = state._switch_guide_plan;
  const plan = planId ? getPlanById(planId) : null;
  const supplierKey = planId ? getSupplierKey(planId) : null;
  const guide = supplierKey ? SWITCH_GUIDES[supplierKey] : null;
  const affiliateUrl = planId ? getAffiliateUrl(planId) : null;

  if (!guide){
    return `${topbar('How to switch', 'blue', true)}
    <div class="screen">
      <div class="qr-hero" style="border-color:var(--blue)">
        <div class="qr-eyebrow" style="color:var(--blue)">Switching electricity in Ireland</div>
        <div style="font-family:var(--display);font-size:17px;font-weight:600;color:var(--ink)">It takes 10–15 working days</div>
        <div class="qr-sub">Your current supplier is notified automatically. You never lose power.</div>
      </div>
      <div class="card" style="margin-top:0">
        <div class="card-label">The general process</div>
        <ol style="margin:10px 0 0 18px;font-size:15px;color:var(--ink-soft);line-height:1.9;list-style:decimal">
          <li>Find your MPRN (on your current bill)</li>
          <li>Sign up with the new supplier online</li>
          <li>New supplier notifies your current one</li>
          <li>Switch completes in 10–15 working days</li>
          <li>First bill arrives ~4–6 weeks after switch</li>
        </ol>
      </div>
      ${TARIFFS.filter(t => !t.discontinued && getSupplierKey(t.id)).map(t => {
        const key = getSupplierKey(t.id);
        const g = SWITCH_GUIDES[key];
        if (!g) return '';
        return `<div class="secondary-card blue" onclick="openHowToSwitch('${t.id}')">
          <div class="secondary-card-icon">${ic('clip',19)}</div>
          <div class="secondary-card-body">
            <div class="secondary-card-title">How to switch to ${g.name}</div>
            <div class="secondary-card-sub">${t.plan} · step-by-step guide</div>
          </div>
          <div class="secondary-card-arrow">›</div>
        </div>`;
      }).filter((v,i,a) => a.indexOf(v) === i).filter(Boolean).join('')}
    </div>
    ${bottomNav()}`;
  }

  const backFn = planId ? `openPlanDetail('${planId}')` : `setScreen('plans')`;

  return `${topbar('How to switch', 'blue', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="goBack()">← Back</button>
    </div>

    <div class="qr-hero" style="border-color:var(--blue);box-shadow:var(--hero-shadow),0 0 32px -10px var(--blue-glow)">
      <div class="qr-eyebrow" style="color:var(--blue)">Switching to</div>
      <div style="font-family:var(--display);font-size:20px;font-weight:700;color:var(--ink);margin:4px 0">${guide.name}</div>
      ${plan ? `<div class="qr-sub">${plan.plan}</div>` : ''}
    </div>

    ${guide.steps.map((step, i) => `
      <div class="card" style="margin-top:${i===0?'0':'10px'}">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="font-size:20px;line-height:1;flex-shrink:0;margin-top:2px">${step.icon}</div>
          <div>
            <div style="font-weight:700;color:var(--ink);font-size:13px;margin-bottom:4px">
              <span style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);margin-right:8px">${i+1}.</span>${step.title}
            </div>
            <div style="font-size:12px;color:var(--ink-soft);line-height:1.65">${step.body}</div>
          </div>
        </div>
      </div>
    `).join('')}

    ${affiliateUrl ? `
      <a href="${affiliateUrl}" target="_blank" rel="noopener noreferrer" onclick="handleSwitchClick('${planId}','${(plan?.supplier + ' ' + plan?.plan).replace(/'/g,"\\'")}',0)" style="display:block;text-decoration:none;margin-top:14px">
        <div class="switch-cta" style="text-align:center">Switch to ${guide.name} →</div>
      </a>
    ` : `
      <button class="switch-cta" style="margin-top:14px" onclick="handleSwitchClick('${planId}','${(plan?.supplier + ' ' + plan?.plan || '').replace(/'/g,"\\'")}',0)">
        Switch to ${guide.name} →
      </button>
    `}

    <div class="card" style="margin-top:14px;background:var(--overlay-tile)">
      <div class="card-label">${ic('bolt',13)} Good to know about all Irish switches</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:1.8;margin-top:6px">
        ✓ You never lose power during a switch<br>
        ✓ Your current supplier is notified automatically — no cancellation call needed<br>
        ✓ CRU (energy regulator) guarantees the switch completes within 15 working days<br>
        ✓ If you have solar, confirm CEG export registration with the new supplier<br>
        ✓ Check for exit fees on your current bill before switching
      </div>
    </div>

    <p class="disclaimer">We are independent and take no payment from any supplier. Switching through our links costs you nothing and earns us nothing — the ranking is calculated purely from your simulated annual cost. If that ever changes, this notice changes with it.</p>
  </div>
  ${bottomNav()}`;
}

/* ============================================================
   SPRINT 3 — SMART METER CSV IMPORT (F1)
   ESB HDF (Harmonised Data Format) CSV importer.
   Parses 30-min interval data and converts to 6 bimonthly kWh buckets.
   ============================================================ */
function renderCsvImport(){
  const hasImport = state._csv_imported;
  return `${topbar('Meter data', 'blue', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="setScreen('refine')">← Advanced</button>
    </div>

    <div class="qr-hero" style="border-color:var(--blue)">
      <div class="qr-eyebrow" style="color:var(--blue)">Import from ESB Networks</div>
      <div style="font-family:var(--display);font-size:17px;font-weight:600;color:var(--ink);margin:4px 0">Smart meter CSV import</div>
      <div class="qr-sub">Replace estimated bills with your actual 30-minute interval data for a more accurate simulation.</div>
    </div>

    ${hasImport ? `
      <div class="card" style="background:var(--accent-faint);border-color:var(--accent);margin-top:0">
        <div class="card-label" style="color:var(--accent)">✓ Smart meter data imported</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:1.8;margin-top:6px">
          ${Object.entries(state.bills).map(([k,v]) => `${k}: ${Math.round(v).toLocaleString()} kWh`).join(' · ')}<br>
          Total: ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr
        </div>
        <button class="btn-secondary" style="margin-top:10px;width:100%" onclick="clearCsvImport()">✕ Remove imported data · use estimate</button>
      </div>
    ` : ''}

    <div class="card" style="margin-top:${hasImport ? '10px' : '0'}">
      <div class="card-label">Step 1 — download your data from ESB Networks</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.7;margin:8px 0">
        Log in to <b>esbnetworks.ie</b> → "My Meter" → "Download HDF Data" → select "HDF CSV" format for the last 12 months.
      </div>
      <a href="https://myaccount.esbnetworks.ie" target="_blank" rel="noopener noreferrer">
        <button class="btn-secondary" style="width:100%;margin-top:8px">Open ESB Networks →</button>
      </a>
    </div>

    <div class="card" style="margin-top:10px">
      <div class="card-label">Step 2 — upload your HDF CSV file</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.7;margin:8px 0">
        The file is typically named <span style="font-family:var(--mono);font-size:12px;background:var(--well);padding:2px 6px;border-radius:4px">HDF_XXXXXXXX_YYYY-MM-DD.csv</span>. It contains 30-minute readings.
      </div>
      <label class="btn-secondary" style="display:block;text-align:center;cursor:pointer;margin-top:8px;padding:12px 16px;border:1px dashed var(--blue);color:var(--blue)">
        Choose CSV file
        <input id="csv-file-input" type="file" accept=".csv,.CSV" style="display:none" onchange="handleCsvFile(event)">
      </label>
    </div>

    <div id="csv-parse-result" style="margin-top:10px"></div>

    <div class="card" style="margin-top:10px;background:var(--overlay-tile)">
      <div class="card-label">CSV format — ESB Networks HDF (current format)</div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);line-height:1.9;margin-top:6px;white-space:pre-wrap">MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time
10309xxxxxx,000000000xxxxxxxxx,0.154,Active Import Interval (kWh),01-01-2025 00:30
10309xxxxxx,000000000xxxxxxxxx,0.142,Active Import Interval (kWh),01-01-2025 01:00
...</div>
      <div style="font-size:12px;color:var(--ink-dim);margin-top:8px">Supports the current ESB Networks HDF format (5-column, <b>DD-MM-YYYY</b> dates). Log in at <b>myaccount.esbnetworks.ie</b> → My Meter → Download HDF Data → select last 12 months.</div>
    </div>
  </div>
  ${bottomNav()}`;
}

function bindCsvImport(){
  const inp = document.getElementById('csv-file-input');
  if (inp){
    inp.onchange = handleCsvFile;
  }
}

function clearCsvImport(){
  if (state.current_screen === 'onboarding' && _ob.usage_mode === 'csv') _ob.usage_mode = state.usage_input_mode === 'kwh' ? 'kwh' : 'bill';
  state._csv_imported = false;
  state._csv_filename = null;
  state._csv_hourly_shape = null;
  state._csv_days = 0;
  state._csv_periods = 0;
  // CSV import wrote a derived 4-bucket shape override — clear it too so removing
  // the CSV fully reverts to the heating-type default, not a stale custom shape.
  state._shape_buckets = null;
  applyUsageInput();   // rebuild from whichever manual anchor (€ bill / kWh) is active
  invalidate();
  saveState();
  renderApp();
  showToast(state.usage_input_mode === 'kwh' ? 'Removed CSV — manual entry unlocked, usage from your yearly kWh figure' : 'Removed CSV — manual entry unlocked, usage estimated from your € bill');
}

function handleCsvFile(evt){
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const resultEl = document.getElementById('csv-parse-result');
  if (resultEl) resultEl.innerHTML = `<div class="card" style="color:var(--ink-soft);font-family:var(--mono);font-size:12px">Parsing ${file.name}…</div>`;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    parseCsvHdf(text, file.name);
  };
  reader.onerror = () => {
    if (resultEl) resultEl.innerHTML = `<div class="card" style="color:var(--red);font-family:var(--mono);font-size:12px">✗ Could not read file — make sure it\'s a plain-text CSV.</div>`;
  };
  reader.readAsText(file);
}

function parseCsvHdf(text, filename){
  const resultEl = document.getElementById('csv-parse-result');
  try {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2){
      throw new Error('File appears empty or invalid');
    }

    // Detect header and column layout
    const headerRaw = lines[0];
    const headerLow = headerRaw.toLowerCase();
    const hasHeader = headerLow.includes('date') || headerLow.includes('mprn') || headerLow.includes('read');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    // Detect column layout from header.
    // New ESB format (5 cols): MPRN, Meter Serial Number, Read Value, Read Type, Read Date and End Time
    // Old format (4 cols):     MPRN, Read Date, Read Value, Read Type
    const headerCols = headerRaw.split(',').map(c => c.trim().toLowerCase());
    const dateColIdx  = headerCols.findIndex(h => h.includes('date') || h.includes('time'));
    const valueColIdx = headerCols.findIndex(h => h.includes('value') || h.includes('kwh'));
    const typeColIdx  = headerCols.findIndex(h => h.includes('type') || h.includes('read type'));
    // Fallbacks for files without a header row
    const _dateCol  = dateColIdx  >= 0 ? dateColIdx  : 1;
    const _valueCol = valueColIdx >= 0 ? valueColIdx : 2;
    const _typeCol  = typeColIdx  >= 0 ? typeColIdx  : 3;

    // Helper: parse date string → month number (1-12)
    function parseDateMonth(s){
      if (!s) return null;
      // DD-MM-YYYY or DD/MM/YYYY (day first — ESB and most Irish formats)
      const dmy = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (dmy) return parseInt(dmy[2], 10);
      // YYYY-MM-DD ISO
      const ymd = s.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (ymd) return parseInt(ymd[2], 10);
      return null;
    }
    // Helper: parse date string → hour of day (0-23), or null
    function parseDateHour(s){
      if (!s) return null;
      const m = s.match(/(\d{1,2}):(\d{2})\s*$/);  // time at end of string
      if (m) return parseInt(m[1], 10);
      return null;
    }
    // Helper: parse date string → 4-digit year, or null.
    function parseDateYear(s){
      if (!s) return null;
      const dmy = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);  // DD-MM-YYYY
      if (dmy) return parseInt(dmy[3], 10);
      const ymd = s.match(/(\d{4})-(\d{2})-(\d{2})/);              // YYYY-MM-DD
      if (ymd) return parseInt(ymd[1], 10);
      return null;
    }
    // Helper: parse date string → unique day key "YYYY-MM-DD", or null.
    // Used to count how many distinct days of data each bucket actually has,
    // so we can normalise to a single year regardless of the file's span.
    function parseDateDayKey(s){
      if (!s) return null;
      const dmy = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);  // DD-MM-YYYY
      if (dmy) return dmy[3]+'-'+dmy[2].padStart(2,'0')+'-'+dmy[1].padStart(2,'0');
      const ymd = s.match(/(\d{4})-(\d{2})-(\d{2})/);              // YYYY-MM-DD
      if (ymd) return ymd[1]+'-'+ymd[2]+'-'+ymd[3];
      return null;
    }

    // ── Unit detection ────────────────────────────────────────────────
    // ESB HDF interval files label the read type "Active Import Interval (kW)":
    // each value is the AVERAGE POWER over a 30-minute interval, so the energy
    // for that interval is value × 0.5 kWh. Some exports are already in kWh
    // ("(kWh)") — those are used as-is. Summing kW values as kWh silently
    // doubles the user's usage, so this distinction is load-bearing.
    let _unitIsKw = false;
    for (const line of dataLines){
      const cols0 = line.split(',').map(x => x.replace(/^"|"$/g,'').trim());
      const t0 = (cols0[_typeCol] || '').toLowerCase();
      if (t0.includes('active import')){
        _unitIsKw = t0.includes('(kw)') && !t0.includes('(kwh)');
        break;
      }
    }
    const ENERGY_FACTOR = _unitIsKw ? 0.5 : 1;   // kW over 30 min → kWh

    const BIMONTHLY_KEYS = ["Jan-Feb","Mar-Apr","May-Jun","Jul-Aug","Sep-Oct","Nov-Dec"];
    const BIMONTHLY_MONTHS = [[1,2],[3,4],[5,6],[7,8],[9,10],[11,12]];
    const DAYS_NL = [31,28,31,30,31,30,31,31,30,31,30,31];  // non-leap reference
    // Pick the modal year in the file so February's length is correct for the
    // data's actual year — a leap year (e.g. 2024) has Feb 29, which would
    // otherwise make the Jan-Feb period one day short when scaling to a year.
    const _yearCounts = {};
    for (const line of dataLines){
      if (!line.trim()) continue;
      const yc = parseDateYear((line.split(',')[_dateCol] || '').replace(/^"|"$/g,'').trim());
      if (yc) _yearCounts[yc] = (_yearCounts[yc] || 0) + 1;
    }
    const _dataYear = Object.keys(_yearCounts).length
      ? +Object.keys(_yearCounts).reduce((a,b)=> _yearCounts[b] > _yearCounts[a] ? b : a)
      : new Date().getFullYear();
    const _isLeap = (_dataYear % 4 === 0 && _dataYear % 100 !== 0) || (_dataYear % 400 === 0);
    const DAYS_YR = DAYS_NL.slice(); if (_isLeap) DAYS_YR[1] = 29;
    const BIMONTHLY_DAYS = BIMONTHLY_MONTHS.map(([m1,m2]) => DAYS_YR[m1-1] + DAYS_YR[m2-1]);
    const buckets = [0,0,0,0,0,0];
    const bucketDays = [new Set(),new Set(),new Set(),new Set(),new Set(),new Set()];
    let rowsRead = 0;
    let rowsSkipped = 0;

    for (const line of dataLines){
      if (!line.trim()) continue;
      // Split by comma, handle quoted fields
      const cols = line.split(',').map(c => c.replace(/^"|"$/g,'').trim());
      if (cols.length < 3) { rowsSkipped++; continue; }

      const dateStr  = cols[_dateCol]  || '';
      const valueStr = cols[_valueCol] || '';
      const readType = cols[_typeCol]  || '';

      // Only include "Active Import" rows (consumption), skip Active Export etc.
      if (readType && !readType.toLowerCase().includes('active import')){
        rowsSkipped++;
        continue;
      }

      const val = parseFloat(valueStr);
      if (!isFinite(val) || val < 0 || val > 50) { rowsSkipped++; continue; }

      const month = parseDateMonth(dateStr);
      if (!month || month < 1 || month > 12) { rowsSkipped++; continue; }

      const bucketIdx = BIMONTHLY_MONTHS.findIndex(([m1,m2]) => month === m1 || month === m2);
      if (bucketIdx >= 0){
        buckets[bucketIdx] += val * ENERGY_FACTOR;
        const dk = parseDateDayKey(dateStr);
        if (dk) bucketDays[bucketIdx].add(dk);
        rowsRead++;
      }
    }

    if (rowsRead < 12){
      throw new Error(`Only ${rowsRead} valid readings found — need at least 12. Check the file is ESB HDF format with "Active Import" rows.`);
    }

    const maxBucket = Math.max(...buckets);
    if (maxBucket === 0) throw new Error('All consumption readings are zero — check file format');

    // Normalise each bucket to a single year.
    // bucketSum is the total kWh recorded for that bimonth across however many
    // days the file happens to cover (could be 6 months, 12 months, or 2+ years).
    // Convert to average daily kWh, then scale up to the full bimonth period.
    // This makes the annual total correct regardless of the file's time span.
    const bills = {};
    BIMONTHLY_KEYS.forEach((k, i) => {
      const daysOfData = bucketDays[i].size;
      bills[k] = (daysOfData > 0) ? Math.round((buckets[i] / daysOfData) * BIMONTHLY_DAYS[i]) : 0;
    });

    // If some buckets are empty (missing months), fill from the average of the
    // populated buckets, reshaped by the seasonal heating profile.
    const shape = (SEASONAL_SHAPE[state.heating_type] || SEASONAL_SHAPE.gas);
    const shapeMean = shape.reduce((a,b)=>a+b,0)/6;
    const filledVals = BIMONTHLY_KEYS.map((k,i)=> bills[k]>0 ? bills[k] : null).filter(v=>v!=null);
    const avgPerBucket = filledVals.length ? filledVals.reduce((a,b)=>a+b,0)/filledVals.length : 0;
    BIMONTHLY_KEYS.forEach((k, i) => {
      if (bills[k] === 0 && avgPerBucket > 0){
        bills[k] = Math.round(avgPerBucket * (shape[i] / shapeMean));
      }
    });

    // Build 24-hour load shape from real data.
    // hourBuckets[h] = total kWh across all days in this import for hour h.
    const hourBuckets = new Array(24).fill(0);
    const hourCounts  = new Array(24).fill(0);
    for (const line of dataLines){
      if (!line.trim()) continue;
      const cols = line.split(',').map(c => c.replace(/^"|"$/g,'').trim());
      if (cols.length < 3) continue;
      const dateStr2  = cols[_dateCol]  || '';
      const valueStr2 = cols[_valueCol] || '';
      const readType2 = cols[_typeCol]  || '';
      if (readType2 && !readType2.toLowerCase().includes('active import')) continue;
      const val = parseFloat(valueStr2);
      if (!isFinite(val) || val < 0 || val > 50) continue;
      // Extract hour-of-day using the same parseDateHour helper
      const hour = parseDateHour(dateStr2);
      // ESB HDF timestamps are end-of-interval: 00:30 means 00:00–00:30 → hour 0
      if (hour !== null && hour >= 0 && hour < 24){
        const bucketHour = hour === 0 ? 23 : hour - 1; // shift end-of-interval to start
        hourBuckets[bucketHour] += val * ENERGY_FACTOR;
        hourCounts[bucketHour]++;
      }
    }
    // The readings themselves, by date and hour, imports and exports — kept so
    // the app can check its own figures (a switch's saving, the panels' effect)
    // against what the meter recorded. Merged into any earlier upload, and
    // capped at the most recent 400 days.
    try {
      const ledger = {};
      for (const line of dataLines){
        if (!line.trim()) continue;
        const cols = line.split(',').map(c => c.replace(/^"|"$/g,'').trim());
        const t = (cols[_typeCol] || '').toLowerCase();
        const isImp = !t || t.includes('active import'), isExp = t.includes('active export');
        if (!isImp && !isExp) continue;
        const val = parseFloat(cols[_valueCol] || '');
        if (!isFinite(val) || val < 0 || val > 50) continue;
        const ds = cols[_dateCol] || '';
        let day = parseDateDayKey(ds);
        const tm = ds.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*$/);
        if (!day || !tm) continue;
        // ESB stamps the END of each half hour: 00:30 is 00:00–00:30, and
        // 00:00 is the last half hour of the day before.
        let start = (+tm[1]) * 60 + (+tm[2]) - 30;
        if (start < 0){ const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); day = d.toISOString().slice(0, 10); start += 1440; }
        const h = Math.floor(start / 60);
        const row = ledger[day] || (ledger[day] = new Array(48).fill(0));
        row[(isExp ? 24 : 0) + h] += val * ENERGY_FACTOR;
      }
      const merged = { ...((state.meter && state.meter.days) || {}) };
      for (const [d, v] of Object.entries(ledger)) merged[d] = v.map((x) => Math.round(x * 1000) / 1000);
      const keep = Object.keys(merged).sort().slice(-400);
      const days = {}; keep.forEach((d) => { days[d] = merged[d]; });
      if (keep.length) state.meter = { days, imported_at: new Date().toISOString() };
    } catch (e) { /* the yearly figures above do not depend on this */ }

    // Only store the hourly shape if we have good coverage (at least 20 of 24 hours with data)
    const hoursWithData = hourCounts.filter(c => c > 0).length;
    if (hoursWithData >= 20){
      const total24 = hourBuckets.reduce((a,b)=>a+b, 0);
      if (total24 > 0){
        state._csv_hourly_shape = hourBuckets.map(v => v / total24);
        // Derive the 4-bucket consumption-shape split from the real data so the
        // "Advanced — consumption shape" editor reflects the CSV, not the
        // heating-type default. Buckets cover all 24 hours; evening absorbs the
        // rounding remainder so the four values sum to exactly 100.
        const sumHrs = (hrs) => hrs.reduce((a,h)=>a + hourBuckets[h], 0) / total24;
        const night   = sumHrs([22,23,0,1,2,3,4,5]);
        const morning = sumHrs([6,7,8,9]);
        const day     = sumHrs([10,11,12,13,14,15,16]);
        const tot = night + morning + day + sumHrs([17,18,19,20,21]);
        if (tot > 0){
          const n  = Math.round(night/tot*100);
          const mo = Math.round(morning/tot*100);
          const dy = Math.round(day/tot*100);
          const ev = Math.max(0, 100 - n - mo - dy);
          state._shape_buckets = { night:n, morning:mo, day:dy, evening: ev };
        }
      }
    } else {
      state._csv_hourly_shape = null;
    }

    // ── Coverage analysis — the file may span anything from days to years.
    // Every bucket above was already normalised per-day and scaled to a full
    // bimonth, and empty buckets were extrapolated via the heating profile,
    // so the annual figure is always a proper yearly estimate. Here we just
    // measure how much real data backs it, and warn honestly when it's thin.
    const allDaysSet = new Set();
    bucketDays.forEach(s => s.forEach(d => allDaysSet.add(d)));
    const totalDays = allDaysSet.size;
    const periodsCovered = bucketDays.filter(s => s.size > 0).length;
    const sortedDays = Array.from(allDaysSet).sort();
    let spanDays = totalDays;
    if (sortedDays.length > 1){
      const t0 = new Date(sortedDays[0]).getTime(), t1 = new Date(sortedDays[sortedDays.length - 1]).getTime();
      if (isFinite(t0) && isFinite(t1)) spanDays = Math.round((t1 - t0) / 86400000) + 1;
    }
    state._csv_days = totalDays;
    state._csv_periods = periodsCovered;

    let coverageHtml;
    if (totalDays < 45){
      coverageHtml = `<div style="margin-top:10px;padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber);border-radius:8px;font-size:12px;color:var(--ink);line-height:1.6"><b style="color:var(--amber)">⚠ Only ${totalDays} day${totalDays === 1 ? '' : 's'} of data</b> — far short of a year. We scaled it to a full-year profile (per-day average × season length, missing periods filled from your ${state.heating_type} heating shape), but seasonal accuracy will be poor. Treat results as rough and import 12 months when you can.</div>`;
    } else if (totalDays < 300 || periodsCovered < 6){
      coverageHtml = `<div style="margin-top:10px;padding:10px 12px;background:var(--blue-soft);border:1px solid var(--blue);border-radius:8px;font-size:12px;color:var(--ink);line-height:1.6"><b style="color:var(--blue)">Partial year:</b> ${totalDays} days across ${periodsCovered} of 6 billing periods. Measured periods were scaled to full length${periodsCovered < 6 ? `; the ${6 - periodsCovered} missing period${6 - periodsCovered === 1 ? ' was' : 's were'} extrapolated from your data + ${state.heating_type} heating profile` : ''}. A full 12 months will sharpen the seasonal picture.</div>`;
    } else {
      coverageHtml = `<div style="margin-top:10px;padding:9px 12px;background:var(--accent-soft);border-radius:8px;font-size:12px;color:var(--ink-soft)">✓ ${totalDays} days — full-year coverage${spanDays > 400 ? ` (file spans ~${Math.round(spanDays / 365 * 10) / 10} years — averaged per day, so the result is one typical year)` : ''}.</div>`;
    }

    state.bills = bills;
    state._csv_imported = true;
    state._csv_filename = filename;
    invalidate();
    saveState();

    const total = Object.values(bills).reduce((a,b)=>a+b,0);
    if (resultEl) resultEl.innerHTML = `
      <div class="card" style="background:var(--accent-faint);border-color:var(--accent)">
        <div class="card-label" style="color:var(--accent)">✓ Imported ${rowsRead.toLocaleString()} readings</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);line-height:1.9;margin-top:6px">
          ${BIMONTHLY_KEYS.map((k,i) => `${k}: <b>${Math.round(bills[k]).toLocaleString()} kWh</b>${bucketDays[i].size === 0 ? '<span style="color:var(--amber)">*</span>' : ''}`).join(' · ')}<br>
          <b style="color:var(--accent)">Total: ${Math.round(total).toLocaleString()} kWh/yr</b> — anticipated full-year profile
          <br><span style="color:var(--ink-dim)">Readings in ${_unitIsKw ? 'kW (avg per 30-min interval) — converted ×0.5 to kWh' : 'kWh — used as-is'}</span>
          ${periodsCovered < 6 ? `<br><span style="color:var(--amber)">* extrapolated — no data for this period</span>` : ''}
          ${rowsSkipped > 0 ? `<br><span style="color:var(--ink-dim)">(${rowsSkipped.toLocaleString()} rows skipped — export/header rows)</span>` : ''}
        </div>
        ${coverageHtml}
        <button class="switch-cta" style="margin-top:12px;font-size:13px;padding:12px 16px" onclick="applyImportedBills()">Use this data →</button>
      </div>`;
    fireEvent('csv_imported', { rows: rowsRead, total_kwh: Math.round(total), region: state.region });
  } catch(e){
    if (resultEl) resultEl.innerHTML = `
      <div class="card" style="border-color:var(--red);background:rgba(255,23,68,.06)">
        <div class="card-label" style="color:var(--red)">✗ Parse error</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--ink-soft);margin-top:6px;line-height:1.6">${e.message}</div>
      </div>`;
  }
}

function applyImportedBills(){
  invalidate();
  saveState();
  if (state.current_screen === 'onboarding' || state.current_screen === 'fastpath'){
    // Mid-setup import: lock it in and carry on with the flow instead of
    // yanking the user out to the result screen.
    state._fp_csv_mode = false;
    showToast('Smart meter data locked in — continue your setup');
    renderApp();
    return;
  }
  if (state.current_screen === 'flow'){
    (state._flow = state._flow || {}).bill = 'meter';
    state._flow_edit = null;
    showToast('Meter data in: built on your real year', { type: 'accent', icon: ic('checkC', 16) });
    renderApp();
    return;
  }
  if (state._sheet && state._sheet.kind === 'meter'){
    // Uploaded from a challenge or an alert: stay where you were; the score
    // and the figures update around you.
    state._sheet = null;
    showToast('Meter data in: your figures now use your real readings', { type: 'accent', icon: ic('checkC', 16) });
    renderApp();
    return;
  }
  showToast('Smart meter data applied — results updated');
  setScreen('result');
}

/* ============================================================
   SPRINT 4 — METHODOLOGY / ABOUT PAGE (T1)
   ============================================================ */
function renderMethodology(){
  return `${topbar('How it works', 'sage', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="setScreen('refine')">← Advanced</button>
    </div>

    <div class="qr-hero" style="border-color:var(--ink-soft);box-shadow:none">
      <div class="qr-eyebrow" style="color:var(--ink-soft)">${BRAND.name}</div>
      <div style="font-family:var(--display);font-size:20px;font-weight:700;color:var(--ink)">Methodology &amp; About</div>
      <div class="qr-sub">How we calculate your best electricity plan and solar payback — completely transparent.</div>
    </div>

    <div class="card" style="margin-top:0">
      <div class="card-label">${ic('bolt',13)} Electricity cost simulation</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        We simulate <b>8,760 hourly intervals</b> (one per hour of the year) for every plan. Your annual consumption is distributed using an industry-standard Irish load profile (ESBN EAB profile), scaled to your bimonthly bill and adjusted for heating type (gas vs heat-pump vs direct electric).<br><br>
        For each hour we calculate the import cost at the applicable rate band, plus any export income from solar. The total includes the standing charge and the PSO levy. We run this for all ${TARIFFS.length} plans and rank them by total annual cost.
      </div>
    </div>

    <div class="card">
      <div class="card-label">${ic('sun',13)} Solar generation model</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        Solar generation uses <b>PVGIS-calibrated irradiance data</b> for Ireland, broken into regional GHI (Global Horizontal Irradiance) multipliers: South +6%, East/West ±0%, North-West −6%. Your panel count, tilt, azimuth, and panel wattage (default 460W N-Type) are used to compute hourly generation.<br><br>
        We apply a <b>0.4% annual degradation rate</b> (industry conservative) and model battery dispatch as: (1) solar → self-use, (2) excess → charge battery, (3) battery discharges in high-rate hours to offset import.<br><br>
        Export income uses the <b>CEG (Clean Export Guarantee)</b> rate from your chosen plan.
      </div>
    </div>

    <div class="card">
      <div class="card-label">${ic('battery',13)} Battery dispatch strategy</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        With a battery, we support three strategies:<br><br>
        <b>Self-consume:</b> Charge from solar, discharge to offset import. Never charge from grid.<br><br>
        <b>Arbitrage:</b> Charge during cheap night/EV tariff windows, discharge during day. Best for TOU and EV tariffs with a cheap overnight rate.<br><br>
        <b>Export-priority:</b> Maximise CEG export income by minimising self-use. Good when export rates are high.<br><br>
        Battery cycle efficiency defaults to 92% round-trip. We cap battery cycles at 1.2/day to model realistic degradation.
      </div>
    </div>

    <div class="card">
      <div class="card-label">${ic('shield',13)} SEAI grants</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        We use the <b>2024 SEAI Home Solar Scheme</b> structure:<br>
        • First 2 kWp: €900/kWp (max €1,800 panels)<br>
        • Next 2 kWp: €300/kWp (max €600 additional)<br>
        • Battery storage ≥2 kWh: +€600<br>
        • Maximum total grant: €3,000<br><br>
        Grants are applied to your net cost for NPV and payback calculations. SEAI grants require a registered installer — check <b>seai.ie</b> for the current approved contractor list.
      </div>
    </div>

    <div class="card">
      <div class="card-label">${ic('chart',13)} Tariff data</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        We track <b>${TARIFFS.length} Irish residential electricity plans</b> across 7 suppliers. Rates are sourced directly from supplier websites and include 9% VAT. We show a "Verified" date on each plan — our automated checker scrapes supplier sites regularly to flag any significant rate changes.<br><br>
        <b>Limitations:</b> Dynamic plans (Bord Gáis SmartSave, EI DynaMo, Energia Flex) use a modelled wholesale price curve, not live SEMOpx data. Actual dynamic plan bills will vary based on real-time market prices.
      </div>
    </div>

    <div class="card">
      <div class="card-label">${ic('link',13)} Independence &amp; revenue</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        ${BRAND.name} is independent and currently takes no money from suppliers, installers or anyone else. There is no referral fee behind the switch links. Rankings are calculated purely from your simulated annual cost. If we ever introduce a commercial arrangement, it will be stated here first.<br><br>
        We do not sell your data. All calculations happen in your browser. Your inputs are stored only in your own device's local storage.
      </div>
    </div>

    <div class="card" style="background:rgba(0,230,118,.04);border-color:var(--accent)">
      <div class="card-label" style="color:var(--accent)">${ic('doc',13)} Contact</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        Found an error in a tariff rate? Have a question about the methodology?<br>
        Email: <b style="color:var(--accent)">hello@solaroptimiser.ie</b><br><br>
        Rate corrections are applied within 48 hours.
      </div>
    </div>

    <p class="disclaimer">
      <b>Disclaimer.</b> All figures are estimates. Actual energy bills, solar generation, and payback periods will vary depending on weather, metering, supplier changes, and individual consumption patterns. ${BRAND.name} is not a regulated financial or energy advisor.
    </p>
  </div>
  ${bottomNav()}`;
}

/* ============================================================
   SPRINT 4 — IMPROVED INSTALLER LEAD FORM (B3)
   Qualification fields + detailed spec capture
   ============================================================ */
const LEAD_COUNTIES = ['Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin', 'Galway', 'Kerry', 'Kildare',
  'Kilkenny', 'Laois', 'Leitrim', 'Limerick', 'Longford', 'Louth', 'Mayo', 'Meath', 'Monaghan', 'Offaly',
  'Roscommon', 'Sligo', 'Tipperary', 'Waterford', 'Westmeath', 'Wexford', 'Wicklow'];
// Must match CONSENT_TEXT_V1 in api/_lead.js — the server stores its own copy.
const LEAD_CONSENT_TEXT = `I agree that ${BRAND.name} may share my name, contact details, county and the system modelled here with up to three SEAI-registered installers so they can contact me with a quote.`;

/** What the installers receive about the system: the spec and its modelled economics. */
function leadSpec(){
  const kwp = totalKwp();
  let payback = null, benefit = null;
  try {
    const sc = computeSolarPaybackScenarios();
    const cur = state.ev_active ? sc.withEv : sc.withoutEv;
    if (cur && cur.payback < 50) payback = +cur.payback.toFixed(1);
    if (cur) benefit = Math.round(cur.solarBenefit);
  } catch (e) { /* the spec alone is still a lead */ }
  return {
    panels: totalPanels(), kwp: +kwp.toFixed(2), battery_kwh: state.battery_kwh || 0,
    annual_kwh: Math.round(Object.values(state.bills).reduce((a, b) => a + b, 0)),
    ev: !!state.ev_active, heating: state.heating_type || '',
    payback_years: payback, annual_benefit_eur: benefit,
    has_solar_now: !!state.has_solar && !state.solar_planned && !state.considering_solar,
    uploaded_quote: (state.solar_quotes || []).some((q) => q.source === 'upload'),
  };
}

function openLeadForm(){
  const m = document.createElement('div');
  m.id = 'lead-modal';
  m.className = 'modal-overlay';
  const sp = leadSpec();
  const lf = state._lead_form || {};
  m.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-height:90vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>${lf.sent_at ? 'Update your <em>quote request</em>' : 'Get up to <em>3 installer quotes</em>'}</h3>
      ${lf.sent_at ? `<p style="font-size:12px;color:var(--ink-dim);margin:-4px 0 10px">Sent ${new Date(lf.sent_at).toLocaleDateString('en-IE')}. Change anything and send again — installers who have it see the update; nobody is charged twice.</p>` : ''}
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:14px;line-height:1.6">SEAI-registered installers covering your county. They see the system below and contact you directly.</p>
      <div style="background:var(--well);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:var(--ink-soft);line-height:1.6">
        <b style="color:var(--ink)">${sp.panels} panels · ${sp.kwp} kWp${sp.battery_kwh ? ` · ${sp.battery_kwh} kWh battery` : ''}</b>${sp.payback_years ? `<br>Modelled payback ${sp.payback_years} years` : ''}
      </div>
      <label class="lead-field"><span>Email *</span>
        <input id="lead-email" class="modal-input" type="email" autocomplete="email" value="${escAttr(lf.email || state.user_email || '')}"></label>
      <label class="lead-field"><span>County *</span>
        <select id="lead-county" class="modal-input"><option value="">Choose…</option>
          ${LEAD_COUNTIES.map((c) => `<option ${lf.county === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="lead-field"><span>Name</span>
        <input id="lead-name" class="modal-input" type="text" autocomplete="name" value="${escAttr(lf.name || '')}"></label>
      <label class="lead-field"><span>Phone</span>
        <input id="lead-phone" class="modal-input" type="tel" autocomplete="tel" value="${escAttr(lf.phone || '')}"></label>
      <label class="lead-field"><span>Eircode routing key (first 3 characters)</span>
        <input id="lead-eircode" class="modal-input" type="text" maxlength="3" placeholder="e.g. T12" value="${escAttr(lf.eircode_area || '')}"></label>
      <label class="lead-field"><span>When are you hoping to install?</span>
        <select id="lead-timeline" class="modal-input">
          ${[['asap', 'As soon as possible'], ['3m', 'Within 3 months'], ['6m', 'Within 6 months'], ['12m', 'Within a year'], ['browsing', 'Just exploring']]
            .map(([v, t]) => `<option value="${v}" ${lf.timeline === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="lead-consent"><input id="lead-consent" type="checkbox"> <span>${LEAD_CONSENT_TEXT}</span></label>
      <div id="lead-error" class="lead-error" role="alert"></div>
      <button class="modal-btn" id="lead-submit" onclick="submitLeadForm()">Send my request →</button>
      <button class="modal-skip" onclick="closeLeadModal()">Not now</button>
      <div class="modal-privacy">We never sell your data. Installers pay us for introductions; that never changes which plan or system we show you. <a href="#" onclick="event.preventDefault();closeLeadModal();setScreen('privacy')">Privacy</a></div>
    </div>`;
  m.onclick = closeLeadModal;
  document.body.appendChild(m);
  setTimeout(() => { const el = document.getElementById('lead-email'); if (el && !el.value) el.focus(); }, 100);
}

function closeLeadModal(){
  const m = document.getElementById('lead-modal');
  if (m) m.remove();
}

async function submitLeadForm(){
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const err = (msg) => { const e = document.getElementById('lead-error'); if (e) e.textContent = msg; };
  const body = {
    email: val('lead-email'), county: val('lead-county'), name: val('lead-name') || null,
    phone: val('lead-phone') || null, eircode_area: val('lead-eircode') || null, timeline: val('lead-timeline'),
    consent_share: !!document.getElementById('lead-consent')?.checked,
    spec: leadSpec(), session_id: analyticsSession(),
  };
  // Remembered on this device so a failed send never loses what was typed.
  state._lead_form = { email: body.email, county: body.county, name: body.name, phone: body.phone, eircode_area: body.eircode_area, timeline: body.timeline };
  saveState();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return err('Please enter a valid email address.');
  if (!body.county) return err('Please choose your county.');
  if (!body.consent_share) return err('Tick the box so we can pass your details to installers.');
  const btn = document.getElementById('lead-submit');
  if (btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    // Signed in: the server links the request to the account (My Peakless lists it).
    try { const t = _sb && (await _sb.auth.getSession()).data.session?.access_token; if (t) headers.Authorization = 'Bearer ' + t; } catch (e) {}
    const res = await fetch('/api/lead', { method: 'POST', headers, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Your request could not be sent. Please try again.');
    captureEmail(body.email, 'installer_quotes');
    state._lead_form = { ...state._lead_form, sent_at: state._lead_form.sent_at || new Date().toISOString() };
    saveState();
    trackEvent('lead_submitted', { county: body.county, timeline: body.timeline, battery: body.spec.battery_kwh > 0 });
    closeLeadModal();
    showToast(out.updated ? `Updated. ${out.matched > 0 ? `The installer${out.matched > 1 ? 's' : ''} already looking at it will see your new details.` : 'We have your latest details.'}`
      : out.matched > 0 ? `Sent to ${out.matched} installer${out.matched > 1 ? 's' : ''} in ${body.county}. They'll contact you directly.`
      : `Saved. We don't have a partner installer in ${body.county} yet — we'll email you when we do.`,
      { type: 'accent', icon: ic('checkC', 16) });
  } catch (e) {
    err((e && e.message) || 'Your request could not be sent. Please try again.');
    if (btn){ btn.disabled = false; btn.textContent = 'Send my request →'; }
  }
}

/* ============================================================
   SPRINT 4 — PDF REPORT VIA EMAIL (F4)
   Sends state snapshot to server → server generates PDF → emails it
   ============================================================ */
function openPdfReportModal(){
  const m = document.createElement('div');
  m.id = 'pdf-modal';
  m.className = 'modal-overlay';
  const best = state.onboarding_complete ? getBestPlan() : null;
  const baselinePlan = state.baseline ? getPlanById(state.baseline) : null;
  const baseSim = state.baseline && state.onboarding_complete ? baselineSim(state.baseline) : null;
  const baseCost = baseSim ? sumF(baseSim.cost) + baselinePlan.standing + PSO_LEVY : 0;
  const annualSavings = best ? Math.max(0, baseCost - best.net) : 0;

  m.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-handle"></div>
      <h3>Download &amp; email your report</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:12px;line-height:1.6">
        Your personalised PDF includes: plan comparison, solar payback (if modelled), SEAI grant estimate, and a switching guide.
        ${best ? `<br><br><b style="color:var(--accent)">Save ${fmtCurrency(publishableSavings())}/yr by switching to ${best.plan.supplier}${state.solar_planned ? ' (excludes your planned solar)' : ''}</b>` : ''}
      </p>
      <div style="padding:10px 12px;background:rgba(41,182,246,.07);border-radius:8px;border:1px solid rgba(41,182,246,.25);margin-bottom:14px;font-size:12px;color:var(--ink-soft);line-height:1.65;font-family:var(--mono)">
        ① PDF saves to your <b style="color:var(--ink)">Downloads</b> folder<br>
        ② Your <b style="color:var(--ink)">email app opens</b> pre-filled with a summary<br>
        ③ Attach the PDF and tap Send (or share it later)
      </div>
      <input id="pdf-email" class="modal-input" type="email" placeholder="you@example.com (optional)" autocomplete="email" value="${state.user_email || ''}">
      <button class="modal-btn" id="pdf-submit-btn" onclick="submitPdfRequest()">Download PDF →</button>
      <button class="modal-skip" onclick="closePdfModal(); doGeneratePdf('')">Download only (no email)</button>
      <div class="modal-privacy" style="margin-top:8px">This is a static app — the PDF is generated on your device, not sent from a server.</div>
    </div>`;
  m.onclick = closePdfModal;
  document.body.appendChild(m);
  setTimeout(() => { const el = document.getElementById('pdf-email'); if(el && !el.value) el.focus(); }, 100);
}

function closePdfModal(){
  const m = document.getElementById('pdf-modal');
  if (m) m.remove();
}

function submitPdfRequest(){
  const email = (document.getElementById('pdf-email')?.value || '').trim();
  const btn = document.getElementById('pdf-submit-btn');
  if (btn){ btn.disabled = true; btn.textContent = 'Generating…'; }
  if (email) captureEmail(email, 'pdf_report');
  closePdfModal();
  // Generate PDF client-side and open mailto if email provided
  doGeneratePdf(email);
}

// Expose globals for inline onclick attrs
window.obNext = obNext;
window.obBack = obBack;
window.renderApp = renderApp;
window.navigateAuditor = navigateAuditor;
window.exploreSolar = exploreSolar;
window.handleSwitchClick = handleSwitchClick;
window.setScreen = setScreen;
window.v7Sheet = v7Sheet;
window.sysSet = sysSet;
window.sysPreview = sysPreview;
window.sysFine = sysFine;
window.sysSplit = sysSplit;
window.sysGrant = sysGrant;
window.sysTypicalPrice = sysTypicalPrice;
window.openMySystem = openMySystem;
window.homeSet = homeSet;
window.openMyHome = openMyHome;
window.questDone = questDone;
window.sgCancel = sgCancel;
window.flowSupplier = flowSupplier;
window.sgKeep = sgKeep;
window.sgGrant = sgGrant;
window.anTab = anTab;
window.anPick = anPick;
window.removeEv = removeEv;
window.toggleEvModel = toggleEvModel;
window.undoLast = undoLast;
window._undoKeep = _undoKeep;
window.useGoalDesign = useGoalDesign;
window.startSolarGuide = startSolarGuide;
window.startFlow = startFlow;
window.plannedSolarSplit = plannedSolarSplit;
window.flowAnswer = flowAnswer;
window.flowEdit = flowEdit;
window.flowFinish = flowFinish;
window.startEvGuide = startEvGuide;
window.egGo = egGo;
window.egSet = egSet;
window.egDone = egDone;
window.egCancel = egCancel;
window.sgGo = sgGo;
window.sgDone = sgDone;
window.sgRoof = sgRoof;
window.sgBattery = sgBattery;
window.getAdvice = getAdvice;
window.householdScore = householdScore;
window.realityChecks = realityChecks;
window.recordSwitch = recordSwitch;
window.recordInstall = recordInstall;
window.removeJourney = removeJourney;
window.journeyCommit = journeyCommit;
window.markAlertsSeen = markAlertsSeen;
window.computeAlerts = computeAlerts;
window.journeyTotal = journeyTotal;
window.setSolarInstalled = setSolarInstalled;
window.handoverKeep = handoverKeep;
// Pure sync rules, exposed for the tests.
window.__sync = { cloudCopy, setupKey, mergeQuotes };
window.quoteToSystem = quoteToSystem;
window.meOpenAuth = meOpenAuth;
window.modelAccuracy = modelAccuracy;
window.clearThisDevice = clearThisDevice;
window.startFresh = startFresh;
window.deleteMyAccount = deleteMyAccount;
window.setLeadStatus = setLeadStatus;
window.setAnalyticsConsent = setAnalyticsConsent;
window.submitLeadForm = submitLeadForm;
window.isPartnerPlan = isPartnerPlan;
window.v7QuoteFile = v7QuoteFile;
window.v7QuoteReset = v7QuoteReset;
window.v7ApplyQuote = v7ApplyQuote;
window.__setQuoteRead = (q) => { _quoteRead = q; };
window.toggleSolarModel = toggleSolarModel;
window.v7Choose = v7Choose;
window.v7OpenMonth = v7OpenMonth;
window.v7GoMonth = v7GoMonth;
window.v7MonthScrolled = v7MonthScrolled;
window.toggleEv = toggleEv;
window.requestInstallerQuotes = requestInstallerQuotes;
window.openEmailModal = openEmailModal;
window.closeEmailModal = closeEmailModal;
window.submitModalEmail = submitModalEmail;
window.runAudit = runAudit;
window.refineChanged = refineChanged;
window.restartOnboarding = restartOnboarding;
window.confirmResetAll = confirmResetAll;
window.startOnboarding = startOnboarding;
window.confirmExitOnboarding = confirmExitOnboarding;
window.setObAzA = setObAzA;
window.setObAzB = setObAzB;
window.toggleRoofB = toggleRoofB;
window.showPlanDetail = showPlanDetail;
window.pickObHeating = pickObHeating;
window.setAnalyticsDay = setAnalyticsDay;
window.anMonth = anMonth;
window.useSystem = useSystem;
window.saveSystemAs = saveSystemAs;
window.removeSavedSystem = removeSavedSystem;
window.useQuote = useQuote;
window.designToConfig = designToConfig;
window.systemOutcome = systemOutcome;
window.quoteChanges = quoteChanges;
window.quoteOutcomes = quoteOutcomes;
window.sgTwo = sgTwo;
window.azFromWords = azFromWords;
window.quoteFaces = quoteFaces;
window.downloadMyData = downloadMyData;
window.setStrategy = setStrategy;
window.setHotWater = setHotWater;
window.updateShapeBucket = updateShapeBucket;
window.setShapePreset = setShapePreset;
window.clearShapeOverride = clearShapeOverride;
window.editPlanRate = editPlanRate;
window.editPlanField = editPlanField;
window.resetPlanOverride = resetPlanOverride;
window.setAsBaseline = setAsBaseline;
// Auth handlers. These are invoked from inline on* attributes, which evaluate
// in global scope, so a module-scoped function is simply not in scope there.
// All seven were missed when the app moved to ES modules, which left every
// authentication path — sign in, sign up, Google, sign out, password reset,
// profile save, cloud sync — throwing ReferenceError on click with no visible
// effect. Nothing in the interface said anything had gone wrong.
window.doGoogleSignIn   = doGoogleSignIn;
window.doSignIn         = doSignIn;
window.doSignUp         = doSignUp;
window.doSignOut        = doSignOut;
window.doForgotPassword = doForgotPassword;
window.doUpdateProfile  = doUpdateProfile;
window.doSyncState      = doSyncState;
window.choosePlan = choosePlan;
window.openPlanPicker = openPlanPicker;
window.applyBestDesign = applyBestDesign;
window.bestDesign = bestDesign;
window.sweepGoalDesigns = sweepGoalDesigns;
window.arbitrageOn = arbitrageOn;
window.hardRefreshApp = hardRefreshApp;
window.reportOAuthReturn = reportOAuthReturn;
window.captureOAuthReturn = captureOAuthReturn;
window.reportOAuthSilence = reportOAuthSilence;
window.deliverPdf = deliverPdf;
window.ensureJsPdf = ensureJsPdf;
window.STRATEGY_TRACE = STRATEGY_TRACE;
window.effectiveStrategy = effectiveStrategy;
window.SIM_FIELDS = SIM_FIELDS;
window.withSimState = withSimState;
window.snapshotSim = snapshotSim;
window.setPlansSort = setPlansSort;
window.toggleCompare = toggleCompare;
window.clearCompare = clearCompare;
window.openCompare = openCompare;
window.pickPlan = pickPlan;
window.clearChosenPlan = clearChosenPlan;
window.openPlanDetail = openPlanDetail;
window.toggleNpvBreakdown = toggleNpvBreakdown;
window.setRegion = setRegion;
window.setObBaseline = setObBaseline;
window.refreshTariffs = refreshTariffs;
window.toggleMonitoring = toggleMonitoring;
window.setContractReminder = setContractReminder;
window.clearContractDate = clearContractDate;
window.addQuote = addQuote;
window.removeQuote = removeQuote;
window.fastPathGo = fastPathGo;
window.fpSync = fpSync;
window.fpCycle = fpCycle;
window.setTheme = setTheme;
window.goFastPath = goFastPath;
window.goLanding = goLanding;
window.reRunOnboarding = reRunOnboarding;
window.solarEstCycle = solarEstCycle;
window.goRefineSolar = goRefineSolar;
window.applyOptimisation = applyOptimisation;
window.fpTogglePlanPicker = fpTogglePlanPicker;
window.fpPickPlan = fpPickPlan;
window.goBack = goBack;
window.markSolarAsMine = markSolarAsMine;
window.toggleOptExpand = toggleOptExpand;
window.removeOptimisation = removeOptimisation;
window.saveContractDate = saveContractDate;
window.cancelContractEdit = cancelContractEdit;
window.setEvMode = setEvMode;
window.calibrateBillsToBaseline = calibrateBillsToBaseline;
window.shareSavingsCard = shareSavingsCard;
window.computeScenarioRange = computeScenarioRange;
window.computeSolarPaybackScenarios = computeSolarPaybackScenarios;
window.computeOptimisations = computeOptimisations;
window.cachedScenario = cachedScenario;
window.startGoalDesign = startGoalDesign;
window.applyGoalDesign = applyGoalDesign;
window.setSolarView = setSolarView;
window.commitGoalDesign = commitGoalDesign;
window.copyShareUrl = copyShareUrl;
window.openHowToSwitch = openHowToSwitch;
window.openLeadForm = openLeadForm;
window.closeLeadModal = closeLeadModal;
window.submitLeadForm = submitLeadForm;
window.openPdfReportModal = openPdfReportModal;
window.closePdfModal = closePdfModal;
window.submitPdfRequest = submitPdfRequest;
window.clearCsvImport = clearCsvImport;
window.handleCsvFile = handleCsvFile;
window.parseCsvHdf = parseCsvHdf;
window.applyImportedBills = applyImportedBills;
window.trackPlanView = trackPlanView;
window.toggleTrust = toggleTrust;
window.toggleSettingsSection = toggleSettingsSection;
window.setPlansFilter = setPlansFilter;
window.showToast = showToast;
/* Engine surface published for the parity e2e suite (and console debugging). */
window.CACHE = CACHE;
window.TARIFFS = TARIFFS;
window.rebuildBase = rebuildBase;
window.applyRegion = applyRegion;
window.getRecommendation = getRecommendation;
window.getBestPlan = getBestPlan;
window.v7SolarData = v7SolarData;
window.sim = sim;
window.annualCost = annualCost;
window.getPlanById = getPlanById;
window.__annual = (s, p) => annualCost(s, p).net;   // tests: a plan's comparable yearly cost
window.bandAt = bandAt;
window.calcNPV20 = calcNPV20;

/* ---------------------------------------------------------------
 * Live bridge for module-scoped state touched by inline on* attributes.
 *
 * Inline handlers evaluate in global scope, so `onclick="state.x=1"` and
 * `onclick="_introStep=3"` need these bindings on window. A plain
 * `window.state = state` copy is not enough: every one of these is a `let`
 * that gets REASSIGNED in module code (_ob = makeOb(), _sbUser = ..., etc.),
 * so a snapshot would go stale, and assigning a primitive from an inline
 * handler would write to a dead global the module never reads.
 *
 * Accessors keep both directions live. Phase 4 replaces inline handlers with
 * delegated listeners and this bridge is deleted.
 * --------------------------------------------------------------- */
Object.defineProperties(window, {
  state:          { get: () => state,          set: v => { state = v; },          configurable: true },
  _ob:            { get: () => _ob,            set: v => { _ob = v; },            configurable: true },
  _sbUser:        { get: () => _sbUser,        set: v => { _sbUser = v; },        configurable: true },
  // Bridged so a test can take the client away and prove the sign-in form
  // still answers. Without this a test that nulls it proves nothing.
  _sb:            { get: () => _sb,            set: v => { _sb = v; },            configurable: true },
  _introStep:     { get: () => _introStep,     set: v => { _introStep = v; },     configurable: true },
  _authModalOpen: { get: () => _authModalOpen, set: v => { _authModalOpen = v; }, configurable: true },
  _authEmailView: { get: () => _authEmailView, set: v => { _authEmailView = v; }, configurable: true },
});

/* ---------------------------------------------------------------
 * Inline on* attributes resolve against the global scope. Under a
 * classic <script> these were implicit globals; as an ES module they
 * are module-scoped, so the handlers referenced from HTML strings
 * must be published explicitly. Phase 4 replaces inline handlers with
 * delegated listeners and this block goes away.
 * --------------------------------------------------------------- */
window.deleteScenario = deleteScenario;
window.doGeneratePdf = doGeneratePdf;
window.fpSetUsageMode = fpSetUsageMode;
window.introBack = introBack;
window.introNext = introNext;
window.introSignInEmail = introSignInEmail;
window.invalidate = invalidate;
window.loadScenario = loadScenario;
window.obAdj = obAdj;
window.obSetVal = obSetVal;
window.openTariffPopup = openTariffPopup;
window.rfAdj = rfAdj;
window.rfSet = rfSet;
window.saveCurrentScenario = saveCurrentScenario;
window.saveState = saveState;
window.sbInitialized = sbInitialized;
window.setObUsageMode = setObUsageMode;
window.setUsageMode = setUsageMode;
window.toggleCompareSelect = toggleCompareSelect;

/* ============================================================
   PWA LAYER — installable, offline-capable web app.
   Kept entirely separate from the app engine: this block only
   wires up a manifest + service worker and can never affect the
   simulation. All steps are wrapped so a failure degrades to a
   normal (online) web page rather than breaking anything.
   ============================================================ */
(function(){
  // ---- 1. Inline web app manifest (data URI, no extra file needed) ----
  try {
    var ICON_LARGE = iconDataUri(512);
    var manifest = {
      name: BRAND.name + " — Irish Energy Advisor",
      short_name: BRAND.name,
      description: "Find the cheapest Irish electricity plan for your home — with or without solar, battery or EV.",
      start_url: ".",
      scope: ".",
      display: "standalone",
      orientation: "portrait",
      background_color: BRAND.ink,
      theme_color: BRAND.ink,
      categories: ["utilities", "finance", "productivity"],
      lang: "en-IE",
      icons: [
        { src: ICON_LARGE, sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
        { src: ICON_LARGE, sizes: "192x192", type: "image/svg+xml", purpose: "any" }
      ]
    };
    var blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("link");
    link.rel = "manifest";
    link.href = url;
    document.head.appendChild(link);
  } catch (e) { /* manifest optional — app still works */ }

  // ---- 2. Inline service worker for offline use ----
  // Network-first for the page so users always get the latest version when
  // online, falling back to the cached copy when offline. Fonts are
  // cache-first (they never change). This makes the app open with no
  // connection after the first visit.
  try {
    if ("serviceWorker" in navigator) {
      var SW_SRC = [
        "const CACHE = 'solar-optimiser-v3';",
        "const APP_URL = self.registration.scope;",
        "self.addEventListener('install', function(e){ self.skipWaiting(); });",
        "self.addEventListener('activate', function(e){",
        "  e.waitUntil((async function(){",
        "    const keys = await caches.keys();",
        "    await Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));",
        "    await self.clients.claim();",
        "  })());",
        "});",
        "self.addEventListener('fetch', function(e){",
        "  const req = e.request;",
        "  if (req.method !== 'GET') return;",
        "  const url = new URL(req.url);",
        "  const isFont = url.hostname.indexOf('fonts.g') !== -1;",
        "  const isDoc = req.mode === 'navigate' || (req.destination === 'document');",
        "  if (isFont) {",
        "    e.respondWith((async function(){",
        "      const cache = await caches.open(CACHE);",
        "      const hit = await cache.match(req);",
        "      if (hit) return hit;",
        "      try { const res = await fetch(req); if (res && res.ok) cache.put(req, res.clone()); return res; }",
        "      catch (err) { return hit || Response.error(); }",
        "    })());",
        "    return;",
        "  }",
        "  if (isDoc) {",
        "    e.respondWith((async function(){",
        "      try {",
        "        const res = await fetch(req, { cache: 'reload' });",
        "        const cache = await caches.open(CACHE);",
        "        cache.put(req, res.clone());",
        "        return res;",
        "      } catch (err) {",
        "        const cache = await caches.open(CACHE);",
        "        const hit = await cache.match(req) || await cache.match(APP_URL) || await cache.match('./') || await cache.match('index.html');",
        "        return hit || Response.error();",
        "      }",
        "    })());",
        "    return;",
        "  }",
        "});"
      ].join("\n");
      var swBlob = new Blob([SW_SRC], { type: "text/javascript" });
      var swUrl = URL.createObjectURL(swBlob);
      window.addEventListener("load", function(){
        navigator.serviceWorker.register(swUrl, { updateViaCache: "none" }).then(function(reg){
          // Force an update check every launch so the installed PWA never lingers
          // on a stale build. When a new worker activates, reload once to swap in
          // the fresh code (guarded so it only reloads a single time).
          try { reg.update(); } catch (e) {}
          reg.addEventListener("updatefound", function(){
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener("statechange", function(){
              if (nw.state === "activated" && navigator.serviceWorker.controller && !window.__sw_reloaded){
                window.__sw_reloaded = true;
                location.reload();
              }
            });
          });
        }).catch(function(){ /* offline support optional */ });
        // Belt-and-braces: if the controller changes (new SW took over), reload once.
        var refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", function(){
          if (refreshing) return; refreshing = true;
          if (!window.__sw_reloaded){ window.__sw_reloaded = true; location.reload(); }
        });
      });
    }
  } catch (e) { /* service worker optional — app still works online */ }

  // ---- 3. Custom "Add to Home Screen" hook (Android/desktop Chrome) ----
  // Captures the install prompt so the app can offer installation from a
  // button later if desired. Exposed globally; safe no-op if unsupported.
  try {
    window.addEventListener("beforeinstallprompt", function(e){
      e.preventDefault();
      window._deferredInstallPrompt = e;
    });
    window.promptInstall = function(){
      var p = window._deferredInstallPrompt;
      if (p && p.prompt) { p.prompt(); window._deferredInstallPrompt = null; }
    };
  } catch (e) {}
})();
