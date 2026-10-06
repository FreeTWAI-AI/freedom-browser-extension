/** CLIENT-A2 will attach DOM vocabulary, the durable journal, and Stop/takeover here.
 * A1 keeps the names reserved so a page or content script cannot invent them. */
export const A2_RESERVED_TYPES = Object.freeze([
  'dom.observe',
  'dom.act',
  'journal.append',
  'control.stop',
  'control.takeover',
]);
