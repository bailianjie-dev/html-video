import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAlbumEditableImageSlotRequest,
  patchAlbumHtmlAddImageSlot,
  patchAlbumHtmlAppendPageWithImage,
  patchAlbumHtmlForSimpleRequest,
  validateAlbumHtmlBeforePersist,
  validateAlbumHtmlHasNoInPageUploadControls,
} from '../dist/studio-server.js';

test('detects file inputs as invalid in album HTML', () => {
  const html = `<!doctype html><html><body>
    <section data-album-page="contact">
      <div data-hv-image="contact.extra_image">
        <input type="file" accept="image/png,image/jpeg">
      </div>
    </section>
  </body></html>`;

  assert.match(
    validateAlbumHtmlHasNoInPageUploadControls(html) ?? '',
    /input type="file"/i,
  );
});

test('detects FileReader upload preview code as invalid in album HTML', () => {
  const html = `<!doctype html><html><body>
    <section data-album-page="contact" data-hv-image="contact.extra_image"></section>
    <script>
      const reader = new FileReader();
      reader.onload = () => {};
    </script>
  </body></html>`;

  assert.match(
    validateAlbumHtmlHasNoInPageUploadControls(html) ?? '',
    /FileReader/i,
  );
});

test('allows Studio-editable image placeholders without page upload controls', () => {
  const html = `<!doctype html><html><body>
    <section data-album-page="contact">
      <div class="img-placeholder" data-hv-image="page_5.bottom_image">
        <span data-hv-text="page_5.bottom_image_label">Replace in the edit panel</span>
      </div>
    </section>
  </body></html>`;

  assert.equal(validateAlbumHtmlHasNoInPageUploadControls(html), null);
});

test('recognizes natural-language requests for editable image slots', () => {
  assert.equal(
    isAlbumEditableImageSlotRequest('\u6700\u540e\u4e00\u9875\u5e95\u90e8\u52a0\u4e00\u4e2a\u53ef\u4ee5\u4e0a\u4f20\u56fe\u7247\u7684\u5730\u65b9'),
    true,
  );
  assert.equal(
    isAlbumEditableImageSlotRequest('\u7b2c 3 \u9875\u9884\u7559\u56fe\u7247\u4f4d\u7f6e'),
    true,
  );
  assert.equal(isAlbumEditableImageSlotRequest('add an uploadable image area on the last page'), true);
  assert.equal(isAlbumEditableImageSlotRequest('\u628a\u6807\u9898\u6539\u5927\u4e00\u70b9'), false);
  assert.equal(
    isAlbumEditableImageSlotRequest('\u5728\u76f8\u518c\u672b\u5c3e\u6dfb\u52a0\u4e00\u9875\uff0c\u6807\u9898\u662f\u4e16\u754c\u676f\uff0c\u52a0\u4e0a\u6211\u4e0a\u4f20\u7684\u8fd9\u4e2a\u7167\u7247'),
    false,
  );
});

test('appends a new album page with the uploaded image URL', () => {
  const oldHtml = `<!doctype html><html><body>
    <main id="album">
      <section class="page active" data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
      <section class="page" data-album-page="page_2"><h1 data-hv-text="page_2.title">Two</h1></section>
    </main>
  </body></html>`;
  const imageUrl = '/api/projects/proj_1/assets/asset_1/content';

  const result = patchAlbumHtmlAppendPageWithImage(oldHtml, {
    userText: '\u5728\u76f8\u518c\u672b\u5c3e\u6dfb\u52a0\u4e00\u9875\uff0c\u6807\u9898\u662f\u4e16\u754c\u676f\uff0c\u52a0\u4e0a\u6211\u4e0a\u4f20\u7684\u8fd9\u4e2a\u7167\u7247',
    imageUrl,
  });

  assert.ok(result);
  assert.equal(result.action, 'append_page_with_image');
  assert.equal(result.pageIndex, 2);
  assert.equal(result.pageCount, 3);
  assert.equal(result.key, 'page_3.hero_image');
  assert.match(result.html, /data-album-page="page_3"/);
  assert.match(result.html, /data-page="page_3"/);
  assert.match(result.html, /data-page-title="\u4e16\u754c\u676f"/);
  assert.match(result.html, /<h1[^>]*data-hv-text="page_3\.title"[^>]*>\u4e16\u754c\u676f<\/h1>/);
  assert.match(result.html, /data-hv-image="page_3\.hero_image"/);
  assert.match(result.html, /src="\/api\/projects\/proj_1\/assets\/asset_1\/content"/);
  assert.doesNotMatch(result.html, /<section[^>]*page_3[^>]*active/i);
  assert.deepEqual(validateAlbumHtmlBeforePersist(oldHtml, result.html), {
    ok: true,
    reasons: [],
  });
});

test('append page patch syncs common static page counters and dots', () => {
  const oldHtml = `<!doctype html><html><body>
    <main id="album">
      <section class="album-page" data-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
      <section class="album-page" data-page="page_2"><h1 data-hv-text="page_2.title">Two</h1></section>
    </main>
    <nav class="album-controls">
      <div class="counter" id="pageCounter">01 / 02</div>
      <span data-total-pages="2"></span>
    </nav>
    <div class="dots" id="pageDots">
      <button class="dot active" data-index="0" aria-current="page" aria-label="Go to page 1"></button>
      <button class="dot" data-index="1" aria-current="false" aria-label="Go to page 2"></button>
    </div>
    <script>const totalPages = 2; const pageCount = 2;</script>
  </body></html>`;

  const result = patchAlbumHtmlAppendPageWithImage(oldHtml, {
    userText: '\u6700\u540e\u52a0\u4e00\u9875\uff0c\u6807\u9898\u662f\u4e16\u754c\u676f\uff0c\u7528\u6211\u4e0a\u4f20\u7684\u56fe\u7247',
    imageUrl: '/api/projects/proj_1/assets/asset_1/content',
  });

  assert.ok(result);
  assert.match(result.html, /01 \/ 03/);
  assert.match(result.html, /data-total-pages="3"/);
  assert.match(result.html, /const totalPages = 3;/);
  assert.match(result.html, /const pageCount = 3;/);
  assert.equal((result.html.match(/<button class="dot/g) || []).length, 3);
  assert.match(result.html, /class="dot" data-index="2" aria-current="false" aria-label="Go to page 3"/);
});

test('simple structured patch routes append-page uploaded-image requests without a target page', () => {
  const oldHtml = `<!doctype html><html><body>
    <main id="album">
      <section class="page" data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
    </main>
  </body></html>`;

  const result = patchAlbumHtmlForSimpleRequest(oldHtml, {
    userText: '\u6700\u540e\u52a0\u4e00\u9875\uff0c\u6807\u9898\u4e3a\u4e16\u754c\u676f\uff0c\u7528\u6211\u4e0a\u4f20\u7684\u56fe\u7247',
    imageUrl: 'https://cdn.example.com/world-cup.png',
  });

  assert.ok(result);
  assert.equal(result.action, 'append_page_with_image');
  assert.equal(result.pageIndex, 1);
  assert.match(result.html, /data-album-page="page_2"/);
  assert.match(result.html, /src="https:\/\/cdn\.example\.com\/world-cup\.png"/);
});

test('append uploaded-image page patch returns null when album pages cannot be located', () => {
  assert.equal(
    patchAlbumHtmlAppendPageWithImage('<!doctype html><html><body><div>No pages</div></body></html>', {
      userText: '\u6700\u540e\u52a0\u4e00\u9875\uff0c\u6807\u9898\u662f\u4e16\u754c\u676f\uff0c\u7528\u6211\u4e0a\u4f20\u7684\u56fe\u7247',
      imageUrl: '/api/projects/proj_1/assets/asset_1/content',
    }),
    null,
  );
});

test('patches an editable image slot into the target album page', () => {
  const oldHtml = `<!doctype html><html><body>
    <main id="album">
      <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
      <section data-album-page="page_2"><h1 data-hv-text="page_2.title">Two</h1></section>
      <section data-album-page="page_3"><h1 data-hv-text="page_3.title">Three</h1></section>
      <section data-album-page="page_4"><h1 data-hv-text="page_4.title">Four</h1></section>
      <section data-album-page="page_5"><h1 data-hv-text="page_5.title">Five</h1></section>
    </main>
  </body></html>`;

  const result = patchAlbumHtmlAddImageSlot(oldHtml, { targetPageIndex: 4 });

  assert.ok(result);
  assert.equal(result.pageIndex, 4);
  assert.equal(result.pageCount, 5);
  assert.equal(result.key, 'page_5.bottom_image');
  assert.match(result.html, /data-hv-image="page_5\.bottom_image"/);
  assert.match(result.html, /data-hv-text="page_5\.bottom_image_label"/);
  assert.equal(validateAlbumHtmlHasNoInPageUploadControls(result.html), null);
  assert.deepEqual(validateAlbumHtmlBeforePersist(oldHtml, result.html), {
    ok: true,
    reasons: [],
  });

  const page4 = result.html.slice(
    result.html.indexOf('data-album-page="page_4"'),
    result.html.indexOf('data-album-page="page_5"'),
  );
  assert.doesNotMatch(page4, /bottom_image/);
});

test('patch image slot returns null when the target album page cannot be located', () => {
  const html = `<!doctype html><html><body>
    <main id="album">
      <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
    </main>
  </body></html>`;

  assert.equal(patchAlbumHtmlAddImageSlot(html, { targetPageIndex: 3 }), null);
});

test('structured patch updates target page data-hv-text copy', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1"><h1 data-hv-text="page_1.title">Old one</h1></section>
    <section data-album-page="page_2"><h1 data-hv-text="page_2.title">Old two</h1><p data-hv-text="page_2.body">Body</p></section>
  </main></body></html>`;

  const result = patchAlbumHtmlForSimpleRequest(html, {
    userText: '\u628a\u6807\u9898\u6539\u6210\u65b0\u6807\u9898',
    targetPageIndex: 1,
  });

  assert.ok(result);
  assert.equal(result.action, 'text');
  assert.equal(result.key, 'page_2.title');
  assert.match(result.html, /data-hv-text="page_2\.title">新标题<\/h1>/);
  assert.match(result.html, /data-hv-text="page_1\.title">Old one<\/h1>/);
});

test('structured patch replaces an existing CTA', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1">
      <h1 data-hv-text="page_1.title">One</h1>
      <a data-hv-cta="page_1.cta" href="#old">Old CTA</a>
    </section>
  </main></body></html>`;

  const result = patchAlbumHtmlForSimpleRequest(html, {
    userText: 'CTA\u6539\u6210\u7acb\u5373\u54a8\u8be2\uff0c\u94fe\u63a5 https://example.com/contact',
    targetPageIndex: 0,
  });

  assert.ok(result);
  assert.equal(result.action, 'cta');
  assert.equal(result.key, 'page_1.cta');
  assert.match(result.html, /data-hv-cta="page_1\.cta"/);
  assert.match(result.html, /href="https:\/\/example\.com\/contact"/);
  assert.match(result.html, />立即咨询<\/a>/);
});

test('structured patch adds a CTA when none exists on the page', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
  </main></body></html>`;

  const result = patchAlbumHtmlForSimpleRequest(html, {
    userText: '\u52a0\u4e00\u4e2a\u6309\u94ae \u8054\u7cfb\u6211\u4eec',
    targetPageIndex: 0,
  });

  assert.ok(result);
  assert.equal(result.action, 'cta');
  assert.equal(result.key, 'page_1.cta');
  assert.match(result.html, /data-hv-cta="page_1\.cta"/);
  assert.match(result.html, />联系我们<\/a>/);
});

test('structured patch adjusts image size style on target page', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1"><img data-hv-image="page_1.hero" src="/a.jpg"></section>
    <section data-album-page="page_2"><img data-hv-image="page_2.hero" src="/b.jpg"></section>
  </main></body></html>`;

  const result = patchAlbumHtmlForSimpleRequest(html, {
    userText: '\u8fd9\u9875\u56fe\u7247\u5927\u4e00\u70b9',
    targetPageIndex: 1,
  });

  assert.ok(result);
  assert.equal(result.action, 'image_size');
  assert.equal(result.key, 'page_2.hero');
  assert.match(result.html, /data-hv-image="page_2\.hero"[^>]*class="hv-image-larger"/);
  assert.match(result.html, /data-hv-image="page_2\.hero"[^>]*transform:scale\(1\.08\)/);
  assert.doesNotMatch(
    result.html.slice(result.html.indexOf('data-album-page="page_1"'), result.html.indexOf('data-album-page="page_2"')),
    /hv-image-larger/,
  );
});

test('structured patch applies horizontal and vertical layout variants', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1><img data-hv-image="page_1.hero" src="/a.jpg"></section>
    <section data-album-page="page_2"><h1 data-hv-text="page_2.title">Two</h1><img data-hv-image="page_2.hero" src="/b.jpg"></section>
  </main></body></html>`;

  const horizontal = patchAlbumHtmlForSimpleRequest(html, {
    userText: '\u7b2c2\u9875\u6539\u6210\u5de6\u53f3\u6392\u7248',
    targetPageIndex: 1,
  });
  assert.ok(horizontal);
  assert.equal(horizontal.action, 'layout');
  assert.match(horizontal.html, /data-album-page="page_2"[^>]*class="hv-layout-horizontal"/);
  assert.match(horizontal.html, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);

  const vertical = patchAlbumHtmlForSimpleRequest(html, {
    userText: '\u8fd9\u9875\u6539\u6210\u4e0a\u4e0b\u6392\u7248',
    targetPageIndex: 0,
  });
  assert.ok(vertical);
  assert.equal(vertical.action, 'layout');
  assert.match(vertical.html, /data-album-page="page_1"[^>]*class="hv-layout-vertical"/);
  assert.match(vertical.html, /flex-direction:column/);
});

test('structured patch returns null for complex album rewrite requests', () => {
  const html = `<!doctype html><html><body><main id="album">
    <section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
  </main></body></html>`;

  assert.equal(
    patchAlbumHtmlForSimpleRequest(html, {
      userText: '\u91cd\u65b0\u8bbe\u8ba1\u6574\u672c\u76f8\u518c\uff0c\u6362\u6210\u79d1\u6280\u98ce\u5e76\u91cd\u5199\u6bcf\u4e00\u9875',
      targetPageIndex: 0,
    }),
    null,
  );
});

test('unified persist validation rejects large album page-count drops', () => {
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1" data-hv-text="page_1.title">One</section>
    <section data-album-page="page_2" data-hv-text="page_2.title">Two</section>
    <section data-album-page="page_3" data-hv-text="page_3.title">Three</section>
    <section data-album-page="page_4" data-hv-text="page_4.title">Four</section>
    <section data-album-page="page_5" data-hv-text="page_5.title">Five</section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1" data-hv-text="page_1.title">One</section>
    <section data-album-page="page_2" data-hv-text="page_2.title">Two</section>
    <section data-album-page="page_3" data-hv-text="page_3.title">Three</section>
  </body></html>`;

  const result = validateAlbumHtmlBeforePersist(oldHtml, newHtml);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /page count dropped/i);
});

test('unified persist validation rejects large editable key loss', () => {
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <h1 data-hv-text="page_1.title">One</h1>
      <p data-hv-text="page_1.subtitle">Sub</p>
      <p data-hv-text="page_1.body">Body</p>
      <img data-hv-image="page_1.hero" src="/a.jpg">
      <a data-hv-cta="page_1.cta" href="#">Go</a>
    </section>
    <section data-album-page="page_2">
      <h1 data-hv-text="page_2.title">Two</h1>
      <p data-hv-text="page_2.body">Body</p>
      <img data-hv-image="page_2.hero" src="/b.jpg">
    </section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <h1 data-hv-text="page_1.title">One</h1>
      <img data-hv-image="page_1.hero" src="/a.jpg">
    </section>
    <section data-album-page="page_2">
      <h1>No editable marker</h1>
    </section>
  </body></html>`;

  const result = validateAlbumHtmlBeforePersist(oldHtml, newHtml);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /data-hv-text/i);
});

test('unified persist validation rejects local filesystem paths', () => {
  const result = validateAlbumHtmlBeforePersist('', `<!doctype html><html><body>
    <img data-hv-image="cover.hero" src="C:\\Users\\abc\\Downloads\\photo.jpg">
  </body></html>`);

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /local path/i);
});

test('unified persist validation rejects lost uploaded project asset URLs', () => {
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <img data-hv-image="page_1.hero" src="/api/projects/proj_1/assets/asset_1/content">
    </section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <img data-hv-image="page_1.hero" src="/placeholder.jpg">
    </section>
  </body></html>`;

  const result = validateAlbumHtmlBeforePersist(oldHtml, newHtml);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /uploaded image references/i);
});

test('unified persist validation allows one explicitly replaced project image reference', () => {
  const oldRef = '/api/projects/proj_1/assets/asset_1/content';
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <img data-hv-image="page_1.hero" src="${oldRef}">
    </section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <img data-hv-image="page_1.hero" src="/api/projects/proj_1/assets/asset_2/content">
    </section>
  </body></html>`;

  assert.deepEqual(validateAlbumHtmlBeforePersist(oldHtml, newHtml, {
    allowedRemovedImageRefs: new Set([oldRef]),
  }), { ok: true, reasons: [] });
});

test('unified persist validation rejects lost data image references', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <div data-hv-image="page_1.hero" style="background-image:url(${dataUri})"></div>
    </section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <div data-hv-image="page_1.hero"></div>
    </section>
  </body></html>`;

  const result = validateAlbumHtmlBeforePersist(oldHtml, newHtml);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /uploaded image references/i);
});

test('unified persist validation allows preserved editable contract', () => {
  const oldHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <h1 data-hv-text="page_1.title">One</h1>
      <img data-hv-image="page_1.hero" src="/api/projects/p/assets/a/content">
      <a data-hv-cta="page_1.cta" href="#">Go</a>
    </section>
  </body></html>`;
  const newHtml = `<!doctype html><html><body>
    <section data-album-page="page_1">
      <h1 data-hv-text="page_1.title">One updated</h1>
      <img data-hv-image="page_1.hero" src="/api/projects/p/assets/a/content">
      <a data-hv-cta="page_1.cta" href="#">Go</a>
    </section>
  </body></html>`;

  assert.deepEqual(validateAlbumHtmlBeforePersist(oldHtml, newHtml), {
    ok: true,
    reasons: [],
  });
});
