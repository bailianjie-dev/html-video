import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editableTextFromInnerHtml,
  editableTextToInnerHtml,
  normalizeEditableNewlines,
  readEditableTextValue,
  writeEditableTextValue,
} from '../public/editable-text.js';

function createEditableElement(innerHtml = '') {
  const childNodes = [];
  const el = {
    childNodes,
    get firstChild() {
      return childNodes[0] || null;
    },
    removeChild(node) {
      const index = childNodes.indexOf(node);
      if (index >= 0) childNodes.splice(index, 1);
      return node;
    },
    appendChild(node) {
      childNodes.push(node);
      return node;
    },
    get innerHTML() {
      return childNodes.map((node) => {
        if (node.nodeType === 3) {
          return String(node.nodeValue ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        }
        if (String(node.tagName || '').toUpperCase() === 'BR') return '<br>';
        return '';
      }).join('');
    },
  };

  el.ownerDocument = {
    createElement(tagName) {
      return {
        nodeType: 1,
        tagName: String(tagName).toUpperCase(),
        childNodes: [],
      };
    },
    createTextNode(value) {
      return { nodeType: 3, nodeValue: String(value ?? '') };
    },
  };

  // Seed from a simple br/text fragment used by album titles.
  const parts = String(innerHtml).split(/<br\s*\/?\s*>/i);
  parts.forEach((part, index) => {
    if (index > 0) el.appendChild(el.ownerDocument.createElement('br'));
    if (part) el.appendChild(el.ownerDocument.createTextNode(part));
  });
  return el;
}

test('editableTextToInnerHtml escapes text and restores br between lines', () => {
  assert.equal(
    editableTextToInnerHtml('核心性能\n遥遥领先'),
    '核心性能<br>遥遥领先',
  );
  assert.equal(
    editableTextToInnerHtml('A < B\nC & D'),
    'A &lt; B<br>C &amp; D',
  );
});

test('editableTextFromInnerHtml recovers newlines from br and nested spans', () => {
  assert.equal(
    editableTextFromInnerHtml('核心性能<br>全面领先'),
    '核心性能\n全面领先',
  );
  assert.equal(
    editableTextFromInnerHtml('核心性能<br><span style="color:red">遥遥领先</span>'),
    '核心性能\n遥遥领先',
  );
  assert.equal(
    normalizeEditableNewlines('a\r\nb\rc'),
    'a\nb\nc',
  );
});

test('DOM read/write round-trips br line breaks without collapsing lines', () => {
  const el = createEditableElement('核心性能<br>全面领先');
  assert.equal(readEditableTextValue(el), '核心性能\n全面领先');

  writeEditableTextValue(el, '核心性能\n遥遥领先');
  assert.equal(el.innerHTML, '核心性能<br>遥遥领先');
  assert.equal(readEditableTextValue(el), '核心性能\n遥遥领先');
  assert.equal(el.childNodes.length, 3);
  assert.equal(el.childNodes[1].tagName, 'BR');
});

test('writeEditableTextValue does not interpret HTML from the textarea', () => {
  const el = createEditableElement('');
  writeEditableTextValue(el, '<script>alert(1)</script>\nsafe');
  assert.equal(el.childNodes.length, 3);
  assert.equal(el.childNodes[0].nodeType, 3);
  assert.equal(el.childNodes[0].nodeValue, '<script>alert(1)</script>');
  assert.equal(el.childNodes[1].tagName, 'BR');
  assert.equal(readEditableTextValue(el), '<script>alert(1)</script>\nsafe');
});
