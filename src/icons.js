/** Icons as inline SVG, by name. Shared by the page and the model's region list. */
import { MARK_PATHS } from './brand';


/* ============================================================
   0. ICON SYSTEM — custom stroke icons, 24-grid, no emoji.
   ic(name, size, extraStyle) → inline SVG, inherits currentColor
   ============================================================ */
export const IC = {
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
  contrast:'<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4Z" fill="currentColor"/>',
  menu:    '<path d="M4 7h16M4 12h16M4 17h16"/>',
  mobile:  '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
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
  minus:   '<path d="M5.2 12h13.6"/>',
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
export function ic(name, size, style){
  const p = IC[name] || IC.info;
  return `<svg class="ic" width="${size||18}" height="${size||18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${style ? ` style="${style}"` : ''} aria-hidden="true">${p}</svg>`;
}
