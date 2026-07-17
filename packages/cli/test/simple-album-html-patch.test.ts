import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSimpleAlbumHtmlPatch,
  executeSimpleAlbumHtmlPatchForCandidates,
  locateSimpleTextTargetCandidates,
} from '../dist/simple-album-html-patch.js';
import type { SimpleAlbumCommand } from '../dist/simple-album-command.js';

const PREFIX = `<!doctype html><html><head><style>.p2-title{animation:rise 1s;color:white}</style></head><body><main id="album">`;
const SUFFIX = `</main><script>window.albumAnimation = '<br>全面领先';</script></body></html>`;

function album(pageTwoTitle = '核心性能<br>全面领先'): string {
  return `${PREFIX}
<section data-album-page="page_1"><div data-hv-text="page_1.title">全面领先</div></section>
<section data-album-page="page_2"><div class="p2-title" data-motion="rise" data-hv-text="page_2.title">${pageTwoTitle}</div><p data-hv-text="page_2.body">其它内容</p></section>
${SUFFIX}`;
}

function replaceCommand(oldText = '全面领先', newText = '遥遥领先'): SimpleAlbumCommand {
  return { type: 'replace_text', page_number: 2, old_text: oldText, new_text: newText };
}

test('replaces only the nested text node after br and reports patch metadata', () => {
  const original = album();
  const result = executeSimpleAlbumHtmlPatch(original, replaceCommand());
  assert.equal(result.handled, true);
  if (!result.handled) return;

  assert.match(result.patch.html, /data-hv-text="page_2\.title">核心性能<br>遥遥领先<\/div>/);
  assert.match(result.patch.html, /data-hv-text="page_1\.title">全面领先<\/div>/);
  assert.match(result.patch.html, /window\.albumAnimation = '<br>全面领先'/);
  assert.equal(result.patch.changed_key, 'page_2.title');
  assert.equal(result.patch.page_number, 2);
  assert.equal(result.patch.patch_strategy, 'replace_text_node_source');
  assert.equal(original.slice(result.patch.source_range.start, result.patch.source_range.end), '全面领先');
  assert.equal(result.patch.html.slice(0, result.patch.source_range.start), original.slice(0, result.patch.source_range.start));
  assert.equal(
    result.patch.html.slice(result.patch.replacement_range.end),
    original.slice(result.patch.source_range.end),
  );
});

test('wraps only the target text in a controlled color span', () => {
  const original = album();
  const result = executeSimpleAlbumHtmlPatch(original, {
    type: 'set_text_color',
    page_number: 2,
    target_text: '全面领先',
    color: '#FF5A36',
  });
  assert.equal(result.handled, true);
  if (!result.handled) return;

  assert.match(
    result.patch.html,
    /class="p2-title" data-motion="rise" data-hv-text="page_2\.title">核心性能<br><span style="color:#FF5A36">全面领先<\/span><\/div>/,
  );
  assert.equal(result.patch.patch_strategy, 'wrap_text_node_with_color_span');
  assert.equal(result.patch.html.slice(0, result.patch.source_range.start), original.slice(0, result.patch.source_range.start));
  assert.equal(
    result.patch.html.slice(result.patch.replacement_range.end),
    original.slice(result.patch.source_range.end),
  );
});

test('finds text inside an existing nested span without rewriting that span', () => {
  const original = album('核心性能<br><span class="accent" data-motion="pulse">全面领先</span>');
  const result = executeSimpleAlbumHtmlPatch(original, replaceCommand());
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.match(result.patch.html, /<span class="accent" data-motion="pulse">遥遥领先<\/span>/);
  assert.match(result.patch.html, /\.p2-title\{animation:rise 1s;color:white\}/);
});

test('colors text inside an existing nested span without changing its attributes', () => {
  const original = album('核心性能<br><span class="accent" data-motion="pulse">全面领先</span>');
  const result = executeSimpleAlbumHtmlPatch(original, {
    type: 'set_text_color',
    page_number: 2,
    target_text: '全面领先',
    color: 'rgb(255, 90, 54)',
  });
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.match(
    result.patch.html,
    /<span class="accent" data-motion="pulse"><span style="color:rgb\(255, 90, 54\)">全面领先<\/span><\/span>/,
  );
  assert.doesNotMatch(result.patch.html, /on(?:click|load|error)=/i);
});

test('updates a controlled color-only span instead of nesting another span', () => {
  const original = album('核心性能<br><span style="color:#FF0000">全面领先</span>');
  const result = executeSimpleAlbumHtmlPatch(original, {
    type: 'set_text_color',
    page_number: 2,
    target_text: '全面领先',
    color: '#FF5A36',
  });
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.equal(result.patch.patch_strategy, 'update_controlled_color_span');
  assert.match(result.patch.html, /核心性能<br><span style="color:#FF5A36">全面领先<\/span>/);
  assert.doesNotMatch(result.patch.html, /<span style="color:#FF0000"><span/);
  assert.equal(original.slice(result.patch.source_range.start, result.patch.source_range.end), '#FF0000');
});

test('matches decoded HTML entities and escapes replacement text', () => {
  const original = album('核心性能<br>A&amp;B');
  const result = executeSimpleAlbumHtmlPatch(original, replaceCommand('A&B', '<领先 & "安全">'));
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.match(result.patch.html, /核心性能<br>&lt;领先 &amp; &quot;安全&quot;&gt;/);
  assert.equal(original.slice(result.patch.source_range.start, result.patch.source_range.end), 'A&amp;B');
});

test('keeps same text on other pages outside target-page matching', () => {
  const result = executeSimpleAlbumHtmlPatch(album(), replaceCommand());
  assert.equal(result.handled, true);
  if (!result.handled) return;
  assert.match(result.patch.html, /page_1\.title">全面领先/);
  assert.match(result.patch.html, /page_2\.title">核心性能<br>遥遥领先/);
});

test('returns target_ambiguous for multiple matches on the target page', () => {
  const original = album('全面领先<br><span>全面领先</span>');
  assert.deepEqual(executeSimpleAlbumHtmlPatch(original, replaceCommand()), {
    handled: false,
    reason: 'target_ambiguous',
  });
});

test('locates same-page ASCII matches case-insensitively and applies only a snapshotted candidate', () => {
  const original = `${PREFIX}
<section data-album-page="page_1"><h1 data-hv-text="page_1.title">One</h1></section>
<section data-album-page="page_2">
  <h1 data-hv-text="page_2.title">开启你的 SU7 之旅</h1>
  <p data-hv-text="page_2.subtitle">亲身感受小米 SU7 带来的极致体验</p>
  <p data-hv-text="page_2.email">su7@xiaomi.com</p>
  <p data-hv-text="page_2.footer_right">SU7 · 官方宣传</p>
</section>${SUFFIX}`;
  const command: SimpleAlbumCommand = {
    type: 'set_text_color', page_number: 2, target_text: 'su7', color: '#0000FF',
  };
  assert.deepEqual(executeSimpleAlbumHtmlPatch(original, command), {
    handled: false,
    reason: 'target_ambiguous',
  });
  const located = locateSimpleTextTargetCandidates(original, command);
  assert.equal(located.handled, true);
  if (!located.handled) return;
  assert.equal(located.candidates.length, 4);
  assert.deepEqual(located.candidates.map((candidate) => candidate.matched_text), ['SU7', 'SU7', 'su7', 'SU7']);
  assert.deepEqual(located.candidates.map((candidate) => candidate.data_hv_text_key), [
    'page_2.title', 'page_2.subtitle', 'page_2.email', 'page_2.footer_right',
  ]);
  assert.ok(located.candidates.every((candidate) => /^[0-9a-f]{64}$/.test(candidate.source_hash)));

  const selected = executeSimpleAlbumHtmlPatchForCandidates(
    original,
    command,
    located.candidates,
    [located.candidates[0]!.candidate_id],
  );
  assert.equal(selected.handled, true);
  if (!selected.handled) return;
  assert.match(selected.patch.html, /开启你的 <span style="color:#0000FF">SU7<\/span> 之旅/);
  assert.match(selected.patch.html, />su7@xiaomi\.com</);
  assert.equal((selected.patch.html.match(/style="color:#0000FF"/g) ?? []).length, 1);
});

test('revalidates candidate source hashes and supports server-approved all selection', () => {
  const original = album('SU7<br><span>su7</span>');
  const command: SimpleAlbumCommand = {
    type: 'set_text_color', page_number: 2, target_text: 'su7', color: '#0000FF',
  };
  const located = locateSimpleTextTargetCandidates(original, command);
  assert.equal(located.handled, true);
  if (!located.handled) return;
  const all = executeSimpleAlbumHtmlPatchForCandidates(
    original, command, located.candidates, located.candidates.map((candidate) => candidate.candidate_id),
  );
  assert.equal(all.handled, true);
  if (all.handled) assert.equal((all.patch.html.match(/style="color:#0000FF"/g) ?? []).length, 2);

  const changed = original.replace('data-hv-text="page_2.title"', 'data-hv-text="page_2.changed"');
  assert.deepEqual(
    executeSimpleAlbumHtmlPatchForCandidates(
      changed, command, located.candidates, [located.candidates[0]!.candidate_id],
    ),
    { handled: false, reason: 'target_changed' },
  );
});

test('returns target_not_found for zero matches', () => {
  assert.deepEqual(executeSimpleAlbumHtmlPatch(album(), replaceCommand('不存在', '新文字')), {
    handled: false,
    reason: 'target_not_found',
  });
});

test('refuses a target that crosses markup boundaries', () => {
  const original = album('<span>遥遥</span>领先');
  assert.deepEqual(executeSimpleAlbumHtmlPatch(original, replaceCommand('遥遥领先', '新的文字')), {
    handled: false,
    reason: 'target_crosses_markup',
  });
});

test('resolves current_page only from an explicit execution option', () => {
  const command: SimpleAlbumCommand = {
    type: 'replace_text',
    current_page: true,
    old_text: '全面领先',
    new_text: '遥遥领先',
  };
  assert.deepEqual(executeSimpleAlbumHtmlPatch(album(), command), {
    handled: false,
    reason: 'current_page_unresolved',
  });
  const result = executeSimpleAlbumHtmlPatch(album(), command, { currentPageNumber: 2 });
  assert.equal(result.handled, true);
});

test('rejects malicious or invalid colors even when command objects bypass the parser', () => {
  for (const color of [
    'red;position:fixed',
    'url(javascript:alert(1))',
    'var(--brand)',
    '#12',
    'rgb(999,0,0)',
    '" onmouseover="alert(1)',
  ]) {
    const result = executeSimpleAlbumHtmlPatch(album(), {
      type: 'set_text_color',
      page_number: 2,
      target_text: '全面领先',
      color,
    });
    assert.deepEqual(result, { handled: false, reason: 'invalid_color' }, color);
  }
});

test('does not treat text in CSS or scripts as an editable match', () => {
  const original = album('核心性能<br>安全标题');
  assert.deepEqual(executeSimpleAlbumHtmlPatch(original, replaceCommand()), {
    handled: false,
    reason: 'target_not_found',
  });
});

test('returns page_not_found without changing source', () => {
  assert.deepEqual(executeSimpleAlbumHtmlPatch(album(), {
    type: 'replace_text',
    page_number: 3,
    old_text: '全面领先',
    new_text: '遥遥领先',
  }), {
    handled: false,
    reason: 'page_not_found',
  });
});

test('runs the existing album persist validator before returning success', () => {
  const unsafe = album().replace(
    '</main>',
    '<input type="file" accept="image/*" id="uploadInput"></main>',
  );
  const result = executeSimpleAlbumHtmlPatch(unsafe, replaceCommand());
  assert.equal(result.handled, false);
  if (result.handled) return;
  assert.equal(result.reason, 'validation_failed');
  assert.ok((result.validation_reasons?.length ?? 0) > 0);
});
