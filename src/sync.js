// @ts-check
/**
 * What of the app's state is the household, and so goes to the account.
 *
 * A save is queued on every change to the state, a screen change included,
 * and each one sent the whole home, meter readings and all (often over 100 KB).
 * Since 11 Oct 2026 main.js sends a copy only when it differs from the last one
 * sent to that account, so screen changes cost the database nothing.
 */

/** What describes this screen rather than the household is never synced. */
export const NO_SYNC = ['_flow', '_flow_edit', '_flow_intent', '_flow_given', '_st_open', '_eg', '_sg', 'current_screen', '_home_deep', '_solar_deep', '_solar_more', '_an_tab', '_an_from', '_an_pick', '_an_note', '_an_day_open', '_an_mon', '_sheet', '_sys_saving', '_sys_name', '_fine_open', '_settings_open', '_return_to', '_lead_form',
  '_tariff_refreshing', '_expert_open', '_account_id', '_saved_at', '_plans_filter',
  // Contact details typed for the email-capture part (src/features.js) stay on this device.
  'lead_queue', 'user_email', 'email_captured'];

/** The household's copy for the account: the state without what is only this screen's. */
export function cloudCopy(src){
  /** @type {Record<string, any>} */
  const o = {};
  for (const k in src) if (!NO_SYNC.includes(k)) o[k] = src[k];
  return o;
}

/**
 * The key a sent copy is remembered by: the account and the copy, so a copy
 * sent to one account is never taken as sent to another.
 * @param {string} account @param {string} json
 */
export const sentKey = (account, json) => `${account}|${json}`;
