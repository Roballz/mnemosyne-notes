import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCleanTags, filterChatMessages } from '../lib/workbench/tag-filter.js';

const clean = async (content, tags) => (await filterChatMessages([{ content }], tags))[0].content;

test('literal selectors normalize names, values, whitespace and duplicates without weakening attributes', () => {
    assert.deepEqual(normalizeCleanTags([' sxrp ', '<SXRp>', '', '<Archive TYPE=关系>', "<archive type='关系'>", '<状态>']),
        ['<sxrp>', '<archive type="关系">', '<状态>']);
    assert.deepEqual(normalizeCleanTags(['<archive b="Mixed" A="a > b">']), ['<archive a="a > b" b="Mixed">']);
    for (const invalid of ['</archive>', '<archive/>', '<archive>text</archive>', '<archive><sxrp>', '<archive type="关系>',
        '<archive type="甲" TYPE="乙">', 'archive type=关系', '<archive.*>', '<archive type=>'])
        assert.throws(() => normalizeCleanTags([invalid]), /清洗标签/);
    assert.throws(() => normalizeCleanTags('archive'), /清洗标签/);
});

test('multiple selectors remove every matching block, including multiline and attributed openings', async () => {
    const text = '前文\n<archive type="关系">\n## R-001 合成记录\n隐藏内容\n</archive>\n中段'
        + '<sxrp guests="合成嘉宾">隐藏台词</sxrp>后文<archive type="事件">另一个块</archive>';
    assert.equal(await clean(text, ['<sxrp>', '<archive>']), '前文\n\n中段后文');
    assert.equal(await clean(text, ['<sxrp>', '<archive type="关系">']), '前文\n\n中段后文<archive type="事件">另一个块</archive>');
});

test('attribute constraints ignore order, names case and quote styles, but preserve values and exact tag names', async () => {
    const text = '<ARCHIVE extra="a > b" TYPE = \'关系\'>隐藏一</ARCHIVE >'
        + '<archive type=关系 extra=x>隐藏二</archive><archive type="关系图">保留</archive>'
        + '<archive-old type="关系">保留旧类</archive-old><archive type="Other">保留大小写</archive>';
    assert.equal(await clean(text, ['<archive type="关系">', '<archive type="other">']),
        '<archive type="关系图">保留</archive><archive-old type="关系">保留旧类</archive-old><archive type="Other">保留大小写</archive>');
    assert.equal(await clean('<archive a="x" b="y">删</archive><archive a="x">留</archive>', ['<archive b="y" a="x">']), '<archive a="x">留</archive>');
});

test('nested blocks do not leak trailing content and selective children do not remove unrelated parents', async () => {
    assert.equal(await clean('前<archive>外<archive type="另一类">内</archive>外尾<sxrp>杂</sxrp></archive>后', ['archive', 'sxrp']), '前后');
    assert.equal(await clean('<archive type="保留">前<archive type="关系">内<archive>更内</archive>内尾</archive>后</archive>', ['<archive type="关系">']), '<archive type="保留">前后</archive>');
    assert.equal(await clean('甲<sxrp>一</sxrp>乙<sxrp/>丙<archive type="关系" />丁', ['sxrp', '<archive type="关系">']), '甲乙丙丁');
    assert.equal(await clean('甲<状态>隐藏</状态>乙', ['状态']), '甲乙');
});

test('unclosed selected blocks hide the message tail; empty filtered bodies and original message identities remain safe', async () => {
    const messages = [{ floor: 0, role: 'user', name: '合成用户', content: '保留' },
        { floor: 1, role: 'assistant', name: '合成角色', content: '<archive>整条隐藏' },
        { floor: 2, role: 'assistant', content: '可见<archive>外<archive>内</archive>尾' }];
    assert.equal(await filterChatMessages(messages, []), messages);
    const result = await filterChatMessages(messages, ['archive']);
    assert.equal(result[0], messages[0]);
    assert.deepEqual(result[1], { ...messages[1], content: '' });
    assert.equal(result[2].content, '可见');
    assert.equal(messages[1].content, '<archive>整条隐藏');
    assert.equal(await clean('<archive type="别类">保留未闭合', ['<archive type="关系">']), '<archive type="别类">保留未闭合');
});

test('large quoted attributes, dense unclosed tags and many messages yield to timers while preserving exact filtering', async () => {
    const cases = [
        { messages: [{ content: '<archive note="' + '甲>'.repeat(180000) + '" type="关系">秘密</archive>尾' }], expected: '尾', tags: ['<archive type="关系">'] },
        { messages: [{ content: '首' + '<archive>'.repeat(50000) + '秘密' }], expected: '首', tags: ['archive'] },
        { messages: Array.from({ length: 2000 }, () => ({ content: '<sxrp>秘密</sxrp>' })), expected: '', tags: ['sxrp'] },
    ];
    for (const { messages, expected, tags } of cases) {
        let advanced = false;
        const timer = setTimeout(() => { advanced = true; }, 0);
        const result = await filterChatMessages(messages, tags);
        clearTimeout(timer);
        assert.equal(advanced, true, 'filtering must let a queued browser-style task run');
        assert.ok(result.every(message => message.content === expected));
    }
});
