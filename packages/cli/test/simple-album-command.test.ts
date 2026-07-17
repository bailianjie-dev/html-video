import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSafeColor,
  normalizeSimpleCommandAliases,
  normalizeSimpleCommandText,
  parseSimpleAlbumCommand,
} from '../dist/simple-album-command.js';

test('parses exact replacement with a Chinese page number', () => {
  assert.deepEqual(parseSimpleAlbumCommand('第二页的全面领先，改为遥遥领先'), {
    handled: true,
    command: {
      type: 'replace_text',
      page_number: 2,
      old_text: '全面领先',
      new_text: '遥遥领先',
    },
  });
});

test('parses quoted replacement and Arabic page numbers', () => {
  assert.deepEqual(parseSimpleAlbumCommand(' 把第 2 页 “全面领先” 替换成 “遥遥领先” 。 '), {
    handled: true,
    command: {
      type: 'replace_text',
      page_number: 2,
      old_text: '全面领先',
      new_text: '遥遥领先',
    },
  });
});

test('parses Chinese page numbers containing tens', () => {
  const result = parseSimpleAlbumCommand('第十二页的旧标题改成新标题');
  assert.deepEqual(result, {
    handled: true,
    command: {
      type: 'replace_text',
      page_number: 12,
      old_text: '旧标题',
      new_text: '新标题',
    },
  });
});

test('treats an omitted page as the current page', () => {
  assert.deepEqual(parseSimpleAlbumCommand('把“小米SU7”改成“Xiaomi SU7”'), {
    handled: true,
    command: {
      type: 'replace_text',
      current_page: true,
      old_text: '小米SU7',
      new_text: 'Xiaomi SU7',
    },
  });
});

test('parses a safe named color without an explicit style word', () => {
  assert.deepEqual(parseSimpleAlbumCommand('当前页的遥遥领先改成红色'), {
    handled: true,
    command: {
      type: 'set_text_color',
      current_page: true,
      target_text: '遥遥领先',
      color: '#FF0000',
    },
  });
});

test('normalizes bounded colloquial operators into deterministic color commands', () => {
  for (const operator of ['变成', '变为', '弄成', '搞成', '调成', '调整为', '设置成']) {
    assert.deepEqual(parseSimpleAlbumCommand(`xiaomi${operator}绿色`), {
      handled: true,
      command: {
        type: 'set_text_color',
        current_page: true,
        target_text: 'xiaomi',
        color: '#008000',
      },
    }, operator);
  }
});

test('keeps colloquial normalization lexical and preserves quoted literals', () => {
  assert.equal(normalizeSimpleCommandAliases('xiaomi变成绿色'), 'xiaomi改为绿色');
  assert.equal(
    normalizeSimpleCommandAliases('把"成长变成力量"变成"新的文案"'),
    '把"成长变成力量"改为"新的文案"',
  );
  assert.equal(
    normalizeSimpleCommandAliases('背景换成渐变色,渐变为白色'),
    '背景改为渐变色,渐变为白色',
  );
  assert.deepEqual(parseSimpleAlbumCommand('xiaomi变成小米'), {
    handled: true,
    command: {
      type: 'replace_text',
      current_page: true,
      old_text: 'xiaomi',
      new_text: '小米',
    },
  });
});

test('parses 把 before an explicit page and marks 就是第N页 as strict', () => {
  assert.deepEqual(parseSimpleAlbumCommand('把第一页的核心性能改成红色'), {
    handled: true,
    command: {
      type: 'set_text_color',
      page_number: 1,
      target_text: '核心性能',
      color: '#FF0000',
    },
  });
  assert.deepEqual(parseSimpleAlbumCommand('就是第一页，把核心性能改成红色'), {
    handled: true,
    command: {
      type: 'set_text_color',
      page_number: 1,
      page_match_policy: 'strict',
      target_text: '核心性能',
      color: '#FF0000',
    },
  });
});

test('treats 这一页, 这页, and 本页 as the Session current page', () => {
  for (const pageSelector of ['这一页', '这页', '本页']) {
    assert.deepEqual(parseSimpleAlbumCommand(`${pageSelector}的核心性能改为红色`), {
      handled: true,
      command: {
        type: 'set_text_color',
        current_page: true,
        target_text: '核心性能',
        color: '#FF0000',
      },
    });
  }
});

test('parses an explicit font color with a hex value', () => {
  assert.deepEqual(parseSimpleAlbumCommand('第二页“遥遥领先”的字体改为 #FF5A36'), {
    handled: true,
    command: {
      type: 'set_text_color',
      page_number: 2,
      target_text: '遥遥领先',
      color: '#FF5A36',
    },
  });
});

test('parses preset colors on the current page', () => {
  assert.deepEqual(parseSimpleAlbumCommand('把遥遥领先设为品牌蓝'), {
    handled: true,
    command: {
      type: 'set_text_color',
      current_page: true,
      target_text: '遥遥领先',
      color: '#2563EB',
    },
  });
});

test('normalizes punctuation, quotes, whitespace, hex, and rgb colors', () => {
  assert.equal(normalizeSimpleCommandText('  把 “A” ， 改为 “B” 。  '), '把 "A",改为 "B".');
  assert.equal(normalizeSafeColor('#ff5a36'), '#FF5A36');
  assert.equal(normalizeSafeColor('#abc8'), '#ABC8');
  assert.equal(normalizeSafeColor('rgb( 255, 90, 54 )'), 'rgb(255, 90, 54)');
  assert.equal(normalizeSafeColor('BLUE'), '#0000FF');
});

test('rejects unsafe or malformed colors', () => {
  assert.equal(normalizeSafeColor('rgb(256, 0, 0)'), null);
  assert.equal(normalizeSafeColor('#12'), null);
  assert.equal(normalizeSafeColor('var(--brand-color)'), null);
  assert.equal(normalizeSafeColor('url(javascript:alert(1))'), null);
  assert.deepEqual(parseSimpleAlbumCommand('把“遥遥领先”的字体改为霓虹渐变色'), {
    handled: false,
    reason: 'invalid_color',
  });
});

test('returns subjective_request for non-deterministic visual requests', () => {
  for (const input of ['做得更高级', '把第二页改得更好看', '让标题更有科技感']) {
    assert.deepEqual(parseSimpleAlbumCommand(input), {
      handled: false,
      reason: 'subjective_request',
    });
  }
});

test('rejects non-text style properties before the generic replacement grammar', () => {
  for (const input of [
    '第一页背景色换成渐变色，上面蓝色，渐变为白色',
    '第二页边框改成蓝色',
    '当前页动画改为淡入',
    '背景变成绿色',
    '第二页边框弄成蓝色',
  ]) {
    assert.deepEqual(parseSimpleAlbumCommand(input), {
      handled: false,
      reason: 'non_text_style_request',
    });
  }
  assert.deepEqual(parseSimpleAlbumCommand('把“背景色”改成“背景颜色”'), {
    handled: true,
    command: {
      type: 'replace_text',
      current_page: true,
      old_text: '背景色',
      new_text: '背景颜色',
    },
  });
});

test('returns explicit reasons when required values are missing', () => {
  assert.deepEqual(parseSimpleAlbumCommand('改成遥遥领先'), {
    handled: false,
    reason: 'missing_old_text',
  });
  assert.deepEqual(parseSimpleAlbumCommand('把全面领先改成'), {
    handled: false,
    reason: 'missing_new_text',
  });
  assert.deepEqual(parseSimpleAlbumCommand('把标题字体改为红色'), {
    handled: false,
    reason: 'missing_target_text',
  });
  assert.deepEqual(parseSimpleAlbumCommand('把遥遥领先的字体颜色调整一下'), {
    handled: false,
    reason: 'missing_color',
  });
});

test('rejects compound, ambiguous-page, invalid-page, and unsupported requests', () => {
  assert.deepEqual(parseSimpleAlbumCommand('第二页改A为B，同时第三页改C为D'), {
    handled: false,
    reason: 'compound_request',
  });
  assert.deepEqual(parseSimpleAlbumCommand('当前页把第二页的A改成B'), {
    handled: false,
    reason: 'ambiguous_page',
  });
  assert.deepEqual(parseSimpleAlbumCommand('第三十一页把A改成B'), {
    handled: false,
    reason: 'invalid_page',
  });
  assert.deepEqual(parseSimpleAlbumCommand('帮我生成一个相册'), {
    handled: false,
    reason: 'unsupported_command',
  });
});

test('rejects commands containing more than one mutation operator', () => {
  assert.deepEqual(parseSimpleAlbumCommand('把A改成B改成C'), {
    handled: false,
    reason: 'ambiguous_command',
  });
  assert.deepEqual(parseSimpleAlbumCommand('把A变成B再调成C'), {
    handled: false,
    reason: 'ambiguous_command',
  });
});
