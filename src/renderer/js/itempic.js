/* =====================================================================
   SamItemPic — the picture of an item, in ONE place
   The customer asked for the picture of the item to sit BESIDE its name
   everywhere — in the lists, in the reports and on the papers — and for
   the code of the item to GO: «واجعل الصوره بجانبه بدل كود الصنف».

   The picture lives in the data folder (next to the database). The item
   keeps only the NAME of the file; the renderer never writes a file —
   the main process puts it on the disk and hands out a link to it.

   THE API (the same everywhere):
     SamItemPic.ensure()            → Promise<string>  the pictures folder
     SamItemPic.url(src)            → string   the link of the picture ('' when there is none)
     SamItemPic.thumbHtml(src, size, print)
                                     → string   the <img> beside the name ('' when there is none)
     SamItemPic.has(src)            → boolean  the item has a picture
     SamItemPic.imageName(src)      → string   the name of the file

   `src` is an ITEM ({ image }) or a LINE of a document ({ itemImage }) —
   the documents carry the picture of their item under `itemImage`.
   ===================================================================== */
(function (global) {
  'use strict';
  if (global.SamItemPic) return;

  const appApi = () => (global.sam && global.sam.app) ? global.sam.app : null;

  /** the folder of the pictures — the main process knows it */
  let dir = '';
  let pending = null;

  /** ask the main process for the folder of the pictures (once) */
  function ensure() {
    if (dir) return Promise.resolve(dir);
    if (pending) return pending;
    const a = appApi();
    if (!a) return Promise.resolve('');
    pending = a.imagesDir()
      .then((r) => { dir = (r && r.ok && r.dir) ? r.dir : ''; return dir; })
      .catch(() => { dir = ''; return dir; });
    return pending;
  }

  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** the name of the picture file — of an item or of a line of a document */
  function imageName(src) {
    if (!src) return '';
    if (typeof src === 'string') return String(src).trim();
    return String(src.image || src.itemImage || '').trim();
  }

  /** the link of the picture — '' when the item has no picture */
  function url(src) {
    const name = imageName(src);
    if (!name || !dir) return '';
    const a = appApi();
    if (!a) return '';
    try { return a.fileUrl(dir + '/' + name) || ''; } catch (e) { return ''; }
  }

  /** the item has a picture */
  function has(src) { return !!imageName(src); }

  /**
   * The tiny picture that sits beside the name.
   * NOTHING at all when the item has no picture — no empty box, no broken
   * image. `size` is the width in pixels, `print` drops the shadow for
   * the papers.
   */
  function thumbHtml(src, size, print) {
    const u = url(src);
    if (!u) return '';
    const px = Number(size) || 16;
    const title = (src && (src.name || src.itemName)) || '';
    const frame = print
      ? 'border:1px solid #cfd6e0;box-shadow:none;'
      : 'border:1px solid var(--line);box-shadow:0 1px 3px rgba(15,23,42,.14);';
    return `<img class="sam-pic" src="${escAttr(u)}" alt="" title="${escAttr(title)}"`
      + ` style="width:${px}px;height:${px}px;object-fit:contain;border-radius:6px;${frame}`
      + 'background:#f1f5f9;flex:none;align-self:center;vertical-align:middle;">';
  }

  global.SamItemPic = { ensure, url, thumbHtml, has, imageName };
})(window);
