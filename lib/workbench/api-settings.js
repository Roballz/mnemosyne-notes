import { button, field, iconButton, input, node } from '../dom.js';
import { clone, makeId } from './model.js';

const row = (className, ...children) => {
    const el = node('div', className); el.append(...children); return el;
};
function selector(options, value, label) {
    const el = node('select'); el.setAttribute('aria-label', label);
    for (const [id, title] of options) {
        const option = node('option', '', title); option.value = id; el.append(option);
    }
    el.value = value; return el;
}
const defaultList = async (...args) => (await import('./providers.js')).listChannelModels(...args);
const defaultTest = async (...args) => (await import('./providers.js')).testChannel(...args);

// Provider errors sometimes echo request headers. Never display a credential,
// including when an incompatible proxy returns a diagnostic response as text.
function publicText(value, key) {
    let text = String(value?.message || value || '请求失败，请检查配置。');
    if (key) text = text.split(key).join('[已隐藏密钥]');
    return text.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[已隐藏密钥]').slice(0, 2400);
}

function channelEditor(initial, { generation, listModels, test, onSave, onDelete }) {
    const el = node('div', 'mn-wb-api-editor'), fields = {}, controls = [];
    const grid = node('div', 'mn-wb-api-fields');
    let closed = false, revision = 0, request, writing = false, filterTimer, filterVersion = 0;
    let modelIds = [], modelLookup = new Set();
    const status = node('p', 'mn-wb-api-status'); status.setAttribute('role', 'status'); status.hidden = true;
    const show = (text, state = '') => {
        if (closed) return;
        status.textContent = publicText(text, fields.key?.value?.trim()); status.dataset.state = state; status.hidden = !text;
    };
    const read = () => ({ ...clone(initial), ...Object.fromEntries(Object.entries(fields).map(([key, control]) => [key, control.value.trim()])) });
    function cancel() {
        revision++; request?.abort(); request = null;
        clearTimeout(filterTimer); filterTimer = undefined; filterVersion++;
        refresh.disabled = testButton.disabled = writing;
        refresh.textContent = modelIds.length ? '刷新模型' : '获取模型'; testButton.textContent = '测试连接';
    }
    for (const [key, label, placeholder] of [
        ['name', '名称', '例如：归档助手'], ['url', 'API 地址', 'https://example.com/v1'], ['key', '密钥', 'API Key'],
    ]) {
        const control = input(initial[key] || '', placeholder); control.setAttribute('aria-label', label);
        control.autocomplete = 'off'; control.spellcheck = false;
        if (key === 'key') control.type = 'password';
        if (key === 'url') { control.type = 'url'; control.inputMode = 'url'; }
        fields[key] = control; controls.push(control); grid.append(field(label, control));
        control.oninput = () => {
            cancel();
            if (key === 'url' || key === 'key') { modelIds = []; modelLookup = new Set(); drawModels(); refresh.textContent = '获取模型'; }
            show('有未保存的修改');
        };
    }
    const models = selector([['', '获取模型后选择']], '', '可用模型'); models.disabled = true;
    const model = input(initial.model || '', '也可手动填写模型名'); model.setAttribute('aria-label', '模型名称'); model.autocomplete = 'off';
    fields.model = model; controls.push(model, models);
    model.oninput = () => {
        cancel(); models.value = [...models.options].some(o => o.value === model.value) ? model.value : '';
        if (modelIds.length) filterTimer = setTimeout(() => { filterTimer = undefined; drawModels(model.value); }, 150);
        show('有未保存的修改');
    };
    models.onchange = () => { if (models.value) { model.value = models.value; cancel(); show('有未保存的修改'); } };
    const refresh = button('获取模型', () => run('models'), 'mn-wb-small');
    const testButton = button('测试连接', () => run('test'), 'mn-wb-small');
    const save = button('保存 API', () => write(() => onSave(read())), 'mn-primary mn-wb-small');
    controls.push(refresh, testButton, save);
    const actions = row('mn-wb-api-actions', save, testButton);
    if (onDelete) {
        const remove = button('删除 API', () => write(onDelete), 'mn-wb-small mn-wb-danger');
        controls.push(remove); actions.append(remove);
    }
    const modelHint = node('small', 'mn-hint', '列表较长时可在模型名中输入关键词筛选，选中后保存；也可直接填写完整模型名。');
    grid.append(field('模型', row('mn-wb-api-model', row('mn-wb-api-model-row', models, refresh), model, modelHint)));
    el.append(grid, node('p', 'mn-hint', '兼容 OpenAI 聊天补全接口。测试只发送简短验证请求；未保存的配置也可测试。'), actions, status);

    async function drawModels(query = '') {
        const version = ++filterVersion, needle = query.trim().toLocaleLowerCase(), visible = [];
        const exact = modelLookup.has(model.value.trim()) ? model.value.trim() : '';
        if (exact) visible.push(exact);
        // A proxy can return tens of thousands of model names. Keep DOM work
        // bounded, and yield while searching a large cached list without I/O.
        for (let index = 0; index < modelIds.length; index++) {
            if (index && index % 2000 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (closed || writing || version !== filterVersion) return;
            }
            const id = modelIds[index];
            if (id !== exact && (!needle || id.toLocaleLowerCase().includes(needle))) visible.push(id);
            if (visible.length > 200) break;
        }
        if (closed || writing || version !== filterVersion) return;
        const more = visible.length > 200; visible.length = Math.min(visible.length, 200);
        models.replaceChildren();
        for (const id of ['', ...visible]) {
            const option = node('option', '', id || (modelIds.length ? visible.length ? '选择模型' : '没有匹配项，可手动填写' : '获取模型后选择'));
            option.value = id; models.append(option);
        }
        models.disabled = !visible.length; models.value = exact;
        modelHint.textContent = (more ? '仅显示前 200 项。' : '') + '列表较长时可在模型名中输入关键词筛选，选中后保存；也可直接填写完整模型名。';
    }

    async function run(kind) {
        if (closed || writing) return;
        cancel(); const version = revision, abort = new AbortController(); request = abort;
        const channel = read();
        refresh.disabled = testButton.disabled = true;
        (kind === 'models' ? refresh : testButton).textContent = kind === 'models' ? '获取中…' : '测试中…';
        show(kind === 'models' ? '正在获取模型列表…' : '正在发送测试请求…');
        try {
            if (kind === 'models') {
                const values = await listModels(channel, { signal: abort.signal });
                if (closed || abort.signal.aborted || version !== revision) return;
                modelLookup = new Set((Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.id).filter(value => typeof value === 'string' && value));
                modelIds = [...modelLookup]; await drawModels();
                if (closed || abort.signal.aborted || version !== revision) return;
                show(modelIds.length ? `已获取 ${modelIds.length} 个模型，请选择后保存。` : '接口未提供模型列表，可以手动填写模型名。', modelIds.length ? 'success' : '');
            } else {
                const result = await test({ ...channel, ...(typeof generation === 'function' ? generation() : generation || {}) }, { signal: abort.signal });
                if (closed || abort.signal.aborted || version !== revision) return;
                const text = typeof result === 'string' ? result : result?.text;
                if (!String(text || '').trim()) throw Error('接口已响应，但没有返回正文内容。');
                show('测试成功 · ' + String(text).trim(), 'success');
            }
        } catch (error) {
            if (!closed && !abort.signal.aborted && version === revision) show(error, 'error');
        } finally {
            if (!closed && version === revision) { request = null; refresh.disabled = testButton.disabled = false; refresh.textContent = modelIds.length ? '刷新模型' : '获取模型'; testButton.textContent = '测试连接'; }
        }
    }
    async function write(action) {
        if (closed || writing) return;
        cancel(); writing = true; for (const control of controls) control.disabled = true;
        show('正在保存…');
        try { await action(); }
        catch (error) { show(error, 'error'); }
        finally {
            writing = false;
            if (!closed) { for (const control of controls) control.disabled = false; models.disabled = models.options.length < 2; }
        }
    }
    return { el, read, show, dispose() { closed = true; cancel(); } };
}

/** One selected API editor. New channels are held in a separate modal until
 * saved; switching/closing aborts diagnostics and ignores late responses. */
export function mountApiSettings(view, container, draftSettings, options = {}) {
    const controller = view.controller, settingsDialog = container.closest('dialog');
    const listModels = options.listModels || defaultList, test = options.test || defaultTest;
    const generation = options.generation || (() => draftSettings.generation);
    const toolbar = node('div', 'mn-wb-api-toolbar'), current = node('div', 'mn-wb-api-current');
    let disposed = false, editor, selected, addDialog, addEditor, pendingWrite = Promise.resolve();
    const choose = selector([], '', '当前 API');
    const add = button('添加 API', openAdd, 'mn-wb-small'); toolbar.append(choose, add); container.append(toolbar, current);
    function savedChannels() { return controller.settings?.channels || draftSettings.channels || []; }
    function syncDraft(patch) {
        draftSettings.channels = clone(controller.settings?.channels || patch.channels || []);
        draftSettings.sourceId = controller.settings?.sourceId || patch.sourceId || 'main';
    }
    function persist(patch) {
        choose.disabled = add.disabled = true;
        const operation = Promise.resolve().then(() => controller.saveSettings(patch)).then(() => { syncDraft(patch); }).finally(() => {
            if (!disposed) choose.disabled = add.disabled = false;
        });
        // The caller displays an error locally; the outer settings save only
        // needs to wait for in-flight writes, not replay a past failure.
        pendingWrite = operation.catch(() => {});
        return operation;
    }
    function draw(message = '') {
        if (disposed) return;
        editor?.dispose(); editor = null;
        selected = draftSettings.sourceId || 'main';
        choose.replaceChildren();
        for (const [id, label] of [['main', '正文 API'], ...savedChannels().map(c => [c.id, c.name])]) {
            const option = node('option', '', label); option.value = id; choose.append(option);
        }
        choose.value = selected; current.replaceChildren();
        const channel = savedChannels().find(c => c.id === selected);
        if (!channel) {
            current.append(node('p', 'mn-hint', '沿用正文当前连接和模型，包括 Claude 反向代理；生成参数使用工作台设置。'));
            if (message) current.append(node('p', 'mn-wb-api-status', message));
            return;
        }
        editor = channelEditor(channel, { generation, listModels, test,
            onSave: async value => {
                await persist({ channels: savedChannels().map(c => c.id === value.id ? value : c), sourceId: value.id });
                draw('API 配置已保存。');
            },
            onDelete: async () => {
                await persist({ channels: savedChannels().filter(c => c.id !== channel.id), sourceId: 'main' });
                draw('已删除 API，当前使用正文 API。');
            },
        });
        current.append(editor.el); if (message) editor.show(message, 'success');
    }
    choose.onchange = async () => {
        if (disposed || choose.disabled) return;
        const id = choose.value;
        editor?.dispose();
        try { await persist({ sourceId: id }); draw(); }
        catch (error) { draw(); if (editor) editor.show(error, 'error'); else current.append(node('p', 'mn-error', publicText(error))); }
    };
    function openAdd() {
        if (disposed || add.disabled || addDialog) return;
        // Do not use view.dialog(): it closes the settings dialog and discards
        // unsaved generation parameters. Native nested dialogs handle focus.
        const dialog = node('dialog', 'mn-dialog mn-wb-dialog mn-wb-api-dialog'), body = node('div', 'mn-dialog-body');
        dialog.setAttribute('aria-label', '添加 API');
        dialog.append(row('mn-row', node('h3', '', '添加 API'), iconButton('关闭添加 API', 'close', () => dialog.close())), body);
        const draft = { id: makeId('api'), name: '', url: '', model: '', key: '' };
        addDialog = dialog;
        addEditor = channelEditor(draft, { generation, listModels, test,
            onSave: async channel => {
                await persist({ channels: [...savedChannels(), channel], sourceId: channel.id });
                if (!disposed) { dialog.close(); draw('API 已添加并选用。'); }
            },
        });
        body.append(addEditor.el);
        dialog.addEventListener('close', () => {
            addEditor?.dispose(); addEditor = null; addDialog = null; dialog.remove();
            if (!disposed) add.focus({ preventScroll: true });
        }, { once: true });
        view.root.append(dialog); dialog.showModal(); body.querySelector('input')?.focus({ preventScroll: true });
    }
    function dispose() {
        if (disposed) return;
        disposed = true; editor?.dispose(); addEditor?.dispose(); addDialog?.close();
        settingsDialog?.removeEventListener('close', dispose);
    }
    settingsDialog?.addEventListener('close', dispose, { once: true });
    draw();
    return { dispose, refresh: draw, flush: () => pendingWrite };
}
