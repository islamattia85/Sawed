import {
  HOURS_IN_YEAR, DAYS_IN_MONTH, DEG, LOCATION_BASE, dayOfYear,
} from './engine/constants';
import {
  solarPosition, erbsDiffuse, buildHourlyGhi, buildPoa, buildPvGeneration,
} from './engine/solar';
import { npv20 as engineNpv20 } from './engine/npv';
import { buildReportData, renderReport } from './pdf/index.js';
import {
  isInWindow, bandAt, rateAt as engineRateAt, isFlatPlan,
  simulateBaseline as engineSimulateBaseline, annualCost, sumF, WHOLESALE_CAP,
} from './engine/tariff-rules';

/* Solar Optimiser — application entry.
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
  try {
    // Dynamically load Supabase JS SDK
    await new Promise((resolve, reject) => {
      if (window.supabase) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { session } } = await _sb.auth.getSession();
    if (session) {
      _sbUser = session.user;
      await sbLoadProfile();
    }
    _sb.auth.onAuthStateChange(async (event, session) => {
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

async function sbLoadProfile(){
  if (!_sb || !_sbUser) return;
  try {
    const { data } = await _sb.from('profiles').select('*').eq('id', _sbUser.id).single();
    _sbProfile = data;
    if (_sbProfile && _sbProfile.app_state) {
      const remote = typeof _sbProfile.app_state === 'string'
        ? JSON.parse(_sbProfile.app_state) : _sbProfile.app_state;
      state = deepMerge(state, remote);
      saveState();
    }
  } catch(e){}
}

async function sbSaveProfile(extraFields){
  if (!_sb || !_sbUser) return;
  try {
    const payload = {
      id: _sbUser.id,
      email: _sbUser.email,
      app_state: JSON.stringify(state),
      updated_at: new Date().toISOString(),
      ...(extraFields || {}),
    };
    await _sb.from('profiles').upsert(payload, { onConflict: 'id' });
  } catch(e){}
}

async function sbSignUp(email, password, displayName){
  const { error } = await _sb.auth.signUp({
    email, password,
    options: { data: { display_name: displayName } }
  });
  return error;
}

async function sbSignIn(email, password){
  const { error } = await _sb.auth.signInWithPassword({ email, password });
  return error;
}

async function sbSignOut(){
  if (_sb) await _sb.auth.signOut();
  _sbUser = null; _sbProfile = null;
  renderApp();
}

async function sbResetPassword(email){
  const { error } = await _sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href
  });
  return error;
}

function sbInitialized(){ return !!(SUPABASE_URL && SUPABASE_ANON_KEY); }

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
          <div style="font-size:11px;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_sbUser.email}</div>
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
    <div style="font-size:11px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-dim);text-align:center;margin-bottom:12px;font-weight:600">Save your results across devices</div>
    <button class="auth-google-btn" onclick="doGoogleSignIn()">
      ${GOOGLE_SVG} Continue with Google
    </button>
    <div class="auth-divider" style="margin:10px 0">or email</div>
    ${emailOpen ? emailForm : `
      <button onclick="window._authEmailOpen=true;renderApp()" style="width:100%;padding:10px;border-radius:10px;border:1.5px solid var(--line);background:transparent;font-family:var(--display);font-size:13px;font-weight:600;color:var(--ink-soft);cursor:pointer">Continue with email</button>
    `}
  </div>`;
}

/* Profile modal — opened from topbar avatar */
function renderAuthModal(){
  if (!_authModalOpen) return '';
  if (!_sbUser) return '';
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
    </div>
  </div>`;
}

function renderProfileNavBtn(){
  if (!sbInitialized()) return '';
  if (_sbUser){
    const initials = (_sbProfile && _sbProfile.display_name
      ? _sbProfile.display_name : (_sbUser.email || '?')).slice(0,1).toUpperCase();
    return `<button class="profile-nav-btn" onclick="_authModalOpen=true;renderApp()" aria-label="Your profile">
      <div class="profile-nav-avatar">${initials}</div>
    </button>`;
  }
  return `<button class="profile-nav-btn" onclick="_introStep=3;state.current_screen='intro';renderApp()" aria-label="Sign in" style="font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;gap:5px">
    ${ic('shield',15)} <span>Sign in</span>
  </button>`;
}

// ---- Auth actions (called from onclick) ----

async function doGoogleSignIn(){
  const btn = document.querySelector('.auth-google-btn');
  const origHTML = btn ? btn.innerHTML : '';
  if (btn){ btn.disabled = true; btn.innerHTML = '<span style="opacity:.6">Connecting…</span>'; }
  if (!_sb) await sbInit();
  if (!_sb){
    showAuthMsg('Could not connect to auth service. Try again in a moment.', 'err');
    if (btn){ btn.disabled = false; btn.innerHTML = origHTML; }
    return;
  }
  const { error } = await _sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error){
    showAuthMsg(error.message, 'err');
    if (btn){ btn.disabled = false; btn.innerHTML = origHTML; }
  }
}

async function doSignIn(){
  const email = (document.getElementById('auth-email') || {}).value || '';
  const pw    = (document.getElementById('auth-password') || {}).value || '';
  const btn   = document.getElementById('auth-submit-btn');
  if (!email || !pw){ showAuthMsg('Please enter your email and password.', 'err'); return; }
  if (btn) btn.disabled = true;
  const err = await sbSignIn(email, pw);
  if (err){ showAuthMsg(err.message, 'err'); if(btn) btn.disabled=false; return; }
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
  const err = await sbSignUp(email, pw, name);
  if (err){ showAuthMsg(err.message, 'err'); if(btn) btn.disabled=false; return; }
  showAuthMsg('Account created! Check your email to confirm, then sign in.', 'ok');
}

async function doSignOut(){
  _authModalOpen = false;
  await sbSignOut();
}

async function doForgotPassword(){
  const email = (document.getElementById('auth-email') || {}).value || '';
  if (!email){ showAuthMsg('Enter your email address first.', 'err'); return; }
  const err = await sbResetPassword(email);
  if (err){ showAuthMsg(err.message, 'err'); return; }
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
function showAuthMsg(msg, type){
  const el = document.getElementById('auth-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'auth-msg ' + (type || 'err');
  el.style.display = msg ? 'block' : 'none';
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
  strategy_mode: "arbitrage",      // tool default; sanitizer drops to 'self-consume' if no battery
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
  schema_version: 2             // bump + add a migrateState case when a field's MEANING changes
};

let state;
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
function saveState(){ try { localStorage.setItem("solarAppState_v2", JSON.stringify(state)); } catch(e){} }

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
  // === DYNAMIC TARIFFS (CRU mandate effective 1 June 2026) ===
  // These are wholesale-tracking: rates change every 30 min, base rate + half-hourly SEMOpx price (capped 50c).
  {
    id:"EI-DYN",
    supplier:"Electric Ireland",
    plan:"Dynamic Price Plan",
    type:"dynamic",
    rates:{day:0.1981, night:0.0852, peak:0.2255, ev:0.0852},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:328.58, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"★ NEW (19 May 2026). Base ToU + half-hourly SEMOpx wholesale (capped 50c). Requires CTF-4 smart meter. Sign up via 1800 30 50 90."
  },
  {
    id:"BG-DYN",
    supplier:"Bord Gáis",
    plan:"Smart Dynamic",
    type:"dynamic",
    rates:{day:0.1673, night:0.1673, peak:0.1673, ev:0.1673},
    windows:{ ev:null },
    standing:331.96, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"★ NEW (1 June 2026). Single base rate 16.73c + half-hourly wholesale. No discount on base. Day-ahead prices published at bordgaisenergy.ie/day-ahead-market-prices."
  },
  {
    id:"EN-DYN",
    supplier:"Energia",
    plan:"Dynamic Rates",
    type:"dynamic",
    rates:{day:0.2197, night:0.1251, peak:0.2292, ev:0.1251},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:299.75, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"★ NEW (2 June 2026). 3-band base ToU + half-hourly wholesale. 100% green. Day 21.97c / Night 12.51c / Peak 22.92c base."
  },

  // === STANDARD 24-HOUR PLANS (smart meter, flat rate, new-customer discount applied) ===
  {
    id:"EI-24",
    supplier:"Electric Ireland",
    plan:"Home Dual+ 24hr",
    type:"flat",
    rates:{day:0.3114, night:0.3114, peak:0.3114, ev:0.3114},
    windows:{ ev:null },
    standing:328.58, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"8.5% direct-debit/eBill discount. Prices changing 1 July 2026."
  },
  {
    id:"EN-24",
    supplier:"Energia",
    plan:"Standard 24hr",
    type:"flat",
    rates:{day:0.2986, night:0.2986, peak:0.2986, ev:0.2986},
    windows:{ ev:null },
    standing:265.01, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"30% new-customer discount on 42.65c standard rate. 100% green."
  },
  {
    id:"BG-24",
    supplier:"Bord Gáis",
    plan:"Smart All Day",
    type:"flat",
    rates:{day:0.3078, night:0.3078, peak:0.3078, ev:0.3078},
    windows:{ ev:null },
    standing:244.76, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"VERIFIED bordgaisenergy.ie/home/ev-plan-comparison. Flat 30.78c with 26% new-customer discount. Standing €244.76. CEG 18.5c."
  },
  {
    id:"SSE-EVDAY",
    supplier:"SSE Airtricity",
    plan:"1 Year Fixed 24hr Smart",
    type:"flat",
    rates:{day:0.3152, night:0.3152, peak:0.3152, ev:0.3152},
    windows:{ ev:null },
    standing:240.97, exit:50, length:12, green:true, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"VERIFIED from SSE PDF 1YR-ELEC-FIXED-V5 (DD & eBill column). Flat 31.52c. Standing €240.97. 12-month price fix. CEG 19.5c."
  },
  {
    id:"YN-24",
    supplier:"Yuno Energy",
    plan:"Standard Smart Plan",
    type:"flat",
    rates:{day:0.2524, night:0.2524, peak:0.2524, ev:0.2524},
    windows:{ ev:null },
    standing:219.22, exit:50, length:12, green:false, export_rate:0.1589,
    verified_date:"2026-06-02",
    notes:"Cheapest flat smart rate. Low standing charge. CEG rises to 17.16c on 1 July 2026."
  },
  {
    id:"FL-24",
    supplier:"Flogas",
    plan:"Smart 24hr",
    type:"flat",
    rates:{day:0.3024, night:0.3024, peak:0.3024, ev:0.3024},
    windows:{ ev:null },
    standing:234.50, exit:50, length:12, green:false, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"Mid-pack flat smart plan."
  },
  {
    id:"PIN-LF",
    supplier:"Pinergy",
    plan:"Lifestyle Standard Smart Tariff",
    type:"tou",
    rates:{day:0.4177, night:0.3177, peak:0.4472, ev:0.3177},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:283.47, exit:50, length:12, green:true, export_rate:0.250,
    verified_date:"2026-06-02",
    notes:"3-band ToU (verified pinergy.ie 22 May 2026). Day 8-23h, Night 23-8h, Peak 17-19h. Best export rate (25c)."
  },
  {
    id:"PIN-WFH",
    supplier:"Pinergy",
    plan:"Lifestyle Working from Home Time",
    type:"tou",
    // 29.24c inside the 9-17 WFH window, 41.77c the rest of the time. The
    // rate keys must mirror the window keys: a window with no matching rate
    // resolves to undefined and poisons the whole plan's cost with NaN.
    rates:{day:0.4177, wfh:0.2924, night:0.4177, peak:0.4177, ev:0.4177},
    windows:{ peak:null, night:null, ev:null, wfh:[9,17] },
    standing:283.47, exit:50, length:12, green:true, export_rate:0.250,
    verified_date:"2026-06-02",
    notes:"29.24c Mon-Fri 9-5, 41.77c otherwise. Best for daytime-occupied homes."
  },
  {
    id:"PIN-FAM",
    supplier:"Pinergy",
    plan:"Lifestyle Family Time",
    type:"tou",
    rates:{day:0.4177, night:0.2506, peak:0.4177, ev:0.4177},
    windows:{ peak:null, night:[19,24], ev:null },
    standing:283.47, exit:50, length:12, green:true, export_rate:0.250,
    verified_date:"2026-06-02",
    notes:"25.06c every day 7pm-midnight, 41.77c otherwise."
  },

  // === SMART DAY/NIGHT/PEAK PLANS (3-band ToU) ===
  {
    id:"EI-SST",
    supplier:"Electric Ireland",
    plan:"Home Dual+ SST",
    type:"tou",
    rates:{day:0.3388, night:0.1780, peak:0.3614, ev:0.1780},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:328.58, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"3-band ToU with 8.5% discount (verified electricireland.ie). Day 33.88c, Night 17.80c, Peak 36.14c. Prices changing 1 July 2026."
  },
  {
    id:"EN-SMART",
    supplier:"Energia",
    plan:"Smart Data",
    type:"tou",
    rates:{day:0.3075, night:0.1691, peak:0.3454, ev:0.1691},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:265.01, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"27% new-customer discount (verified energia.ie 29 May 2026). 100% green. Day 30.75 / Night 16.91 / Peak 34.54."
  },
  {
    id:"BG-TOU",
    supplier:"Bord Gáis",
    plan:"Smart Standard Electricity",
    type:"tou",
    rates:{day:0.3289, night:0.2428, peak:0.4004, ev:0.2428},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:244.76, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"VERIFIED bordgaisenergy.ie/home/ev-plan-comparison. 26% new-customer discount (NOT 32% — earlier 3rd-party sources were wrong). Standing €244.76. CEG 18.5c."
  },
  {
    id:"SSE-DNP",
    supplier:"SSE Airtricity",
    plan:"1 Year Fixed Smart Day/Night/Peak",
    type:"tou",
    rates:{day:0.3320, night:0.2096, peak:0.4010, ev:0.2096},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:302.48, exit:50, length:12, green:true, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"VERIFIED from SSE PDF 1YR-ELEC-FIXED-V5 (DD & eBill column). Day 33.20c / Night 20.96c / Peak 40.10c. Standing €302.48. 12-month price fix. CEG 19.5c."
  },
  {
    id:"YN-DNP",
    supplier:"Yuno Energy",
    plan:"Smart Day/Night/Peak",
    type:"tou",
    rates:{day:0.2998, night:0.1645, peak:0.3499, ev:0.1645},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:219.22, exit:50, length:12, green:false, export_rate:0.1589,
    verified_date:"2026-06-02",
    notes:"Low standing charge. CEG rises to 17.16c on 1 July 2026."
  },
  {
    id:"FL-DNP",
    supplier:"Flogas",
    plan:"Smart Day/Night/Peak",
    type:"tou",
    rates:{day:0.3145, night:0.1844, peak:0.3699, ev:0.1844},
    windows:{ peak:[17,19], night:[23,8], ev:null },
    standing:234.50, exit:50, length:12, green:false, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"Mid-pack 3-band ToU."
  },

  // === EV / NIGHT BOOST PLANS (key arbitrage candidates) ===
  {
    id:"PIN-EV",
    supplier:"Pinergy",
    plan:"Lifestyle EV Night Time",
    type:"ev",
    rates:{day:0.4177, night:0.4177, peak:0.4177, ev:0.0599},
    windows:{ ev:[2,5], peak:null, night:null },
    standing:283.47, exit:50, length:12, green:true, export_rate:0.250,
    discontinued: true,
    discontinued_date: "2026-05-21",
    verified_date:"2026-06-02",
    notes:"NO LONGER ON SALE since 21 May 2026 (existing customers retain). Cheapest EV window was 5.99c (2-5am). Source: pinergy.ie."
  },
  {
    id:"EI-NB",
    supplier:"Electric Ireland",
    plan:"Home Dual+ Night Boost",
    type:"ev",
    rates:{day:0.3325, night:0.1640, peak:0.3325, ev:0.0962},
    windows:{ ev:[2,4], night:[23,8], peak:null },
    standing:328.58, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"Shortest EV window (2-4am, 2hr). Verified electricireland.ie. Prices changing 1 July 2026."
  },
  {
    id:"EN-EV",
    supplier:"Energia",
    plan:"EV Smart Drive",
    type:"ev",
    rates:{day:0.4016, night:0.4016, peak:0.4016, ev:0.0942},
    windows:{ ev:[2,6], peak:null, night:null },
    standing:265.01, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"Simplified EV plan (10% off): single day rate + EV window 2-6am. Verified energia.ie 1 May 2026."
  },
  {
    id:"EN-EV-PLUS",
    supplier:"Energia",
    plan:"EV Smart Drive Plus",
    type:"ev",
    rates:{day:0.3893, night:0.2399, peak:0.5108, ev:0.1103},
    windows:{ ev:[2,6], peak:[17,19], night:[23,8] },
    standing:265.01, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"4-band EV plan (10% off). Higher EV rate but adds night & peak structure. Verified energia.ie."
  },
  {
    id:"BG-EV",
    supplier:"Bord Gáis",
    plan:"EV Smart Electricity",
    type:"ev",
    rates:{day:0.3523, night:0.2657, peak:0.4914, ev:0.0898},
    windows:{ ev:[2,5], peak:[17,19], night:[23,8] },
    standing:364.89, exit:50, length:12, green:true, export_rate:0.185,
    verified_date:"2026-06-02",
    notes:"VERIFIED directly from bordgaisenergy.ie/home/ev-plan-comparison. EV rate 8.98c (2-5am). 15% new customer discount. Standing €364.89 is €120 HIGHER than BG's other plans (€244.76). High peak 49.14c — avoid 5-7pm. CEG 18.5c."
  },
  {
    id:"SSE-EVMAX",
    supplier:"SSE Airtricity",
    plan:"Smart EV Max",
    type:"ev",
    rates:{day:0.3376, night:0.3376, peak:0.3376, ev:0.1213},
    windows:{ ev:[23,5], peak:null, night:null },
    standing:357.23, exit:50, length:12, green:true, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"2-band only: 18h rate 33.76c (5am-11pm) + 6h EV rate 12.13c (11pm-5am). 30% new customer discount, valid from 31 Oct 2025. Standing €357.23 (higher than other SSE plans). CEG 19.5c. Verified directly from sseairtricity.com/assets/Tariffs/ROI/Current/1YR-ELEC-30-EVMax.pdf."
  },
  {
    id:"YN-EV",
    supplier:"Yuno Energy",
    plan:"EV Variable Discount",
    type:"ev",
    rates:{day:0.3245, night:0.2099, peak:0.3845, ev:0.1079},
    windows:{ ev:[2,6], peak:[17,19], night:[23,8] },
    standing:219.22, exit:50, length:12, green:false, export_rate:0.1589,
    verified_date:"2026-06-02",
    notes:"4hr EV window. Low standing charge. CEG rises 15.89c → 17.16c on 1 July 2026."
  },

  // === LEGACY NIGHTSAVER (no smart meter; for reference only) ===
  {
    id:"EI-NS",
    supplier:"Electric Ireland",
    plan:"Nightsaver (legacy D/N)",
    type:"dn",
    rates:{day:0.3645, night:0.1659, peak:0.3645, ev:0.1659},
    windows:{ peak:null, night:[23,8], ev:null },
    standing:298.46, exit:50, length:12, green:false, export_rate:0.195,
    verified_date:"2026-06-02",
    notes:"Legacy Day/Night meter only. Once on smart, can't go back. For reference only."
  }
];

let TARIFFS = EMBEDDED_TARIFFS.slice();

async function loadTariffs(){
  try {
    const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 3000) : null;
    const res = await fetch('tariffs.json', { cache:'no-cache', signal: ac ? ac.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty');
    const meta = data.find(t => t.id === '__meta__');
    if (meta) window._tariffsMeta = meta;
    TARIFFS = data.filter(t => t.id && t.id !== '__meta__' && t.supplier);
    return true;
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
    const rate = isDynamic ? effRates[i] : (plan.rates[band] ?? plan.rates.day ?? 0);

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
  const strategy = {
    mode: state.strategy_mode || 'arbitrage',
    charge_from_grid: state.charge_from_grid !== false,  // default true to match tool
    arbitrage_priority: 0.7,
    discharge_strategy: 'peak_first',
    reserve_for_evening: 0.0
  };
  const ssim = simulate(plan, CACHE.solar.total, CACHE.cons, strategy);
  const sdf = baselineDiscountFactor(planId);
  if (sdf !== 1){ for (let i = 0; i < ssim.cost.length; i++) ssim.cost[i] *= sdf; }
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

function invalidate(){
  coerceNumericState();
  CACHE.dirty = true;
  CACHE._scenarios = null;
  CACHE._scenario_ck = null;
  CACHE._opt = null;
  CACHE._opt_ck = null;
  CACHE._range = null;
  CACHE._range_ck = null;
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
  // No battery → no grid-charging arbitrage
  if ((state.battery_kwh || 0) === 0){
    state.strategy_mode = 'self-consume';
    state.charge_from_grid = false;
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
  // Snapshot
  const snap = {
    count_A: state.count_A,
    count_B: state.count_B,
    battery_kwh: state.battery_kwh,
    has_solar: state.has_solar,
    ev_active: state.ev_active,
    ev_km_per_year: state.ev_km_per_year,
    strategy_mode: state.strategy_mode,
    charge_from_grid: state.charge_from_grid
  };
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
  // Find best plan for THIS scenario (not global best — best for this exact config)
  const best = getBestPlan();
  const totalGen = sumF(CACHE.solar.total);
  const totalImport = sumF(best.sim.grid_import);
  const totalExport = sumF(best.sim.grid_export);
  const result = {
    hasSolar, hasEv,
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
  Object.assign(state, snap);
  invalidate();
  rebuildBase();
  return result;
}

// Returns { withEv: {payback, solarBenefit, ...}, withoutEv: {...} } — pure solar payback in both cases
// Worst / realistic / optimistic scenarios: re-run the engine with GHI multiplied
// down (poor year, heavy cloud) or up (good Irish summer). Gives Persona 5 the
// honest range they need without hiding Irish winter reality.
function computeScenarioRange(){
  const ck = JSON.stringify(['range', state.region, state.count_A, state.count_B,
    state.battery_kwh, state.install_cost, state.grant_seai, state.heating_type,
    state.bimonthly_bill_eur, state.ev_active, state.ev_in_bill, state.ev_km_per_year]);
  if (CACHE._range_ck === ck && CACHE._range) return CACHE._range;

  const origMult = state._ghi_override;
  const run = (mult) => {
    state._ghi_override = mult;
    invalidate();
    rebuildBase();
    const s = computeSolarPaybackScenarios();
    return s[state.ev_active ? 'withEv' : 'withoutEv'];
  };

  const realistic  = run(undefined);        // normal regional multiplier
  const pessimist  = run(0.82);             // ~18% below average — a genuinely bad Irish year
  const optimist   = run(1.15);             // ~15% above — a good summer

  state._ghi_override = origMult;
  invalidate();
  rebuildBase();

  const out = { realistic, pessimist, optimist };
  CACHE._range_ck = ck;
  CACHE._range = out;
  return out;
}

function computeSolarPaybackScenarios(){
  const sysCost = state.install_cost - state.grant_seai;

  // Cache key — only recompute if relevant state changed
  // (region, panels, battery, install cost, EV km, heating, bills)
  const ck = JSON.stringify([state.region, state.count_A, state.count_B, state.azimuth_A, state.azimuth_B,
    state.tilt_A, state.tilt_B, state.battery_kwh, state.panel_w, state.install_cost, state.grant_seai,
    state.heating_type, state.bimonthly_bill_eur, state.ev_km_per_year, state.ev_kwh_per_100km,
    state.fuel_price, state.ice_l_per_100km, state.hot_water_strategy, state.region, state.ev_in_bill]);
  if (CACHE._scenario_ck === ck && CACHE._scenarios) return CACHE._scenarios;

  // Scenario A: no solar + with EV
  const A = runScenario(false, true);
  // Scenario B: WITH solar + with EV (the user's setup if they get an EV)
  const B = runScenario(true, true);
  // Scenario C: no solar + no EV
  const C = runScenario(false, false);
  // Scenario D: WITH solar + no EV
  const D = runScenario(true, false);

  // Pure solar benefits (electricity only — petrol displacement excluded; it happens regardless of solar)
  const solarBenefitWithEv = A.annualCost - B.annualCost;
  const solarBenefitNoEv   = C.annualCost - D.annualCost;
  const paybackWithEv = solarBenefitWithEv > 0 ? sysCost / solarBenefitWithEv : 999;
  const paybackNoEv   = solarBenefitNoEv   > 0 ? sysCost / solarBenefitNoEv   : 999;

  // Also expose "tariff switch saving" — orthogonal to solar, just the value of switching plans
  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = sumF(baseSim.cost) + baselinePlan.standing;

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
  CACHE._scenario_ck = ck;
  CACHE._scenarios = result;
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
  const baseNet = baseEnergy + basePlan.standing;
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
function dataVerifiedDate(){
  let max = '';
  for (const t of TARIFFS){ if (!t.discontinued && t.verified_date > max) max = t.verified_date; }
  return max;
}
function dataAgeDays(){
  const d = dataVerifiedDate();
  return d ? Math.round((Date.now() - new Date(d)) / 86400000) : 999;
}

function renderSavingsBreakdown(best, baseCost){
  const b = savingsBreakdown(best);
  if (b.total <= 5) return '';
  const row = (label, v, sub) => Math.abs(v) < 3 ? '' : `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <div style="font-size:12px;color:var(--ink-soft)">${label}${sub ? `<div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-dim);margin-top:2px">${sub}</div>` : ''}</div>
      <div style="font-family:var(--mono);font-size:12.5px;font-weight:700;color:${v >= 0 ? 'var(--accent)' : 'var(--loss)'};white-space:nowrap">${v >= 0 ? '−' : '+'}${fmtCurrency(Math.abs(Math.round(v)))}</div>
    </div>`;
  const evKwh = Math.round((state.ev_km_per_year || 0) * (state.ev_kwh_per_100km || 17) / 100);
  const age = dataAgeDays();
  return `
    <div class="card" style="margin-bottom:14px">
      <div style="font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('scales',12,'vertical-align:-2px')} Why this plan wins</div>
      <div style="font-size:11px;color:var(--ink-soft);line-height:1.5;margin-bottom:6px">Same usage, priced hour by hour on both plans. − means cheaper on the new plan.</div>
      ${row('Your home\'s usage on the new rates', b.household)}
      ${state.ev_active ? row(state.ev_in_bill ? 'Your EV charging (night window)' : 'Adding the EV\'s charging', b.ev, evKwh ? evKwh.toLocaleString() + ' kWh in the cheap window' : '') : ''}
      ${row('Standing charge', b.standing)}
      ${state.has_solar ? row('Solar export payments (new plan)', b.export_) : ''}
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:9px 0 2px">
        <div style="font-size:12.5px;font-weight:700;color:var(--ink)">Total saving</div>
        <div style="font-family:var(--mono);font-size:14px;font-weight:700;color:var(--accent)">${fmtCurrency(Math.round(b.total))}/yr</div>
      </div>
      <div style="font-family:var(--mono);font-size:9.5px;color:${age > 60 ? 'var(--amber)' : 'var(--ink-dim)'};margin-top:8px;letter-spacing:.03em">
        ${age > 60 ? ic('warn',10,'vertical-align:-1px') + ' Rates last verified ' + fmtShortDate(dataVerifiedDate()) + ' — over 2 months old, re-check before switching' : '✓ Rates verified ' + fmtShortDate(dataVerifiedDate()) + ' · all ' + TARIFFS.filter(t=>!t.discontinued).length + ' live plans checked'}
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
  const baseCost = sumF(baselineSim(state.baseline).cost) + basePlan.standing;
  // No-solar best computed with a direct, minimal snapshot — rebuilt in the
  // same pass so it can never read a stale per-plan sim cache.
  const snap = { count_A: state.count_A, count_B: state.count_B,
                 battery_kwh: state.battery_kwh, has_solar: state.has_solar };
  state.count_A = 0; state.count_B = 0; state.battery_kwh = 0; state.has_solar = false;
  invalidate(); rebuildBase();
  const noSolarNet = getBestPlan().net;
  Object.assign(state, snap);
  invalidate(); rebuildBase();
  const switchNow = Math.max(0, Math.round(baseCost - noSolarNet));
  const total = Math.max(0, Math.round(baseCost - withSolar.net));
  return { switchNow, withPlanned: Math.max(0, total - switchNow), total };
}

// The savings figure that's honest to publish (share card / PDF): for planned
// solar, switch-now only; otherwise the full figure.
function publishableSavings(){
  const split = plannedSolarSplit();
  if (split) return split.switchNow;
  const best = getBestPlan();
  const basePlan = getPlanById(state.baseline);
  const baseCost = sumF(baselineSim(state.baseline).cost) + basePlan.standing;
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
 */
function getBestPlan(){
  if (CACHE.dirty) rebuildBase();
  let best = evaluateChosenPlan();
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
  const baseCost = bs ? (sumF(bs.cost) + (baselinePlan ? baselinePlan.standing : 0)) : 0;
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
  const baseCost = bs ? (sumF(bs.cost) + (baselinePlan ? baselinePlan.standing : 0)) : 0;
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
      <div style="font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:.14em;text-transform:uppercase;font-weight:700">How the 20-yr NPV is built</div>
      <button onclick="toggleNpvBreakdown()" style="background:transparent;border:1px solid var(--line);color:var(--ink-soft);font-family:var(--mono);font-size:10px;padding:5px 10px;border-radius:6px;cursor:pointer;letter-spacing:.04em">HIDE ▴</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;line-height:1.55">
      <div>Net install (Y0)</div><div style="text-align:right;color:var(--loss)">−${fmtCurrency(sysCostNet)}</div>
      <div>Discounted savings (Y1–Y20)</div><div style="text-align:right;color:var(--accent)">+${fmtCurrency(totalDiscountedSavings)}</div>
      ${batteryKwh > 0 ? `<div>Battery replacement (Y12, ${batteryKwh} kWh × €400)</div><div style="text-align:right;color:var(--loss)">−${fmtCurrency(batterySwapDiscounted)}</div>` : ''}
      <div style="border-top:1px solid var(--line);padding-top:8px;font-weight:700;color:var(--ink)">= 20-yr NPV</div><div style="text-align:right;border-top:1px solid var(--line);padding-top:8px;font-weight:700;color:${finalNpv > 0 ? 'var(--accent)' : 'var(--loss)'}">${fmtCurrency(finalNpv)}</div>
    </div>

    <div style="margin-top:14px;padding:10px 12px;background:var(--well);border:1px solid var(--line);border-radius:8px;font-size:11px;color:var(--ink-soft);line-height:1.55;font-family:var(--mono);letter-spacing:.02em">
      <div style="color:var(--accent);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:6px">Assumptions</div>
      <div>· Annual benefit (Y1): <b style="color:var(--ink)">${fmtCurrency(annualBenefit)}</b> = solar electricity benefit only (same EV state, with vs without solar — petrol savings excluded)</div>
      <div>· Discount rate: <b style="color:var(--ink)">3%/yr</b> (Irish bond yields + small premium)</div>
      <div>· Panel degradation: <b style="color:var(--ink)">${(deg*100).toFixed(1)}%/yr</b> (LG/Jinko Tier-1 spec)</div>
      ${batteryKwh > 0 ? `<div>· Battery swap: <b style="color:var(--ink)">€${batterySwapNominal} nominal</b> at Y12 (€400/kWh in 2026 € — assumes price decay matches inflation)</div>` : ''}
      <div>· Tariff rates: held constant in real terms (inflation cancels with nominal rate growth)</div>
    </div>

    <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--well);border-radius:8px">
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);letter-spacing:.04em">Break-even (discounted)</div>
      <div style="font-family:var(--mono);font-size:13px;font-weight:600;color:${breakevenYear < 0 ? 'var(--loss)' : 'var(--accent)'}">${breakevenLabel}</div>
    </div>

    <div style="margin-top:14px">
      <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase;font-weight:600;margin-bottom:8px">Cumulative cash position (€, discounted)</div>
      <div style="display:grid;grid-template-columns:repeat(20,1fr);gap:2px;height:64px;background:var(--well);padding:3px;border-radius:6px;position:relative">
        ${(() => {
          const maxAbs = Math.max(...rows.map(r => Math.abs(r.cumulative)), 1);
          return rows.map(row => {
            const pct = Math.min(48, Math.abs(row.cumulative) / maxAbs * 48);
            const pos = row.cumulative >= 0;
            return `<div style="position:relative;height:100%" title="Y${row.y}: ${fmtCurrency(row.cumulative)}">
              <div style="position:absolute;left:0;right:0;${pos
                ? `bottom:50%;height:${pct}%;background:var(--accent);border-radius:2px 2px 0 0`
                : `top:50%;height:${pct}%;background:var(--loss);border-radius:0 0 2px 2px`}"></div>
            </div>`;
          }).join('');
        })()}
        <div style="position:absolute;left:3px;right:3px;top:50%;height:1px;background:var(--line);z-index:1"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--ink-dim);margin-top:4px;letter-spacing:.04em">
        <span>Y1</span><span>Y5</span><span>Y10</span><span>Y15</span><span>Y20</span>
      </div>
      <div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-dim);margin-top:6px;letter-spacing:.03em">Red = still paying off the install · green = in profit · crosses zero at break-even</div>
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
  const snap = {};
  for (const k in overrides) snap[k] = state[k];
  Object.assign(state, overrides);
  invalidate();
  rebuildBase();
  const best = getBestPlan();
  const out = { net: best.net, planLabel: best.plan.supplier + ' — ' + best.plan.plan };
  Object.assign(state, snap);
  invalidate();
  rebuildBase();
  return out;
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

function computeOptimisations(){
  const ck = JSON.stringify([state.strategy_mode, state.charge_from_grid, state.hot_water_strategy,
    state.export_enabled, state.battery_kwh, state.heating_type, state.bimonthly_bill_eur, state.region,
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
  if ((state.battery_kwh || 0) > 0){
    const onArb = state.strategy_mode === 'arbitrage' && state.charge_from_grid !== false;
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
        upgrades.push({ label, netExtra, gain, payback: netExtra / gain });
      } else if (netExtra > 0){
        upgrades.push({ label, netExtra, gain: Math.max(0, gain), payback: Infinity });
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
  Object.assign(state, o.overrides);
  invalidate();   // may sanitise the change back (e.g. arbitrage needs a battery)
  saveState();
  // Verify the override actually held — invalidate() reverts impossible combos
  // (arbitrage with no battery, etc). Only claim success if it truly applied,
  // so we never show "Applied" while the engine silently reverted it.
  const held = Object.keys(o.overrides).every(k => state[k] === o.overrides[k]);
  if (held){
    showToast(`Applied — worth about ${opt ? fmtCurrency(opt.delta) : ''}/yr on your setup`, { type:'accent', icon:ic('checkC',16), title:o.title });
  } else if (id === 'arbitrage' && (state.battery_kwh || 0) === 0){
    showToast('Battery arbitrage needs a home battery — add one in Settings first.', { type:'amber', icon:ic('warn',16), title:'No battery to charge' });
  } else {
    showToast('That setting doesn\'t apply to your current setup.', { type:'amber', icon:ic('warn',16) });
  }
  renderApp();
}

function renderOptimisations(){
  const opts = computeOptimisations();
  if (!opts.suggest.length && !opts.confirmed.length) return '';
  return `
    <div class="section-title">Maximise your benefit — free changes</div>
    ${opts.suggest.map(o => `
      <div class="advisor-card" style="border-color:var(--accent);box-shadow:0 0 24px -10px var(--accent-glow)">
        <div class="advisor-title" style="color:var(--accent)">Worth +${fmtCurrency(o.delta)}/yr · simulated on your home</div>
        <div class="advisor-headline">${o.title}</div>
        <div class="advisor-body">${o.body}</div>
        <button onclick="applyOptimisation('${o.id}')" style="margin-top:11px;padding:10px 16px;border-radius:999px;font-size:12.5px;font-weight:700;font-family:var(--display);border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent)">Apply to my model →</button>
      </div>
    `).join('')}
    ${opts.confirmed.map(o => `
      <div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 15px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="toggleOptExpand('${o.id}')">
          <span style="color:var(--accent);flex-shrink:0">${ic('checkC',17)}</span>
          <div style="flex:1;font-size:13px;color:var(--ink);font-weight:600">${o.title}</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);white-space:nowrap">~${fmtCurrency(o.keep)}/yr ${state._opt_open === o.id ? '▴' : '▾'}</div>
        </div>
        ${state._opt_open === o.id ? `
        <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.55;margin:10px 0 0;padding-top:10px;border-top:1px solid var(--line)">${o.body}</div>
        <div style="display:flex;gap:8px;margin-top:11px">
          <div style="flex:1;padding:9px;text-align:center;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent)">✓ Included · +${fmtCurrency(o.keep)}/yr</div>
          <button onclick="removeOptimisation('${o.id}')" style="padding:9px 16px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--line);background:transparent;color:var(--ink-soft)">Exclude →</button>
        </div>` : ''}
      </div>
    `).join('')}
    ${opts.suggest.length ? `<div style="font-family:var(--display);font-size:10px;color:var(--ink-dim);line-height:1.6;margin:4px 2px 0;letter-spacing:.02em">Values are re-simulated on your exact setup — applying one change can unlock others, so check back after applying.</div>` : ''}`;
}

/* ============================================================
   12. HARDWARE ADVISOR — diagnoses the system's weak link
   from the simulation output and surfaces strategic upgrades.
   Returns an array of {kind, headline, body} cards.
   ============================================================ */
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
  // Compute payback against the user's current system simulation
  const best = getBestPlan();
  const econ = state.ev_active ? evEconomics(best.plan.id) : null;
  const totalAnnualBenefit = best.savings + (econ ? econ.petrolCost : 0);
  const payback = totalAnnualBenefit > 0 ? netQuoted / totalAnnualBenefit : 999;
  const npv20 = calcNPV20(totalAnnualBenefit, netQuoted, batteryKwh, state.panel_degradation);
  return {
    verdict, color, headline, advice,
    quotedPrice, expLo, expHi, expMid, grant, netQuoted,
    payback, npv20, totalAnnualBenefit, kwp,
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
// First-ever load (no prior state) — start on intro
if (!state.onboarding_complete && (state.current_screen === 'onboarding' || !state.current_screen)){
  state.current_screen = state.seen_intro ? 'welcome' : 'intro';
}
// Returning user who finished onboarding — never show intro again
if (state.onboarding_complete) state.seen_intro = true;

// Helper — get affiliate URL for a tariff, fallback to a placeholder
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
function captureEmail(email, source){
  state.user_email = email;
  state.email_captured = true;
  saveState();
  trackLeadSubmit(source);
  dlog('LEAD', 'email_capture', { email, source, address: state.address });
  // Wire to email service: fetch('https://formspree.io/f/YOUR_FORM_ID', { method:'POST', ... })
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
    const annual = sumF(s.cost) + plan.standing;
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
    const cost = sumF(sim.cost) + plan.standing;
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
  state.current_screen = 'welcome';
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
        <div class="intro-title" style="font-size:26px;text-align:left;margin-bottom:20px">All you need to<br>cut your energy bills</div>
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
        <div class="intro-sub">Sign in to save your analysis and settings — pick up where you left off on any device.</div>
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
  return `<div class="welcome-page">
    <div class="welcome-content">
      <div class="welcome-brand">Solar Optimiser · Ireland</div>
      <h1 class="welcome-title">Your personal <em>energy advisor</em>.</h1>
      <p class="welcome-sub">With or without solar. We model your exact home against every Irish tariff to find the real saving — and the right plan to lock it in.</p>

      <div class="welcome-features">
        <div class="welcome-feature">
          <div class="welcome-feature-icon">${ic('bolt',20)}</div>
          <div class="welcome-feature-text">
            <b>Find your best tariff</b>
            <span>All ${TARIFFS.length} Irish residential plans modelled against your usage</span>
          </div>
        </div>
        <div class="welcome-feature">
          <div class="welcome-feature-icon">${ic('sun',20)}</div>
          <div class="welcome-feature-text">
            <b>Real solar payback</b>
            <span>Not generic — your roof, your tariff, your numbers</span>
          </div>
        </div>
        <div class="welcome-feature">
          <div class="welcome-feature-icon">${ic('clip',20)}</div>
          <div class="welcome-feature-text">
            <b>Audit any installer quote</b>
            <span>Objective benchmark vs 2026 Irish market prices</span>
          </div>
        </div>
      </div>

      <div class="welcome-actions">
        <button class="switch-cta" style="margin-bottom:0" onclick="goFastPath()">Get my quick answer → <span style="font-weight:400;font-size:13px;opacity:.85">one screen, 30 seconds</span></button>
        <button onclick="startOnboarding()" style="width:100%;margin-top:10px;padding:16px;border-radius:14px;border:1.5px solid var(--line);background:var(--panel);font-family:var(--display);font-size:14px;font-weight:700;color:var(--ink);cursor:pointer">Full setup — guided, with solar &amp; EV →</button>
        <button class="ob-skip-btn" onclick="navigateAuditor()">Just want to audit an installer quote? →</button>
      </div>
      ${state.onboarding_complete ? `<button class="ob-skip-btn" style="margin-top:10px" onclick="setScreen('result')">← Back to my results</button>` : ''}
      <div class="welcome-trust">Free · Independent · Your data stays on this device</div>
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
  // Battery arbitrage only makes sense with a battery — reset to the safe default
  state.strategy_mode = 'self-consume';
  state.charge_from_grid = false;
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
  _ob.strategy = state.strategy_mode || 'arbitrage';
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
      <div style="font-family:var(--display);font-size:9.5px;color:var(--ink-dim);letter-spacing:.04em;margin:-22px 0 22px;text-align:center">${ic('info',10)} Takes about 2 minutes · you can change anything later</div>
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
  const typeLabel = { flat: '24h Flat', tou: 'Day/Night', ev: 'EV', dynamic: 'Dynamic', dn: 'Day/Night' };
  // Supplier-first: pick supplier, then see just their plans
  const suppliers = [...new Set(plans.map(p => p.supplier))].sort();
  const selSup = _ob._ob5_supplier || null;
  const filteredPlans = selSup ? plans.filter(p => p.supplier === selSup) : [];

  const supplierGrid = suppliers.map(sup => {
    const active = selSup === sup;
    const count = plans.filter(p => p.supplier === sup).length;
    return `<button onclick="_ob._ob5_supplier='${sup}';renderApp();" style="flex:1;min-width:calc(50% - 4px);padding:10px 8px;border-radius:10px;font-size:12px;font-weight:700;font-family:var(--display);border:1.5px solid ${active ? 'var(--accent)' : 'var(--line)'};background:${active ? 'var(--accent-soft)' : 'var(--well)'};color:${active ? 'var(--accent)' : 'var(--ink)'};cursor:pointer;text-align:center">
      <div>${sup}</div>
      <div style="font-size:9px;font-weight:400;color:${active ? 'var(--accent)' : 'var(--ink-dim)'};margin-top:2px;font-family:var(--mono)">${count} plan${count !== 1 ? 's' : ''}</div>
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
      <span style="font-family:var(--mono);font-size:10px;letter-spacing:.04em">${!_ob.baseline_known ? '✓' : '›'}</span>
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--ink-soft);font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">1. Pick your supplier</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
      ${supplierGrid}
    </div>

    ${selSup ? `
    <div style="font-size:11px;font-weight:700;color:var(--ink-soft);font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">2. Pick your plan</div>
    <div class="ob-plan-picker" style="max-height:240px">
      ${planList}
    </div>` : `
    <div style="padding:14px;border:1px dashed var(--line);border-radius:10px;text-align:center;color:var(--ink-dim);font-size:12px">
      Select a supplier above to see their plans
    </div>`}

    ${_ob.baseline_known ? `
    <div style="margin-top:12px;padding:12px 14px;background:var(--accent-faint);border:1px solid var(--line);border-radius:12px">
      <div style="font-size:12.5px;font-weight:700;color:var(--ink)">Any discount on this plan?</div>
      <div style="font-size:11px;color:var(--ink-soft);margin-top:2px;line-height:1.5">Sign-up or loyalty discounts change what you really pay. Pick the % off unit rates — it's on your bill.</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">
        ${[0,5,10,15,20,25,30,40].map(p => `
          <div onclick="_ob.baseline_discount=${p};renderApp();" style="padding:7px 12px;border-radius:999px;font-size:11.5px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${(+_ob.baseline_discount||0)===p ? 'var(--accent)' : 'var(--line)'};background:${(+_ob.baseline_discount||0)===p ? 'var(--accent-soft)' : 'var(--panel)'};color:${(+_ob.baseline_discount||0)===p ? 'var(--accent)' : 'var(--ink-soft)'}">${p === 0 ? 'None' : p + '%'}</div>`).join('')}
      </div>
    </div>` : ''}
    <p class="ob-help" style="margin-top:10px">Can't find your exact plan? Choose the closest match by type, or tap "Not sure" — the estimate will still be directionally accurate.</p>`;
}


function obStep1Home(){
  return `
    <div class="ob-step-num">Step 1 of 5 · Your home</div>
    <h1 class="ob-title">Where are you, and how do you <em>heat</em> it?</h1>
    <p class="ob-sub">Solar yield varies ~12% across Ireland, and heating shapes when you use electricity. Between them these set your whole load profile.</p>

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
    <p class="ob-help" style="margin-top:12px">County-level accuracy is all solar modelling needs — postcode precision wouldn't move the result by more than 1%.</p>`;
}


function pickObHeating(heating){
  _ob.heating = heating;
  // Auto-reset HW strategy to the sensible default for this heating type
  _ob.hot_water_strategy = DEFAULT_HW_FOR_HEATING[heating] || 'none';
  renderApp();
}

function obStep2Usage(){
  const m = _ob.usage_mode || 'bill';
  const pill = (mode, label) => `<button onclick="setObUsageMode('${mode}')" style="padding:8px 14px;font-size:11.5px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${m === mode ? 'var(--accent)' : 'transparent'};color:${m === mode ? '#fff' : 'var(--ink-soft)'}">${label}</button>`;
  const pills = `<div style="display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well);margin-bottom:14px">${pill('bill','€ Bill')}${pill('kwh','kWh / year')}${pill('csv','Smart meter')}</div>`;

  // An imported CSV wins over everything — one source of truth.
  if (state._csv_imported){
    return `
    <div class="ob-step-num">Step 2 of 5 · Your usage</div>
    <h1 class="ob-title">Usage comes from your <em>smart meter</em></h1>
    <p class="ob-sub">Real 30-minute readings are active — the most accurate source there is, so manual entry is locked while it's in use.</p>
    ${csvLockCard()}
    <p class="ob-help" style="margin-top:12px">Happy with this? Just continue — everything else in this setup applies on top of it.</p>`;
  }

  const head = `
    <div class="ob-step-num">Step 2 of 5 · Your usage</div>
    <h1 class="ob-title">How much electricity do you <em>use</em>?</h1>
    <p class="ob-sub">Pick whichever you have to hand. A smart-meter file is most accurate; a bill figure is plenty to get started.</p>
    ${pills}`;

  if (m === 'csv'){
    return `${head}
    <div class="card" style="margin-top:0;margin-bottom:12px">
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.7">Log in at <b>myaccount.esbnetworks.ie</b> → My Meter → <b>Download HDF Data</b> (12 months if offered). The file looks like <span style="font-family:var(--mono);font-size:10px;background:var(--well);padding:2px 6px;border-radius:4px">HDF_XXXXXXXX_YYYY-MM-DD.csv</span>.</div>
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
      <span style="position:absolute;right:18px;top:20px;font-size:16px;color:var(--ink-soft);font-family:var(--mono);">kWh</span>
    </div>
    <p class="ob-help">Typical Irish home: 3,500–4,500 kWh/yr · heat pump homes: 7,000–12,000. This is the most accurate figure you can type in.</p>
    <div id="ob-bill-preview" class="ob-bill-preview" style="display:none"></div>`;
  }

  const hint = _ob.heating === 'gas'
    ? `${ic('info',13,'vertical-align:-2px;color:var(--blue)')} <b>Gas home:</b> enter your <b>electricity bill only</b> — from Electric Ireland, Bord Gáis Energy, Energia and so on. Your gas bill is separate. Typical: <b>€80–€180/2 months</b>.`
    : `${ic('bolt',13,'vertical-align:-2px')} <b>Electricity bill only</b>, for a 2-month period. ${_ob.heating === 'heatpump' ? 'Heat pump homes typically pay <b>€200–€450</b>.' : _ob.heating === 'storage' ? 'Storage heater homes typically pay <b>€180–€380</b>.' : 'Typical Irish home: <b>€150–€350</b>.'}`;
  const hintBg = _ob.heating === 'gas' ? 'background:var(--blue-soft);border:1px solid var(--blue)' : 'background:var(--accent-faint);border:1px solid var(--line)';

  return `${head}
    <div style="${hintBg};border-radius:10px;padding:10px 13px;margin-bottom:12px;font-size:12px;color:var(--ink);line-height:1.5">${hint}</div>
    <div style="position:relative;">
      <span style="position:absolute;left:18px;top:18px;font-size:24px;color:var(--ink-soft);font-family:var(--mono);">€</span>
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
  const btn = (d, sym) => `<button onclick="obAdj('${key}',${d},${min},${max})" style="width:46px;height:46px;border-radius:12px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink);font-size:22px;font-weight:700;font-family:var(--mono);cursor:pointer;flex-shrink:0">${sym}</button>`;
  return `<div style="display:flex;align-items:center;gap:10px">
    ${btn(-1, '−')}
    <div style="flex:1;text-align:center;font-family:var(--mono);font-size:24px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${val}<span style="font-size:12px;font-weight:400;color:var(--ink-soft)"> ${unit || ''}</span></div>
    ${btn(1, '+')}
  </div>`;
}
function obPills(key, val, options){
  const opts = options.slice();
  // Preserve any custom value the user already has — show it as its own pill
  if (!opts.some(([v]) => Math.abs(v - val) < 0.001)) opts.push([val, String(val)]);
  return `<div style="display:flex;flex-wrap:wrap;gap:7px">${opts.map(([v, l]) => `
    <div onclick="obSetVal('${key}',${v})" style="padding:9px 14px;border-radius:999px;font-size:12.5px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--line)'};background:${Math.abs(v - val) < 0.001 ? 'var(--accent-soft)' : 'var(--panel)'};color:${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--ink-soft)'}">${l}</div>`).join('')}</div>`;
}

function obStep6Solar(){
  return `
    <div class="ob-step-num">Step 4 of 5 · Solar (optional)</div>
    <h1 class="ob-title">Do you have or plan to add <em>solar</em>?</h1>
    <p class="ob-sub">Skip this if no solar. Otherwise, more detail = more accurate payback.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div onclick="_ob.has_solar=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${!_ob.has_solar?'var(--accent)':'var(--line)'};background:${!_ob.has_solar?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${!_ob.has_solar?'var(--accent)':'var(--ink)'}">No solar</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">Don't have it</div>
      </div>
      <div onclick="_ob.has_solar=true; _ob.solar_status='have'; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent)':'var(--line)'};background:${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_solar&&_ob.solar_status!=='plan')?'var(--accent)':'var(--ink)'}">I have it</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">Already installed</div>
      </div>
      <div onclick="_ob.has_solar=true; _ob.solar_status='plan'; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent)':'var(--line)'};background:${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('sun',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_solar&&_ob.solar_status==='plan')?'var(--accent)':'var(--ink)'}">Planning it</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">Getting quotes</div>
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
        <div style="margin-top:8px;font-size:10.5px;color:var(--ink-dim);font-family:var(--display);line-height:1.5">Typical Irish installs: 5–13.5 kWh. Common: Powerwall 13.5, GivEnergy 9.5, Sigenergy 8.</div>
      </div>

      ${_ob.battery_kwh > 0 ? `
      <div class="ob-mini-section">
        <div class="ob-mini-title">${ic('bolt',14)} Battery strategy</div>
        <p style="font-size:11px;color:var(--ink-dim);margin:0 0 10px;line-height:1.6;font-family:var(--display)">How should your battery charge? Arbitrage uses cheap off-peak grid rates to fill the battery and discharge at peak prices — it earns more but needs a night-rate or EV plan.</p>
        <div style="display:flex;gap:8px">
          <div onclick="_ob.strategy='arbitrage';_ob.charge_from_grid=true;renderApp();" style="flex:1;padding:12px 10px;border:1.5px solid ${_ob.strategy === 'arbitrage' ? 'var(--accent)' : 'var(--line)'};border-radius:10px;cursor:pointer;background:${_ob.strategy === 'arbitrage' ? 'var(--accent-soft)' : 'transparent'}">
            <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:${_ob.strategy === 'arbitrage' ? 'var(--accent)' : 'var(--ink-soft)'};letter-spacing:.06em">ARBITRAGE</div>
            <div style="font-size:11px;color:var(--ink-soft);margin-top:4px;line-height:1.5">Charge from grid at cheap rate (2–8am), discharge at peak. Best on night/EV plans.</div>
          </div>
          <div onclick="_ob.strategy='self-consume';_ob.charge_from_grid=false;renderApp();" style="flex:1;padding:12px 10px;border:1.5px solid ${_ob.strategy !== 'arbitrage' ? 'var(--blue)' : 'var(--line)'};border-radius:10px;cursor:pointer;background:${_ob.strategy !== 'arbitrage' ? 'rgba(41,182,246,.06)' : 'transparent'}">
            <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:${_ob.strategy !== 'arbitrage' ? 'var(--blue)' : 'var(--ink-soft)'};letter-spacing:.06em">SELF-CONSUME</div>
            <div style="font-size:11px;color:var(--ink-soft);margin-top:4px;line-height:1.5">Battery only fills from solar surplus. Simpler — good if no cheap off-peak window.</div>
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
        <p style="font-size:11px;color:var(--ink-dim);margin-top:6px;line-height:1.5;font-family:var(--display)">Auto-calculated: €900/kWp for first 2 kWp — maximum grant €1,800 (SEAI 2025 scheme).</p>
      </div>
    ` : ''}`;
}

function obStep7EV(){
  return `
    <div class="ob-step-num">Step 5 of 5 · Electric vehicle (optional)</div>
    <h1 class="ob-title">Do you have or plan to add an <em>EV</em>?</h1>
    <p class="ob-sub">EV ownership transforms your tariff choice — night-boost plans become very attractive.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">
      <div onclick="_ob.has_ev=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${!_ob.has_ev?'var(--accent)':'var(--line)'};background:${!_ob.has_ev?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${!_ob.has_ev?'var(--accent)':'var(--ink)'}">No EV</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">Don't have one</div>
      </div>
      <div onclick="_ob.has_ev=true; _ob.ev_in_bill=true; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent)':'var(--line)'};background:${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_ev&&_ob.ev_in_bill)?'var(--accent)':'var(--ink)'}">I have one</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">In my bill already</div>
      </div>
      <div onclick="_ob.has_ev=true; _ob.ev_in_bill=false; renderApp();" style="padding:11px 8px;border-radius:12px;cursor:pointer;text-align:center;border:1.5px solid ${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent)':'var(--line)'};background:${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent-soft)':'var(--panel)'}">
        <div style="margin-bottom:4px">${ic('car',18)}</div>
        <div style="font-size:12px;font-weight:700;color:${(_ob.has_ev&&!_ob.ev_in_bill)?'var(--accent)':'var(--ink)'}">Planning it</div>
        <div style="font-size:10px;color:var(--ink-soft);margin-top:2px">Will add charging</div>
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
        <p style="font-size:11px;color:var(--ink-dim);margin-top:6px;line-height:1.5;font-family:var(--display)">Average Irish driving: 16,500 km/yr. EV efficiency: small EVs 14, mid 16-18, large/SUV 20+.</p>
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
      <div style="font-size:10px;color:var(--accent);font-family:var(--mono);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px">Using your real consumption — no € guessing</div>
      <div style="font-family:var(--mono);font-size:18px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${(+_ob.annual_kwh).toLocaleString()} kWh/yr</div>
      <div style="font-size:11px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono)">shaped across the year by your ${_ob.heating} heating profile</div>`;
    return;
  }
  if (!_ob.bill || _ob.bill < 30){ el.style.display = 'none'; return; }
  el.style.display = 'block';
  const bills = inferBillsFromEuro(_ob.bill, _ob.heating);
  const total = Object.values(bills).reduce((a,b)=>a+b,0);
  el.innerHTML = `
    <div style="font-size:10px;color:var(--accent);font-family:var(--display);letter-spacing:.02em;text-transform:uppercase;font-weight:700;margin-bottom:6px">Rough first estimate — refined against your plan at the end</div>
    <div style="font-family:var(--mono);font-size:18px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums">${total.toLocaleString()} kWh/yr</div>
    <div style="font-size:11px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono)">~€${(_ob.bill * 6).toLocaleString()} per year</div>`;
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
  }

  // Commit battery strategy from onboarding
  if (_ob.battery_kwh > 0){
    state.strategy_mode = _ob.strategy || 'arbitrage';
    state.charge_from_grid = _ob.charge_from_grid !== false;
  } else {
    state.strategy_mode = 'self-consume';
    state.charge_from_grid = false;
  }

  // Commit EV
  state.ev_active = _ob.has_ev;
  state.ev_in_bill = _ob.has_ev ? _ob.ev_in_bill !== false : false;
  if (_ob.has_ev){
    state.ev_km_per_year = _ob.ev_km;
    state.ev_kwh_per_100km = _ob.ev_eff;
    // EV + battery always enables arbitrage (override self-consume if EV added later)
    if (state.battery_kwh > 0 && state.strategy_mode !== 'self-consume'){
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
function checkTariffStaleness(){
  if (!TARIFFS || !TARIFFS.length) return null;
  const dates = TARIFFS.map(t => t.verified_date).filter(Boolean).sort();
  if (!dates.length) return null;
  const mostRecent = dates[dates.length - 1];
  const then = new Date(mostRecent);
  const now = new Date();
  const days = Math.floor((now - then) / 864e5);
  return days > 45 ? { days, date: mostRecent } : null;
}

// Most-recent tariff verified date, formatted for display (always shown, to
// make data freshness visible and build trust — separate from the >45-day
// staleness warning).
function latestVerifiedLabel(){
  try {
    const dates = (TARIFFS||[]).map(t => t.verified_date).filter(Boolean).sort();
    if (!dates.length) return '';
    return fmtVerifiedDate(dates[dates.length - 1]);
  } catch(e){ return ''; }
}

function fmtVerifiedDate(isoDate){
  if (!isoDate) return '';
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-IE', { day:'numeric', month:'short', year:'numeric' });
}

function renderStalenessBanner(){
  const stale = checkTariffStaleness();
  if (!stale) return '';
  return `<div class="staleness-banner">
    <span class="staleness-icon">${ic('warn',13)}</span>
    <div><b>Rate data may be outdated</b> — last verified ${fmtVerifiedDate(stale.date)} (${stale.days} days ago). Irish suppliers can change rates without notice.
      <a href="#" onclick="event.preventDefault(); setScreen('plans')">See plan details for upcoming changes →</a>
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
      } else if (unreached === (data.unreachable_suppliers || []).length && confirmed === 0){
        // Common reality: every supplier returned 403/blocked the scraper
        showToast(`All ${unreached} supplier sites blocked the check (403/anti-bot). Bundled rates are unchanged — they're verified manually.`, { type:'blue', icon:'ⓘ', title:'Suppliers blocked scraper' });
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
    <div style="font-family:var(--mono);font-size:10px;color:var(--blue);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('car',12,'vertical-align:-2px')} ${state.ev_in_bill ? 'Your EV vs running a petrol car' : 'If you get the EV — what changes'}</div>
    <div style="font-size:11px;color:var(--ink-soft);line-height:1.5;margin-bottom:10px">${state.ev_in_bill
      ? 'This is about the car, not your electricity plan — what driving electric saves you compared to doing the same kilometres in a petrol car. Plan-switching savings are shown separately above.'
      : 'What your bills would look like with the car, versus fuelling a petrol car for the same kilometres. Separate from plan-switching savings above.'}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div style="padding:10px;background:${state.ev_in_bill ? 'var(--well)' : 'rgba(255,23,68,.06)'};border-radius:8px">
        <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">${state.ev_in_bill ? 'Charging cost (in your bill)' : 'Electricity added to your bill'}</div>
        <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:${state.ev_in_bill ? 'var(--ink)' : 'var(--loss)'};margin-top:3px">${state.ev_in_bill ? '' : '+'}${fmtCurrency(Math.round(electricityCostIncrease))}<span style="font-size:10px;font-weight:400">/yr</span></div>
        <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">${Math.round(econ.evKwh).toLocaleString()} kWh charging your ${econ.km.toLocaleString()} km</div>
      </div>
      <div style="padding:10px;background:var(--accent-faint);border-radius:8px">
        <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Petrol for the same km</div>
        <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--accent);margin-top:3px">−${fmtCurrency(Math.round(econ.petrolCost))}<span style="font-size:10px;font-weight:400">/yr</span></div>
        <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">${Math.round(econ.litres).toLocaleString()} L @ €${(state.fuel_price || 1.83).toFixed(2)}/L ${state.ev_in_bill ? "you're NOT buying" : "you'd avoid buying"}</div>
      </div>
    </div>
    <div style="padding:12px;background:${isPositive ? 'rgba(0,230,118,.08)' : 'rgba(255,145,0,.08)'};border-radius:8px;border:1px solid ${isPositive ? 'var(--accent)' : 'var(--amber)'}">
      <div style="font-family:var(--mono);font-size:9px;color:${isPositive ? 'var(--accent)' : 'var(--amber)'};text-transform:uppercase;letter-spacing:.08em">${state.ev_in_bill ? 'Your EV saves vs a petrol car' : 'Net transport saving if you get it'}</div>
      <div style="font-family:var(--mono);font-size:22px;font-weight:700;color:${isPositive ? 'var(--accent)' : 'var(--amber)'};margin-top:3px">${isPositive ? '' : '-'}${fmtCurrency(Math.abs(Math.round(netSaving)))}<span style="font-size:12px;font-weight:400;color:var(--ink-soft)">/yr</span></div>
      <div style="font-size:10px;color:var(--ink-soft);margin-top:4px;font-family:var(--mono);line-height:1.6">
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
  // Plan efficiency: best-possible cost as % of what you pay now (100 = on the best plan)
  const planScore = clamp(100 * best.net / Math.max(1, baseCost));
  parts.push({ key:'plan', label:'Plan efficiency', score:planScore,
    why: planScore >= 99 ? "You're on the best plan for your usage" : `You pay ${fmtCurrency(Math.round(baseCost))}, best is ${fmtCurrency(Math.round(best.net))} — switching closes the gap` });
  // Solar: performance if installed, potential if not
  if (state.has_solar && totalPanels() > 0){
    const s = best.sim;
    const gen = sumF(CACHE.solar.total);
    const selfUse = gen > 0 ? Math.max(0, (gen - sumF(s.grid_export) - sumF(s.curtailed)) / gen) * 100 : 0;
    parts.push({ key:'solar', label:'Solar performance', score: clamp(35 + selfUse * 0.6 + (state.export_enabled !== false ? 8 : 0)),
      why: `${Math.round(selfUse)}% of generation used on-site${state.export_enabled === false ? ' · export payments OFF' : ''}` });
  } else {
    const mult = (IRISH_REGIONS[state.region] || {}).ghi_multiplier || 1;
    parts.push({ key:'solar', label:'Solar potential', score: clamp(80 + (mult - 1) * 200),
      why: `${IRISH_REGIONS[state.region] ? IRISH_REGIONS[state.region].name : 'Your region'} yield ${mult >= 1 ? '+' : ''}${Math.round((mult-1)*100)}% vs national — model a system on the Solar tab` });
  }
  // EV readiness: is the charging actually landing in a cheap window?
  if (state.ev_active){
    const basePlan = getPlanById(state.baseline);
    const baseHasWindow = !!(basePlan.windows && (basePlan.windows.ev || basePlan.windows.night));
    const bestHasWindow = !!(best.plan.windows && (best.plan.windows.ev || best.plan.windows.night));
    const evScore = clamp(baseHasWindow ? 92 : (bestHasWindow ? 58 : 45));
    parts.push({ key:'ev', label:'EV readiness', score:evScore,
      why: baseHasWindow ? 'Your plan has a cheap charging window' : 'Your current plan has no night/EV window — the recommended switch captures one' });
  }
  // Export optimisation
  if (state.has_solar && totalPanels() > 0){
    const bestExport = Math.max(...TARIFFS.filter(t=>!t.discontinued).map(t=>t.export_rate || 0));
    const cur = (getPlanById(state.baseline).export_rate || 0);
    parts.push({ key:'export', label:'Export optimisation',
      score: state.export_enabled === false ? 15 : clamp(100 * cur / Math.max(0.01, bestExport)),
      why: state.export_enabled === false ? 'Export payments not registered — free money missed' : `Your export rate ${fmtCent(cur)} vs best available ${fmtCent(bestExport)}` });
  }
  const overall = clamp(parts.reduce((a,p)=>a+p.score,0) / parts.length);
  return { overall, parts };
}

function renderEnergyScore(best, baseCost){
  const s = computeEnergyScore(best, baseCost);
  const open = !!state._score_open;
  return `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px;cursor:pointer;padding:10px 0;margin:-10px 0" onclick="state._score_open=!state._score_open;renderApp();">
        <div style="font-family:var(--mono);font-size:26px;font-weight:700;color:${s.overall >= 80 ? 'var(--accent)' : s.overall >= 55 ? 'var(--amber)' : 'var(--loss)'}">${s.overall}<span style="font-size:12px;color:var(--ink-dim);font-weight:400">/100</span></div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:var(--ink)">Energy health score</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);letter-spacing:.03em;margin-top:2px">${s.parts.length} factors · simulated on your home</div>
        </div>
        <span style="font-family:var(--mono);font-size:12px;color:var(--ink-dim)">${open ? '▴' : '▾'}</span>
      </div>
      ${open ? s.parts.map(p => `
        <div style="margin-top:11px">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px">
            <span style="color:var(--ink);font-weight:600">${p.label}</span>
            <span style="font-family:var(--mono);font-weight:700;color:${p.score >= 80 ? 'var(--accent)' : p.score >= 55 ? 'var(--amber)' : 'var(--loss)'}">${p.score}</span>
          </div>
          <div style="height:5px;background:var(--track-soft);border-radius:99px;overflow:hidden"><div style="height:100%;width:${p.score}%;background:${p.score >= 80 ? 'var(--accent)' : p.score >= 55 ? 'var(--amber)' : 'var(--loss)'};border-radius:99px"></div></div>
          <div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-dim);margin-top:4px;line-height:1.5">${p.why}</div>
        </div>`).join('') + `
      <div style="font-family:var(--display);font-size:9.5px;color:var(--ink-dim);margin-top:12px;letter-spacing:.03em">Improve it: apply the free changes on the Solar tab · switch when the gap is real</div>` : ''}
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
    return `<div onclick="${g === 'mine' ? "setSolarView('mine')" : "startGoalDesign('" + g + "')"}" style="flex:1;padding:12px 10px;border-radius:14px;cursor:pointer;border:1.5px solid ${active ? 'var(--accent)' : 'var(--line)'};background:${active ? 'var(--accent-soft)' : 'var(--well)'}">
      <div style="margin-bottom:4px">${ic(icon,17)}</div>
      <div style="font-size:12px;font-weight:700;color:${active ? 'var(--accent)' : 'var(--ink)'};line-height:1.25">${title}</div>
      <div style="font-size:9.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4">${sub}</div>
    </div>`;
  };

  const selIdx = (state._goal_sel && state._goal_sel[view]) || 0;
  let body = '';
  if (busy){
    body = `<div style="margin-top:12px;padding:14px;background:var(--well);border-radius:12px;text-align:center">
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);letter-spacing:.04em">Simulating ${GOAL_PANELS.length * GOAL_BATTS.length} system designs × ${TARIFFS.filter(t=>!t.discontinued).length} plans on your usage…</div>
      <div style="height:4px;background:var(--track-soft);border-radius:99px;margin-top:10px;overflow:hidden"><div style="height:100%;width:55%;background:var(--accent);border-radius:99px;animation:pulse 1.1s ease infinite"></div></div>
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
        <div style="font-family:var(--mono);font-size:9.5px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:6px">${goal === 'npv' ? 'Most value over 20 years' : 'Fastest payback'} — best design</div>
        <div style="font-size:17px;font-weight:800;color:var(--ink);font-family:var(--display)">${win.panels} panels (${win.kwp} kWp)${win.batt ? ' · ' + win.batt + ' kWh battery' : ' · no battery'}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px">
          <div><div style="font-family:var(--mono);font-size:8.5px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">Payback</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${win.payback} yr</div></div>
          <div><div style="font-family:var(--mono);font-size:8.5px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">20-yr profit (NPV)</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">€${win.npv.toLocaleString()}</div></div>
          <div><div style="font-family:var(--mono);font-size:8.5px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.05em;min-height:2.4em">Est. cost after grant</div><div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">~€${win.net.toLocaleString()}</div></div>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);margin-top:8px;line-height:1.6">€${win.benefit.toLocaleString()}/yr benefit on ${win.planLabel} · ~€${win.cost.toLocaleString()} <b>estimated</b> install − €${win.grant.toLocaleString()} SEAI grant · estimated from 2026 Irish market prices, not an installer quote</div>
        <div style="font-family:var(--mono);font-size:9.5px;color:var(--accent);margin-top:9px;letter-spacing:.04em">● LIVE PREVIEW — every card on this screen now shows this design</div>
        <button onclick="commitGoalDesign()" class="switch-cta" style="margin:10px 0 0;padding:13px;font-size:14px">Make this my system →</button>
      </div>
      ${!same ? `<div style="margin-top:10px;padding:0 2px;font-size:11px;color:var(--ink-soft);line-height:1.6">
        ${goal === 'npv'
          ? `The fastest-payback design (${other.panels} panels${other.batt ? ' + ' + other.batt + ' kWh' : ''}) breaks even in <b>${other.payback} yr</b> but earns <b>€${(win.npv - other.npv).toLocaleString()} less</b> over 20 years.`
          : `The value-maximising design (${other.panels} panels${other.batt ? ' + ' + other.batt + ' kWh' : ''}) takes <b>${other.payback} yr</b> to break even but earns <b>€${(other.npv - win.npv).toLocaleString()} more</b> over 20 years.`}
      </div>` : `<div style="margin-top:10px;padding:0 2px;font-size:11px;color:var(--ink-soft)">Both goals point to the same design for your home — an easy decision.</div>`}
      <div style="margin-top:8px;font-family:var(--display);font-size:9px;color:var(--ink-dim);line-height:1.6;letter-spacing:.02em">~ Prices are 2026 install estimates + auto SEAI grant — not quotes · benefit is electricity-only · 20-yr value discounted at 3%</div>`;
  }

  const isEstD = !!state.solar_is_estimate;
  return `
    <div class="card" style="margin-bottom:14px${isEstD ? ';border:1.5px dashed var(--blue)' : ''}">
      <div style="font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${ic('target',12,'vertical-align:-2px')} Design my system</div>
      <div style="font-size:11.5px;color:var(--ink-soft);line-height:1.5;margin-bottom:10px">${view !== 'mine' ? `You're previewing an optimised design — your own setup is safe under <b style="color:var(--ink)">My system</b>.` : isEstD ? `The numbers below use an <b style="color:var(--ink)">estimated system</b> — our model, not your confirmed setup. Pick a goal to preview ${GOAL_PANELS.length * GOAL_BATTS.length} optimised designs, or set your exact panels below.` : `Switch views any time — the whole screen re-simulates instantly. Your own setup always lives under My system.`}</div>
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
        return `<div style="margin-top:8px;padding:8px 12px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);letter-spacing:.02em">
          <b style="color:var(--ink)">vs my system:</b> ${parts.join(' · ')}
        </div>`;
      })()}
      ${body}
      <div style="display:flex;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid var(--line-soft);align-items:center;justify-content:space-between">
        <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim)">${isEstD ? 'Install ~' + fmtCurrency(state.install_cost) + ' est. · grant −' + fmtCurrency(state.grant_seai) : 'Know your exact spec?'}</div>
        <button onclick="goRefineSolar()" style="flex-shrink:0;padding:8px 13px;border-radius:999px;font-size:11.5px;font-weight:700;font-family:var(--display);border:1px solid var(--blue);background:transparent;color:var(--blue);cursor:pointer">Set my exact system →</button>
      </div>
      ${isEstD ? `<div onclick="markSolarAsMine()" style="margin-top:8px;text-align:center;font-size:11px;color:var(--ink-soft);text-decoration:underline;cursor:pointer">These match my real system — mark as confirmed</div>` : ''}
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
        <div style="font-family:var(--mono);font-size:10px;color:var(--blue);letter-spacing:.1em;text-transform:uppercase;font-weight:700;flex:1">${ic('flask',12,'vertical-align:-2px')} Energy flow breakdown</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim)">${open?'▴':'▾'}</div>
      </div>
      ${open ? `
      <div style="font-size:11px;color:var(--ink-soft);line-height:1.5;margin:8px 0 12px">Exact kWh accounting for the best plan on your home — every number is a simulation output, not a guess.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:var(--accent-faint);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:.06em">Generated</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--accent);margin-top:2px">${gen.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh/yr</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">From your ${totalKwp().toFixed(1)} kWp array</div>
        </div>
        <div style="background:var(--well);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Used on-site</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${selfUse.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">${selfPct}% of generation</div>
        </div>
        <div style="background:var(--well);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Exported to grid</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${exp.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">Paid at ${fmtCent(getBestPlan().plan.export_rate||0)}/kWh</div>
        </div>
        <div style="background:var(--well);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.06em">Grid import</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${gridImp.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">From supplier (cheapest window)</div>
        </div>
      </div>
      ${(state.battery_kwh||0) > 0 ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <div style="background:var(--amber-soft);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em">Battery charged</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${battIn.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">Solar + grid ${state.charge_from_grid ? '(arbitrage)' : '(solar only)'}</div>
        </div>
        <div style="background:var(--amber-soft);border-radius:10px;padding:10px 12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--amber);text-transform:uppercase;letter-spacing:.06em">Battery discharged</div>
          <div style="font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);margin-top:2px">${battOut.toLocaleString()}<span style="font-size:10px;font-weight:400"> kWh</span></div>
          <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">Round-trip eff: ${Math.round(state.battery_eff*100*state.battery_eff*100)/100}%</div>
        </div>
      </div>` : ''}
      ${curt > 0 ? `<div style="margin-top:8px;padding:9px 12px;background:rgba(255,145,0,.06);border-radius:8px;font-size:11px;color:var(--ink-soft)">⚠ ${curt.toLocaleString()} kWh curtailed (export limit or export disabled) — enable export to capture this.</div>` : ''}
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
    <div style="font-family:var(--mono);font-size:10px;color:var(--amber);letter-spacing:.08em;text-transform:uppercase;font-weight:700;margin-bottom:6px">${ic('bolt',12,'vertical-align:-2px')} Night-rate savings unlocked</div>
    <div style="font-size:13px;font-weight:700;color:var(--ink);line-height:1.4">An extra <span style="color:var(--amber)">${fmtCurrency(Math.round(extraSaving))}/yr</span> if you shift loads to off-peak</div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);margin-top:6px;line-height:1.65">
      ${bestNight.supplier} — ${bestNight.plan} has a <b style="color:var(--ink)">${nightRate}c/kWh night rate</b> vs ${dayRate}c/kWh day.<br>
      Run dishwasher, washing machine &amp; hot water at <b style="color:var(--ink)">2am–8am</b> to capture this saving.
    </div>
    <button class="btn-secondary" style="margin-top:10px;width:100%;border-color:var(--amber);color:var(--amber)" onclick="setScreen('plans')">
      See all night-rate plans ranked →
    </button>
  </div>`;
}

/* ============================================================
   QUICK RESULT — THE money screen. Single focused conversion.
   Shows: switching savings + giant CTA to switch via affiliate
   ============================================================ */
function renderResult(){
  if (CACHE.dirty) rebuildBase();
  const rec = getRecommendation();
  const best = rec.best;
  // Fallback when no rankable tariff exists — guards against a crash cascade
  // if the tariff list is somehow empty or fully filtered out.
  if (!best || best._noPlan || !best.plan){
    return `<div class="screen">
      ${topbar('No plans available', 'sage', false)}
      <div class="card" style="margin:20px 16px;text-align:center;padding:32px 20px">
        <div style="margin-bottom:12px">${ic('bolt',32)}</div>
        <h2 style="font-size:18px;margin-bottom:8px">No active tariffs found</h2>
        <p style="color:var(--ink-soft);font-size:13px;line-height:1.6;margin-bottom:18px">We couldn't find any current plans to compare against. This is usually temporary — try refreshing the tariff data, or check back shortly.</p>
        <button class="switch-cta" style="margin:0 auto;max-width:240px" onclick="location.reload()">Reload app</button>
      </div>
    </div>`;
  }
  const baselinePlan = getPlanById(state.baseline);
  const { baseCost, annualSavings } = rec;
  const setupLabel = state.has_solar
    ? `${totalKwp().toFixed(1)} kWp ${state.solar_planned ? 'planned solar' : 'solar'}${state.battery_kwh > 0 ? ' + ' + state.battery_kwh + ' kWh battery' : ''}`
    : 'no solar yet';

  return `${topbar('Solar Optimiser', 'accent')}
  <div class="screen">
    ${renderStalenessBanner()}
    <div class="qr-hero">
      <div class="qr-eyebrow">You could save</div>
      <div class="qr-value" data-countup="${Math.round(annualSavings)}" data-prefix="€"><span data-countup-num>${fmtCurrency(annualSavings)}</span><span class="qr-value-unit">/yr</span></div>
      <div class="qr-headline">by switching to a better electricity plan</div>
      ${(() => {
        const split = plannedSolarSplit();
        if (!split) return '';
        return `<div style="margin:8px auto 0;padding:8px 14px;background:rgba(255,145,0,.08);border:1px solid var(--amber);border-radius:10px;display:inline-block">
          <div style="font-family:var(--mono);font-size:10.5px;color:var(--ink);line-height:1.7">
            Switch today: <b>${fmtCurrency(split.switchNow)}/yr</b> · your <b>planned</b> solar adds <b>+${fmtCurrency(split.withPlanned)}/yr</b> once installed
          </div>
        </div>`;
      })()}
      <div class="qr-sub">Based on ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr usage · ${state.heating_type} heating · ${setupLabel}</div>
      ${!state._csv_imported ? `<div style="margin-top:7px;font-family:var(--mono);font-size:10px;color:var(--ink-dim);line-height:1.6;display:flex;align-items:center;gap:5px;justify-content:center;flex-wrap:wrap">
        <span>${ic('info',11)} Estimated from your bill.</span>
        <a href="#" onclick="event.preventDefault(); setScreen('csv-import')" style="color:var(--accent);text-decoration:underline">Import smart-meter data</a>
        <span>for precise results.</span>
      </div>` : `<div style="margin-top:7px;font-family:var(--mono);font-size:10px;color:var(--accent);line-height:1.6;display:flex;align-items:center;gap:5px;justify-content:center">${ic('checkC',11)} Based on your real smart-meter data</div>`}
      ${configChips()}
    </div>

    ${renderTrustPanel()}
    ${renderContractAlert()}
    ${state.chosen_plan ? renderChoiceStrip() : ''}

    <div class="plan-compare">
      <div class="plan-row current">
        <div>
          <div class="plan-label">${state.baseline_known ? 'Your current plan' : 'Estimated baseline'}</div>
          <div class="plan-value">${baselinePlan.supplier} — ${baselinePlan.plan}${!state.baseline_known ? ' <span style="font-size:10px;color:var(--ink-dim);font-family:var(--mono)">(not confirmed)</span>' : ''}</div>
        </div>
        <div class="plan-amount">${fmtCurrency(baseCost)}/yr</div>
      </div>
      <div class="plan-row best">
        <div>
          <div class="plan-label">${state.chosen_plan === best.plan.id ? '→ Your chosen plan' : '→ Switch to'}</div>
          <div class="plan-value">${best.plan.supplier} — ${best.plan.plan}</div>
        </div>
        <div class="plan-amount">${best.net <= 0 ? 'Net earner' : fmtCurrency(best.net)+'/yr'}</div>
      </div>
      ${(() => {
        // P0.3: symmetric netting labels — both figures are on the same basis (gross import
        // cost + standing − export revenue). Label export income explicitly when it's material
        // so users aren't confused by the offset.
        if (best.net <= 0){
          return `<div style="font-family:var(--mono);font-size:10px;color:var(--accent);margin-top:4px;letter-spacing:.03em">${ic('checkC',11)} Your system more than covers your usage — you'd earn about ${fmtCurrency(Math.round(Math.abs(best.net)))}/yr net from export income</div>`;
        }
        const exportRev = Math.round(best.export_revenue || 0);
        if (state.has_solar && exportRev > 50){
          return `<div style="font-family:var(--display);font-size:10px;color:var(--ink-dim);margin-top:6px;letter-spacing:.03em;line-height:1.6">
            Both figures: electricity cost + standing − export income. Export credit on this plan: <b style="color:var(--ink)">${fmtCurrency(exportRev)}/yr</b> (${fmtCent(best.plan.export_rate)}/kWh).
          </div>`;
        }
        return '';
      })()}
    </div>

    ${renderSavingsBreakdown(best, baseCost)}

    <button class="btn-secondary" style="margin-bottom:8px" onclick="openPlanPicker()">
      ${ic('tune',14)} ${state.chosen_plan ? 'Change plan' : 'Use a different plan'}
    </button>
    <button class="switch-cta" onclick="handleSwitchClick('${best.plan.id}', '${(best.plan.supplier + ' ' + best.plan.plan).replace(/'/g,"\\'")}', ${annualSavings.toFixed(0)})">
      Switch to ${best.plan.supplier} →
    </button>
    ${annualSavings > 10 ? `<div style="text-align:center;margin:2px 0 8px">
      <span onclick="setScreen('how-to-switch')" style="display:inline-block;padding:8px 10px;font-size:12.5px;font-weight:600;color:var(--ink-soft);text-decoration:underline;text-underline-offset:3px;cursor:pointer">How switching works — takes ~10 minutes</span>
    </div>` : ''}
    <div class="switch-cta-sub">Independent · ranked by your cost · we may earn a commission if you switch, which never changes the ranking</div>

    ${renderEnergyScore(best, baseCost)}

    ${(() => {
      // Everything that answers "how did you work that out?" rather than
      // "what should I do?" — one tap away instead of in the default scroll.
      const detail = renderLogicBreakdown() + renderNightRateCard(best, baseCost) + renderEvSavingsCard(best);
      if (!detail.trim()) return '';
      const open = !!state._home_detail_open;
      return `<div style="margin-top:14px">
        <button onclick="state._home_detail_open=!state._home_detail_open;saveState();renderApp()"
          style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px 16px;border-radius:14px;border:1px solid var(--hair);background:var(--surface);box-shadow:var(--lift);cursor:pointer;font-family:var(--display)">
          <span style="display:flex;align-items:center;gap:12px">
            ${ic('flask',19)}
            <span style="text-align:left">
              <span style="display:block;font-size:14.5px;font-weight:700;color:var(--ink)">More about your result</span>
              <span style="display:block;font-size:11.5px;color:var(--ink-soft);margin-top:2px">Our working, night-rate options${state.ev_active ? ', EV vs petrol' : ''}</span>
            </span>
          </span>
          <span style="color:var(--ink-soft);font-size:18px;transform:rotate(${open ? '90' : '0'}deg);transition:transform .2s">›</span>
        </button>
        ${open ? `<div style="margin-top:10px">${detail}</div>` : ''}
      </div>`;
    })()}

    <div class="section-title">Save me money</div>

    <div class="secondary-card blue" onclick="setScreen('plans')">
      <div class="secondary-card-icon">${ic('chart',19)}</div>
      <div class="secondary-card-body">
        <div class="secondary-card-title">See all ${TARIFFS.length} plans ranked</div>
        <div class="secondary-card-sub">Compare every Irish residential tariff against your usage</div>
      </div>
      <div class="secondary-card-arrow">›</div>
    </div>

    ${state.has_solar ? `
      <div class="secondary-card amber" onclick="setScreen('solar')">
        <div class="secondary-card-icon">${ic('sun',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">Your solar payback details</div>
          <div class="secondary-card-sub">Payback, free optimisations, hardware advisor</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>
    ` : `
      <div class="secondary-card amber" onclick="exploreSolar()">
        <div class="secondary-card-icon">${ic('sun',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">Model a solar + battery system</div>
          <div class="secondary-card-sub">See real payback for your home + best plan together</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>
    `}

    <div class="section-title">This result</div>
    <div class="mini-action-grid">
      <div class="mini-action" onclick="openPdfReportModal()">
        ${ic('doc',18)}<div class="mini-action-t">PDF report</div><div class="mini-action-s">Emailed to you</div>
      </div>
      <div class="mini-action" onclick="copyShareUrl()">
        ${ic('link',18)}<div class="mini-action-t">Share analysis</div><div class="mini-action-s">Link with your inputs</div>
      </div>
      ${annualSavings > 25 ? `
      <div class="mini-action" onclick="shareSavingsCard()">
        ${ic('spark',18)}<div class="mini-action-t">Challenge a friend</div><div class="mini-action-s">Your €${Math.round(annualSavings).toLocaleString()}/yr card</div>
      </div>` : ''}
      <div class="mini-action" onclick="reRunOnboarding()">
        ${ic('rotate',18)}<div class="mini-action-t">Re-run setup</div><div class="mini-action-s">Answers pre-filled</div>
      </div>
    </div>

    <p class="disclaimer">
      <b>How we estimate.</b> We ${state._csv_imported ? 'used your imported smart meter CSV data' : `back-calculated your kWh from your €${state.bimonthly_bill_eur} bimonthly bill and applied a ${state.heating_type} load shape`}. Edit anything in <a onclick="setScreen('refine')" style="cursor:pointer;padding:12px 6px;margin:-12px -6px;display:inline-block">Settings</a> for more accuracy. <a onclick="setScreen('methodology')" style="cursor:pointer;padding:12px 6px;margin:-12px -6px;display:inline-block">About our methodology →</a>
    </p>
  </div>
  ${bottomNav()}`;
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
    state.ev_kwh_per_100km, state.azimuth_A, state.tilt_A, state.panel_w, state.hot_water_strategy]);
}

function sweepGoalDesigns(){
  const ck = goalSweepCk();
  if (CACHE._goalSweep_ck === ck && CACHE._goalSweep) return CACHE._goalSweep;

  const snap = {
    count_A: state.count_A, count_B: state.count_B, battery_kwh: state.battery_kwh,
    has_solar: state.has_solar, install_cost: state.install_cost, grant_seai: state.grant_seai,
    azimuth_A: state.azimuth_A, tilt_A: state.tilt_A
  };
  const az = state.azimuth_A || 180;
  const tilt = state.tilt_A || 30;
  const ev = !!state.ev_active;

  // Shared no-solar reference (one run for all 12 designs)
  state.count_A = 0; state.count_B = 0; state.battery_kwh = 0; state.has_solar = false;
  invalidate(); rebuildBase();
  const noSolarCost = getBestPlan().net;

  const designs = [];
  for (const p of GOAL_PANELS){
    for (const b of GOAL_BATTS){
      state.count_A = p; state.count_B = 0; state.azimuth_A = az; state.tilt_A = tilt;
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
      designs.push({ panels: p, batt: b, kwp: +kwp.toFixed(1), cost, grant, net,
        benefit: Math.round(benefit), payback: +payback.toFixed(1),
        npv: computeNpv20(benefit, net, b), planId: best.plan.id,
        planLabel: best.plan.supplier + ' — ' + best.plan.plan });
    }
  }

  Object.assign(state, snap);
  invalidate(); rebuildBase();

  const byPayback = designs.slice().sort((a,b) => a.payback - b.payback || a.net - b.net);
  const byNpv     = designs.slice().sort((a,b) => b.npv - a.npv || a.payback - b.payback);
  const out = { designs, byPayback, byNpv, noSolarCost: Math.round(noSolarCost) };
  CACHE._goalSweep_ck = ck;
  CACHE._goalSweep = out;
  return out;
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
  return { has_solar: true, count_A: d.panels, count_B: 0,
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
  if (!state.cost_is_manual)  state.install_cost = estimateInstallCost(kwp, state.battery_kwh || 0);
  if (!state.grant_is_manual) state.grant_seai = calcSeaiGrant(kwp, state.battery_kwh || 0).total;
}

function exploreSolar(){
  state.considering_solar = true;
  state.solar_is_estimate = true;
  // Size a sensible example system from the user's annual kWh
  const annualKwh = Object.values(state.bills).reduce((a,b)=>a+b,0);
  state.count_A = Math.max(6, Math.min(16, Math.round(annualKwh / 450))); state.count_B = 0; state.has_solar = true;
  state.battery_kwh = annualKwh > 6000 ? 10 : annualKwh > 3500 ? 5 : 0;
  applyEstimatedSolarCost();
  state.current_screen = 'solar';
  invalidate();
  saveState();
  if (maybeAutoPaybackView()) return;
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
  // Editing your spec makes the live values YOURS — exit preview mode first
  if ((state.solar_view || 'mine') !== 'mine'){ state.solar_view = 'mine'; snapshotMySystem(); }
  state._settings_open = 'solar';
  state._return_to = 'solar';
  state.current_screen = 'refine';
  saveState();
  trackPageView('refine');
  renderApp();
}

// Growth loop: a share-ready savings card. Brand-styled canvas PNG with the
// headline saving — no personal data, no usage details. Web Share API with
// download fallback.
function makeShareCardCanvas(savings){
  const cv = document.createElement('canvas');
  if (!cv || typeof cv.getContext !== 'function') return null;
  cv.width = 1080; cv.height = 1080;
  const x = cv.getContext('2d');
  if (!x || typeof x.fillRect !== 'function') return null;
  x.fillStyle = '#F2F5F2'; x.fillRect(0, 0, 1080, 1080);
  x.fillStyle = '#FFFFFF';
  x.beginPath(); x.roundRect(70, 120, 940, 840, 48); x.fill();
  x.strokeStyle = '#00A35A'; x.lineWidth = 3;
  x.beginPath(); x.roundRect(70, 120, 940, 840, 48); x.stroke();
  x.fillStyle = '#00C966';
  x.beginPath(); x.roundRect(130, 190, 84, 84, 24); x.fill();
  x.fillStyle = '#03130A';
  x.beginPath(); x.arc(172, 232, 18, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#111A14';
  x.font = '700 44px -apple-system, "Inter Tight", sans-serif';
  x.fillText('Solar Optimiser', 240, 246);
  x.fillStyle = '#5A6A61';
  x.font = '400 30px -apple-system, sans-serif';
  x.fillText('Independent Irish energy advisor', 240, 290);
  x.fillStyle = '#5A6A61';
  x.font = '700 34px ui-monospace, Menlo, monospace';
  x.fillText('I JUST FOUND', 130, 430);
  x.fillStyle = '#00A35A';
  x.font = '800 170px -apple-system, "Inter Tight", sans-serif';
  x.fillText('\u20ac' + Math.round(savings).toLocaleString(), 120, 600);
  x.fillStyle = '#111A14';
  x.font = '700 52px -apple-system, sans-serif';
  x.fillText('a year in electricity savings', 130, 690);
  x.fillStyle = '#5A6A61';
  x.font = '400 34px -apple-system, sans-serif';
  x.fillText('in about 30 seconds. The average Irish home', 130, 770);
  x.fillText('overpays \u20ac300+/yr. Check yours \u2014 it\u2019s free.', 130, 818);
  x.fillStyle = '#93A199';
  x.font = '400 26px ui-monospace, Menlo, monospace';
  const live = TARIFFS.filter(t => !t.discontinued).length;
  x.fillText('Checked against ' + live + ' live Irish tariffs \u00b7 verified ' + fmtShortDate(dataVerifiedDate()), 130, 905);
  return cv;
}

function shareSavingsCard(){
  const savings = publishableSavings();   // honest: planned solar excluded
  const cv = makeShareCardCanvas(savings);
  if (!cv){ copyShareUrl(); return; }
  const text = 'I just found \u20ac' + Math.round(savings).toLocaleString() + '/yr of electricity savings in 30 seconds \u2014 check yours free';
  cv.toBlob((blob) => {
    if (!blob){ copyShareUrl(); return; }
    const file = new File([blob], 'my-savings.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({ files: [file], text }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-savings.png';
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
  const url = getAffiliateUrl(planId);
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
  return ({ all:'All', flat:'Flat 24h', tou:'Day · Night', ev:'EV', dynamic:'Dynamic' })[cat] || cat;
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
function setPlansFilter(cat){
  state._plans_filter = cat;
  saveState();
  renderApp();
}

function showToast(message, opts){
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

/* ============================================================
   SOLAR DASHBOARD — the deep-dive screen
   ============================================================ */
// Tiny monochrome system pictogram for the Solar hero — panels drawn as
// panels (one slanted group per roof, opposite slants for different
// orientations) plus a battery glyph with a proportional fill level.
// The whole configuration reads at a glance: "8 + 4 panels · 9 kWh".
function sysVisual(){
  const nA = Math.max(0, state.count_A || 0);
  const nB = Math.max(0, state.count_B || 0);
  const batt = state.battery_kwh || 0;
  if (!state.has_solar || (nA + nB) === 0) return '';
  const COLS = 4, PW = 12, PH = 16, GAP = 3, CAPN = 20;
  const panelRect = (x, y) => `<g transform="translate(${x},${y})">` +
      `<rect width="${PW}" height="${PH}" rx="1.6" fill="var(--ink)" fill-opacity=".10" stroke="var(--ink-soft)" stroke-width="1"/>` +
      `<line x1="${PW/2}" y1="1.5" x2="${PW/2}" y2="${PH-1.5}" stroke="var(--ink-dim)" stroke-width=".6" opacity=".55"/>` +
      `<line x1="1.5" y1="${PH/2}" x2="${PW-1.5}" y2="${PH/2}" stroke="var(--ink-dim)" stroke-width=".6" opacity=".55"/></g>`;
  const roofGroup = (n, skew, yOff) => {
    const shown = Math.min(n, CAPN);
    const rows = Math.ceil(shown / COLS);
    let cells = '';
    for (let i = 0; i < shown; i++){
      cells += panelRect((i % COLS) * (PW + GAP), Math.floor(i / COLS) * (PH + GAP));
    }
    const w = Math.min(shown, COLS) * (PW + GAP) - GAP;
    const h = rows * (PH + GAP) - GAP;
    const more = n > CAPN ? `<text x="${w/2}" y="${h + 9}" text-anchor="middle" font-size="7" font-family="var(--mono)" fill="var(--ink-dim)">+${n - CAPN} more</text>` : '';
    return { svg: `<g transform="translate(8,${yOff}) skewX(${skew})">${cells}${more}</g>`, h: h + (n > CAPN ? 11 : 0) };
  };
  let y = 3;
  const parts = [];
  const gA = roofGroup(nA, -7, y); parts.push(gA.svg); y += gA.h;
  if (nB > 0){
    y += 8;
    const gB = roofGroup(nB, 7, y); parts.push(gB.svg); y += gB.h;
  }
  if (batt > 0){
    y += 10;
    const bw = 46, bh = 15;
    const fill = Math.max(.18, Math.min(1, batt / 15));
    parts.push(`<g transform="translate(9,${y})">` +
      `<rect width="${bw}" height="${bh}" rx="3" fill="none" stroke="var(--ink-soft)" stroke-width="1.1"/>` +
      `<rect x="${bw + 1}" y="${bh/2 - 3}" width="2.5" height="6" rx="1" fill="var(--ink-soft)"/>` +
      `<rect x="2" y="2" width="${Math.round((bw - 4) * fill)}" height="${bh - 4}" rx="1.6" fill="var(--ink)" fill-opacity=".20"/>` +
      `<text x="${bw/2}" y="${bh/2 + 3}" text-anchor="middle" font-size="7.5" font-family="var(--mono)" font-weight="700" fill="var(--ink-soft)">${batt} kWh</text></g>`);
    y += bh;
  }
  y += 13;
  parts.push(`<text x="38" y="${y - 3}" text-anchor="middle" font-size="7.5" font-family="var(--mono)" letter-spacing=".05em" fill="var(--ink-dim)">${nA}${nB ? ' + ' + nB : ''} PANELS</text>`);
  return `<svg width="76" height="${y}" viewBox="0 0 76 ${y}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">${parts.join('')}</svg>`;
}

function renderSolarDashboard(){
  if (CACHE.dirty) rebuildBase();
  const best = getBestPlan();
  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = sumF(baseSim.cost) + baselinePlan.standing;
  const annualSavings = Math.max(0, baseCost - best.net);
  const totalGen = sumF(CACHE.solar.total);
  const totalExport = sumF(best.sim.grid_export);
  // Unified self-use definition (same as Analytics + hardware advice):
  // generation − export − curtailed = consumed on-site (direct or via battery)
  const selfConsumed = Math.max(0, totalGen - totalExport - sumF(best.sim.curtailed));
  const selfConsumPct = totalGen > 0 ? Math.round(selfConsumed / totalGen * 100) : 0;
  const sysCost = state.install_cost - state.grant_seai;
  const kwp = totalPanels() * state.panel_w / 1000;

  // Compute proper solar-only payback for both EV scenarios
  const scen = computeSolarPaybackScenarios();
  const currentScen = state.ev_active ? scen.withEv : scen.withoutEv;
  const altScen     = state.ev_active ? scen.withoutEv : scen.withEv;
  const currentLabel = state.ev_active ? 'WITH EV' : 'NO EV';
  const altLabel     = state.ev_active ? 'NO EV'  : 'WITH EV';

  // Total annual benefit = solar electricity savings + petrol displacement (EV displaces petrol regardless of solar,
  // but combined with the solar payback it gives the user a "total annual return" view)
  const econ = state.ev_active ? evEconomics(best.plan.id) : null;
  const totalAnnualBenefit = currentScen.solarBenefit + (econ ? econ.petrolCost : 0);
  const npv20 = calcNPV20(currentScen.solarBenefit, sysCost, state.battery_kwh || 0, state.panel_degradation);

  const advice = generateAdvice(best);
  const affiliateUrl = getAffiliateUrl(best.plan.id);

  const isEst = !!state.solar_is_estimate;
  return `${topbar('Solar payback', 'accent', true)}
  <div class="screen">
    ${renderGoalDesigner()}
    <div class="sd-hero" style="position:relative">
      <button onclick="goRefineSolar()" style="position:absolute;top:14px;right:14px;display:flex;align-items:center;gap:5px;padding:7px 12px;border-radius:999px;font-size:11px;font-weight:700;font-family:var(--display);border:1px solid var(--hair-strong);background:transparent;color:var(--ink-soft)">${ic('tune',13)} Customise</button>
      <div class="qr-eyebrow" style="margin-bottom:6px;padding-right:110px">${(state.solar_view || 'mine') === 'payback' ? 'Fastest-payback design — preview' : (state.solar_view || 'mine') === 'npv' ? 'Most 20-yr value design — preview' : isEst ? 'With this estimated system' : 'With this solar system'}</div>
      <div style="display:inline-flex;gap:0;border:1px solid rgba(255,255,255,.2);border-radius:999px;overflow:hidden;background:rgba(0,0,0,.15);margin-bottom:10px">
        ${['pessimist','realistic','optimist'].map(k => {
          const lbl = k==='pessimist'?'Worst':k==='realistic'?'Typical':'Best';
          const active = (state._scenario_view||'realistic')===k;
          return '<button onclick="state._scenario_view=\''+k+'\';renderApp();" style="padding:6px 13px;font-size:10.5px;font-weight:700;font-family:var(--mono);border:none;cursor:pointer;border-radius:999px;background:'+(active?'rgba(255,255,255,.25)':'transparent')+';color:#fff">'+lbl+'</button>';
        }).join('')}
      </div>
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">
      ${(() => {
        const view = state._scenario_view || 'realistic';
        if (view !== 'realistic'){
          try {
            const range = computeScenarioRange();
            const s = range[view];
            const pb = s && s.payback < 50 ? s.payback.toFixed(1) : '—';
            const ben = s ? Math.round(s.solarBenefit) : 0;
            const lbl = view === 'pessimist' ? 'poor year −18% sun' : 'good year +15% sun';
            return '<div class="qr-value">'+pb+'<span class="qr-value-unit"> yr payback ('+view+')</span></div>'+
                   '<div style="font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);margin-top:4px">€'+ben.toLocaleString()+'/yr solar benefit · '+lbl+'</div>';
          } catch(e){}
        }
        return '<div class="qr-value">'+(currentScen.payback < 50 ? currentScen.payback.toFixed(1) : '—')+'<span class="qr-value-unit"> yr payback</span></div>';
      })()}
      <div class="qr-headline">${kwp.toFixed(1)} kWp · ${state.battery_kwh > 0 ? state.battery_kwh + ' kWh battery' : 'no battery'} · €${sysCost.toLocaleString()} net${isEst ? ' (est.)' : ''}</div>
        </div>
        <div style="flex-shrink:0">${sysVisual()}</div>
      </div>
      ${configChips()}
      ${evChip()}

      ${state.ev_active ? `
      <div style="margin-top:14px;padding:12px 14px;background:var(--overlay-tile);border:1px solid var(--line);border-radius:10px">
        <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);letter-spacing:.14em;text-transform:uppercase;font-weight:700;margin-bottom:8px">Solar payback isolated (electricity only)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="padding:10px;background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;text-align:center">
            <div style="font-family:var(--mono);font-size:9px;color:var(--accent);letter-spacing:.1em;font-weight:700;margin-bottom:4px">★ WITH EV</div>
            <div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums">${scen.withEv.payback < 50 ? scen.withEv.payback.toFixed(1) : '—'}<span style="font-size:11px;color:var(--ink-soft);margin-left:2px">yr</span></div>
            <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);margin-top:4px">€${Math.round(scen.withEv.solarBenefit).toLocaleString()}/yr solar</div>
          </div>
          <div style="padding:10px;background:var(--well);border:1px solid var(--line);border-radius:8px;text-align:center">
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);letter-spacing:.1em;font-weight:700;margin-bottom:4px">IF NO EV</div>
            <div style="font-family:var(--mono);font-size:22px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${scen.withoutEv.payback < 50 ? scen.withoutEv.payback.toFixed(1) : '—'}<span style="font-size:11px;color:var(--ink-soft);margin-left:2px">yr</span></div>
            <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);margin-top:4px">€${Math.round(scen.withoutEv.solarBenefit).toLocaleString()}/yr solar</div>
          </div>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);text-align:center;margin-top:10px;line-height:1.5;letter-spacing:.02em">
          ★ = your current setup. Solar payback compares <b>same EV state with vs without solar</b> — the EV-petrol savings happen regardless of solar, so they're not in the payback math.
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
          <div style="font-size:12.5px;font-weight:600;color:var(--ink)">EV in the model <span style="font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);font-weight:400">· ${(state.ev_km_per_year||15000).toLocaleString()} km/yr · ${state.ev_in_bill ? 'already in your bill' : 'added on top'}</span></div>
          <div class="mon-switch ${state.ev_active ? 'on' : 'off'}" onclick="toggleSolarEvModel()" style="cursor:pointer"><div class="mon-knob"></div></div>
        </div>
      </div>` : `
      <div style="font-family:var(--display);font-size:10px;color:var(--ink-dim);text-align:center;margin-top:12px;letter-spacing:.03em">Payback uses electricity savings only — solar vs no solar, everything else equal.</div>`}
    </div>

    <!-- Directly under the payback headline, because every figure above and
         below it is priced on this plan. It used to sit below the day
         inspector, two screens down, where nobody found it. -->
    ${renderPlanChoiceBlock(best, annualSavings, { title: 'Best plan WITH this solar' })}
    <div class="switch-cta-sub">Same plan whether or not you install solar</div>

    ${state.ev_active && econ ? `
      <div class="card" style="margin-bottom:14px;border-color:var(--amber);background:linear-gradient(140deg,var(--amber-faint),var(--panel))">
        <div class="card-label" style="color:var(--amber)">${ic('car',13)} EV petrol displacement (separate from solar)</div>
        <div class="card-value" style="color:var(--amber);font-family:var(--mono)">€${econ.petrolCost.toFixed(0)}<span class="unit">/yr saved on petrol</span></div>
        <div class="card-delta">${econ.litres.toFixed(0)} L petrol avoided · ${econ.evKwh.toFixed(0)} kWh charged (€${econ.evElectricityCost.toFixed(0)} elec) · net €${econ.evVsPetrolNet.toFixed(0)}/yr vs ICE</div>
      </div>
    ` : ''}

    <div class="grid-2">
      <div class="card">
        <div class="card-label">${ic('bolt',13)} Solar electricity benefit</div>
        <div class="card-value accent">${fmtCurrency(currentScen.solarBenefit)}<span class="unit">/yr</span></div>
        <div class="card-delta">vs no solar, ${state.ev_active ? 'with EV' : 'no EV'}</div>
      </div>
      <div class="card" onclick="toggleNpvBreakdown()" style="cursor:pointer">
        <div class="card-label">∑ 20-yr NPV (3%) <span style="float:right;color:var(--accent);font-size:11px">tap for math ↓</span></div>
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

    ${renderDayInspector()}


    ${state.ev_active && econ ? `
      <div class="ev-banner">
        <div class="ev-banner-icon">${ic('car',20)}</div>
        <div>
          <b>EV profile active.</b> Petrol displaced: ${fmtCurrency(econ.petrolCost)}/yr for ${econ.km.toLocaleString()} km. Your battery now grid-charges 2-5am to keep the EV on cheap rates.
          <div style="margin-top:8px"><a href="#" onclick="event.preventDefault(); toggleEv();" style="color:var(--amber);font-size:11px;font-weight:600">Remove EV profile</a></div>
        </div>
      </div>
    ` : `
      <div class="secondary-card amber" onclick="toggleEv()">
        <div class="secondary-card-icon">${ic('car',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">Considering an EV?</div>
          <div class="secondary-card-sub">See how it changes your tariff and lifetime payback</div>
        </div>
        <div class="secondary-card-arrow">+</div>
      </div>
    `}

    ${renderOptimisations()}

    ${(advice.length > 0 || (computeOptimisations().upgrades || []).length > 0) ? `
      <div class="section-title">Hardware upgrades</div>
      ${(computeOptimisations().upgrades || []).map(u => `
        <div style="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
            <div style="font-size:13.5px;font-weight:700;color:var(--ink)">${u.label}</div>
            <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:${u.gain > 0 ? 'var(--accent)' : 'var(--ink-dim)'};white-space:nowrap">+${fmtCurrency(u.gain)}/yr</div>
          </div>
          <div style="font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);margin-top:5px;letter-spacing:.02em">
            ~${fmtCurrency(u.netExtra)} extra (after grant) · ${u.payback === Infinity || u.payback > 30 ? `<span style="color:var(--amber);font-weight:700">doesn't pay for itself — not recommended</span>` : u.payback > 12 ? `<span style="color:var(--amber)">pays back in ${u.payback.toFixed(0)} yr — long; not recommended at current prices</span>` : `pays itself back in <b style="color:var(--ink)">${u.payback.toFixed(0)} yr</b>`}
          </div>
        </div>
      `).join('')}
      ${advice.map(a => `
        <div class="advisor-card">
          <div class="advisor-title" ${a.kind === 'battery-hold' ? 'style="color:var(--ink-soft)"' : ''}>${a.kind === 'optimal' ? '✓ Optimal' : a.kind === 'battery-hold' ? 'On hold — honest call' : 'Upgrade opportunity'}</div>
          <div class="advisor-headline">${a.headline}</div>
          <div class="advisor-body">${a.body}</div>
        </div>
      `).join('')}
    ` : ''}

    ${renderSolarComparison()}

    ${renderSeaiGrantCard(kwp, state.battery_kwh)}

    <div class="section-title">Get this system installed</div>
    <div class="secondary-card" onclick="openLeadForm()">
      <div class="secondary-card-icon">${ic('home',19)}</div>
      <div class="secondary-card-body">
        <div class="secondary-card-title">Get 3 installer quotes for this exact spec</div>
        <div class="secondary-card-sub">${totalPanels()} panels · ${state.battery_kwh > 0 ? state.battery_kwh + ' kWh battery · ' : ''}SEAI-registered only</div>
      </div>
      <div class="secondary-card-arrow">›</div>
    </div>

    <div class="secondary-card amber" onclick="setScreen('quotes')">
      <div class="secondary-card-icon">${ic('scales',19)}</div>
      <div class="secondary-card-body">
        <div class="secondary-card-title">Already have quotes? Check them</div>
        <div class="secondary-card-sub">Audit against 2026 benchmarks or compare side-by-side${(state.solar_quotes||[]).length ? ' · ' + state.solar_quotes.length + ' added' : ''}</div>
      </div>
      <div class="secondary-card-arrow">›</div>
    </div>

    ${state.has_solar ? `
      <div class="secondary-card blue" onclick="setScreen('analytics')">
        <div class="secondary-card-icon">${ic('chart',19)}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">See engine details &amp; hourly flows</div>
          <div class="secondary-card-sub">Day inspector · monthly bars · annual production/use/export</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>
    ` : ''}

    <p class="disclaimer">
      <b>Disclaimer.</b> Estimates based on TMY data and your provided bill. Actual generation, degradation, and grid behaviour will vary by ±5-8%. Always validate with a qualified installer and your supplier.
    </p>
  </div>
  ${bottomNav()}`;
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
         <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Flat rate</div><div style="font-size:10.5px;color:var(--ink-dim);font-family:var(--mono)">All hours, every day</div></div>
         <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${fmtCent(plan.rates.day)}/kWh</div>
       </div>`
    : bands.map(b => {
        const w = plan.windows && plan.windows[b];
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line-soft)">
          <div><div style="font-size:13px;font-weight:600;color:var(--ink)">${labels[b] || b}</div><div style="font-size:10.5px;color:var(--ink-dim);font-family:var(--mono)">${w ? w[0] + 'h–' + w[1] + 'h' : b === 'day' ? 'All remaining hours' : ''}</div></div>
          <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:${b === 'peak' ? 'var(--amber)' : b === 'ev' || b === 'night' ? 'var(--accent)' : 'var(--ink)'}">${fmtCent(plan.rates[b])}/kWh</div>
        </div>`;
      }).join('');
  const modal = document.createElement('div');
  modal.id = 'tariff-popup';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-height:82vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <div style="font-family:var(--mono);font-size:9.5px;color:var(--accent);letter-spacing:.12em;text-transform:uppercase;font-weight:700;margin-bottom:4px">${plan.type === 'dynamic' ? 'Dynamic wholesale tariff' : flat ? 'Flat tariff' : 'Time-of-use tariff'}${isCurrent ? ' · your current plan' : ''}</div>
      <h3 style="margin-bottom:2px">${plan.supplier} — <em>${plan.plan}</em></h3>
      <p style="margin-bottom:10px">Rates incl. VAT — exactly what the simulation uses.</p>
      ${rows}
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0;border-bottom:1px solid var(--line-soft)">
        <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Export (CEG)</div><div style="font-size:10.5px;color:var(--ink-dim);font-family:var(--mono)">Paid for surplus solar</div></div>
        <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">${fmtCent(plan.export_rate || 0)}/kWh</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:11px 0">
        <div><div style="font-size:13px;font-weight:600;color:var(--ink)">Standing charge</div><div style="font-size:10.5px;color:var(--ink-dim);font-family:var(--mono)">Fixed yearly, incl. PSO levy</div></div>
        <div style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--ink)">${fmtCurrency(plan.standing)}/yr</div>
      </div>
      ${plan.type === 'dynamic' ? `<div style="padding:9px 12px;background:var(--blue-soft);border-radius:9px;font-size:11px;color:var(--ink-soft);line-height:1.5;margin-top:4px">Half-hourly wholesale pricing on top of the base rates above — hourly prices move with the market.</div>` : ''}
      ${plan.notes ? `<div style="padding:9px 12px;background:var(--well);border-radius:9px;font-size:11px;color:var(--ink-soft);line-height:1.55;margin-top:8px"><b style="color:var(--ink)">Supplier note.</b> ${plan.notes}</div>` : ''}
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
      <h3 style="margin-bottom:2px">Which plan should we use?</h3>
      <p style="margin-bottom:10px">Everything in the app and your PDF report is calculated on the plan you pick here. The ranking is by cost on your usage — but contract length, exit fees and service are yours to weigh.</p>
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

/**
 * The plan every figure on this screen assumes, and the control to change it.
 * Shared by the result and solar screens so the two can never disagree.
 */
function renderPlanChoiceBlock(best, annualSavings, opts = {}){
  const isChosen = !!state.chosen_plan && state.chosen_plan === best.plan.id;
  return `
    <div class="section-title">${opts.title || 'Best plan'}</div>
    ${state.chosen_plan ? renderChoiceStrip() : ''}
    <div class="plan-compare">
      <div class="plan-row best" onclick="openTariffPopup('${best.plan.id}')" style="cursor:pointer">
        <div>
          <div class="plan-label">${isChosen ? '→ Your chosen plan' : '→ Recommended'} · <span style="text-decoration:underline">tap for tariff</span></div>
          <div class="plan-value">${best.plan.supplier} — ${best.plan.plan}</div>
        </div>
        <div class="plan-amount">${fmtCurrency(best.net)}/yr</div>
      </div>
    </div>
    <button class="btn-secondary" style="margin-top:10px" onclick="openPlanPicker()">
      ${ic('tune',14)} ${state.chosen_plan ? 'Change plan' : 'Use a different plan'}
    </button>
    <button class="switch-cta" style="margin-top:8px" onclick="handleSwitchClick('${best.plan.id}', '${(best.plan.supplier + ' ' + best.plan.plan).replace(/'/g,"\\'")}', ${annualSavings.toFixed(0)})">
      Switch to ${best.plan.supplier} →
    </button>`;
}

function toggleSolarEvModel(){
  const before = computeSolarPaybackScenarios();
  const pBefore = state.ev_active ? before.withEv.payback : before.withoutEv.payback;
  state.ev_active = !state.ev_active;
  if (state.ev_active && !state.ev_km_per_year) state.ev_km_per_year = 15000;
  invalidate();
  saveState();
  const after = computeSolarPaybackScenarios();
  const pAfter = state.ev_active ? after.withEv.payback : after.withoutEv.payback;
  if (pBefore < 50 && pAfter < 50 && Math.abs(pAfter - pBefore) >= 0.05){
    showToast(`Solar payback ${pBefore.toFixed(1)} → ${pAfter.toFixed(1)} yr`, { type:'accent', icon:ic('car',16), title: state.ev_active ? 'EV added to the model' : 'EV removed from the model' });
  } else {
    showToast(state.ev_active ? 'EV added to the model' : 'EV removed from the model', { type:'accent', icon:ic('car',16) });
  }
  renderApp();
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
      state.strategy_mode = 'arbitrage';
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
  showToast('Lead submitted. We\'ll match you with 3 SEAI installers within 48h.', { type:'accent', icon:ic('checkC',16) });
}

/* ============================================================
   PLANS SCREEN — full ranking of all 14 Irish tariffs
   ============================================================ */
function renderPlans(){
  if (CACHE.dirty) rebuildBase();
  if (!state._plans_filter) state._plans_filter = 'all';

  const ranked = TARIFFS.filter(p => !p.discontinued).map(plan => {
    const s = sim(plan.id);
    const c = annualCost(s, plan);
    const onHold = plan.type === 'dynamic' && !state.include_dynamic;
    return { plan, cost: c.net, energy: c.energy_cost, standing: c.standing, exportRev: c.export_revenue, cat: planCategory(plan), onHold };
  }).sort((a,b) => (a.onHold - b.onHold) || (a.cost - b.cost));

  // Filter
  const f = state._plans_filter;
  const filtered = f === 'all' ? ranked : ranked.filter(r => r.cat === f);

  // Counts per category for pill badges
  const counts = { all: ranked.length, flat: 0, tou: 0, ev: 0, dynamic: 0 };
  ranked.forEach(r => { if (counts[r.cat] !== undefined) counts[r.cat]++; });

  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = sumF(baseSim.cost) + baselinePlan.standing;

  const annualKwh = Object.values(state.bills).reduce((a,b)=>a+b,0);
  const region = IRISH_REGIONS[state.region || 'east'];

  return `${topbar('All plans ranked', 'blue', true)}
  <div class="screen">
    ${renderStalenessBanner()}

    <div class="plans-context">
      <div><span class="plans-context-label">Ranking for</span><b>${annualKwh.toLocaleString()} kWh/yr</b> · <b>${state.heating_type}</b> heating · ${ic('pin',11)} <b>${region.name}</b></div>
      <div style="margin-top:3px"><span class="plans-context-label">System</span>${state.has_solar ? `<b>${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ' + ' + state.battery_kwh + ' kWh battery' : ''}</b>` : '<b>no solar</b>'} · ${state.ev_active ? `<b style="color:var(--amber)">EV ${(state.ev_km_per_year || 0).toLocaleString()} km/yr</b>` : 'no EV'}</div>
      ${latestVerifiedLabel() ? `<div class="plan-verified" style="margin-top:6px">Rates verified ${latestVerifiedLabel()} · ${TARIFFS.filter(t=>!t.discontinued).length} active plans</div>` : ''}
    </div>

    ${renderChoiceStrip()}

    <div class="plans-filters">
      ${['all','flat','tou','ev','dynamic'].map(cat => `
        <div class="plan-filter-pill ${cat === f ? 'active' : ''}" onclick="setPlansFilter('${cat}')">
          ${planCategoryLabel(cat)}<span class="count">${counts[cat]}</span>
        </div>
      `).join('')}
    </div>

    ${filtered.length === 0 ? `
      <div style="padding:30px 20px;text-align:center;color:var(--ink-soft);font-family:var(--display);font-size:12px;letter-spacing:.02em">
        No plans in this category match. Try a different filter.
      </div>
    ` : filtered.map((r, i) => {
      const globalRank = ranked.indexOf(r) + 1;
      const isBest = globalRank === 1 && f === 'all';
      const isCurrent = r.plan.id === state.baseline;
      const isChosen = r.plan.id === state.chosen_plan;
      const cardClass = isChosen ? 'chosen' : isBest ? 'best' : isCurrent ? 'current' : '';
      const rankClass = isChosen ? 'chosen' : isBest ? 'best' : isCurrent ? 'current' : '';
      const saving = baseCost - r.cost;

      let rateSummary;
      if (isFlatPlan(r.plan)){
        rateSummary = `Flat ${fmtCent(r.plan.rates.day)}/kWh`;
      } else if (r.plan.rates.ev && r.plan.rates.ev !== r.plan.rates.night){
        rateSummary = `EV ${fmtCent(r.plan.rates.ev)} · Night ${fmtCent(r.plan.rates.night)} · Day ${fmtCent(r.plan.rates.day)}`;
      } else if (r.plan.rates.night && r.plan.rates.night !== r.plan.rates.day){
        rateSummary = `Night ${fmtCent(r.plan.rates.night)} · Day ${fmtCent(r.plan.rates.day)}`;
      } else {
        rateSummary = `Day ${fmtCent(r.plan.rates.day)}/kWh`;
      }

      return `<div class="plan-card ${cardClass}" onclick="showPlanDetail('${r.plan.id}')">
        <div class="plan-card-header">
          <div style="display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0">
            <div class="plan-rank ${rankClass}" ${r.onHold ? 'style="background:rgba(138,180,248,.12);color:#8AB4F8"' : ''}>${r.onHold ? 'HOLD' : isChosen ? '✓ Yours' : isBest ? '★ #1' : isCurrent ? 'Current' : '#' + globalRank}</div>
            <div style="flex:1;min-width:0">
              <div class="plan-supplier">${r.plan.supplier}${r.plan._is_edited ? ' <span style="color:var(--amber);font-size:9px;font-family:var(--mono);letter-spacing:.06em">EDITED</span>' : ''}</div>
              <div class="plan-name">${r.plan.plan}</div>
              <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);margin-top:4px;letter-spacing:.02em">${rateSummary}${r.plan.export_rate ? ' · Export ' + fmtCent(r.plan.export_rate) : ''}</div>
              ${r.onHold ? `<div style="font-family:var(--display);font-size:9.5px;color:#8AB4F8;margin-top:4px;letter-spacing:.03em">ON HOLD — wholesale-tracking price, too unpredictable to rank · shown for reference only</div>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;text-align:right">
            <div class="plan-cost ${isBest ? 'best' : ''}">${fmtCurrency(r.cost)}<span style="font-size:11px;color:var(--ink-soft);font-weight:500;margin-left:2px">/yr</span></div>
            ${!isCurrent ? `<div class="plan-saving" style="color:${saving > 0 ? 'var(--accent)' : 'var(--loss)'}">${saving > 0 ? '−' + fmtCurrency(saving) : '+' + fmtCurrency(-saving)}</div>` : ''}
          </div>
        </div>
        ${r.plan.verified_date ? `<div class="plan-verified">Verified ${fmtVerifiedDate(r.plan.verified_date)}</div>` : ''}
        ${isChosen || (isBest && !state.chosen_plan) ? `
          <button class="switch-cta" style="margin-top:12px;margin-bottom:0;font-size:13px;padding:11px 16px"
                  onclick="event.stopPropagation(); handleSwitchClick('${r.plan.id}', '${(r.plan.supplier + ' ' + r.plan.plan).replace(/'/g,"\\'")}', ${saving.toFixed(0)})">
            Switch to ${r.plan.supplier} →
          </button>
        ` : ''}
      </div>`;
    }).join('')}

    <p class="disclaimer">
      <b>How we rank.</b> Each plan simulated hour-by-hour against your usage profile. We include energy, standing charge, and CEG export revenue. Tap any plan to see full rates &amp; edit. Rates verified June 2026, incl. VAT.
    </p>
  </div>
  ${bottomNav()}`;
}

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
      Ranked on cost. Tap any plan to see the detail — or to go with it instead of the cheapest.
    </div>`;
  }
  const premium = rec.choicePremium;
  return `<div class="choice-strip">
    <div>
      <b>${ic('checkC',13)} Using ${rec.best.plan.supplier} — ${rec.best.plan.plan}</b>
      <div class="choice-strip-sub">Your pick, ranked #${rec.chosenRank}.${
        premium > 1
          ? ` It costs ${fmtCurrency(premium)}/yr more than ${rec.cheapest.plan.supplier}, and every figure in the app and your report uses it.`
          : ' Every figure in the app and your report uses it.'
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
  if (!planId) return renderPlans();
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
        <span class="pd-hero-tag ${planType}">${planType === 'flat' ? 'Flat 24h' : planType === 'tou' ? 'Time-of-use' : planType === 'ev' ? 'EV-specific' : planType === 'dynamic' ? 'Dynamic' : planType}</span>
        ${plan.green ? '<span class="pd-hero-tag tou">Green</span>' : ''}
        ${plan.length ? `<span class="pd-hero-tag">${plan.length}-month contract</span>` : ''}
        ${isCurrent ? '<span class="pd-hero-tag tou">Your baseline</span>' : ''}
        ${isEdited ? '<span class="pd-hero-tag edited">EDITED</span>' : ''}
        ${baseTariff.verified_date ? `<span class="pd-hero-tag" style="color:var(--accent);border-color:var(--accent)">✓ Verified ${fmtVerifiedDate(baseTariff.verified_date)}</span>` : ''}
      </div>
    </div>

    <div class="pd-cost-card">
      <div class="pd-cost-label">Your annual cost on this plan</div>
      <div class="pd-cost-value">${fmtCurrency(c.net)}<span style="font-size:14px;color:var(--ink-soft);font-weight:500;margin-left:4px">/yr</span></div>
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
          <small>Fixed daily fee, includes PSO levy</small>
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
        <button class="switch-cta" style="margin-bottom:0" onclick="handleSwitchClick('${planId}', '${(plan.supplier + ' ' + plan.plan).replace(/'/g,"\\\\'")}', ${Math.max(0, (sumF(baselineSim(state.baseline).cost) + getPlanById(state.baseline).standing) - c.net).toFixed(0)})">
          Switch to ${plan.supplier} →
        </button>
      ` : ''}
      ${!plan.discontinued ? `
        <button class="btn-secondary" onclick="openHowToSwitch('${planId}')" style="border-color:var(--blue);color:var(--blue)">${ic('clip',14)} How to switch to ${plan.supplier}</button>
      ` : ''}
      ${chooseAction(planId, plan, c.net)}
      ${!isCurrent ? `
        <button class="btn-secondary" onclick="setAsBaseline('${planId}')">Use as comparison baseline</button>
      ` : '<div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);text-align:center;padding:10px;letter-spacing:.04em">✓ This is your current baseline</div>'}
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
      <div>${ic('checkC',14)} <b>You're going with this plan</b><div class="chosen-banner-sub">Every figure in the app and your report is calculated on it.</div></div>
      <button class="chosen-banner-undo" onclick="clearChosenPlan()">Undo</button>
    </div>`;
  }
  if (isCheapest && !rec.isManualChoice){
    return `<div style="font-family:var(--mono);font-size:11px;color:var(--accent);text-align:center;padding:10px;letter-spacing:.04em">★ Cheapest for your usage — already in use</div>`;
  }
  const premium = rec.cheapest ? netCost - rec.cheapest.net : 0;
  const note = premium > 1
    ? `${fmtCurrency(premium)}/yr more than ${rec.cheapest.plan.supplier}`
    : 'Same cost as the cheapest plan';
  return `<button class="btn-secondary" onclick="choosePlan('${planId}')">
    Go with this plan<span style="opacity:.7;font-weight:400"> · ${note}</span>
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
      ? `Using ${plan.supplier} — ${fmtCurrency(premium)}/yr more than the cheapest`
      : `Using ${plan.supplier} — ${plan.plan}`,
    { type: 'accent', icon: ic('checkC', 16) });
}

function clearChosenPlan(){
  if (!state.chosen_plan) return;
  state.chosen_plan = null;
  invalidate();
  saveState();
  renderApp();
  showToast('Back to the cheapest plan for your usage');
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
        <div style="display:flex;gap:18px;font-family:var(--mono);font-size:10px;letter-spacing:.04em;margin-bottom:8px">
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
      const label = pct > 0 ? `+${pct}%` : pct === 0 ? 'baseline' : `${pct}%`;
      return `<div class="region-tile ${id === currentRegion ? 'active' : ''}" onclick="setRegion('${id}')">
        <div class="region-tile-multi ${cls}">${label}</div>
        <div class="region-tile-head">
          <div class="region-tile-icon">${ic('pin',16)}</div>
          <div class="region-tile-name">${r.name}</div>
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
    <span style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:999px;font-family:var(--mono);font-size:10px;letter-spacing:.02em;border:1px solid ${on ? 'var(--accent)' : 'var(--line)'};background:${on ? 'var(--accent-soft)' : 'transparent'};color:${on ? 'var(--accent)' : 'var(--ink-dim)'}">${icon}${label}</span>`;
  const pvOn = state.has_solar && totalPanels() > 0;
  const battOn = state.has_solar && (state.battery_kwh || 0) > 0;
  const evOn = !!state.ev_active;
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
    ${chip(ic('sun',12), pvOn, pvOn ? totalKwp().toFixed(1)+' kWp' : 'no PV')}
    ${chip(ic('battery',12), battOn, battOn ? state.battery_kwh+' kWh' : 'no battery')}
    ${chip(ic('car',12), evOn, evOn ? Math.round((state.ev_km_per_year||15000)/1000)+'k km EV' : 'no EV')}
  </div>`;
}

function evChip(){
  if (!state.ev_active) return '';
  const km = state.ev_km_per_year || 0;
  return `<div class="ev-chip">${ic('car',13,'margin-right:3px;vertical-align:-2px')}EV: <b>${km.toLocaleString()} km/yr</b> · ${state.ev_kwh_per_100km || 17} kWh/100km</div>`;
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
    dis.push(s.battery_discharge[i]);
    soc.push(s.soc ? s.soc[i] : 0);
  }

  // Chart dimensions
  const W = 320, H = 160, PAD_L = 28, PAD_R = 8, PAD_T = 12, PAD_B = 28;
  const CW = W - PAD_L - PAD_R;
  const CH = H - PAD_T - PAD_B;
  const barW = CW / 24;

  const hasBattery = state.battery_kwh > 0;

  // Net grid flow: positive = importing, negative = exporting
  const netGrid = imp.map((v, h) => v - exp[h]);

  // Y scale: show both positive (solar, demand) and negative (export) values
  let maxPos = 0.5, maxNeg = 0.1;
  for (let h = 0; h < 24; h++){
    if (gen[h] > maxPos) maxPos = gen[h];
    if (cons[h] > maxPos) maxPos = cons[h];
    if (hasBattery && dis[h] > maxPos) maxPos = dis[h];
    if (netGrid[h] > maxPos) maxPos = netGrid[h];
    if (netGrid[h] < -maxNeg) maxNeg = -netGrid[h];
  }
  maxPos = Math.ceil(maxPos * 4) / 4;
  maxNeg = Math.ceil(maxNeg * 4) / 4;
  const totalRange = maxPos + maxNeg;

  // zero line position within chart area
  const zeroY = PAD_T + (maxPos / totalRange) * CH;
  const yScale = v => zeroY - (v / totalRange) * CH;
  const xPos = h => PAD_L + h * barW;
  const xMid = h => PAD_L + (h + 0.5) * barW;

  // Solar filled area (yellow, above zero only)
  const solarAreaPts = (() => {
    const top = gen.map((v, h) => `${xMid(h).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
    const bot = gen.map((_, h) => `${xMid(h).toFixed(1)},${zeroY.toFixed(1)}`).reverse().join(' ');
    return top + ' ' + bot;
  })();

  // Demand line (blue, solid)
  const demandPath = cons.map((v, h) => `${h === 0 ? 'M' : 'L'}${xMid(h).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');

  // Grid net: import fill (red above zero), export fill (green below zero)
  const gridImpPts = (() => {
    const top = netGrid.map((v, h) => `${xMid(h).toFixed(1)},${yScale(Math.max(0, v)).toFixed(1)}`).join(' ');
    const bot = netGrid.map((_, h) => `${xMid(h).toFixed(1)},${zeroY.toFixed(1)}`).reverse().join(' ');
    return top + ' ' + bot;
  })();
  const gridExpPts = (() => {
    const top = netGrid.map((v, h) => `${xMid(h).toFixed(1)},${yScale(Math.min(0, v)).toFixed(1)}`).join(' ');
    const bot = netGrid.map((_, h) => `${xMid(h).toFixed(1)},${zeroY.toFixed(1)}`).reverse().join(' ');
    return top + ' ' + bot;
  })();

  // Battery discharge line (green dashed)
  const batPath = hasBattery ? dis.map((v, h) => `${h === 0 ? 'M' : 'L'}${xMid(h).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ') : '';
  // Battery charge (below zero, cyan)
  const batChgPath = hasBattery ? ch.map((v, h) => `${h === 0 ? 'M' : 'L'}${xMid(h).toFixed(1)},${yScale(-v).toFixed(1)}`).join(' ') : '';

  // SOC secondary axis line
  const socPath = hasBattery ? soc.map((v, h) => {
    const sy = PAD_T + CH - (v / 100) * CH;
    return `${h === 0 ? 'M' : 'L'}${xMid(h).toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ') : '';

  // Y axis labels
  const yLabelVals = [];
  for (let v = 0; v <= maxPos; v += maxPos / 2) yLabelVals.push(v);
  if (maxNeg > 0.05) yLabelVals.push(-maxNeg);
  const yLabels = yLabelVals.map(v => ({ v, y: yScale(v) }));

  // X-axis hour labels
  const xLabels = [0, 4, 8, 12, 16, 20, 23].map(h => ({ x: xMid(h), label: h + 'h' }));

  // Legend items
  const totalH = H + 8;
  const label = season === 'summer' ? 'Summer · Jun 21' : 'Winter · Jan 19';

  // Compute stats
  const totalExport = exp.reduce((a,b)=>a+b,0);
  const totalImport = imp.reduce((a,b)=>a+b,0);
  const selfUse = gen.reduce((a,b)=>a+b,0) - totalExport;

  // Peak/arbitrage region x positions
  const peakX1 = xPos(17), peakX2 = xPos(19);
  const arbX1 = xPos(2), arbX2 = xPos(5);

  return `
  <div class="section-title" style="margin-top:20px">Day inspector</div>
  <div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 12px 10px;margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div style="font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--ink)">${label}</div>
      <div style="display:inline-flex;gap:4px;padding:3px;background:var(--well);border:1px solid var(--line);border-radius:999px">
        ${['summer','winter'].map(s2 => {
          const active = season === s2;
          return `<button onclick="state._di_season='${s2}';renderApp();" style="padding:4px 11px;font-size:10px;font-weight:700;font-family:var(--mono);border:none;cursor:pointer;border-radius:999px;background:${active ? 'var(--accent)' : 'transparent'};color:${active ? '#fff' : 'var(--ink-soft)'};">${s2 === 'summer' ? '☀ Summer' : '❄ Winter'}</button>`;
        }).join('')}
      </div>
    </div>
    <svg viewBox="0 0 ${W} ${totalH}" width="100%" style="overflow:visible;display:block">

      <!-- Background shading regions -->
      <rect x="${arbX1.toFixed(1)}" y="${PAD_T}" width="${(arbX2-arbX1).toFixed(1)}" height="${CH}" fill="rgba(140,80,220,.08)" rx="0"/>
      <rect x="${peakX1.toFixed(1)}" y="${PAD_T}" width="${(peakX2-peakX1).toFixed(1)}" height="${CH}" fill="rgba(240,80,60,.07)" rx="0"/>

      <!-- Grid lines at y-axis label positions -->
      ${yLabels.map(l => `<line x1="${PAD_L}" y1="${l.y.toFixed(1)}" x2="${W - PAD_R}" y2="${l.y.toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`).join('')}

      <!-- Zero line (bold) -->
      <line x1="${PAD_L}" y1="${zeroY.toFixed(1)}" x2="${W - PAD_R}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,.18)" stroke-width="1"/>

      <!-- Solar filled area (yellow, above zero) -->
      <polygon points="${solarAreaPts}" fill="rgba(250,200,0,.25)"/>
      <path d="${gen.map((v,h) => `${h===0?'M':'L'}${xMid(h).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#f5c800" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>

      <!-- Grid export fill (green below zero) -->
      <polygon points="${gridExpPts}" fill="rgba(0,200,100,.2)"/>

      <!-- Grid import fill (red above zero — only visible during import hours) -->
      <polygon points="${gridImpPts}" fill="rgba(240,80,60,.2)"/>

      <!-- Battery discharge line (green) -->
      ${hasBattery ? `<path d="${batPath}" fill="none" stroke="rgba(0,220,130,.8)" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>` : ''}

      <!-- Battery charge (below zero, cyan dashed) -->
      ${hasBattery ? `<path d="${batChgPath}" fill="none" stroke="rgba(0,180,220,.6)" stroke-width="1.2" stroke-dasharray="3,2" stroke-linejoin="round"/>` : ''}

      <!-- Demand line (blue, most prominent) -->
      <path d="${demandPath}" fill="none" stroke="#4ea8f0" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>

      <!-- Y axis labels -->
      ${yLabels.map(l => `<text x="${(PAD_L - 3).toFixed(1)}" y="${(l.y + 3).toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,.3)" font-size="7.5" font-family="monospace">${l.v >= 0 ? l.v.toFixed(1) : l.v.toFixed(1)}</text>`).join('')}

      <!-- X axis labels -->
      ${xLabels.map(l => `<text x="${l.x.toFixed(1)}" y="${(PAD_T + CH + 11).toFixed(1)}" text-anchor="middle" fill="rgba(255,255,255,.3)" font-size="7.5" font-family="monospace">${l.label}</text>`).join('')}

      <!-- Region labels -->
      <text x="${((arbX1+arbX2)/2).toFixed(1)}" y="${(PAD_T + 9).toFixed(1)}" text-anchor="middle" fill="rgba(160,100,255,.6)" font-size="7" font-family="monospace">02–05h</text>
      <text x="${((peakX1+peakX2)/2).toFixed(1)}" y="${(PAD_T + 9).toFixed(1)}" text-anchor="middle" fill="rgba(240,100,60,.7)" font-size="7" font-family="monospace">peak</text>

    </svg>

    <!-- Legend strip -->
    <div style="display:flex;flex-wrap:wrap;gap:7px 14px;margin-top:8px;padding:8px 2px 2px;border-top:1px solid var(--line-soft)">
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-soft);font-family:var(--mono)"><span style="display:inline-block;width:16px;height:3px;background:#f5c800;border-radius:2px;flex-shrink:0"></span>Solar</span>
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-soft);font-family:var(--mono)"><span style="display:inline-block;width:16px;height:3px;background:#4ea8f0;border-radius:2px;flex-shrink:0"></span>Load</span>
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-soft);font-family:var(--mono)"><span style="display:inline-block;width:16px;height:3px;background:rgba(240,80,60,.7);border-radius:2px;flex-shrink:0"></span>Grid import</span>
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-soft);font-family:var(--mono)"><span style="display:inline-block;width:16px;height:3px;background:rgba(0,200,100,.7);border-radius:2px;flex-shrink:0"></span>Export</span>
      ${hasBattery ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink-soft);font-family:var(--mono)"><span style="display:inline-block;width:16px;height:3px;background:rgba(0,220,130,.8);border-radius:2px;flex-shrink:0"></span>Battery</span>` : ''}
    </div>

    <!-- Quick stats row -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">
      ${[
        { label: 'Solar', val: gen.reduce((a,b)=>a+b,0).toFixed(1) + ' kWh', color: '#f5c800' },
        { label: 'Self-used', val: selfUse.toFixed(1) + ' kWh', color: 'var(--accent)' },
        { label: 'Exported', val: totalExport.toFixed(1) + ' kWh', color: 'rgba(0,200,100,.9)' },
      ].map(st => `
        <div style="background:var(--well);border-radius:8px;padding:7px 8px;text-align:center">
          <div style="font-family:var(--mono);font-size:8.5px;color:var(--ink-dim);margin-bottom:2px">${st.label}</div>
          <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${st.color}">${st.val}</div>
        </div>
      `).join('')}
    </div>
  </div>`;
}

// Seasonal preset days (idx into the 365-day year)
const ANALYTICS_PRESETS = [
  { idx: 18,  label: 'Jan 19',  season: 'winter' },
  { idx: 80,  label: 'Mar 22',  season: 'spring' },
  { idx: 172, label: 'Jun 21',  season: 'summer' },
  { idx: 265, label: 'Sep 23',  season: 'autumn' },
  { idx: 355, label: 'Dec 22',  season: 'winter' }
];

function analyticsDayLabel(dayIdx){
  // Compute calendar label from day-of-year
  const d = new Date(2025, 0, 1);
  d.setDate(d.getDate() + dayIdx);
  return d.toLocaleDateString('en-IE', { month:'short', day:'numeric' });
}

function ensureAnalyticsState(){
  if (state._an_day === undefined) state._an_day = 172;
  // Default to user's recommended best plan so Analytics matches Solar tab.
  // User can switch via the picker — selection persists via state._an_plan.
  if (!state._an_plan){
    try {
      const best = getBestPlan();
      state._an_plan = best.plan.id;
    } catch(e){
      state._an_plan = state.baseline || 'EI-24';
    }
  }
  if (!state._an_view) state._an_view = 'flows';
}

function renderAnalytics(){
  ensureAnalyticsState();
  if (CACHE.dirty) rebuildBase();

  const dayIdx = state._an_day;
  const plan = getPlanById(state._an_plan) || getPlanById(state.baseline);
  const s = sim(plan.id);
  const annualCons = sumF(s.cons);
  const annualGen = sumF(s.gen);
  const annualImp = sumF(s.grid_import);
  const annualExp = sumF(s.grid_export);
  const annualSelfUse = sumF(s.self_use);
  const annualCurtailed = sumF(s.curtailed);
  // Consistent definition with Solar tab: solar that wasn't exported or curtailed
  // counts as "self-consumed" (whether direct or via battery).
  const selfConsumed = Math.max(0, annualGen - annualExp - annualCurtailed);
  const solarUtilization = annualGen > 0 ? selfConsumed / annualGen : 0;
  // "Solar covers X% of demand" — same numerator (solar that ended up consumed),
  // different denominator (consumption). Avoids the arbitrage-confusion of treating
  // cheap-window grid → battery → home as "non-self-sufficient" imports.
  const demandFromSolar = annualCons > 0 ? selfConsumed / annualCons : 0;

  // Hourly slice for the chosen day
  const start = dayIdx * 24;
  const hours = [];
  let maxFlow = 0.001;
  let maxBatt = 0.001;
  let maxCost = 0.001;
  for (let h = 0; h < 24; h++){
    const i = start + h;
    const rate = plan.type === 'dynamic' && s.eff_rate ? s.eff_rate[i] : plan.rates[bandAt(h, plan)];
    const exportRev = s.grid_export[i] * plan.export_rate;
    const importCost = s.grid_import[i] * rate;
    const hCost = importCost - exportRev;
    hours.push({
      h,
      gen: s.gen[i], cons: s.cons[i],
      imp: s.grid_import[i], exp: s.grid_export[i],
      ch: s.battery_charge[i], dis: s.battery_discharge[i],
      band: bandAt(h, plan),
      rate, hCost
    });
    if (s.gen[i] > maxFlow) maxFlow = s.gen[i];
    if (s.cons[i] > maxFlow) maxFlow = s.cons[i];
    if (s.grid_import[i] > maxFlow) maxFlow = s.grid_import[i];
    if (s.grid_export[i] > maxFlow) maxFlow = s.grid_export[i];
    if (s.battery_charge[i] > maxBatt) maxBatt = s.battery_charge[i];
    if (s.battery_discharge[i] > maxBatt) maxBatt = s.battery_discharge[i];
    if (Math.abs(hCost) > maxCost) maxCost = Math.abs(hCost);
  }
  const dayCost = hours.reduce((a, x) => a + x.hCost, 0);
  const dayGen = hours.reduce((a, x) => a + x.gen, 0);
  const dayCons = hours.reduce((a, x) => a + x.cons, 0);
  const dayImp = hours.reduce((a, x) => a + x.imp, 0);
  const dayExp = hours.reduce((a, x) => a + x.exp, 0);

  // Monthly bars
  const HOURS_PER_MONTH = HOURS_IN_YEAR / 12;
  const m = { gen:new Array(12).fill(0), cons:new Array(12).fill(0), imp:new Array(12).fill(0), exp:new Array(12).fill(0) };
  for (let i = 0; i < HOURS_IN_YEAR; i++){
    const mi = Math.floor(i / HOURS_PER_MONTH);
    m.gen[mi]  += s.gen[i];
    m.cons[mi] += s.cons[i];
    m.imp[mi]  += s.grid_import[i];
    m.exp[mi]  += s.grid_export[i];
  }
  const monthMax = Math.max(...m.gen, ...m.cons);

  // Per-day cost values (positive = paid; negative = credit)
  const FLOW_COLORS = {
    gen:  'var(--accent)',
    cons: 'var(--amber)',
    imp:  'var(--loss)',
    exp:  '#5A9CFF'
  };
  const BAND_COLORS = {
    ev:    'var(--accent)',
    night: '#5A9CFF',
    day:   '#9CA39B',
    peak:  'var(--loss)',
    wfh:   '#7BC8FF'
  };
  const FLOW_LABEL = { gen:'Solar generation', cons:'House load', imp:'Grid import', exp:'Grid export' };

  const flowRow = (key) => {
    const total = hours.reduce((a,x) => a + x[key], 0);
    return `<div class="an-row">
      <div class="an-row-head">
        <div class="an-row-label" style="color:${FLOW_COLORS[key]}">${FLOW_LABEL[key]}</div>
        <div class="an-row-stat">${total.toFixed(1)} kWh today</div>
      </div>
      <div class="an-bars">
        ${hours.map(x => {
          const v = x[key];
          const pct = Math.max(0, Math.min(100, Math.round(v / maxFlow * 100)));
          return `<div class="an-bar" style="height:${pct}%;background:${FLOW_COLORS[key]};opacity:${0.55 + pct/200}" title="${x.h}h: ${v.toFixed(2)} kWh"></div>`;
        }).join('')}
      </div>
      <div class="an-hours">
        ${Array.from({length:24},(_,h) => `<div>${h % 6 === 0 || h === 23 ? h + 'h' : ''}</div>`).join('')}
      </div>
    </div>`;
  };

  // Is the currently-selected analytics plan the user's recommended best one?
  const _rec = getRecommendation();
  const recommendedId = _rec.best ? _rec.best.plan.id : null;
  const isRecommended = (recommendedId === plan.id);

  return `${topbar('Analytics', 'blue', true)}
  <div class="screen">
    <div class="an-hero">
      <div class="an-hero-label">Annual flows · ${plan.supplier} ${plan.plan}${isRecommended ? ' · ★ RECOMMENDED' : ''}</div>
      <div style="font-family:var(--display);font-size:20px;font-weight:600;color:var(--ink);line-height:1.2;letter-spacing:-.01em">${Math.round(annualCons).toLocaleString()} kWh used / yr</div>
      ${evChip()}
      ${!isRecommended && recommendedId ? `
        <div onclick="state._an_plan='${recommendedId}'; saveState(); renderApp(); showToast('Now viewing your recommended plan.',{type:'accent',icon:'★',title:''});" style="margin-top:8px;padding:8px 12px;background:var(--accent-faint);border:1px dashed var(--accent);border-radius:8px;font-family:var(--mono);font-size:11px;color:var(--accent);cursor:pointer;letter-spacing:.02em">
          ★ Tap to view your <b>recommended</b> plan — ${getPlanById(recommendedId).supplier} — ${getPlanById(recommendedId).plan}
        </div>` : ''}
      <div class="an-hero-grid">
        <div class="an-stat" title="Solar generated minus exports minus curtailed = consumed on-site (either directly or via battery)">
          <div class="an-stat-label">Solar generated</div>
          <div class="an-stat-value accent">${Math.round(annualGen).toLocaleString()}</div>
          <div class="an-stat-unit">kWh / yr</div>
          <div class="an-stat-sub">${(solarUtilization*100).toFixed(0)}% kept at home</div>
        </div>
        <div class="an-stat" title="Of your total household demand, this fraction came from your own solar (directly or via battery storage of solar)">
          <div class="an-stat-label">Of your needs met</div>
          <div class="an-stat-value blue">${(demandFromSolar*100).toFixed(0)}</div>
          <div class="an-stat-unit">% by solar</div>
          <div class="an-stat-sub">${Math.round(selfConsumed).toLocaleString()} of ${Math.round(annualCons).toLocaleString()} kWh</div>
        </div>
        <div class="an-stat">
          <div class="an-stat-label">Grid import</div>
          <div class="an-stat-value amber">${Math.round(annualImp).toLocaleString()}</div>
          <div class="an-stat-unit">kWh / yr</div>
          <div class="an-stat-sub">${state.battery_kwh > 0 && state.charge_from_grid ? 'Incl. cheap-window battery charging' : 'Direct grid imports'}</div>
        </div>
        <div class="an-stat">
          <div class="an-stat-label">Grid export</div>
          <div class="an-stat-value accent">${Math.round(annualExp).toLocaleString()}</div>
          <div class="an-stat-unit">kWh / yr</div>
          <div class="an-stat-sub">€${(annualExp * plan.export_rate).toFixed(0)} CEG revenue</div>
        </div>
      </div>
    </div>

    <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);line-height:1.6;margin:-6px 0 14px;padding:10px 12px;background:rgba(90,156,255,.04);border:1px solid rgba(90,156,255,.15);border-radius:8px;letter-spacing:.02em">
      <b style="color:var(--blue);text-transform:uppercase;letter-spacing:.1em;font-size:9px">How to read these</b> · same kWh, two lenses.<br>
      <span style="color:var(--accent)">${(solarUtilization*100).toFixed(0)}% kept at home</span> = share of <b>generation</b> used on-site (rest exported).
      <span style="color:var(--blue)">${(demandFromSolar*100).toFixed(0)}% of your needs met by solar</span> = share of <b>demand</b> covered by your own panels.
    </div>

    <div class="section-title">Day inspector</div>

    <div class="an-selector">
      <div class="an-selector-label">Day to inspect</div>
      <div class="an-day-pills">
        ${ANALYTICS_PRESETS.map(p => `
          <div class="an-day-pill ${p.idx === dayIdx ? 'active' : ''}" onclick="setAnalyticsDay(${p.idx})">
            <b>${p.label}</b>${p.season}
          </div>`).join('')}
      </div>
      <input type="range" class="an-day-slider" min="0" max="364" value="${dayIdx}" oninput="setAnalyticsDay(+this.value)" id="an-day-slider">
      <div class="an-day-tag">Currently showing <b>${analyticsDayLabel(dayIdx)}</b> (day ${dayIdx + 1} of 365)</div>
      <div class="an-selector-label" style="margin-top:14px">Tariff plan</div>
      <select class="an-plan-select" onchange="state._an_plan=this.value; saveState(); renderApp();">
        ${TARIFFS.filter(t => !t.discontinued).map(t => `
          <option value="${t.id}" ${t.id === plan.id ? 'selected' : ''}>${t.supplier} — ${t.plan}</option>`).join('')}
      </select>
    </div>

    <div class="an-stat" style="margin-bottom:14px;padding:14px 16px">
      <div class="an-stat-label">Day total cost</div>
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:4px">
        <div class="an-stat-value ${dayCost > 0 ? 'amber' : 'accent'}">${dayCost > 0 ? '€' + dayCost.toFixed(2) : '+€' + (-dayCost).toFixed(2) + ' credit'}</div>
        <div class="an-stat-sub" style="margin:0">${dayImp.toFixed(1)} kWh imported · ${dayExp.toFixed(1)} kWh exported</div>
      </div>
    </div>

    <div class="an-chart">
      <div class="an-chart-title">Energy flows (kWh per hour)</div>
      ${flowRow('gen')}
      ${flowRow('cons')}
      ${flowRow('imp')}
      ${flowRow('exp')}
    </div>

    ${state.battery_kwh > 0 ? (() => {
      // Battery annual stats
      const annualCharged    = sumF(s.battery_charge);
      const annualDischarged = sumF(s.battery_discharge);
      const roundTripLoss    = annualCharged - annualDischarged;
      const cap = state.battery_kwh;
      const isArb = state.strategy_mode === 'arbitrage' && state.charge_from_grid;

      // Estimate arbitrage value: kWh discharged at avg day rate minus kWh charged at avg night rate
      const nightRate = plan.rates.ev || plan.rates.night || plan.rates.day;
      const peakRateV = plan.rates.peak || plan.rates.day;
      const arbValueEst = isArb
        ? Math.max(0, annualDischarged * peakRateV - annualCharged * nightRate)
        : 0;

      // SOC curve for the selected day (24 points from sim)
      const socPts = [];
      for (let h=0; h<24; h++) socPts.push(s.soc[start + h]);
      const maxSoc = cap > 0 ? cap : 1;
      const socPolyline = socPts.map((v, h) => {
        const x = (h / 23) * 280;
        const y = 40 - (v / maxSoc) * 36;  // 40px track, 36px usable height
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');

      const dayCharge    = hours.reduce((a,x) => a+x.ch, 0);
      const dayDischarge = hours.reduce((a,x) => a+x.dis, 0);

      // Build a proper SVG combining all three series in one chart:
      // Top half (above midline) = charge (green bars up)
      // Bottom half (below midline) = discharge (amber bars down)
      // Blue line = SOC (state of charge, right Y-axis 0..cap kWh)
      const svgW = 300, svgH = 110, mid = 52;  // mid = centre dividing line y
      const chargeArea = mid - 4;    // available px above midline for charge bars
      const disArea   = svgH - mid - 4; // available px below midline for discharge bars
      const colW = svgW / 24;

      const battSvg = hours.map((x, i) => {
        const cx = i * colW + colW * 0.1;
        const cw = colW * 0.8;
        let bars = '';
        if (x.ch > 0){
          const bh = Math.max(1, (x.ch / Math.max(maxBatt, 0.001)) * chargeArea);
          bars += `<rect x="${cx.toFixed(1)}" y="${(mid - bh).toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="#00E676" opacity=".75" rx="1"><title>${x.h}h charge ${x.ch.toFixed(3)} kWh</title></rect>`;
        }
        if (x.dis > 0){
          const bh = Math.max(1, (x.dis / Math.max(maxBatt, 0.001)) * disArea);
          bars += `<rect x="${cx.toFixed(1)}" y="${mid.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--amber)" opacity=".75" rx="1"><title>${x.h}h discharge ${x.dis.toFixed(3)} kWh</title></rect>`;
        }
        return bars;
      }).join('');

      // SOC line — scaled to the full chart height (0=bottom, cap=top)
      const socLine = socPts.map((v, h) => {
        const x = (h / 23) * (svgW - colW/2) + colW/4;
        const y = svgH - 4 - (v / maxSoc) * (svgH - 8);
        return (h === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');

      // Band colouring behind the chart to show cheap/expensive windows
      const bandBg = hours.map((x, i) => {
        const col = x.band === 'ev' || x.band === 'night' ? 'rgba(0,230,118,.05)' : x.band === 'peak' ? 'rgba(231,110,92,.05)' : null;
        return col ? `<rect x="${(i*colW).toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${svgH}" fill="${col}"/>` : '';
      }).join('');

      return `
      <div class="an-chart">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="an-chart-title" style="margin-bottom:0">Battery charge / discharge · SOC</div>
        </div>
        <div style="display:flex;gap:14px;font-family:var(--mono);font-size:10px;margin-bottom:10px;flex-wrap:wrap">
          <span style="color:var(--accent)">▲ charge ${dayCharge.toFixed(2)} kWh</span>
          <span style="color:var(--amber)">▼ discharge ${dayDischarge.toFixed(2)} kWh</span>
          <span style="color:var(--blue)">— SOC 0–${cap} kWh</span>
        </div>

        <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:${svgH}px;overflow:visible" preserveAspectRatio="none">
          <!-- Band colouring -->
          ${bandBg}
          <!-- Midline (zero charge/discharge) -->
          <line x1="0" y1="${mid}" x2="${svgW}" y2="${mid}" stroke="var(--line)" stroke-width="1"/>
          <!-- Charge label -->
          <text x="3" y="${mid - 3}" font-size="7" fill="#00E676" opacity=".6" font-family="monospace">CHARGE ▲</text>
          <!-- Discharge label -->
          <text x="3" y="${mid + 9}" font-size="7" fill="var(--amber)" opacity=".6" font-family="monospace">DISCHARGE ▼</text>
          <!-- Bars -->
          ${battSvg}
          <!-- SOC line (blue) -->
          <path d="${socLine}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round"/>
          ${socPts.map((v, h) => {
            const x2 = ((h / 23) * (svgW - colW/2) + colW/4).toFixed(1);
            const y2 = (svgH - 4 - (v / maxSoc) * (svgH - 8)).toFixed(1);
            return `<circle cx="${x2}" cy="${y2}" r="2" fill="var(--blue)" opacity=".8"/>`;
          }).join('')}
        </svg>

        <div class="an-hours" style="margin-top:2px">
          ${Array.from({length:24},(_,h) => `<div>${h % 6 === 0 || h === 23 ? h + 'h' : ''}</div>`).join('')}
        </div>

        <!-- Annual battery performance stats -->
        <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="padding:10px;background:var(--bg-elev);border-radius:8px;border:1px solid var(--line)">
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.08em">Annual charged</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--accent);margin-top:3px;white-space:nowrap">${Math.round(annualCharged).toLocaleString()}</div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);letter-spacing:.04em;margin-top:1px">kWh / yr</div>
            <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">${isArb ? 'Solar + cheap grid' : 'Solar surplus only'}</div>
          </div>
          <div style="padding:10px;background:var(--bg-elev);border-radius:8px;border:1px solid var(--line)">
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.08em">Annual discharged</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--amber);margin-top:3px;white-space:nowrap">${Math.round(annualDischarged).toLocaleString()}</div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);letter-spacing:.04em;margin-top:1px">kWh / yr</div>
            <div style="font-size:10px;color:var(--ink-dim);margin-top:2px">Roundtrip loss: ${Math.round(roundTripLoss)} kWh</div>
          </div>
          ${isArb ? `
          <div style="padding:10px;background:rgba(0,230,118,.04);border-radius:8px;border:1px solid var(--accent);grid-column:span 2">
            <div style="font-family:var(--mono);font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:.08em">Arbitrage strategy · est. annual gain</div>
            <div style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--accent);margin-top:3px">€${Math.round(arbValueEst).toLocaleString()}</div>
            <div style="font-size:10px;color:var(--ink-soft);margin-top:2px;font-family:var(--mono)">
              Buy cheap (${fmtCent(nightRate)}/kWh) · sell dear (${fmtCent(peakRateV)}/kWh) · ${Math.round(annualDischarged).toLocaleString()} kWh/yr cycled
            </div>
          </div>` : `
          <div style="padding:10px;background:var(--bg-elev);border-radius:8px;border:1px solid var(--line);grid-column:span 2">
            <div style="font-family:var(--mono);font-size:9px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.08em">Self-consume strategy</div>
            <div style="font-size:11px;color:var(--ink-soft);margin-top:4px;line-height:1.5">Battery fills from solar surplus only. Cheap-window grid charging is off.</div>
            <button onclick="state.strategy_mode='arbitrage';state.charge_from_grid=true;invalidate();saveState();showToast('Switched to Arbitrage — your battery now charges on cheap overnight rates.',{type:'accent',icon:'⚡',title:'Arbitrage on'});renderApp();" style="margin-top:8px;display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:999px;font-size:11.5px;font-weight:700;font-family:var(--display);border:1.5px solid var(--accent);background:var(--accent-soft);color:var(--accent);cursor:pointer">
              ⚡ Switch to Arbitrage
            </button>
          </div>`}
        </div>
      </div>`;
    })() : ''}

    <div class="an-chart">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div class="an-chart-title" style="margin-bottom:0">Tariff bands &amp; rates</div>
        <div onclick="openPlanDetail('${plan.id}')" style="font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.06em;cursor:pointer;padding:5px 9px;border:1px solid var(--accent);border-radius:6px">EDIT ↗</div>
      </div>
      ${isFlatPlan(plan) ? `
        <div class="an-bands">
          ${hours.map(x => `<div style="background:#9CA39B" title="${x.h}h flat ${fmtCent(x.rate)}/kWh"></div>`).join('')}
        </div>
        <div class="an-hours">
          ${Array.from({length:24},(_,h) => `<div>${h % 6 === 0 || h === 23 ? h + 'h' : ''}</div>`).join('')}
        </div>
        <div class="an-band-legend">
          <span style="color:#9CA39B">FLAT — ${fmtCent(plan.rates.day)}/kWh, all hours</span>
          ${plan._is_edited ? '<span style="color:var(--amber)">EDITED</span>' : ''}
        </div>
      ` : `
        <div class="an-bands">
          ${hours.map(x => {
            const col = BAND_COLORS[x.band] || BAND_COLORS.day;
            return `<div style="background:${col}" title="${x.h}h ${x.band} · ${fmtCent(x.rate)}/kWh"></div>`;
          }).join('')}
        </div>
        <div class="an-hours">
          ${Array.from({length:24},(_,h) => `<div>${h % 6 === 0 || h === 23 ? h + 'h' : ''}</div>`).join('')}
        </div>
        <div class="an-band-legend">
          ${['ev','night','day','peak','wfh'].filter(b => plan.rates[b] != null && plan.rates[b] !== undefined).map(b => `
            <span style="color:${BAND_COLORS[b]}">${b.toUpperCase()} ${fmtCent(plan.rates[b])}/kWh</span>
          `).join('')}
          ${plan._is_edited ? '<span style="color:var(--amber)">EDITED</span>' : ''}
        </div>
      `}
    </div>

    <div class="an-chart">
      <div class="an-chart-title">Net cost per hour (€)</div>
      <div class="an-cost-strip">
        ${hours.map(x => {
          const v = x.hCost;
          const pct = Math.max(2, Math.round(Math.abs(v) / maxCost * 100));
          return `<div class="an-cost-cell ${v < 0 ? 'credit' : ''}" style="height:${pct}%" title="${x.h}h: €${v.toFixed(2)}"></div>`;
        }).join('')}
      </div>
      <div class="an-hours">
        ${Array.from({length:24},(_,h) => `<div>${h % 6 === 0 || h === 23 ? h + 'h' : ''}</div>`).join('')}
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);margin-top:6px;letter-spacing:.04em">Red = paid · Green = credit (export revenue exceeds import cost)</div>
    </div>

    <div class="section-title">Monthly breakdown</div>
    <div class="an-flow-tabs">
      <div class="an-flow-tab ${state._an_view === 'flows' ? 'active' : ''}" onclick="setAnalyticsView('flows')">Gen vs Use</div>
      <div class="an-flow-tab ${state._an_view === 'monthly' ? 'active' : ''}" onclick="setAnalyticsView('monthly')">Import vs Export</div>
    </div>

    <div class="an-chart">
      ${state._an_view === 'flows' ? `
        <div style="display:flex;gap:18px;font-family:var(--mono);font-size:10px;letter-spacing:.04em;margin-bottom:10px">
          <span style="color:var(--accent)">■ Solar generated</span>
          <span style="color:var(--amber)">■ House consumed</span>
        </div>
        <div class="an-month-bars">
          ${m.gen.map((g,i) => `<div class="an-month-bar gen" style="height:${Math.max(2,Math.round(g/monthMax*100))}%" title="Gen ${Math.round(g)} kWh"></div>`).join('')}
        </div>
        <div class="an-month-bars" style="margin-top:0">
          ${m.cons.map((c,i) => `<div class="an-month-bar cons" style="height:${Math.max(2,Math.round(c/monthMax*100))}%" title="Use ${Math.round(c)} kWh"></div>`).join('')}
        </div>
      ` : `
        <div style="display:flex;gap:18px;font-family:var(--mono);font-size:10px;letter-spacing:.04em;margin-bottom:10px">
          <span style="color:var(--amber)">■ Grid imported</span>
          <span style="color:var(--accent)">■ Grid exported</span>
        </div>
        <div class="an-month-bars">
          ${m.imp.map((v,i) => `<div class="an-month-bar imp" style="height:${Math.max(2,Math.round(v/(Math.max(...m.imp,...m.exp))*100))}%" title="Imp ${Math.round(v)} kWh"></div>`).join('')}
        </div>
        <div class="an-month-bars" style="margin-top:0">
          ${m.exp.map((v,i) => `<div class="an-month-bar exp" style="height:${Math.max(2,Math.round(v/(Math.max(...m.imp,...m.exp))*100))}%" title="Exp ${Math.round(v)} kWh"></div>`).join('')}
        </div>
      `}
      <div class="an-month-labels">
        ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(mo => `<div>${mo}</div>`).join('')}
      </div>
    </div>

    <p class="disclaimer">
      <b>How to read.</b> Each chart shows what your system would do on the selected day at the selected plan. Per-hour numbers are simulated — actual will vary ±5-8% with weather. The day total uses real tariff bands; for dynamic plans we use the modeled SEMOpx curve.
    </p>
  </div>
  ${bottomNav()}`;
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

function doGeneratePdf(email){
  if (!email) {
    const emailEl = document.getElementById('pdf-email-input');
    email = emailEl ? emailEl.value.trim() : '';
  }
  const modal = document.getElementById('pdf-modal');
  if (modal) modal.remove();

  if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined'){
    showToast('Preparing your report\u2026', { type:'accent', icon:ic('doc',16) });
    ensureJsPdf().then(ok => {
      if (ok) doGeneratePdf(email);
      else showToast('Couldn\u2019t start the PDF engine \u2014 please reload and try again', { type:'amber', icon:ic('warn',16) });
    });
    return;
  }

  try {
    if (CACHE.dirty) rebuildBase();
    const best         = getBestPlan();
    const baselinePlan = getPlanById(state.baseline);
    const baseSim      = baselineSim(state.baseline);
    const baseCost     = sumF(baseSim.cost) + baselinePlan.standing;
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
        const sc = range[state._scenario_view || 'realistic'] || range.realistic;
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
        const cur = sumF(bs.cost) + baselinePlan.standing;
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
       * The caller's own restore is not enough. Rebuilding runs the state
       * sanitizer, which owns some fields outright — set battery_kwh to 0 for
       * the "remove the battery" lever and it forces strategy_mode to
       * 'self-consume' and clears charge_from_grid. Restoring the battery does
       * not restore those, so generating a report used to silently change the
       * user's dispatch strategy and every figure computed afterwards. Snapshot
       * the sanitizer-owned fields here, where no individual lever can forget.
       */
      const GUARDED = ['strategy_mode', 'charge_from_grid', 'hot_water_strategy'];
      const trial = (mutate, restore) => {
        const guard = {};
        GUARDED.forEach(k => { guard[k] = state[k]; });
        mutate();
        invalidate(); rebuildBase();
        const v = getBestPlan().net;
        restore();
        GUARDED.forEach(k => { state[k] = guard[k]; });
        invalidate(); rebuildBase();
        return baseNet - v;   // positive = better off after the change
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

    const data = buildReportData({
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
    doc.save('solar-optimiser-report-' + new Date().toISOString().slice(0,10) + '.pdf');
    showToast('Report downloaded', { type:'accent', icon:ic('checkC',16) });
    fireEvent('pdf_generated', { has_solar: !!state.has_solar, ev: !!state.ev_active });
    if (email) submitPdfRequest(email);
  } catch (err){
    console.error('PDF generation failed', err);
    showToast('Couldn\u2019t build the report \u2014 a plain-text summary was downloaded instead',
      { type:'amber', icon:ic('warn',16) });
    try { downloadTextReport(email); } catch(_){}
  }
}

// Plain-text report fallback (no jsPDF). Small, always works, downloads as .txt.
function downloadTextReport(email){
  const best = getBestPlan();
  if (!best || !best.plan) { showToast('No plan data to export yet', { type:'amber' }); return; }
  const saving = Math.max(0, (best.baseCost || 0) - best.net);
  const kwp = totalKwp();
  const L = [];
  L.push('SOLAR OPTIMISER — SUMMARY REPORT');
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

function setAnalyticsView(v){
  state._an_view = v;
  saveState();
  renderApp();
}

/* ============================================================
   STRATEGY + CONSUMPTION SHAPE — for Settings tab
   ============================================================ */

function renderStrategyControls(){
  const hasBatt = (state.battery_kwh || 0) > 0;
  const isArb = state.strategy_mode === 'arbitrage' && state.charge_from_grid;
  return `
    <div class="strat-row">
      <div class="strat-opt ${isArb ? 'active' : ''}" onclick="setStrategy('arbitrage', true)" style="${!hasBatt ? 'opacity:0.4;pointer-events:none' : ''}">
        <div class="strat-opt-icon">${ic('bolt',18)}</div>
        <div class="strat-opt-title">Arbitrage</div>
        <div class="strat-opt-sub">Charge battery from grid in cheap windows · discharge at peak. Maximises savings on TOU/EV plans.</div>
      </div>
      <div class="strat-opt ${!isArb ? 'active' : ''}" onclick="setStrategy('self-consume', false)" style="${!hasBatt ? 'opacity:0.4;pointer-events:none' : ''}">
        <div class="strat-opt-icon">${ic('sun',18)}</div>
        <div class="strat-opt-title">Self-consume</div>
        <div class="strat-opt-sub">Battery only fills from solar surplus. Simpler, but gives up arbitrage gain. Good if your plan has no cheap window.</div>
      </div>
    </div>
    ${!hasBatt ? `<p style="font-size:11px;color:var(--ink-dim);margin:6px 0 0;font-family:var(--display);letter-spacing:.02em">Add a battery (Battery section above) to enable strategy selection.</p>` : ''}

    <div style="margin-top:14px">
      <div style="font-size:11px;color:var(--ink-soft);font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:8px">Hot water strategy</div>
      <div class="strat-row" style="grid-template-columns:1fr 1fr 1fr">
        ${[['none','None','HW from gas/oil boiler — no electric load'],
           ['smart','Smart','15% of load shifted to 2-5am window'],
           ['legacy','Legacy','Immersion timer boost at peak hours']].map(([v,lbl,sub]) => `
          <div class="strat-opt ${state.hot_water_strategy === v ? 'active' : ''}" onclick="setHotWater('${v}')">
            <div class="strat-opt-title">${lbl}</div>
            <div class="strat-opt-sub">${sub}</div>
          </div>`).join('')}
      </div>
      <p style="font-size:11px;color:var(--ink-dim);margin:8px 0 0;font-family:var(--mono);letter-spacing:.02em">
        Gas/oil heating auto-resets to "None" (combi boiler handles HW). Override here if you have separate electric immersion.
      </p>
    </div>`;
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
      <button onclick="clearShapeOverride()" style="background:transparent;border:1px solid var(--line);color:var(--ink-soft);padding:8px 14px;border-radius:8px;font-family:var(--mono);font-size:10px;letter-spacing:.04em;cursor:pointer">Reset to heating-type default</button>
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
      <div style="font-family:var(--display);font-size:22px;font-weight:700;color:var(--ink);line-height:1.3;letter-spacing:-.015em;margin-top:4px">Paste an installer quote.<br>Get an objective verdict.</div>
      <div class="qr-sub">Compared against 2026 Irish market benchmarks. We have no affiliations with installers.</div>
    </div>

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
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.7;font-family:var(--mono)">
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
  if (!state._settings_open) state._settings_open = 'home';
  const open = state._settings_open;

  const section = _refineSection;

  const region = IRISH_REGIONS[state.region || 'east'];
  const homeSummary = `${region.name} · ${state.heating_type} · €${state.bimonthly_bill_eur}/bimonth`;
  const solarSummary = state.considering_solar
    ? `${totalKwp().toFixed(1)} kWp${state.battery_kwh > 0 ? ' + ' + state.battery_kwh + ' kWh' : ''} · €${state.install_cost.toLocaleString()} gross`
    : 'No solar configured yet';
  const stratSummary = state.battery_kwh > 0
    ? `${state.strategy_mode || 'arbitrage'}${state.charge_from_grid ? ' · grid-charge ON' : ''} · HW: ${state.hot_water_strategy || 'none'}`
    : 'No battery — strategy not applicable';
  const evSummary = state.ev_active
    ? `${(state.ev_km_per_year || 0).toLocaleString()} km/yr · ${state.ev_kwh_per_100km || 17} kWh/100km · ${state.ev_charger_kw || 7} kW charger`
    : 'No EV in household';
  const tariffDates = TARIFFS.map(t => t.verified_date).filter(Boolean).sort();
  const tariffSummary = tariffDates.length
    ? `${TARIFFS.length} plans · last verified ${fmtVerifiedDate(tariffDates[tariffDates.length-1])}`
    : `${TARIFFS.length} plans bundled`;
  const csvSummary = state._csv_imported
    ? `✓ Smart meter data imported · ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr`
    : 'Replace bill estimate with real 30-min interval data';
  const shapeSummary = 'Edit only if you have evidence — default profile is calibrated for Irish homes';

  return `${topbar('Settings', 'sage', true)}
  <div class="screen">
    <div class="qr-hero" style="background:var(--surface-deep);border-color:var(--ink-soft);box-shadow:var(--hero-shadow)">
      <div class="qr-eyebrow" style="color:var(--ink-soft)">Direct edit</div>
      <div style="font-family:var(--display);font-size:15px;font-weight:600;color:var(--ink);line-height:1.4;letter-spacing:-.01em">Tap any section. Changes autosave and re-run the simulation.</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
        <div style="flex:1">
          <div style="font-size:12.5px;font-weight:700;color:var(--ink)">View</div>
          <div style="font-size:10.5px;color:var(--ink-soft);margin-top:1px">${state.simple_mode ? 'Essential fields only' : 'All fields shown'}</div>
        </div>
        <div style="display:flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well)">
          <button onclick="state.simple_mode=true;saveState();renderApp();" style="padding:7px 14px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${state.simple_mode?'var(--accent)':'transparent'};color:${state.simple_mode?'#fff':'var(--ink-soft)'}">Simple</button>
          <button onclick="state.simple_mode=false;saveState();renderApp();" style="padding:7px 14px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${!state.simple_mode?'var(--ink)':'transparent'};color:${!state.simple_mode?'#fff':'var(--ink-soft)'}">Expert</button>
        </div>
      </div>
    </div>

    ${section('home', ic('home',17), 'Home & bills', homeSummary, `
      <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase;font-weight:600;margin-bottom:10px">Region</div>
      ${renderRegionPicker(state.region || 'east')}
      <div style="margin-top:14px">
        ${refineRow('Heating type', '', refineSel('rf-heat', state.heating_type, [['gas','Gas / Oil Boiler'],['heatpump','Heat pump'],['storage','Storage heaters'],['direct','Direct electric']]))}
        ${state._csv_imported ? `<div style="margin-bottom:10px">${csvLockCard(true)}</div>` : `
        ${refineRow('Usage from', 'kWh/yr beats a € bill for accuracy if you have it', `
          <div style="display:flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well);width:fit-content">
            <button onclick="setUsageMode('bill')" style="padding:7px 13px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${state.usage_input_mode !== 'kwh' ? 'var(--accent)' : 'transparent'};color:${state.usage_input_mode !== 'kwh' ? '#fff' : 'var(--ink-soft)'}">€ Bill</button>
            <button onclick="setUsageMode('kwh')" style="padding:7px 13px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${state.usage_input_mode === 'kwh' ? 'var(--accent)' : 'transparent'};color:${state.usage_input_mode === 'kwh' ? '#fff' : 'var(--ink-soft)'}">kWh / year</button>
          </div>`)}
        ${state.usage_input_mode === 'kwh'
          ? refineRow('Yearly consumption (kWh)', 'Ground truth — we shape it across the year by heating type. Derived bill: ~€' + (state.bimonthly_bill_eur || 0) + '/2mo', refineNum('rf-kwh', state.annual_kwh || (state.bills && Object.keys(state.bills).length ? Object.values(state.bills).reduce((a,b)=>a+b,0) : 4200), 500, 40000, 100, 'kWh'))
          : refineRow('Bimonthly bill (€)', 'Auto-derives kWh', refineNum('rf-bill', state.bimonthly_bill_eur, 0, 1500, 10, '€'))}`}
        ${refineRow('Currently on', 'Plan to compare against', refineSel('rf-base', state.baseline, activeTariffsSorted().map(t => [t.id, t.supplier + ' — ' + t.plan])))}
        ${refineRow('Discount on your plan (%)', 'Sign-up discount or equivalent older rates — % off unit rates on YOUR current plan only. Standing charge stays full price.', refineNum('rf-disc', state.baseline_discount_pct || 0, 0, 60, 1, '%'))}
      </div>
    `)}

    ${section('solar', ic('sun',17), 'Solar system', solarSummary, state.considering_solar ? `
      ${refineRow('Front roof — panels', state.count_A > 30 ? "\u26A0 That is a large array for one roof — double-check the count" : 'Number of panels on your main roof', refineNum('rf-cA', state.count_A, 0, 40, 1, ''))}
      ${refineRow('Front roof — orientation', sectorFromAzimuth(state.azimuth_A) + ' (' + state.azimuth_A + '°)', refineSel('rf-azA', sectorFromAzimuth(state.azimuth_A), [['S','South'],['SE','Southeast'],['SW','Southwest'],['E','East'],['W','West'],['NE','Northeast'],['NW','Northwest'],['N','North']]))}
      ${refineRow('Front roof — tilt', '', refineNum('rf-tiltA', state.tilt_A, 0, 90, 1, '°'))}
      ${refineRow('Back roof — panels', state.count_B > 30 ? "\u26A0 Unusually large for a second roof — sure?" : '0 if single roof', refineNum('rf-cB', state.count_B, 0, 40, 1, ''))}
      ${state.count_B > 0 ? refineRow('Back roof — orientation', sectorFromAzimuth(state.azimuth_B) + ' (' + state.azimuth_B + '°)', refineSel('rf-azB', sectorFromAzimuth(state.azimuth_B), [['S','South'],['SE','Southeast'],['SW','Southwest'],['E','East'],['W','West'],['NE','Northeast'],['NW','Northwest'],['N','North']])) + refineRow('Back roof — tilt', '', refineNum('rf-tiltB', state.tilt_B, 0, 90, 1, '°')) : ''}
      ${refineRow('Panel wattage (W)', 'Check your installer spec sheet — modern N-type: 420–480W, older panels: 250–350W.', refineNum('rf-pw', state.panel_w, 200, 700, 5, 'W'))}
      ${refineRow('Battery storage (kWh)', state.battery_kwh > 30 ? "\u26A0 That is a very large home battery — double-check the size" : 'Enter 0 if no battery. A 9 kWh battery covers a typical family evening.', refineNum('rf-batt', state.battery_kwh, 0, 50, 0.5, 'kWh'))}
      ${refineRow('Install cost (gross)', '', refineNum('rf-cost', state.install_cost, 0, 50000, 100, '€'))}
      ${refineRow('SEAI grant', state.grant_is_manual ? "You've set this manually — clear the field to return to auto" : 'Auto-calculated from your system size — editing locks it to your value', refineNum('rf-grant', state.grant_seai, 0, 5000, 100, '€'))}
      <div style="margin-top:14px;border-top:1px solid var(--line-soft);padding-top:12px">
        <button onclick="state._expert_open=!state._expert_open;renderApp();" style="display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;font-size:11px;font-weight:700;font-family:var(--mono);border:1px solid var(--line);background:${state._expert_open ? 'var(--well)' : 'transparent'};color:var(--ink-soft);cursor:pointer;letter-spacing:.04em">
          ${ic('tune',12)} Expert mode ${state._expert_open ? '▲' : '▼'}
        </button>
        ${state._expert_open ? `
        <div style="margin-top:10px;padding:12px 14px;background:var(--well);border:1px solid var(--line);border-radius:12px">
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:10px">Advanced simulation parameters</div>
          ${refineRow('Inverter size (kW)', 'Max AC output. Typical Irish home: 4.6–6 kW. Should roughly match your total array kWp.', refineNum('rf-inv', state.inverter_kw, 1, 20, 0.5, 'kW'))}
          ${refineRow('Battery depth of discharge (%)', 'Most lithium batteries: 90–100%. Lowering this reduces usable capacity but extends battery life.', refineNum('rf-dod', Math.round((state.battery_dod || 0.9) * 100), 50, 100, 5, '%'))}
          ${refineRow('Panel degradation (%/yr)', 'Industry typical: 0.4%/yr. Premium N-type panels: 0.3%/yr. Older poly: 0.6%/yr.', refineNum('rf-deg', Math.round((state.panel_degradation || 0.004) * 1000) / 10, 0.1, 1.5, 0.1, '%/yr'))}
        </div>` : ''}
      </div>
    ` : `
      <div onclick="exploreSolar()" style="padding:12px;background:var(--amber-soft);border:1px solid var(--amber);border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:12px">
        <div>${ic('sun',22)}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:var(--ink)">Add a solar system to model</div>
          <div style="font-size:11px;color:var(--ink-soft);margin-top:2px">Currently only modelling tariff savings</div>
        </div>
        <div style="color:var(--ink-soft);font-size:18px">›</div>
      </div>
    `)}

    ${sectionIf(!state.simple_mode, 'strategy', ic('bolt',17), 'Battery strategy', stratSummary, renderStrategyControls())}

    ${section('ev', ic('car',17), 'Electric vehicle', evSummary, `
      ${refineRow('EV in household', '', refineToggle('rf-ev', state.ev_active))}
      ${state.ev_active ? `
        ${refineRow('EV status', 'Determines whether its kWh are inside or on top of your bill', `
          <div style="display:flex;gap:6px">
            <button onclick="setEvMode('have')" style="flex:1;padding:8px 6px;border-radius:999px;font-size:11px;font-weight:700;font-family:var(--display);border:1px solid ${state.ev_in_bill ? 'var(--accent)' : 'var(--line)'};background:${state.ev_in_bill ? 'var(--accent-soft)' : 'transparent'};color:${state.ev_in_bill ? 'var(--accent)' : 'var(--ink-soft)'}">Have it · in bill</button>
            <button onclick="setEvMode('plan')" style="flex:1;padding:8px 6px;border-radius:999px;font-size:11px;font-weight:700;font-family:var(--display);border:1px solid ${!state.ev_in_bill ? 'var(--accent)' : 'var(--line)'};background:${!state.ev_in_bill ? 'var(--accent-soft)' : 'transparent'};color:${!state.ev_in_bill ? 'var(--accent)' : 'var(--ink-soft)'}">Planning · on top</button>
          </div>`)}
        ${state._ev_just_enabled ? `
          <div class="ev-fields-prompt">
            <p>We've added an EV using <b style="color:var(--amber)">typical Irish defaults</b>. <b style="color:var(--ink)">Confirm or edit these fields below</b> — the simulation has already updated.</p>
          </div>
        ` : ''}
        ${refineRow('Annual driving', 'Irish avg: 16,500 km/yr', refineNum('rf-evkm', state.ev_km_per_year, 0, 100000, 500, 'km'))}
        ${refineRow('EV efficiency', 'Small ~14, mid ~17, SUV ~20', refineNum('rf-eveff', state.ev_kwh_per_100km, 5, 35, 0.5, 'kWh/100km'))}
        ${refineRow('Home charger', '7.4 kW typical AC', refineNum('rf-evchg', state.ev_charger_kw, 1.4, 22, 0.1, 'kW'))}
      ` : ''}
    `)}

    ${sectionIf(!state.simple_mode, 'tariffs', ic('radar',17), 'Tariff data freshness', tariffSummary, `
      <div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line-soft);margin-bottom:10px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--ink)">Include dynamic-price plans</div>
          <div style="font-size:10.5px;color:var(--ink-soft);margin-top:2px;line-height:1.5">Wholesale-tracking plans (hourly market price) are excluded from rankings until pricing clarity improves. Their real cost depends on market swings nobody can predict.</div>
        </div>
        <div onclick="state.include_dynamic=!state.include_dynamic;invalidate();saveState();renderApp()" style="flex-shrink:0;width:44px;height:26px;border-radius:99px;cursor:pointer;background:${state.include_dynamic ? 'var(--accent)' : 'var(--track-soft)'};position:relative;transition:background .15s">
          <div style="position:absolute;top:3px;left:${state.include_dynamic ? '21px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .15s"></div>
        </div>
      </div>
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);line-height:1.7;margin-bottom:12px">
        ${(() => {
          const dates = TARIFFS.map(t => t.verified_date).filter(Boolean).sort();
          const latest = dates.length ? dates[dates.length-1] : null;
          const s = state._tariff_status;
          const apiAvailable = state._refresh_api_available !== false;
          let html = '';
          if (latest){
            html += `<b style="color:var(--ink)">Bundled rates verified:</b> ${fmtVerifiedDate(latest)} (${TARIFFS.length} plans)`;
          }
          if (s && s.timestamp){
            const ts = new Date(s.timestamp).toLocaleString('en-IE', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
            html += `<br><span style="color:var(--ink-dim)">Last live check: ${ts}</span>`;
            const changes = (s.potential_changes || []).length;
            if (changes > 0) html += `<br><span style="color:var(--amber)">${changes} possible rate change${changes>1?'s':''} flagged</span>`;
          }
          if (!apiAvailable){
            html += `<br><span style="color:var(--ink-dim)">Live refresh is unavailable on this deployment — rates are manually verified and bundled with each release.</span>`;
          }
          return html || '<span style="color:var(--ink-dim)">Tariff data bundled with this release.</span>';
        })()}
      </div>
      ${state._refresh_api_available !== false ? `
        <button class="btn-secondary" id="tariff-refresh-btn" onclick="refreshTariffs()" style="width:100%">
          ${state._tariff_refreshing ? 'Checking supplier sites…' : 'Try live refresh'}
        </button>
        <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);text-align:center;margin-top:6px;letter-spacing:.04em;line-height:1.5">
          Heads up: most supplier sites block automated checks (HTTP 403).<br>If the refresh shows "0 confirmed", that's why — bundled rates are still accurate.
        </div>
      ` : `
        <div style="padding:10px 12px;background:rgba(90,156,255,.04);border:1px solid rgba(90,156,255,.15);border-radius:8px;font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.6;text-align:center">
          ⓘ Live refresh runs on the dev server, not this static deploy.<br>Rates are manually verified and shipped with each release.
        </div>
      `}
      ${(state._tariff_status?.potential_changes || []).length > 0 ? `
        <div style="margin-top:10px;padding:10px 12px;background:rgba(255,145,0,.08);border:1px solid rgba(255,145,0,.35);border-radius:8px;font-family:var(--mono);font-size:10px;line-height:1.7">
          <b style="color:var(--amber)">Possible rate changes detected:</b><br>
          ${(state._tariff_status.potential_changes || []).map(c =>
            `${c.id}: ${c.stored}c → ${c.found}c (${c.diff_c > 0 ? '+' : ''}${c.diff_c}c/kWh)`
          ).join('<br>')}
          <br><span style="color:var(--ink-dim)">Rates shown are our last verified figures. Edit any plan in the Plans tab.</span>
        </div>
      ` : ''}
    `)}

    ${section('csv', ic('csv',17), 'Smart meter data', csvSummary, `
      <div onclick="setScreen('csv-import')" style="padding:12px;background:rgba(90,156,255,.05);border:1px solid rgba(90,156,255,.3);border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:12px">
        <div>${ic('csv',18)}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:var(--ink)">${state._csv_imported ? 'Update or replace imported CSV' : 'Import ESB smart meter CSV'}</div>
          <div style="font-size:11px;color:var(--ink-soft);margin-top:2px">${state._csv_imported ? `Currently using real 30-min data — ${Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)).toLocaleString()} kWh/yr` : 'Use real data from esbnetworks.ie instead of a bill estimate'}</div>
        </div>
        <div style="color:var(--ink-soft);font-size:18px">›</div>
      </div>
    `)}

    ${sectionIf(!state.simple_mode, 'shape', ic('chart',17), 'Advanced — consumption shape', shapeSummary, renderShapeControls())}

    <div style="margin-top:18px;padding:12px 14px;background:var(--accent-faint);border:1px solid var(--accent);border-radius:10px;font-size:11px;color:var(--ink-soft);line-height:1.55;text-align:center">
      <b style="color:var(--accent);font-family:var(--mono);letter-spacing:.08em">✓ AUTOSAVE</b><br>
      Every change saves immediately. Tap any tab to see new results.
    </div>

    <div style="margin-top:14px;display:flex;gap:10px">
      <button class="btn-secondary" style="flex:1" onclick="restartOnboarding()">Restart onboarding</button>
      <button class="btn-secondary" style="flex:1" onclick="confirmResetAll()">Reset everything</button>
    </div>

    <div onclick="setScreen('auditor')" style="margin-top:14px;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:12px">
      <div>${ic('clip',18)}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:var(--ink)">Audit an installer quote</div>
        <div style="font-size:11px;color:var(--ink-soft);margin-top:2px">Benchmark vs 2026 Irish prices</div>
      </div>
      <div style="color:var(--ink-soft);font-size:18px">›</div>
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
    ${unit ? `<span style="font-size:11px;color:var(--ink-soft);font-family:var(--mono)">${unit}</span>` : ''}
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
  const btn = (d, sym) => `<button onclick="rfAdj('${key}',${d},${min},${max})" style="width:38px;height:38px;border-radius:10px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink);font-size:18px;font-weight:700;font-family:var(--mono);cursor:pointer;flex-shrink:0">${sym}</button>`;
  return `<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
    ${btn(-s, '−')}
    <div style="min-width:64px;text-align:center;font-family:var(--mono);font-size:16px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${val}<span style="font-size:10px;font-weight:400;color:var(--ink-soft)">${unit ? ' ' + unit : ''}</span></div>
    ${btn(s, '+')}
  </div>`;
}
function rfBatteryControl(){
  const val = +state.battery_kwh || 0;
  const opts = [[0,'None'],[5,'5'],[8,'8'],[9.5,'9.5'],[10,'10'],[13.5,'13.5']];
  if (!opts.some(([v]) => Math.abs(v - val) < 0.001)) opts.push([val, String(val)]);
  return `<div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end">${opts.map(([v, l]) => `
      <div onclick="rfSet('battery_kwh',${v},0,50)" style="padding:7px 11px;border-radius:999px;font-size:11.5px;font-weight:700;font-family:var(--mono);cursor:pointer;border:1.5px solid ${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--line)'};background:${Math.abs(v - val) < 0.001 ? 'var(--accent-soft)' : 'transparent'};color:${Math.abs(v - val) < 0.001 ? 'var(--accent)' : 'var(--ink-soft)'}">${l}</div>`).join('')}</div>
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
    state.strategy_mode = 'arbitrage';
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
    state.strategy_mode = 'arbitrage';
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
    showToast('Lead submitted. We\'ll match you with 3 SEAI installers within 48h.');
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
    ? { bg:'#F2F5F2', ink:'#111A14' }
    : { bg:'#090D0A', ink:'#F4F6F5' };
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

function topbar(title, accent, showBack){
  return `<div class="topbar ${accent || 'accent'}">
    <div class="stripe"></div>
    ${showBack
      ? `<button class="icb" onclick="goBack()" aria-label="Back">${ic('chevL', 19)}</button>`
      : `<div class="brand" onclick="setScreen('result')" style="cursor:pointer" role="button" aria-label="Home">${'<span class="brandmark">'}${ic('sun', 15, 'stroke-width:2')}</span>Solar <em>Optimiser</em></div>`}
    <div class="topbar-title">${showBack && title ? title : ''}</div>
    <div style="display:flex;align-items:center;gap:2px">
      ${renderProfileNavBtn()}
      <button class="icb" onclick="setScreen('refine')" aria-label="Settings">${ic('tune', 18)}</button>
    </div>
  </div>`;
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
      <div class="mon-status-line">Market checks are hidden. Turn them back on and we'll re-rank every Irish tariff against your usage each time you open the app.</div>
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
      <div class="mon-status-meta">Your current plan ranks #${rank || '–'} of ${countLabel} for your usage</div>
      <button class="switch-cta" style="margin-top:13px;margin-bottom:0;font-size:14px;padding:13px"
        onclick="handleSwitchClick('${best.plan.id}','${(best.plan.supplier+' '+best.plan.plan).replace(/'/g,"\\'")}',${savings.toFixed(0)})">
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
      <div style="display:flex;gap:12px"><span style="font-family:var(--mono);font-size:11px;color:var(--blue);cursor:pointer" onclick="setContractReminder()">edit</span><span style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);cursor:pointer" onclick="clearContractDate()">clear</span></div>
    </div>`;
  } else if (state._contract_edit){
    contractHtml = `<div class="mon-toggle" style="flex-wrap:wrap;gap:10px">
      <div style="width:100%"><div class="mon-toggle-label">When does your contract end?</div>
        <div class="mon-toggle-sub">It's on your bill or in your sign-up email — roughly is fine</div></div>
      <input type="date" id="contract-date-input" style="flex:1;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--well);color:var(--ink);font-family:var(--mono);font-size:13px"/>
      <button onclick="saveContractDate()" style="padding:10px 16px;border-radius:999px;font-size:12px;font-weight:700;font-family:var(--display);border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent)">Save</button>
      <button onclick="cancelContractEdit()" style="padding:10px 12px;border-radius:999px;font-size:12px;font-weight:600;font-family:var(--display);border:1px solid var(--line);background:transparent;color:var(--ink-soft)">Cancel</button>
    </div>`;
  } else {
    contractHtml = `<div class="mon-toggle" onclick="setContractReminder()" style="cursor:pointer">
      <div><div class="mon-toggle-label">Add a contract-end reminder</div>
        <div class="mon-toggle-sub">Set your contract end date — we'll flag it here from 30 days out</div></div>
      <div style="font-family:var(--mono);font-size:18px;color:var(--accent)">+</div>
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
    title:`Your plan sits #${rank || '–'} of ${countLabel}`,
    sub:`Top 3 for your profile: ${top3.map(t => getPlanById(t.id).supplier).join(', ')}.` });
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

  return `${topbar('Market Monitor', 'blue', true)}
  <div class="screen">
    <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.5;margin:2px 2px 14px">We watch every Irish tariff for you, and only speak up when it's worth acting.</div>
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
      <div style="font-family:var(--mono);font-size:10px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase;font-weight:700;margin-bottom:8px">${ic('check',12,'vertical-align:-2px')} Your switching record</div>
      ${state.switch_history.slice(-3).reverse().map(h => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:12px">
          <div style="color:var(--ink)">${h.planName}<div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-dim);margin-top:2px">${fmtShortDate(h.date)}</div></div>
          <div style="font-family:var(--mono);font-weight:700;color:var(--accent);white-space:nowrap">€${(h.savings||0).toLocaleString()}/yr</div>
        </div>`).join('')}
      <div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-dim);margin-top:8px;letter-spacing:.03em">Projected savings at the moment you started each switch</div>
    </div>` : ''}
    <div class="section-title">Recent activity</div>
    <div class="mon-timeline">${timelineHtml}</div>

    <div class="section-title">What we check for you</div>
    <div class="mon-watch">
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('bolt',14)}</span><div><b>A better plan appeared.</b> A new or repriced tariff now beats your current one for your usage.</div></div>
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('bell',14)}</span><div><b>Your contract is ending.</b> Before you roll onto a default rate, we flag it here so you can re-check.</div></div>
      <div class="mon-watch-item"><span class="mon-watch-ic">${ic('sun',14)}</span><div><b>Seasonal solar insight.</b> If you have panels, how your roof performed and what it saved.</div></div>
    </div>
    <div style="font-size:11px;color:var(--ink-soft);text-align:center;margin-top:12px;line-height:1.6;padding:0 6px">
      These checks run here, in the app — we don't email you or send push notifications, and there's no account required. Open Monitor whenever you want a fresh read.
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
  showToast(state.monitoring_on ? 'Market checks on — re-ranked every time you open the app' : 'Market checks hidden',
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
  const curCost = sumF(baselineSim(state.baseline).cost) + cur.standing;
  const stdCost = sumF(simulateBaseline(std, baseCons).cost) + std.standing;
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
      <div style="font-family:var(--display);font-size:18px;font-weight:600;color:var(--ink);line-height:1.35;margin-top:6px">We only make money when you actually save money. Here's exactly how.</div>
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
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);cursor:pointer;margin-top:6px" onclick="removeQuote('${q.id}')">remove</div>
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
      <button class="switch-cta" style="margin:6px 0 0;font-size:14px;padding:13px" onclick="addQuote()">Add &amp; assess quote</button>
    </div>

    ${quotes.length ? `<div class="section-title">Your quotes, assessed</div>${list}` : `
      <div style="text-align:center;padding:30px 16px;color:var(--ink-soft);font-family:var(--mono);font-size:12px;line-height:1.7">
        No quotes yet.<br>Add one above to see how it stacks up.
      </div>`}

    <div class="refine-panel" style="padding:13px 15px;background:rgba(90,156,255,.04);border-color:rgba(90,156,255,.2);margin-top:8px">
      <div style="font-family:var(--mono);font-size:9.5px;letter-spacing:.08em;color:var(--blue);font-weight:700;margin-bottom:5px">WHY YOU CAN TRUST THIS</div>
      <div style="font-size:11.5px;color:var(--ink-soft);line-height:1.5">Installers pay us per introduction — never to rank higher or to soften a verdict. The benchmark is our own model of Irish 2026 prices.</div>
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
      <div style="font-size:11px;color:var(--ink-soft);line-height:1.5;margin-bottom:10px">Snapshots your current setup — ${liveSummary.hasSolar ? liveSummary.panels + ' panels' : 'no solar'}${liveSummary.battery > 0 ? ' · ' + liveSummary.battery + ' kWh' : ''}${liveSummary.ev ? ' · EV' : ''}, best plan ${liveSummary.bestPlanName}. Load or compare it later.</div>
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
        <div style="font-family:var(--display);font-size:18px;font-weight:600;color:var(--ink);line-height:1.35;margin-top:6px">Design a case, save it, compare them side by side.</div>
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
          <div style="font-size:13.5px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div>
          <div style="font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);margin-top:3px;line-height:1.5">
            ${sm.hasSolar ? sm.kwp + ' kWp · ' + sm.panels + ' panels' : 'no solar'}${sm.battery > 0 ? ' · ' + sm.battery + ' kWh' : ''}${sm.ev ? ' · EV' : ''}<br>
            ${sm.bestPlanName} · €${(sm.bestNet||0).toLocaleString()}/yr${sm.payback != null ? ' · ' + sm.payback.toFixed(1) + 'yr payback' : ''}
          </div>
        </div>
        <label style="display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;flex-shrink:0">
          <div onclick="toggleCompareSelect('${s.id}')" style="width:26px;height:26px;border-radius:8px;border:2px solid ${picked ? 'var(--accent)' : 'var(--line)'};background:${picked ? 'var(--accent)' : 'transparent'};display:grid;place-items:center">${picked ? '<span style="color:#fff;font-size:15px">' + ic('check',14,'stroke:#fff') + '</span>' : ''}</div>
          <span style="font-size:8.5px;color:var(--ink-dim);font-family:var(--mono)">compare</span>
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
  const headCells = cols.map(s => `<div style="font-size:10.5px;font-weight:700;color:var(--ink);text-align:center;padding:6px 4px;line-height:1.3;overflow:hidden;text-overflow:ellipsis">${s.name}</div>`).join('');

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
      return `<div style="font-family:var(--mono);font-size:11px;text-align:center;padding:7px 4px;${win ? 'color:var(--accent);font-weight:700' : 'color:var(--ink-soft)'}">${m.fmt(v)}${win ? ' ★' : ''}</div>`;
    }).join('');
    return `<div style="display:grid;grid-template-columns:96px repeat(${cols.length}, ${colW});border-top:1px solid var(--line-soft);align-items:center">
      <div style="font-size:10px;color:var(--ink-dim);font-family:var(--mono);text-transform:uppercase;letter-spacing:.03em;padding:7px 6px 7px 0">${m.k}</div>
      ${cells}
    </div>`;
  }).join('');

  return `<div class="card" style="margin-bottom:14px;overflow-x:auto">
    <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:8px">Side by side · ★ = best</div>
    <div style="display:grid;grid-template-columns:96px repeat(${cols.length}, ${colW});border-bottom:2px solid var(--line)">
      <div></div>${headCells}
    </div>
    ${rows}
    <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);margin-top:10px;line-height:1.5">Best plan & payback computed at save time. Re-save a scenario to refresh against current tariffs.</div>
  </div>`;
}

function renderMore(){
  const nQuotes = (state.solar_quotes || []).length;
  const groups = [
    ['Your setup', [
      [ic('tune',19),'Settings','Usage, heating, solar spec, EV & battery strategy','refine'],
      [ic('csv',19),'Import smart-meter data','ESB Networks CSV — the most accurate result','csv-import'],
    ]],
    ['Tools', [
      [ic('clip',19),'Audit an installer quote','Objective check against 2026 Irish market prices','auditor'],
      [ic('scales',19),'My saved quotes', nQuotes ? nQuotes + ' quote' + (nQuotes === 1 ? '' : 's') + ' saved — compare side by side' : 'Save installer quotes and compare them side by side','quotes'],
      [ic('chart',19),'Engine details & hourly flows','Day inspector · monthly bars · annual production/use/export','analytics'],
      [ic('layers',19),'Compare scenarios','Save configurations and compare them side by side','compare'],
    ]],
    ['Understand the numbers', [
      [ic('flask',19),'Methodology','Data sources & how the engine works','methodology'],
    ]],
    ['Trust & help', [
      [ic('shield',19),'Our independence','How we make money, in plain English','independence'],
      [ic('swap',19),'How to switch supplier','Step-by-step guide, takes ~10 minutes','how-to-switch'],
    ]],
  ];
  const th = state.theme === 'dark' ? 'dark' : 'light';
  return `${topbar('More', 'sage', true)}
  <div class="screen">
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
    ${groups.map(([title, items]) => `
      <div class="section-title" style="margin-top:14px">${title}</div>
      ${items.map(([icon,t,s,scr]) => `<div class="secondary-card" onclick="setScreen('${scr}')">
        <div class="secondary-card-icon">${icon}</div>
        <div class="secondary-card-body">
          <div class="secondary-card-title">${t}</div>
          <div class="secondary-card-sub">${s}</div>
        </div>
        <div class="secondary-card-arrow">›</div>
      </div>`).join('')}
    `).join('')}
    <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);text-align:center;margin-top:18px;letter-spacing:.04em;line-height:1.7">
      Solar Optimiser · Independent · Ireland<br>Your data stays on this device.
    </div>
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
    <div class="fp-sub">One number and we'll estimate the rest. You can refine anything after you see your savings.</div>

    ${state._csv_imported ? `<div style="margin-bottom:14px">${csvLockCard()}</div>` : `<div class="fp-billbox">
      <div style="display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;background:var(--well);margin-bottom:12px">
        <button onclick="fpSetUsageMode('bill')" style="padding:7px 13px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${!kwhMode && !state._fp_csv_mode?'var(--accent)':'transparent'};color:${!kwhMode && !state._fp_csv_mode?'#fff':'var(--ink-soft)'}">€ Bill</button>
        <button onclick="fpSetUsageMode('kwh')" style="padding:7px 13px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${kwhMode && !state._fp_csv_mode?'var(--accent)':'transparent'};color:${kwhMode && !state._fp_csv_mode?'#fff':'var(--ink-soft)'}">kWh / year</button>
        <button onclick="fpSetUsageMode('csv')" style="padding:7px 13px;font-size:11px;font-weight:700;font-family:var(--display);border:none;border-radius:999px;cursor:pointer;background:${state._fp_csv_mode?'var(--accent)':'transparent'};color:${state._fp_csv_mode?'#fff':'var(--ink-soft)'}">Smart CSV</button>
      </div>
      ${state._fp_csv_mode ? `
      <div style="text-align:left">
        <div style="font-size:12px;color:var(--ink-soft);line-height:1.7">Most accurate — real 30-min readings. From <b>myaccount.esbnetworks.ie</b> → My Meter → <b>Download HDF Data</b>. Less than a year still works — we scale it to a full-year profile.</div>
        <label class="btn-secondary" style="display:block;text-align:center;cursor:pointer;margin-top:10px;padding:12px 16px;border:1px dashed var(--blue);color:var(--blue);border-radius:10px">
          Choose CSV file
          <input id="csv-file-input" type="file" accept=".csv,.CSV" style="display:none" onchange="handleCsvFile(event)">
        </label>
        <div id="csv-parse-result" style="margin-top:10px"></div>
      </div>` : kwhMode ? `
      <div class="fp-billrow">
        <input class="fp-billinput" id="fp-bill" inputmode="numeric" value="${kwh}" oninput="fpSync(this.value)" style="text-align:right"/>
        <span class="fp-cur" style="font-size:16px;align-self:center">kWh</span>
      </div>
      <div class="fp-billhint">total per year · from your annual statement or smart meter</div>
      <input class="fp-billslider" type="range" min="1500" max="15000" step="100" value="${Math.min(15000, Math.max(1500, kwh))}" oninput="document.getElementById('fp-bill').value=this.value"/>` : `
      <div class="fp-billrow">
        <span class="fp-cur">€</span>
        <input class="fp-billinput" id="fp-bill" inputmode="numeric" value="${bill}" oninput="fpSync(this.value)"/>
      </div>
      <div class="fp-billhint">electricity bill only · per two months · not gas</div>
      <input class="fp-billslider" type="range" min="60" max="700" step="10" value="${bill}" oninput="document.getElementById('fp-bill').value=this.value"/>`}
    </div>`}

    <div class="fp-assume-label">We've assumed — tap any to change</div>
    <div class="fp-assume-grid">
      <div class="fp-assume" style="grid-column:span 2" onclick="fpTogglePlanPicker()">
        <span class="fp-assume-ic">${ic('bolt',16)}</span>
        <div style="flex:1;min-width:0"><div class="fp-assume-k">Current plan</div>
        <div class="fp-assume-v" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${state.baseline_known ? (getPlanById(state.baseline).supplier + ' — ' + getPlanById(state.baseline).plan) : "Not sure — we'll estimate"}</div></div>
        <span style="color:var(--ink-dim);font-family:var(--mono);font-size:11px">${state._fp_plan_open ? '▴' : '▾'}</span>
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
        <span style="color:var(--ink-dim);font-family:var(--mono);font-size:11px">tap</span>
      </div>` : ''}
      <div class="fp-assume" onclick="fpCycle('heating')"><span class="fp-assume-ic">${ic('flame',16)}</span><div><div class="fp-assume-k">Heating</div><div class="fp-assume-v">${heatLabel}</div></div></div>
      <div class="fp-assume" onclick="fpCycle('ev')"><span class="fp-assume-ic">${ic('car',16)}</span><div><div class="fp-assume-k">EV</div><div class="fp-assume-v">${state.ev_active ? Math.round((state.ev_km_per_year||15000)/1000)+'k km · ' + (state.ev_in_bill ? 'have it' : 'planning') : 'None'}</div></div></div>
    </div>

    <button class="fp-cta" onclick="fastPathGo()">See my savings →</button>
    <div class="fp-foot">No account needed · 30 seconds · free</div>
    <div class="fp-customise" onclick="startOnboarding()">Want the full setup? Solar, EV &amp; guided steps →</div>
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
    <div style="display:flex;align-items:center;gap:8px"><span>${ic('csv',16)}</span><div style="font-size:12.5px;font-weight:700;color:var(--ink)">Usage locked to your smart-meter CSV</div></div>
    <div style="font-size:11px;color:var(--ink-soft);margin-top:5px;line-height:1.55"><b style="color:var(--ink)">${kwh.toLocaleString()} kWh/yr</b> from ${state._csv_filename || 'your imported file'}${cov}. Manual € / kWh entry is disabled so it can't silently fight the real data.</div>
    <button onclick="clearCsvImport()" style="margin-top:9px;padding:8px 14px;border-radius:999px;font-size:11.5px;font-weight:700;font-family:var(--display);border:1px solid var(--blue);background:transparent;color:var(--blue);cursor:pointer">Remove CSV & enter manually</button>
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
  showToast('Here\u2019s your result — refine anything in Settings', { type:'accent', icon:ic('checkC',16) });
}

function bottomNav(){
  const cur = state.current_screen;
  // map sub-screens to their nav home so the right tab stays lit
  const moreScreens = ['analytics','quotes','auditor','independence','methodology','how-to-switch','refine','csv-import','compare'];
  const navActive = moreScreens.includes(cur) ? 'more' : cur;
  const items = [
    { id:'result',  icon:'home',   label:'Home' },
    { id:'plans',   icon:'plans',  label:'Plans' },
    { id:'solar',   icon:'sun',    label:'Solar' },
    { id:'monitor', icon:'radar',  label:'Monitor' },
    { id:'more',    icon:'grid',   label:'More' }
  ];
  return `<div class="bottom-nav">
    ${items.map(item => `
      <div class="bottom-nav-item ${navActive === item.id ? 'active' : ''}" onclick="setScreen('${item.id}')">
        <span class="nav-ico">${ic(item.icon, 21)}</span>
        <span class="nav-label">${item.label}</span>
      </div>
    `).join('')}
  </div>`;
}

/* ============================================================
   BROWSER HISTORY — the platform Back gesture/button walks the
   in-app screen stack instead of leaving the app. Screens are
   pushed as hash entries; the ?s= share param is left untouched.
   ============================================================ */
const APP_SCREENS = ['result','plans','plan-detail','solar','analytics','monitor',
                     'compare','more','independence','quotes','auditor','refine',
                     'how-to-switch','methodology','csv-import'];

// Set while we are reacting to a popstate, so restoring a screen doesn't
// push a fresh entry and trap the user in a loop.
let _suppressHistoryPush = false;

function _histDepth(){ return (history.state && +history.state.depth) || 0; }
function _hashScreen(){
  const h = (location.hash || '').replace(/^#/, '');
  return APP_SCREENS.indexOf(h) >= 0 ? h : null;
}

function pushScreenHistory(name){
  if (_suppressHistoryPush) return;
  if (APP_SCREENS.indexOf(name) < 0) return;
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
    showToast('Back to your system.', { type:'accent', icon:ic('home',16), title:'' });
  }
  // Solar screen requires user to opt in (so we know the system spec is "real")
  if (name === 'solar' && !state.considering_solar){
    exploreSolar();
    return;
  }
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
function maybeAutoPaybackView(){
  if (state._solar_payback_intro_done) return false;
  if (state._solar_user_configured) return false;                  // solar set up in the full setup → land on My system
  if (state.has_solar && !state.solar_is_estimate) return false;   // user set their exact system
  if ((state.solar_view || 'mine') !== 'mine') return false;       // already in a design view
  state._solar_payback_intro_done = true;
  saveState();
  startGoalDesign('payback');
  return true;
}

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
  const isArb = hasBatt && state.strategy_mode === 'arbitrage' && state.charge_from_grid;

  // Solar economics (payback / NPV / annual benefit) when a system exists
  let payback = null, npv20 = null, solarBenefit = null, sysCostNet = null;
  if (state.has_solar && totalPanels() > 0){
    try {
      const range = computeScenarioRange();
      const sc = range[state._scenario_view || 'realistic'] || range.realistic;
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
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderIntro();
    return;
  }
  // Landing page — first thing new users see; also reachable via the logo
  if (state.current_screen === 'welcome'){
    root.innerHTML = renderWelcome();
    return;
  }
  // Fast-path activation (30-second simple setup)
  if (state.current_screen === 'fastpath'){
    root.innerHTML = renderFastPath();
    return;
  }
  // Onboarding flow — also re-enterable after completion (guided re-setup from Home)
  if (state.current_screen === 'onboarding'){
    root.setAttribute('data-chrome','bare');
    root.innerHTML = renderOnboarding();
    bindOnboarding();
    enhanceA11y();
    return;
  }
  // First-ever load — go to the intro or welcome
  if (!state.onboarding_complete){
    state.current_screen = state.seen_intro ? 'welcome' : 'intro';
    root.setAttribute('data-chrome','bare');
    root.innerHTML = state.seen_intro ? renderWelcome() : renderIntro();
    enhanceA11y();
    return;
  }
  // Post-onboarding screens
  let html = '';
  switch(state.current_screen){
    case 'result':       html = renderResult(); break;
    case 'plans':        html = renderPlans(); break;
    case 'plan-detail':  html = renderPlanDetail(); break;
    case 'solar':        html = renderSolarDashboard(); break;
    case 'analytics':    html = renderAnalytics(); break;
    case 'monitor':      html = renderMonitor(); break;
    case 'compare':      html = renderCompare(); break;
    case 'more':         html = renderMore(); break;
    case 'independence': html = renderIndependence(); break;
    case 'quotes':       html = renderQuotes(); break;
    case 'auditor':      html = renderAuditor(); break;
    case 'refine':       html = renderRefine(); break;
    case 'how-to-switch':html = renderHowToSwitch(); break;
    case 'methodology':  html = renderMethodology(); break;
    case 'csv-import':   html = renderCsvImport(); break;
    default:             html = renderResult();
  }
  // A re-render of the SAME screen is a state update, not navigation: keep the
  // user where they were and don't replay the entry animation. A different
  // screen is navigation: animate in and start at the top.
  const screenChanged = window.__lastScreen !== state.current_screen;
  const keepScroll = screenChanged ? 0 : (window.scrollY || window.pageYOffset || 0);

  root.setAttribute('data-chrome','app');
  root.innerHTML = html;
  if (state.current_screen === 'auditor')    bindAuditor();
  if (state.current_screen === 'refine')     bindRefine();
  if (state.current_screen === 'csv-import') bindCsvImport();
  enhanceA11y();

  if (screenChanged){
    const sc = root.querySelector('.screen');
    if (sc) sc.classList.add('screen-enter');
    window.scrollTo(0, 0);
    runCountUps(root);
    window.__lastScreen = state.current_screen;
  } else if (keepScroll){
    // Restore synchronously so the browser never paints the jumped position.
    window.scrollTo(0, keepScroll);
  }
  // Inject auth modal overlay (if open) — outside the screen so it overlays all screens
  const existingModal = document.getElementById('auth-modal-root');
  if (existingModal) existingModal.remove();
  const modalHtml = renderAuthModal();
  if (modalHtml) {
    const modalEl = document.createElement('div');
    modalEl.id = 'auth-modal-root';
    modalEl.innerHTML = modalHtml;
    document.body.appendChild(modalEl);
  }
  syncScreenHistory();
}

/* ============================================================
   INIT — runs once on page load
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  setTimeout(() => {
    const loader = document.getElementById('loader');
    if (loader) loader.remove();
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
    renderApp();
    loadTariffs().then(refreshed => {
      if (refreshed && state.onboarding_complete){
        invalidate();
        renderApp();
      }
    });
    // Initialise Supabase auth (non-blocking — runs after first render)
    sbInit().then(() => { if (_sbUser) renderApp(); });
    // Load last tariff-check status from server (non-blocking)
    loadTariffStatus().then(() => {
      if (state._tariff_status && state.onboarding_complete) renderApp();
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

function renderSeaiGrantCard(kwp, batteryKwh){
  const g = calcSeaiGrant(kwp, batteryKwh);
  return `<div class="card" style="background:rgba(0,230,118,.04);border-color:var(--accent)">
    <div class="card-label" style="color:var(--accent)">SEAI Home Solar Grant (2025)</div>
    <div class="card-value accent">€${g.total.toLocaleString()}</div>
    <div style="margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.8">
      ${kwp > 0 ? `Panels (${kwp.toFixed(2)} kWp): first 2 kWp × €900 = −€${g.panels.toLocaleString()}` : ''}<br>
      ${kwp > 2 ? `<span style="color:var(--ink-dim)">Above 2 kWp: no additional grant (capped at €1,800)</span>` : ''}
    </div>
    <div style="margin-top:8px;padding:8px 10px;background:var(--overlay-tile);border-radius:7px;font-family:var(--mono);font-size:10px;color:var(--ink-dim);line-height:1.6">
      Current scheme: first 2 kWp × €900/kWp · max €1,800 total · <a href="https://www.seai.ie/grants/solar-electricity-grant/" target="_blank" style="color:var(--blue)">seai.ie ↗</a>
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
      { icon: ic('globe',18), title: 'Go to Electric Ireland', body: 'Visit <b>electricireland.ie</b> → click "Switch" in the nav. Use the UTM-tagged link below to ensure they know you came via Solar Optimiser.' },
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
        <div style="font-family:var(--display);font-size:18px;font-weight:600;color:var(--ink)">It takes 10–15 working days</div>
        <div class="qr-sub">Your current supplier is notified automatically. You never lose power.</div>
      </div>
      <div class="card" style="margin-top:0">
        <div class="card-label">The general process</div>
        <ol style="margin:10px 0 0 18px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);line-height:2;list-style:decimal">
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
      <button class="pd-back-btn" onclick="${backFn}">← Back</button>
    </div>

    <div class="qr-hero" style="border-color:var(--blue);box-shadow:var(--hero-shadow),0 0 32px -10px var(--blue-glow)">
      <div class="qr-eyebrow" style="color:var(--blue)">Switching to</div>
      <div style="font-family:var(--display);font-size:22px;font-weight:700;color:var(--ink);margin:4px 0">${guide.name}</div>
      ${plan ? `<div class="qr-sub">${plan.plan}</div>` : ''}
    </div>

    ${guide.steps.map((step, i) => `
      <div class="card" style="margin-top:${i===0?'0':'10px'}">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="font-size:22px;line-height:1;flex-shrink:0;margin-top:2px">${step.icon}</div>
          <div>
            <div style="font-weight:700;color:var(--ink);font-size:14px;margin-bottom:4px">
              <span style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);margin-right:8px">${i+1}.</span>${step.title}
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
      <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.8;margin-top:6px">
        ✓ You never lose power during a switch<br>
        ✓ Your current supplier is notified automatically — no cancellation call needed<br>
        ✓ CRU (energy regulator) guarantees the switch completes within 15 working days<br>
        ✓ If you have solar, confirm CEG export registration with the new supplier<br>
        ✓ Check for exit fees on your current bill before switching
      </div>
    </div>

    <p class="disclaimer">We are independent and earn a referral fee if you switch via our links — at no extra cost to you. This does not affect our rankings, which are based solely on your simulated annual cost.</p>
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
  return `${topbar('Smart meter data', 'blue', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="setScreen('refine')">← Settings</button>
    </div>

    <div class="qr-hero" style="border-color:var(--blue)">
      <div class="qr-eyebrow" style="color:var(--blue)">Import from ESB Networks</div>
      <div style="font-family:var(--display);font-size:18px;font-weight:600;color:var(--ink);margin:4px 0">Smart meter CSV import</div>
      <div class="qr-sub">Replace estimated bills with your actual 30-minute interval data for a more accurate simulation.</div>
    </div>

    ${hasImport ? `
      <div class="card" style="background:var(--accent-faint);border-color:var(--accent);margin-top:0">
        <div class="card-label" style="color:var(--accent)">✓ Smart meter data imported</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);line-height:1.8;margin-top:6px">
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
        The file is typically named <span style="font-family:var(--mono);font-size:10px;background:var(--well);padding:2px 6px;border-radius:4px">HDF_XXXXXXXX_YYYY-MM-DD.csv</span>. It contains 30-minute readings.
      </div>
      <label class="btn-secondary" style="display:block;text-align:center;cursor:pointer;margin-top:8px;padding:12px 16px;border:1px dashed var(--blue);color:var(--blue)">
        Choose CSV file
        <input id="csv-file-input" type="file" accept=".csv,.CSV" style="display:none" onchange="handleCsvFile(event)">
      </label>
    </div>

    <div id="csv-parse-result" style="margin-top:10px"></div>

    <div class="card" style="margin-top:10px;background:var(--overlay-tile)">
      <div class="card-label">CSV format — ESB Networks HDF (current format)</div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);line-height:1.9;margin-top:6px;white-space:pre-wrap">MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time
10309xxxxxx,000000000xxxxxxxxx,0.154,Active Import Interval (kWh),01-01-2025 00:30
10309xxxxxx,000000000xxxxxxxxx,0.142,Active Import Interval (kWh),01-01-2025 01:00
...</div>
      <div style="font-size:11px;color:var(--ink-dim);margin-top:8px">Supports the current ESB Networks HDF format (5-column, <b>DD-MM-YYYY</b> dates). Log in at <b>myaccount.esbnetworks.ie</b> → My Meter → Download HDF Data → select last 12 months.</div>
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
  if (resultEl) resultEl.innerHTML = `<div class="card" style="color:var(--ink-soft);font-family:var(--mono);font-size:11px">Parsing ${file.name}…</div>`;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    parseCsvHdf(text, file.name);
  };
  reader.onerror = () => {
    if (resultEl) resultEl.innerHTML = `<div class="card" style="color:var(--red);font-family:var(--mono);font-size:11px">✗ Could not read file — make sure it\'s a plain-text CSV.</div>`;
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
      coverageHtml = `<div style="margin-top:10px;padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber);border-radius:9px;font-size:11.5px;color:var(--ink);line-height:1.6"><b style="color:var(--amber)">⚠ Only ${totalDays} day${totalDays === 1 ? '' : 's'} of data</b> — far short of a year. We scaled it to a full-year profile (per-day average × season length, missing periods filled from your ${state.heating_type} heating shape), but seasonal accuracy will be poor. Treat results as rough and import 12 months when you can.</div>`;
    } else if (totalDays < 300 || periodsCovered < 6){
      coverageHtml = `<div style="margin-top:10px;padding:10px 12px;background:var(--blue-soft);border:1px solid var(--blue);border-radius:9px;font-size:11.5px;color:var(--ink);line-height:1.6"><b style="color:var(--blue)">Partial year:</b> ${totalDays} days across ${periodsCovered} of 6 billing periods. Measured periods were scaled to full length${periodsCovered < 6 ? `; the ${6 - periodsCovered} missing period${6 - periodsCovered === 1 ? ' was' : 's were'} extrapolated from your data + ${state.heating_type} heating profile` : ''}. A full 12 months will sharpen the seasonal picture.</div>`;
    } else {
      coverageHtml = `<div style="margin-top:10px;padding:9px 12px;background:var(--accent-soft);border-radius:9px;font-size:11.5px;color:var(--ink-soft)">✓ ${totalDays} days — full-year coverage${spanDays > 400 ? ` (file spans ~${Math.round(spanDays / 365 * 10) / 10} years — averaged per day, so the result is one typical year)` : ''}.</div>`;
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
        <div style="font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.9;margin-top:6px">
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
        <div style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin-top:6px;line-height:1.6">${e.message}</div>
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
  showToast('Smart meter data applied — results updated');
  setScreen('result');
}

/* ============================================================
   SPRINT 3 — SOLAR VS NO-SOLAR VISUAL COMPARISON (F3)
   Side-by-side annual cost bar chart
   ============================================================ */
function renderSolarComparison(){
  if (!state.has_solar || CACHE.dirty) rebuildBase();
  if (!state.has_solar) return '';

  const best = getBestPlan();
  const baselinePlan = getPlanById(state.baseline);
  const baseSim = baselineSim(state.baseline);
  const baseCost = sumF(baseSim.cost) + baselinePlan.standing;

  // No-solar scenario — run full engine with solar removed, find best plan
  const noSolarScenario = runScenario(false, state.ev_active);
  const noSolarCost = noSolarScenario.annualCost;
  const solarCost = best.net;

  const maxCost = Math.max(baseCost, noSolarCost, solarCost, 1);
  const bar = (val, color) => {
    const pct = Math.min(100, (val / maxCost) * 100);
    return `<div style="background:${color};height:10px;border-radius:5px;width:${pct}%;min-width:4px;transition:width .3s"></div>`;
  };

  const solarSaving = noSolarCost - solarCost;

  return `<div class="card" style="margin-top:14px">
    <div class="card-label">${ic('sun',13)} Solar impact — annual cost comparison</div>
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-family:var(--mono);font-size:10px;color:var(--ink-soft)">Your current plan (${baselinePlan.supplier})</span>
          <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--ink)">${fmtCurrency(baseCost)}</span>
        </div>
        ${bar(baseCost, 'var(--track)')}
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-family:var(--mono);font-size:10px;color:var(--ink-soft)">Best plan, no solar (${noSolarScenario.bestPlanLabel.split('—')[0].trim()})</span>
          <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--blue)">${fmtCurrency(noSolarCost)}</span>
        </div>
        ${bar(noSolarCost, 'var(--blue)')}
      </div>
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-family:var(--mono);font-size:10px;color:var(--accent)">Best plan + solar (${best.plan.supplier})</span>
          <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--accent)">${fmtCurrency(solarCost)}</span>
        </div>
        ${bar(solarCost, 'var(--accent)')}
      </div>
    </div>
    <div style="margin-top:10px;padding:8px 10px;background:${solarSaving > 50 ? 'rgba(0,230,118,.06)' : 'rgba(41,182,246,.06)'};border-radius:7px;font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.7">
      ${solarSaving > 50
        ? `Solar saves you an extra <b style="color:var(--accent)">${fmtCurrency(solarSaving)}/yr</b> on top of the best no-solar plan (${fmtCurrency(noSolarCost)} → ${fmtCurrency(solarCost)})`
        : `At your usage level, the best no-solar tariff (${fmtCurrency(noSolarCost)}) closes most of the gap — solar adds <b style="color:var(--blue)">${fmtCurrency(Math.abs(solarSaving))}/yr</b> ${solarSaving >= 0 ? 'on top' : 'less than the no-solar optimum due to plan mix'}`
      }
    </div>
  </div>`;
}

/* ============================================================
   SPRINT 4 — METHODOLOGY / ABOUT PAGE (T1)
   ============================================================ */
function renderMethodology(){
  return `${topbar('How it works', 'sage', true)}
  <div class="screen">
    <div class="pd-back-bar">
      <button class="pd-back-btn" onclick="setScreen('refine')">← Settings</button>
    </div>

    <div class="qr-hero" style="border-color:var(--ink-soft);box-shadow:none">
      <div class="qr-eyebrow" style="color:var(--ink-soft)">Solar Optimiser</div>
      <div style="font-family:var(--display);font-size:22px;font-weight:700;color:var(--ink)">Methodology &amp; About</div>
      <div class="qr-sub">How we calculate your best electricity plan and solar payback — completely transparent.</div>
    </div>

    <div class="card" style="margin-top:0">
      <div class="card-label">${ic('bolt',13)} Electricity cost simulation</div>
      <div style="font-size:12px;color:var(--ink-soft);line-height:1.75;margin-top:6px">
        We simulate <b>8,760 hourly intervals</b> (one per hour of the year) for every plan. Your annual consumption is distributed using an industry-standard Irish load profile (ESBN EAB profile), scaled to your bimonthly bill and adjusted for heating type (gas vs heat-pump vs direct electric).<br><br>
        For each hour we calculate the import cost at the applicable rate band, plus any export income from solar. The total includes the standing charge (PSO levy + network fee). We run this for all ${TARIFFS.length} plans and rank them by total annual cost.
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
        Solar Optimiser is independent. We earn a small referral fee when you switch to a supplier via our links — this does not affect plan rankings, which are calculated purely from your simulated annual cost.<br><br>
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
      <b>Disclaimer.</b> All figures are estimates. Actual energy bills, solar generation, and payback periods will vary depending on weather, metering, supplier changes, and individual consumption patterns. Solar Optimiser is not a regulated financial or energy advisor.
    </p>
  </div>
  ${bottomNav()}`;
}

/* ============================================================
   SPRINT 4 — IMPROVED INSTALLER LEAD FORM (B3)
   Qualification fields + detailed spec capture
   ============================================================ */
function openLeadForm(){
  const m = document.createElement('div');
  m.id = 'lead-modal';
  m.className = 'modal-overlay';
  const kwp = totalPanels ? totalPanels() * (state.panel_w || 460) / 1000 : 0;
  const grant = calcSeaiGrant(kwp, state.battery_kwh || 0);
  m.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-height:90vh;overflow-y:auto">
      <div class="modal-handle"></div>
      <h3>Get <em>3 installer quotes</em></h3>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:16px;line-height:1.6">SEAI-registered installers only. We match based on your spec and region. No spam — promise.</p>

      <div style="background:var(--accent-faint);border:1px solid var(--accent);border-radius:10px;padding:12px 14px;margin-bottom:16px;font-family:var(--mono);font-size:10px;color:var(--ink-soft);line-height:1.8">
        <b style="color:var(--accent)">Your spec:</b><br>
        ${kwp > 0 ? `${kwp.toFixed(2)} kWp · ${totalPanels ? totalPanels() : '?'} panels · ` : ''}${state.battery_kwh > 0 ? state.battery_kwh + ' kWh battery · ' : ''}Region: ${state.region || 'not set'}<br>
        SEAI grant estimate: <b style="color:var(--accent)">€${grant.total.toLocaleString()}</b>
      </div>

      <label style="display:block;margin-bottom:8px">
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:4px">Email address *</div>
        <input id="lead-email" class="modal-input" type="email" placeholder="you@example.com" autocomplete="email" value="${state.user_email || ''}">
      </label>
      <label style="display:block;margin-bottom:8px">
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:4px">Eircode or county *</div>
        <input id="lead-eircode" class="modal-input" type="text" placeholder="e.g. D01 or Dublin" value="${state.eircode || state.address || ''}">
      </label>
      <label style="display:block;margin-bottom:8px">
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:4px">Roof type</div>
        <select id="lead-roof" class="modal-input">
          <option value="">Select…</option>
          <option value="tile">Concrete/clay tile</option>
          <option value="slate">Natural slate</option>
          <option value="flat">Flat roof (felt/EPDM)</option>
          <option value="metal">Metal/standing seam</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label style="display:block;margin-bottom:16px">
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:4px">Timeline</div>
        <select id="lead-timeline" class="modal-input">
          <option value="">Select…</option>
          <option value="asap">As soon as possible</option>
          <option value="3months">Within 3 months</option>
          <option value="6months">Within 6 months</option>
          <option value="exploring">Just exploring</option>
        </select>
      </label>

      <button class="modal-btn" onclick="submitLeadForm()">Get my 3 quotes →</button>
      <button class="modal-skip" onclick="closeLeadModal()">No thanks · skip</button>
      <div class="modal-privacy">We never sell your data · SEAI-registered installers only · unsubscribe anytime</div>
    </div>`;
  m.onclick = closeLeadModal;
  document.body.appendChild(m);
  setTimeout(() => { const el = document.getElementById('lead-email'); if(el && !el.value) el.focus(); }, 100);
}

function closeLeadModal(){
  const m = document.getElementById('lead-modal');
  if (m) m.remove();
}

function submitLeadForm(){
  const email = (document.getElementById('lead-email')?.value || '').trim();
  const eircode = (document.getElementById('lead-eircode')?.value || '').trim();
  const roof = document.getElementById('lead-roof')?.value || '';
  const timeline = document.getElementById('lead-timeline')?.value || '';

  if (!email || !email.includes('@')){
    document.getElementById('lead-email')?.focus();
    return;
  }
  if (!eircode){
    document.getElementById('lead-eircode')?.focus();
    return;
  }

  const kwp = totalPanels ? totalPanels() * (state.panel_w || 460) / 1000 : 0;
  const grant = calcSeaiGrant(kwp, state.battery_kwh || 0);

  captureEmail(email, 'installer_quotes');
  state.eircode = eircode;
  saveState();

  const leadData = {
    email, eircode, roof, timeline,
    spec: {
      kwp: kwp.toFixed(2),
      panels: totalPanels ? totalPanels() : 0,
      battery_kwh: state.battery_kwh,
      region: state.region,
      annual_kwh: Math.round(Object.values(state.bills).reduce((a,b)=>a+b,0)),
      seai_grant: grant.total,
      ev: state.ev_active,
    }
  };
  dlog('LEAD', 'installer_quote_v2', leadData);
  fireEvent('installer_lead', { kwp: parseFloat(kwp.toFixed(2)), region: state.region, battery: state.battery_kwh > 0, timeline });

  closeLeadModal();
  showToast('Request sent — we\'ll match you with 3 SEAI installers within 24h', { type:'accent', icon:ic('checkC',16) });
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
  const baseCost = baseSim ? sumF(baseSim.cost) + baselinePlan.standing : 0;
  const annualSavings = best ? Math.max(0, baseCost - best.net) : 0;

  m.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-handle"></div>
      <h3>Download &amp; email your report</h3>
      <p style="font-size:13px;color:var(--ink-soft);margin-bottom:12px;line-height:1.6">
        Your personalised PDF includes: plan comparison, solar payback (if modelled), SEAI grant estimate, and a switching guide.
        ${best ? `<br><br><b style="color:var(--accent)">Save ${fmtCurrency(publishableSavings())}/yr by switching to ${best.plan.supplier}${state.solar_planned ? ' (excludes your planned solar)' : ''}</b>` : ''}
      </p>
      <div style="padding:10px 12px;background:rgba(41,182,246,.07);border-radius:8px;border:1px solid rgba(41,182,246,.25);margin-bottom:14px;font-size:11px;color:var(--ink-soft);line-height:1.65;font-family:var(--mono)">
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
window.setAnalyticsView = setAnalyticsView;
window.setStrategy = setStrategy;
window.setHotWater = setHotWater;
window.updateShapeBucket = updateShapeBucket;
window.setShapePreset = setShapePreset;
window.clearShapeOverride = clearShapeOverride;
window.editPlanRate = editPlanRate;
window.editPlanField = editPlanField;
window.resetPlanOverride = resetPlanOverride;
window.setAsBaseline = setAsBaseline;
window.choosePlan = choosePlan;
window.openPlanPicker = openPlanPicker;
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
window.toggleSolarEvModel = toggleSolarEvModel;
window.toggleOptExpand = toggleOptExpand;
window.removeOptimisation = removeOptimisation;
window.saveContractDate = saveContractDate;
window.cancelContractEdit = cancelContractEdit;
window.setEvMode = setEvMode;
window.calibrateBillsToBaseline = calibrateBillsToBaseline;
window.shareSavingsCard = shareSavingsCard;
window.computeScenarioRange = computeScenarioRange;
window.startGoalDesign = startGoalDesign;
window.applyGoalDesign = applyGoalDesign;
window.setSolarView = setSolarView;
window.commitGoalDesign = commitGoalDesign;
window.sweepGoalDesigns = sweepGoalDesigns;
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
window.sim = sim;
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
    var ICON_LARGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='112' fill='%23090D0A'/%3E%3Cg fill='none' stroke='%2300E676' stroke-width='26' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='256' cy='256' r='86'/%3E%3Cpath d='M256 80v40M256 392v40M80 256h40M392 256h40M131 131l28 28M353 353l28 28M381 131l-28 28M159 353l-28 28'/%3E%3C/g%3E%3C/svg%3E";
    var manifest = {
      name: "Solar Optimiser — Irish Energy Advisor",
      short_name: "Solar Optimiser",
      description: "Find the cheapest Irish electricity plan for your home — with or without solar, battery or EV.",
      start_url: ".",
      scope: ".",
      display: "standalone",
      orientation: "portrait",
      background_color: "#090D0A",
      theme_color: "#090D0A",
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
