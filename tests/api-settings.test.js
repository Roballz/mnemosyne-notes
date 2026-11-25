import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom/worker';
import { mountApiSettings } from '../lib/workbench/api-settings.js';
import { settingsWithDefaults, validateSettings } from '../lib/workbench/model.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
    for (let index = 0; index < 50; index++) { if (check()) return; await pause(); }
    throw Error('UI did not settle');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function setup(options = {}, sourceId = 'one') {
    const { document, Event, HTMLElement, HTMLSelectElement } = parseHTML('<html><body><div class="mn-notebook"><dialog><div id="apis"></div></dialog></div></body></html>');
    globalThis.document = document;
    HTMLElement.prototype.showModal = function () { this.open = true; };
    HTMLElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(HTMLSelectElement.prototype, 'value', { ...descriptor, set(value) {
        for (const option of this.options) { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); }
    } });
    const c = { settings: settingsWithDefaults({ sourceId, channels: [
        { id: 'one', name: '合成 API 一', url: 'https://example.test/v1', key: 'synthetic-credential-one', model: 'model-a' },
        { id: 'two', name: '合成 API 二', url: 'https://example.test/other/v1', key: 'synthetic-credential-two', model: 'model-b' },
    ] }), writes: [] };
    c.saveSettings = async patch => { c.settings = validateSettings({ ...c.settings, ...structuredClone(patch) }); c.writes.push(structuredClone(patch)); };
    const draft = structuredClone(c.settings), parent = document.querySelector('dialog'); parent.showModal();
    const container = document.querySelector('#apis'), root = document.querySelector('.mn-notebook');
    const api = mountApiSettings({ root, controller: c }, container, draft, options);
    const click = (host, label) => {
        const el = [...host.querySelectorAll('button')].find(b => b.textContent === label);
        assert.ok(el, label); el.click(); return el;
    };
    const input = (host, label, value) => {
        const el = host.querySelector(`[aria-label="${label}"]`); assert.ok(el, label);
        if (value !== undefined) { el.value = value; el.oninput?.(); } return el;
    };
    return { c, draft, parent, container, document, api, click, input };
}

test('add API uses its own dialog, validates before saving, and keeps unsaved generation fields', async () => {
    const { c, draft, parent, container, document, click, input } = setup({}, 'main');
    draft.generation.temperature = 0.4;
    click(container, '添加 API');
    const add = document.querySelector('.mn-wb-api-dialog');
    assert.ok(add.open); assert.ok(parent.open);
    assert.equal(c.settings.channels.length, 2);
    click(add, '保存 API'); await until(() => add.querySelector('[data-state="error"]'));
    assert.equal(c.writes.length, 0, 'an empty API is not added to persistent settings');
    input(add, '名称', '合成 API 三'); input(add, 'API 地址', 'https://example.test/new/v1'); input(add, '模型名称', 'model-c');
    click(add, '保存 API'); await until(() => !document.querySelector('.mn-wb-api-dialog'));
    assert.ok(parent.open); assert.equal(c.settings.channels.length, 3);
    assert.equal(draft.channels.length, 3); assert.equal(draft.sourceId, c.settings.sourceId);
    assert.equal(draft.generation.temperature, 0.4);
    assert.equal(container.querySelectorAll('.mn-wb-api-editor').length, 1);
    assert.equal(input(container, '模型名称').value, 'model-c');
});

test('saving and deleting update the selected configuration without stale outer settings restoring it', async () => {
    const { c, draft, container, api, click, input } = setup();
    input(container, '名称', '合成 API 改名'); input(container, '模型名称', 'model-revised');
    click(container, '保存 API'); await api.flush(); await until(() => container.textContent.includes('API 配置已保存'));
    assert.equal(c.settings.channels[0].name, '合成 API 改名'); assert.equal(draft.channels[0].model, 'model-revised');
    assert.equal(c.settings.channels[0].key, 'synthetic-credential-one');
    click(container, '删除 API'); await api.flush(); await until(() => !container.querySelector('.mn-wb-api-editor'));
    assert.equal(c.settings.sourceId, 'main'); assert.equal(draft.sourceId, 'main');
    assert.deepEqual(draft.channels.map(c => c.id), ['two']);
    await c.saveSettings(draft);
    assert.deepEqual(c.settings.channels.map(c => c.id), ['two'], 'outer save cannot restore the deleted API');
});

test('refresh models and test use the currently edited fields and redact echoed credentials', async () => {
    const listed = [], tested = [];
    const { container, click, input } = setup({
        generation: () => ({ temperature: 0.3, maxTokens: 2048 }),
        listModels: async channel => { listed.push(channel); return ['model-new', 'model-new', 'model-other']; },
        test: async channel => { tested.push(channel); return { text: 'OK synthetic-credential-edited <script>no HTML</script>' }; },
    });
    input(container, 'API 地址', 'https://example.test/edited/v1'); input(container, '密钥', 'synthetic-credential-edited');
    click(container, '获取模型'); await until(() => container.textContent.includes('已获取 2 个模型'));
    assert.equal(listed[0].url, 'https://example.test/edited/v1');
    const models = input(container, '可用模型'); models.value = 'model-new'; models.onchange();
    assert.equal(input(container, '模型名称').value, 'model-new');
    click(container, '测试连接'); await until(() => container.textContent.includes('测试成功'));
    assert.equal(tested[0].model, 'model-new'); assert.equal(tested[0].temperature, 0.3);
    assert.equal(tested[0].key, 'synthetic-credential-edited');
    assert.ok(!container.querySelector('.mn-wb-api-status').textContent.includes('synthetic-credential-edited'));
    assert.equal(container.querySelectorAll('script').length, 0);
    assert.match(container.querySelector('.mn-wb-api-status').textContent, /\[已隐藏密钥\]/);
});

test('switching API aborts pending diagnostics and ignores a late model list', async () => {
    const pending = deferred(); let signal;
    const { container, click, input, c } = setup({ listModels: async (_, options) => { signal = options.signal; return pending.promise; } });
    click(container, '获取模型'); await until(() => signal);
    const current = input(container, '当前 API'); current.value = 'two'; await current.onchange();
    assert.ok(signal.aborted); assert.equal(c.settings.sourceId, 'two');
    assert.equal(input(container, '模型名称').value, 'model-b');
    pending.resolve(['should-not-appear']); await pause();
    assert.ok(!container.textContent.includes('should-not-appear'));
    assert.equal(input(container, '可用模型').options.length, 1);
});

test('closing settings also closes the add dialog and aborts its test', async () => {
    const pending = deferred(); let signal;
    const { parent, container, document, click, c } = setup({ test: async (_, options) => { signal = options.signal; return pending.promise; } });
    click(container, '添加 API'); const add = document.querySelector('.mn-wb-api-dialog');
    click(add, '测试连接'); await until(() => signal);
    parent.close(); assert.ok(signal.aborted); assert.equal(document.querySelector('.mn-wb-api-dialog'), null);
    pending.resolve({ text: 'late result' }); await pause();
    assert.equal(c.writes.length, 0); assert.equal(c.settings.channels.length, 2);
});

test('outer settings can wait for a pending per-API save', async () => {
    const pending = deferred();
    const { container, api, c, draft, click, input } = setup();
    const save = c.saveSettings;
    c.saveSettings = async patch => { await pending.promise; return save(patch); };
    input(container, '模型名称', 'model-after-wait'); click(container, '保存 API');
    let settled = false; const waiting = api.flush().then(() => { settled = true; });
    await pause(); assert.equal(settled, false);
    pending.resolve(); await waiting;
    assert.equal(draft.channels[0].model, 'model-after-wait');
});

test('large cached model lists keep at most 200 choices and can filter to an exact late identifier without refetching', async () => {
    const ids = Array.from({ length: 25000 }, (_, index) => 'synthetic-model-' + String(index).padStart(5, '0'));
    let requests = 0;
    const { container, parent, click, input } = setup({ listModels: async () => { requests++; return ids; } });
    click(container, '获取模型'); await until(() => container.textContent.includes('已获取 25000 个模型'));
    const models = input(container, '可用模型');
    assert.equal(models.options.length, 201, 'placeholder plus at most 200 model choices');
    assert.match(container.textContent, /仅显示前 200 项/);
    input(container, '模型名称', ids.at(-1));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(requests, 1, 'keyword filtering reuses the cached response');
    assert.equal(models.options.length, 2); assert.equal(models.value, ids.at(-1));
    models.onchange(); assert.equal(input(container, '模型名称').value, ids.at(-1));
    input(container, '模型名称', 'manual-model-not-in-list');
    parent.close(); await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(models.options.length, 2, 'closing cancels the pending debounced filter');
    assert.equal(input(container, '模型名称').value, 'manual-model-not-in-list', 'manual identifiers are not truncated or replaced');
});
