import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { markdown } from '../lib/workbench/markdown.js';

function render(text) {
    const { document } = parseHTML('<html><body></body></html>');
    globalThis.document = document;
    const output = markdown(text); document.body.append(output); return output;
}

test('completed assistant Markdown renders headings, lists, and GFM tables as readable elements', () => {
    const output = render('# 整理计划\n\n本轮先检查 **编号**，保留 *疑点*。\n\n| 批次 | 主题 | 条数 |\n| --- | --- | ---: |\n| 一 | 合成设定 | 5 |\n| 二 | 合成关系 | 3 |\n\n1. 第一项\n2. 第二项\n\n- 待核实甲\n- 待核实乙');
    assert.equal(output.querySelector('h1')?.textContent, '整理计划');
    assert.equal(output.querySelector('strong')?.textContent, '编号');
    assert.equal(output.querySelector('em')?.textContent, '疑点');
    assert.equal(output.querySelectorAll('table').length, 1);
    assert.equal(output.querySelectorAll('thead th[scope="col"]').length, 3);
    assert.equal(output.querySelectorAll('tbody tr').length, 2);
    assert.equal(output.querySelectorAll('ol > li').length, 2);
    assert.equal(output.querySelectorAll('ul > li').length, 2);
    assert.ok(output.querySelector('.mn-wb-table > table'), 'only wide tables get a separate horizontal wrapper');
    assert.equal(output.querySelectorAll('pre').length, 0, 'normal prose is not put in a code frame');
});

test('raw HTML is shown literally and cannot create scripts, attributes, or embedded surfaces', () => {
    const payload = '<script>alert("synthetic")</script>\n\n<img src="https://example.test/pixel" onerror="alert(1)">\n\n<svg onload="alert(2)"></svg>\n\n<iframe src="https://example.test/frame"></iframe>\n\n<style>body{display:none}</style>';
    const output = render(payload);
    assert.match(output.textContent, /<script>alert\("synthetic"\)<\/script>/);
    assert.match(output.textContent, /<img src=/);
    assert.equal(output.querySelectorAll('script,style,img,svg,iframe,object,embed,form,input,template').length, 0);
    assert.equal(output.querySelectorAll('[src],[srcdoc],[onerror],[onload],[style]').length, 0);
});

test('unsafe and encoded Markdown links have no executable destination', () => {
    const output = render('[js](javascript:alert%281%29)\n\n[encoded](java&#x73;cript:alert%281%29)\n\n[data](data:text/html,synthetic)\n\n[file](file:///synthetic)\n\n[relative](/local)');
    assert.equal(output.querySelectorAll('a').length, 5);
    for (const link of output.querySelectorAll('a')) assert.equal(link.getAttribute('href'), null);
});

test('safe links retain only an explicit destination and safe target attributes', () => {
    const output = render('[documentation](https://example.test/docs "optional title")\n\n<https://example.test/plain>\n\n[mail](mailto:synthetic@example.test)');
    assert.equal(output.querySelectorAll('a').length, 3);
    for (const link of output.querySelectorAll('a')) {
        assert.match(link.getAttribute('href'), /^(https:\/\/|mailto:)/);
        assert.equal(link.getAttribute('target'), '_blank');
        assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
        assert.deepEqual([...link.attributes].map(a => a.name).sort(), ['href', 'rel', 'target']);
    }
});

test('Markdown images become text and fenced HTML remains an inert code sample', () => {
    const output = render('![合成图示](https://example.test/tracking.png)\n\n![其他图示](data:image/svg+xml;base64,synthetic)\n\n```html\n<img src="https://example.test/code-image" onerror="alert(1)">\n<script>alert(2)</script>\n```');
    assert.match(output.textContent, /合成图示/); assert.match(output.textContent, /其他图示/);
    assert.match(output.querySelector('pre > code')?.textContent || '', /<script>alert\(2\)<\/script>/);
    assert.equal(output.querySelectorAll('img,script,svg,[src],[onerror]').length, 0);
});
