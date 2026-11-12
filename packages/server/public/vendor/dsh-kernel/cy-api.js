/**
 * dsh-cy-api — browser half.
 *
 * Registers the plugin as a GLOBAL page, not a settings section and not a
 * session-scoped surface:
 *   - `sidebar.panellist` contributes the entry in the left sidebar;
 *   - `main` (root-scoped, keyed by `dsh-cy-api`) is the page it opens.
 *
 * The page is a tabbed shell: a top navigation with tab buttons switches
 * between its pages. `TABS` below is the single list to extend when a page is
 * added; the first tab is the fixed connection page (one API address, one
 * EngineCode, one EngineSecret).
 *
 * Hand-written bundle: it declares the ModuleLoader factory the client module
 * system expects and requires only the shared platform module (React).
 */

window.__ModuleLoader__.load({
  id: 'dsh-cy-api',
  factory: (require) => {
    'use strict'

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    /** Dictionary namespace owned by this plugin. */
    var NS = 'dshCyApi'
    /** The id shared by the sidebar entry and the main panel it opens. */
    var PANEL_ID = 'dsh-cy-api'
    var API = '/dsh-cy-api/api'

    /** Top navigation entries. Add a page by adding one row here. */
    var TABS = [
      { id: 'connection', labelKey: 'tabConnection' },
      { id: 'data', labelKey: 'tabData' },
      { id: 'update', labelKey: 'tabUpdate' },
    ]

    /** The selected tab survives leaving and re-entering the page. */
    var lastTab = 'connection'

    var DICT = {
      zh: {
        panel: 'API 转 DSH',
        title: 'API 转 DSH',
        intro:
          '第一个固定页面：接口地址、EngineCode、EngineSecret 各只有一份，保存即覆盖，后续功能直接读取这份数据。',
        globalBadge: '全局页面',
        fixedBadge: '固定页面',
        versionPrefix: 'v',
        unique: '唯一',
        refresh: '刷新',
        loading: '正在加载…',
        configured: '已配置',
        empty: '未配置',
        tabsLabel: '页面导航',
        tabConnection: '接口配置',
        tabData: '数据调用',
        sectionTitle: '接口与组织架构凭据',
        sectionHint: '三项都只有一份，整个文件里不会出现第二条记录。',
        fieldApiUrl: '接口地址',
        fieldApiUrlHint: '组织架构接口的完整地址，只支持 http / https',
        fieldEngineCode: 'EngineCode',
        fieldEngineCodeHint: '组织架构引擎的 EngineCode，全局唯一',
        fieldEngineSecret: 'EngineSecret',
        fieldEngineSecretHint: '使用 AES-256-GCM 加密保存，保存后不会再以明文返回',
        fieldAppCode: 'AppCode（应用编码）',
        fieldAppCodeHint: '该接口所在应用的编码；在应用「设置 > 重命名」弹窗里查看，调用自定义动作时必带',
        secretKeep: '留空表示保持原值',
        secretRequired: '首次保存必须填写',
        save: '保存配置',
        saving: '保存中…',
        test: '测试连接',
        testing: '测试中…',
        clear: '清除配置',
        confirmClear: '确认清除',
        cancel: '取消',
        saved: '配置已保存',
        cleared: '配置已清除',
        statusText: '状态',
        duration: '耗时',
        responseTitle: '响应预览',
        callTitle: '后续如何调用这份数据',
        callHint:
          '宿主侧直接调用导出的函数；其他进程走只读接口。返回的对象与本页展示的一致，secretSet 表示密钥是否已保存。',
        hostApi: '宿主侧',
        httpApi: '接口',
        currentData: '当前记录',
        notConfigured: '还没有保存配置，下面的返回值是 connection: null。',
        returnShape: '返回结构',
        updatedAt: '更新于',
        createdAt: '创建于',
        storageLabel: '存储位置',
        apiUrlRequired: '请填写接口地址',
        engineCodeRequired: '请填写 EngineCode',
        secretRequiredError: '首次保存必须填写 EngineSecret',
        requestFailed: '请求失败',
        tabUpdate: '版本更新',
        updateTitle: '版本与更新',
        updateHint: '从 GitHub 仓库检查是否有新版本。',
        updateCurrent: '当前版本',
        updateLatest: '最新版本',
        updateUpToDate: '已是最新版本',
        updateAvailable: '发现新版本',
        updateNone: '仓库暂无发布版本',
        updateCheck: '检查更新',
        updateChecking: '正在检查…',
        updateFailed: '检查失败',
        updateRelease: '查看发布页',
        updateUnknown: '未知',
        uniqueNote: '全库只有这一份',
        apiListTitle: '已登记接口',
        apiListHint: '在这份连接之上登记要调用的接口动作，后续会把已启用的做成 DSH 工具。',
        apiCount: '共 {n} 个',
        back: '返回',
        editorHint: '在一个独立的页面里配置这条接口；保存后会自动回到「数据调用」页。',
        addApi: '新增接口',
        editApi: '编辑接口',
        saveApi: '保存接口',
        deleteApi: '删除',
        confirmDeleteApi: '确认删除',
        noApis: '还没有登记接口，点「新增接口」添加第一个。',
        fieldApiName: '接口名称',
        fieldApiNameHint: '给人看的名字，如“查询部门列表”',
        fieldActionName: 'ActionName',
        fieldActionNameHint: '氚云 OpenApi 动作名，如 GetServerTime、GetDepartmentList',
        fieldControllerName: 'ControllerName',
        fieldControllerNameHint: '可留空，多数接口不需要',
        fieldDescription: '用途说明',
        fieldDescriptionHint: '这个接口做什么用、返回什么，后续会作为工具描述',
        fieldEnabled: '启用',
        enabledHint: '启用的接口后续会注册成 DSH 工具',
        apiNameRequired: '请填写接口名称',
        actionNameRequired: '请填写 ActionName',
        apiSaved: '接口已保存',
        apiDeleted: '接口已删除',
        paramsTitle: '参数',
        paramsHint: '调用该接口时需要传入的参数；后续注册成工具时会作为工具入参。',
        paramName: '参数名',
        paramType: '类型',
        paramRequired: '必填',
        addParam: '添加参数',
        deleteParam: '删除参数',
        noParams: '无参数',
        testApi: '测试',
        testingApi: '测试中…',
        testApiTitle: '测试该接口',
        testApiHint: '用已保存的连接凭据真实调用一次，参数值仅本次测试使用。',
        testArgValue: '参数值',
        sendTest: '发送测试',
        testApiResult: '测试结果',
      },
      en: {
        panel: 'API to DSH',
        title: 'API to DSH',
        intro:
          'The first fixed page: one API address, one EngineCode, one EngineSecret. Saving replaces it, and later features read this exact record.',
        globalBadge: 'Global page',
        fixedBadge: 'Fixed page',
        versionPrefix: 'v',
        unique: 'Unique',
        refresh: 'Refresh',
        loading: 'Loading…',
        configured: 'Configured',
        empty: 'Not configured',
        tabsLabel: 'Page navigation',
        tabConnection: 'Endpoint',
        tabData: 'Data access',
        sectionTitle: 'Endpoint and organisation credentials',
        sectionHint: 'All three are single-valued: the file never holds a second record.',
        fieldApiUrl: 'Endpoint URL',
        fieldApiUrlHint: 'Full address of the organisation API; http or https only',
        fieldEngineCode: 'EngineCode',
        fieldEngineCodeHint: 'EngineCode of the organisation engine; globally unique',
        fieldEngineSecret: 'EngineSecret',
        fieldEngineSecretHint: 'Encrypted at rest with AES-256-GCM; never returned in plaintext',
        fieldAppCode: 'AppCode (app code)',
        fieldAppCodeHint: 'Code of the app this action belongs to; shown under app Settings > Rename, required for custom actions',
        secretKeep: 'Leave empty to keep the stored value',
        secretRequired: 'Required on first save',
        save: 'Save',
        saving: 'Saving…',
        test: 'Test connection',
        testing: 'Testing…',
        clear: 'Clear',
        confirmClear: 'Confirm clear',
        cancel: 'Cancel',
        saved: 'Configuration saved',
        cleared: 'Configuration cleared',
        statusText: 'Status',
        duration: 'Duration',
        responseTitle: 'Response preview',
        callTitle: 'How later code reads this record',
        callHint:
          'Call the exported function in the Host, or the read-only endpoint from another process. The shape matches what this page shows; secretSet says whether a secret is stored.',
        hostApi: 'Host',
        httpApi: 'Endpoint',
        currentData: 'Current record',
        notConfigured: 'Nothing is saved yet, so the values below are connection: null.',
        returnShape: 'Response shape',
        updatedAt: 'Updated',
        createdAt: 'Created',
        storageLabel: 'Storage',
        apiUrlRequired: 'Endpoint URL is required',
        engineCodeRequired: 'EngineCode is required',
        secretRequiredError: 'EngineSecret is required on first save',
        requestFailed: 'Request failed',
        tabUpdate: 'Version',
        updateTitle: 'Version & updates',
        updateHint: 'Check the GitHub repository for a newer version.',
        updateCurrent: 'Current version',
        updateLatest: 'Latest version',
        updateUpToDate: 'Already up to date',
        updateAvailable: 'New version available',
        updateNone: 'No published version yet',
        updateCheck: 'Check for updates',
        updateChecking: 'Checking…',
        updateFailed: 'Check failed',
        updateRelease: 'View release',
        updateUnknown: 'Unknown',
        uniqueNote: 'One record only',
        apiListTitle: 'Registered APIs',
        apiListHint: 'Register API actions on top of this connection; enabled ones later become DSH tools.',
        apiCount: '{n} total',
        back: 'Back',
        editorHint: 'Configure this action on its own page; saving returns to the data-access list.',
        addApi: 'Add API',
        editApi: 'Edit API',
        saveApi: 'Save API',
        deleteApi: 'Delete',
        confirmDeleteApi: 'Confirm delete',
        noApis: 'No APIs registered yet. Click “Add API” to add the first one.',
        fieldApiName: 'Name',
        fieldApiNameHint: 'A human label, e.g. “List departments”',
        fieldActionName: 'ActionName',
        fieldActionNameHint: 'The OpenApi action, e.g. GetServerTime, GetDepartmentList',
        fieldControllerName: 'ControllerName',
        fieldControllerNameHint: 'Optional; most actions do not need it',
        fieldDescription: 'Description',
        fieldDescriptionHint: 'What this action does and returns; later used as the tool description',
        fieldEnabled: 'Enabled',
        enabledHint: 'Enabled APIs are later registered as DSH tools',
        apiNameRequired: 'Name is required',
        actionNameRequired: 'ActionName is required',
        apiSaved: 'API saved',
        apiDeleted: 'API deleted',
        paramsTitle: 'Parameters',
        paramsHint: 'Parameters this action expects; later used as tool inputs.',
        paramName: 'Name',
        paramType: 'Type',
        paramRequired: 'Required',
        addParam: 'Add parameter',
        deleteParam: 'Remove',
        noParams: 'No parameters',
        testApi: 'Test',
        testingApi: 'Testing…',
        testApiTitle: 'Test this action',
        testApiHint: 'Calls it once with the saved credentials; argument values are for this run only.',
        testArgValue: 'Value',
        sendTest: 'Send test',
        testApiResult: 'Result',
      },
    }

    /**
     * Translate through the slot's `t` seat, falling back to the Chinese
     * dictionary so the page never renders raw keys.
     */
    function makeT(props) {
      var seat = props && typeof props.t === 'function' ? props.t : null
      return function (key) {
        if (seat !== null) {
          var value = seat(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        }
        return DICT.zh[key] || key
      }
    }

    var CSS = [
      '.dsh-cy-api-page{box-sizing:border-box;height:100%;overflow:auto;color:var(--dsw-alias-label-primary,#1f2329);font-size:14px;padding:0 clamp(24px,4vw,48px) 48px}',
      '.dsh-cy-api-inner{width:100%;max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:20px}',
      '.dsh-cy-api-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px;flex-wrap:wrap}',
      "[data-platform='darwin'] .dsh-cy-api-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}",
      '.dsh-cy-api-heading{min-width:0;flex:1 1 320px}',
      '.dsh-cy-api-title{margin:0;font-size:20px;font-weight:500;line-height:28px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-cy-api-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-badge{font-size:11px;line-height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary,#3370ff);color:var(--dsw-alias-brand-primary,#3370ff);white-space:nowrap;font-weight:400}',
      '.dsh-cy-api-badge-muted{border-color:var(--dsw-alias-border-l3,#d5d8dc);color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-badge-ok{border-color:var(--dsw-alias-state-success,#2ea121);color:var(--dsw-alias-state-success,#2ea121)}',
      '.dsh-cy-api-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}',
      '.dsh-cy-api-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-secondary,#e5e6eb);overflow-x:auto}',
      '.dsh-cy-api-tab{font:inherit;font-size:13px;line-height:20px;padding:8px 12px;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0;background:transparent;color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer;white-space:nowrap}',
      '.dsh-cy-api-tab:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,41,.06))}',
      '.dsh-cy-api-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#3370ff);outline-offset:-2px}',
      '.dsh-cy-api-tab-active{color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-cy-api-tabpanel{display:flex;flex-direction:column;gap:20px}',
      '.dsh-cy-api-tabpanel:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#3370ff);outline-offset:2px}',
      '.dsh-cy-api-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l3,#d5d8dc);background:transparent;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer;white-space:nowrap}',
      '.dsh-cy-api-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(31,35,41,.06))}',
      '.dsh-cy-api-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-cy-api-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#3370ff);outline-offset:1px}',
      '.dsh-cy-api-btn-primary{background:var(--dsw-alias-brand-primary,#3370ff);border-color:var(--dsw-alias-brand-primary,#3370ff);color:#fff}',
      '.dsh-cy-api-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#3370ff);filter:brightness(1.08)}',
      '.dsh-cy-api-btn-danger{border-color:var(--dsw-alias-state-error,#d83931);color:var(--dsw-alias-state-error,#d83931)}',
      '.dsh-cy-api-btn-danger:hover:not(:disabled){background:transparent}',
      '.dsh-cy-api-btn-sm{padding:2px 8px;font-size:12px;line-height:18px}',
      '.dsh-cy-api-card{border:1px solid var(--dsw-alias-border-secondary,#e5e6eb);border-radius:var(--dsw-radius-md,8px);padding:16px;display:flex;flex-direction:column;gap:14px}',
      '.dsh-cy-api-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.dsh-cy-api-card-title{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-cy-api-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-cy-api-label{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73);display:flex;align-items:center;gap:6px}',
      '.dsh-cy-api-chip{font-size:10px;line-height:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-bg-secondary,#f2f3f5);color:var(--dsw-alias-label-secondary,#646a73);font-weight:400;letter-spacing:.02em}',
      '.dsh-cy-api-input{font:inherit;font-size:13px;line-height:20px;padding:6px 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l3,#d5d8dc);background:transparent;color:var(--dsw-alias-label-primary,#1f2329);width:100%;box-sizing:border-box}',
      '.dsh-cy-api-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#3370ff)}',
      '.dsh-cy-api-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-error{font-size:13px;color:var(--dsw-alias-state-error,#d83931);white-space:pre-wrap;word-break:break-word}',
      '.dsh-cy-api-notice{font-size:13px;color:var(--dsw-alias-state-success,#2ea121)}',
      '.dsh-cy-api-form-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dsh-cy-api-spacer{flex:1 1 auto}',
      '.dsh-cy-api-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-pre{margin:0;max-height:260px;overflow:auto;padding:10px 12px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-secondary,#f5f6f7);font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}',
      '.dsh-cy-api-code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-secondary,#f2f3f5);border-radius:4px;padding:1px 6px;word-break:break-all}',
      '.dsh-cy-api-test{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-secondary,#e5e6eb);padding-top:12px}',
      '.dsh-cy-api-call-row{display:flex;flex-direction:column;gap:4px}',
      '.dsh-cy-api-call-label{font-size:12px;color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-api-list{display:flex;flex-direction:column;gap:8px}',
      '.dsh-cy-api-api-item{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--dsw-alias-border-secondary,#e5e6eb);border-radius:var(--dsw-radius-md,8px);padding:10px 12px}',
      '.dsh-cy-api-api-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dsh-cy-api-api-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-cy-api-api-actions{flex:none;display:flex;gap:6px;align-items:center}',
      '.dsh-cy-api-api-form{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-secondary,#e5e6eb);padding-top:12px}',
      '.dsh-cy-api-checkbox{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}',
      '.dsh-cy-api-chip-off{background:transparent;border:1px solid var(--dsw-alias-border-l3,#d5d8dc);color:var(--dsw-alias-label-secondary,#646a73)}',
      '.dsh-cy-api-json{margin-top:8px;border:1px solid var(--dsw-alias-border-secondary,#e5e6eb);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-secondary,#f5f6f7);padding:8px 0;max-height:320px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:12px;line-height:18px}',
      '.dsh-cy-api-json-row{display:flex;align-items:baseline;white-space:pre;padding:0 12px}',
      '.dsh-cy-api-json-ln{flex:none;width:28px;margin-right:12px;text-align:right;color:var(--dsw-alias-label-secondary,#9aa0a6);user-select:none}',
      '.dsh-cy-api-json-key{color:#0b6bcb}',
      '.dsh-cy-api-json-string{color:#1a7f37}',
      '.dsh-cy-api-json-number{color:#b35900}',
      '.dsh-cy-api-json-bool{color:#8250df}',
      '.dsh-cy-api-json-null{color:var(--dsw-alias-label-secondary,#9aa0a6)}',
      '.dsh-cy-api-json-punct{color:var(--dsw-alias-label-secondary,#646a73)}',
    ].join('')

    function Styles() {
      return h('style', { 'data-dsh-cy-api-style': '' }, CSS)
    }

    function request(method, path, body) {
      var init = { method: method, cache: 'no-store', headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(API + path, init).then(function (response) {
        return response.text().then(function (text) {
          var data = null
          try {
            data = text === '' ? null : JSON.parse(text)
          } catch (error) {
            data = null
          }
          if (!response.ok) {
            throw new Error((data && data.error) || 'HTTP ' + response.status)
          }
          return data
        })
      })
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      var date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    /** Exactly what `GET /dsh-cy-api/api/connection` returns. */
    function readback(data) {
      return JSON.stringify(
        {
          version: data.version,
          storage: data.storage,
          connection: data.connection,
          apis: data.apis,
        },
        null,
        2,
      )
    }

    /** Colorized leaf value for the Pretty JSON view. */
    function jsonLeaf(value) {
      if (value === null) return h('span', { className: 'dsh-cy-api-json-null' }, 'null')
      if (value === undefined) return h('span', { className: 'dsh-cy-api-json-null' }, 'undefined')
      if (typeof value === 'string') return h('span', { className: 'dsh-cy-api-json-string' }, JSON.stringify(value))
      if (typeof value === 'number') return h('span', { className: 'dsh-cy-api-json-number' }, String(value))
      if (typeof value === 'boolean') return h('span', { className: 'dsh-cy-api-json-bool' }, String(value))
      return h('span', null, String(value))
    }

    /**
     * Render a response body the way an API client shows it: if it is JSON, a
     * row-per-line, indented, colorized tree; otherwise a plain text block.
     */
    function responseBodyView(text) {
      if (typeof text !== 'string' || text === '') return null
      var parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return h('pre', { className: 'dsh-cy-api-pre' }, text)
      }
      var rows = []
      function push(depth, nodes) {
        rows.push({ depth: depth, nodes: nodes })
      }
      function walk(value, depth) {
        if (value === null || typeof value !== 'object') {
          push(depth, [jsonLeaf(value)])
          return
        }
        if (Array.isArray(value)) {
          push(depth, [h('span', { className: 'dsh-cy-api-json-punct' }, '[')])
          value.forEach(function (item) {
            walk(item, depth + 1)
          })
          push(depth, [h('span', { className: 'dsh-cy-api-json-punct' }, ']')])
          return
        }
        var keys = Object.keys(value)
        push(depth, [h('span', { className: 'dsh-cy-api-json-punct' }, '{')])
        keys.forEach(function (k) {
          var v = value[k]
          var keyNode = h('span', { className: 'dsh-cy-api-json-key' }, JSON.stringify(k))
          if (v === null || typeof v !== 'object') {
            push(depth + 1, [
              keyNode,
              h('span', { className: 'dsh-cy-api-json-punct' }, ': '),
              jsonLeaf(v),
            ])
          } else {
            push(depth + 1, [keyNode, h('span', { className: 'dsh-cy-api-json-punct' }, ':')])
            walk(v, depth + 1)
          }
        })
        push(depth, [h('span', { className: 'dsh-cy-api-json-punct' }, '}')])
      }
      walk(parsed, 0)
      return h(
        'div',
        { className: 'dsh-cy-api-json' },
        rows.map(function (row, index) {
          return h(
            'div',
            { key: index, className: 'dsh-cy-api-json-row' },
            h('span', { className: 'dsh-cy-api-json-ln' }, String(index + 1)),
            h('span', { style: { paddingLeft: row.depth * 16 } }, row.nodes),
          )
        }),
      )
    }

    function Field(props) {
      return h(
        'div',
        { className: 'dsh-cy-api-field' },
        h(
          'span',
          { className: 'dsh-cy-api-label' },
          props.label,
          h('span', { className: 'dsh-cy-api-chip' }, props.uniqueLabel),
        ),
        props.children,
        props.hint ? h('span', { className: 'dsh-cy-api-hint' }, props.hint) : null,
      )
    }

    function CyApiPage(props) {
      var t = makeT(props)
      var _data = useState({ version: '', storage: '', connection: null })
      var data = _data[0]
      var setData = _data[1]
      var _loading = useState(true)
      var loading = _loading[0]
      var setLoading = _loading[1]
      var _error = useState('')
      var error = _error[0]
      var setError = _error[1]
      var _notice = useState('')
      var notice = _notice[0]
      var setNotice = _notice[1]
      var _busy = useState('')
      var busy = _busy[0]
      var setBusy = _busy[1]
      var _form = useState({ apiUrl: '', engineCode: '', engineSecret: '' })
      var form = _form[0]
      var setForm = _form[1]
      var _confirm = useState(false)
      var confirmClear = _confirm[0]
      var setConfirmClear = _confirm[1]
      var _test = useState(null)
      var testResult = _test[0]
      var setTestResult = _test[1]
      var _tab = useState(lastTab)
      var tab = _tab[0]
      var setTab = _tab[1]
      var _apiForm = useState(null)
      var apiForm = _apiForm[0]
      var setApiForm = _apiForm[1]
      var _apiBusy = useState(false)
      var apiBusy = _apiBusy[0]
      var setApiBusy = _apiBusy[1]
      var _confirmDeleteId = useState('')
      var confirmDeleteId = _confirmDeleteId[0]
      var setConfirmDeleteId = _confirmDeleteId[1]
      var _testingId = useState('')
      var testingId = _testingId[0]
      var setTestingId = _testingId[1]
      var _testArgs = useState({})
      var testArgs = _testArgs[0]
      var setTestArgs = _testArgs[1]
      var _apiTestResult = useState(null)
      var apiTestResult = _apiTestResult[0]
      var setApiTestResult = _apiTestResult[1]
      var _apiTestBusy = useState(false)
      var apiTestBusy = _apiTestBusy[0]
      var setApiTestBusy = _apiTestBusy[1]

      var _versionInfo = useState(null)
      var versionInfo = _versionInfo[0]
      var setVersionInfo = _versionInfo[1]
      var _versionBusy = useState(false)
      var versionBusy = _versionBusy[0]
      var setVersionBusy = _versionBusy[1]
      var _versionError = useState('')
      var versionError = _versionError[0]
      var setVersionError = _versionError[1]

      var connection = data.connection

      function selectTab(next) {
        lastTab = next
        setTab(next)
      }

      var applyPayload = useCallback(function (payload) {
        setData(payload)
        setForm({
          apiUrl: payload.connection === null ? '' : payload.connection.apiUrl,
          engineCode: payload.connection === null ? '' : payload.connection.engineCode,
          engineSecret: '',
        })
      }, [])

      var load = useCallback(function () {
        setLoading(true)
        return request('GET', '/connection')
          .then(function (payload) {
            applyPayload(payload)
            setError('')
          })
          .catch(function (cause) {
            setError(cause.message)
          })
          .then(function () {
            setLoading(false)
          })
      }, [applyPayload])

      useEffect(function () {
        load()
      }, [load])

      function checkUpdate() {
        if (versionBusy) return
        setVersionBusy(true)
        setVersionError('')
        request('GET', '/version')
          .then(function (payload) {
            setVersionInfo(payload)
          })
          .catch(function (cause) {
            setVersionError(cause.message)
          })
          .then(function () {
            setVersionBusy(false)
          })
      }

      // 切到“版本更新”页签时自动检查一次；之后可手动点击“检查更新”重查。
      useEffect(function () {
        if (tab === 'update' && versionInfo === null && !versionBusy && versionError === '') {
          checkUpdate()
        }
      }, [tab, versionInfo, versionBusy, versionError])

      function patch(patchValue) {
        setForm(function (current) {
          return Object.assign({}, current, patchValue)
        })
      }

      function save() {
        if (form.apiUrl.trim() === '') {
          setError(t('apiUrlRequired'))
          return
        }
        if (form.engineCode.trim() === '') {
          setError(t('engineCodeRequired'))
          return
        }
        if (connection === null && form.engineSecret.trim() === '') {
          setError(t('secretRequiredError'))
          return
        }
        setBusy('save')
        setError('')
        setNotice('')
        request('POST', '/connection', form)
          .then(function (payload) {
            applyPayload(payload)
            setNotice(t('saved'))
            setTestResult(null)
          })
          .catch(function (cause) {
            setError(cause.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function runTest() {
        setBusy('test')
        setError('')
        setNotice('')
        setTestResult(null)
        request('POST', '/connection/test', form)
          .then(function (result) {
            setTestResult(result)
          })
          .catch(function (cause) {
            setTestResult({ ok: false, message: cause.message })
          })
          .then(function () {
            setBusy('')
          })
      }

      function clearConnection() {
        setBusy('clear')
        setError('')
        setNotice('')
        request('DELETE', '/connection')
          .then(function (payload) {
            applyPayload(payload)
            setConfirmClear(false)
            setNotice(t('cleared'))
            setTestResult(null)
          })
          .catch(function (cause) {
            setError(cause.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function blankApiForm() {
        return { id: '', name: '', appCode: '', actionName: '', controllerName: '', description: '', enabled: true, params: [] }
      }

      function patchApiForm(patchValue) {
        setApiForm(function (current) {
          if (current === null) return current
          return Object.assign({}, current, patchValue)
        })
      }

      function patchParam(index, patchValue) {
        setApiForm(function (current) {
          if (current === null || !Array.isArray(current.params)) return current
          var params = current.params.slice()
          var next = Object.assign({}, params[index] || {}, patchValue)
          params[index] = next
          return Object.assign({}, current, { params: params })
        })
      }

      function addParam() {
        setApiForm(function (current) {
          if (current === null) return current
          var params = (Array.isArray(current.params) ? current.params : []).slice()
          params.push({ name: '', type: 'string', required: false })
          return Object.assign({}, current, { params: params })
        })
      }

      function removeParam(index) {
        setApiForm(function (current) {
          if (current === null || !Array.isArray(current.params)) return current
          return Object.assign({}, current, { params: current.params.filter(function (_, at) { return at !== index }) })
        })
      }

      function saveApiForm() {
        if (apiForm === null) return
        if (apiForm.name.trim() === '') {
          setError(t('apiNameRequired'))
          return
        }
        if (apiForm.actionName.trim() === '') {
          setError(t('actionNameRequired'))
          return
        }
        setApiBusy(true)
        setError('')
        setNotice('')
        request('POST', '/apis', apiForm)
          .then(function (payload) {
            setData(payload)
            setApiForm(null)
            setNotice(t('apiSaved'))
          })
          .catch(function (cause) {
            setError(cause.message)
          })
          .then(function () {
            setApiBusy(false)
          })
      }

      function deleteApi(id) {
        setApiBusy(true)
        setError('')
        setNotice('')
        request('DELETE', '/apis', { id: id })
          .then(function (payload) {
            setData(payload)
            setConfirmDeleteId('')
            setNotice(t('apiDeleted'))
          })
          .catch(function (cause) {
            setError(cause.message)
          })
          .then(function () {
            setApiBusy(false)
          })
      }

      function openApiTest(api) {
        setConfirmDeleteId('')
        setApiForm(null)
        setApiTestResult(null)
        var seed = {}
        ;(Array.isArray(api.params) ? api.params : []).forEach(function (p) {
          seed[p.name] = ''
        })
        setTestArgs(seed)
        setTestingId(api.id)
      }

      function runApiTest(id) {
        setApiTestBusy(true)
        setError('')
        setApiTestResult(null)
        request('POST', '/apis/test', { id: id, args: testArgs })
          .then(function (result) {
            setApiTestResult(result)
          })
          .catch(function (cause) {
            setApiTestResult({ ok: false, message: cause.message })
          })
          .then(function () {
            setApiTestBusy(false)
          })
      }

      function onTabsKeyDown(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        var index = 0
        for (var at = 0; at < TABS.length; at += 1) {
          if (TABS[at].id === tab) index = at
        }
        var step = event.key === 'ArrowRight' ? 1 : TABS.length - 1
        selectTab(TABS[(index + step) % TABS.length].id)
      }

      // --- 版本更新页签 -------------------------------------------------
      function updatePanel() {
        var info = versionInfo
        var currentText =
          info !== null && typeof info.currentVersion === 'string' && info.currentVersion !== ''
            ? info.currentVersion
            : data.version !== ''
              ? data.version
              : t('updateUnknown')

        var statusNode = null
        if (versionError !== '') {
          statusNode = h('div', { className: 'dsh-cy-api-error' }, t('updateFailed') + '：' + versionError)
        } else if (info !== null) {
          if (info.error) {
            statusNode = h('div', { className: 'dsh-cy-api-error' }, t('updateFailed') + '：' + info.error)
          } else if (info.latestVersion === null) {
            statusNode = h('div', { className: 'dsh-cy-api-notice' }, t('updateNone'))
          } else if (info.hasUpdate) {
            statusNode = h(
              'div',
              { className: 'dsh-cy-api-notice' },
              t('updateAvailable') + '：' + t('versionPrefix') + info.latestVersion,
              info.releaseUrl
                ? h(
                    'a',
                    {
                      className: 'dsh-cy-api-link',
                      href: info.releaseUrl,
                      target: '_blank',
                      rel: 'noreferrer',
                      style: { marginLeft: '8px', color: 'var(--dsw-alias-label-link,#0b6bcb)' },
                    },
                    t('updateRelease'),
                  )
                : null,
            )
          } else {
            statusNode = h(
              'div',
              { className: 'dsh-cy-api-hint' },
              t('updateUpToDate') +
                (info.latestVersion ? '（' + t('versionPrefix') + info.latestVersion + '）' : ''),
            )
          }
        }

        return h(
          'div',
          { className: 'dsh-cy-api-card' },
          h(
            'div',
            { className: 'dsh-cy-api-card-head' },
            h('div', { className: 'dsh-cy-api-card-title' }, t('updateTitle')),
            h('span', { className: 'dsh-cy-api-hint' }, t('updateHint')),
          ),
          h(
            'div',
            { className: 'dsh-cy-api-call-row' },
            h(
              'span',
              { className: 'dsh-cy-api-call-label' },
              t('updateCurrent') + '：' + t('versionPrefix') + currentText,
            ),
          ),
          statusNode,
          h(
            'div',
            { className: 'dsh-cy-api-form-actions' },
            h(
              'button',
              {
                className: 'dsh-cy-api-btn',
                disabled: versionBusy,
                onClick: checkUpdate,
              },
              versionBusy ? t('updateChecking') : t('updateCheck'),
            ),
          ),
        )
      }

      // --- 接口配置页签 -------------------------------------------------
      function connectionPanel() {
        return h(
          'div',
          { className: 'dsh-cy-api-card' },
          h(
            'div',
            { className: 'dsh-cy-api-card-head' },
            h('div', { className: 'dsh-cy-api-card-title' }, t('sectionTitle')),
            h('span', { className: 'dsh-cy-api-hint' }, connection === null ? t('empty') : t('uniqueNote')),
          ),
          h('span', { className: 'dsh-cy-api-hint' }, t('sectionHint')),

          h(
            Field,
            { label: t('fieldApiUrl'), uniqueLabel: t('unique'), hint: t('fieldApiUrlHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: form.apiUrl,
              placeholder: 'https://www.h3yun.com/OpenApi/Invoke',
              spellCheck: false,
              onChange: function (event) {
                patch({ apiUrl: event.target.value })
              },
            }),
          ),

          h(
            Field,
            { label: t('fieldEngineCode'), uniqueLabel: t('unique'), hint: t('fieldEngineCodeHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: form.engineCode,
              spellCheck: false,
              onChange: function (event) {
                patch({ engineCode: event.target.value })
              },
            }),
          ),

          h(
            Field,
            { label: t('fieldEngineSecret'), uniqueLabel: t('unique'), hint: t('fieldEngineSecretHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              type: 'password',
              value: form.engineSecret,
              autoComplete: 'new-password',
              placeholder: connection !== null && connection.secretSet ? t('secretKeep') : t('secretRequired'),
              onChange: function (event) {
                patch({ engineSecret: event.target.value })
              },
            }),
          ),

          h(
            'div',
            { className: 'dsh-cy-api-form-actions' },
            confirmClear
              ? h(
                  'span',
                  { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } },
                  h(
                    'button',
                    {
                      className: 'dsh-cy-api-btn dsh-cy-api-btn-sm dsh-cy-api-btn-danger',
                      disabled: busy !== '',
                      onClick: clearConnection,
                    },
                    t('confirmClear'),
                  ),
                  h(
                    'button',
                    {
                      className: 'dsh-cy-api-btn dsh-cy-api-btn-sm',
                      onClick: function () {
                        setConfirmClear(false)
                      },
                    },
                    t('cancel'),
                  ),
                )
              : h(
                  'button',
                  {
                    className: 'dsh-cy-api-btn dsh-cy-api-btn-sm dsh-cy-api-btn-danger',
                    disabled: busy !== '' || connection === null,
                    onClick: function () {
                      setConfirmClear(true)
                    },
                  },
                  t('clear'),
                ),
            h('span', { className: 'dsh-cy-api-spacer' }),
            h(
              'button',
              { className: 'dsh-cy-api-btn', disabled: busy !== '', onClick: runTest },
              busy === 'test' ? t('testing') : t('test'),
            ),
            h(
              'button',
              { className: 'dsh-cy-api-btn dsh-cy-api-btn-primary', disabled: busy !== '', onClick: save },
              busy === 'save' ? t('saving') : t('save'),
            ),
          ),

          testResult !== null
            ? h(
                'div',
                { className: 'dsh-cy-api-test' },
                testResult.status === undefined
                  ? h('div', { className: 'dsh-cy-api-error' }, t('requestFailed') + '：' + testResult.message)
                  : h(
                      'div',
                      null,
                      h(
                        'div',
                        { className: 'dsh-cy-api-meta' },
                        h('span', null, t('statusText') + ' ' + testResult.status),
                        h('span', null, t('duration') + ' ' + testResult.durationMs + 'ms'),
                      ),
                      h(
                        'div',
                        {
                          className: testResult.ok ? 'dsh-cy-api-notice' : 'dsh-cy-api-error',
                          style: { marginTop: '6px' },
                        },
                        (testResult.ok ? '✓ ' : '✗ ') + testResult.message,
                      ),
                      testResult.responsePreview
                        ? h(
                            'div',
                            { style: { marginTop: '8px' } },
                            h('div', { className: 'dsh-cy-api-call-label' }, t('responseTitle')),
                            responseBodyView(testResult.responsePreview),
                          )
                        : null,
                    ),
              )
            : null,
        )
      }

      // --- 数据调用页签：接口登记表 -------------------------------------
      function apiFormField() {
        if (apiForm === null) return null
        return h(
          'div',
          { className: 'dsh-cy-api-api-form' },
          h(
            'div',
            { className: 'dsh-cy-api-card-title' },
            apiForm.id === '' ? t('addApi') : t('editApi'),
          ),
          h(
            Field,
            { label: t('fieldApiName'), hint: t('fieldApiNameHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: apiForm.name,
              spellCheck: false,
              onChange: function (event) {
                patchApiForm({ name: event.target.value })
              },
            }),
          ),
          h(
            Field,
            { label: t('fieldAppCode'), hint: t('fieldAppCodeHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: apiForm.appCode,
              spellCheck: false,
              onChange: function (event) {
                patchApiForm({ appCode: event.target.value })
              },
            }),
          ),
          h(
            Field,
            { label: t('fieldActionName'), hint: t('fieldActionNameHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: apiForm.actionName,
              spellCheck: false,
              onChange: function (event) {
                patchApiForm({ actionName: event.target.value })
              },
            }),
          ),
          h(
            Field,
            { label: t('fieldControllerName'), hint: t('fieldControllerNameHint') },
            h('input', {
              className: 'dsh-cy-api-input',
              value: apiForm.controllerName,
              spellCheck: false,
              onChange: function (event) {
                patchApiForm({ controllerName: event.target.value })
              },
            }),
          ),
          h(
            Field,
            { label: t('fieldDescription'), hint: t('fieldDescriptionHint') },
            h('textarea', {
              className: 'dsh-cy-api-input',
              rows: 3,
              value: apiForm.description,
              onChange: function (event) {
                patchApiForm({ description: event.target.value })
              },
            }),
          ),
          h(
            'label',
            { className: 'dsh-cy-api-checkbox' },
            h('input', {
              type: 'checkbox',
              checked: apiForm.enabled,
              onChange: function (event) {
                patchApiForm({ enabled: event.target.checked })
              },
            }),
            t('fieldEnabled'),
            h('span', { className: 'dsh-cy-api-hint' }, t('enabledHint')),
          ),
          h(
            'div',
            { className: 'dsh-cy-api-field' },
            h('span', { className: 'dsh-cy-api-label' }, t('paramsTitle')),
            h('span', { className: 'dsh-cy-api-hint' }, t('paramsHint')),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              (Array.isArray(apiForm.params) ? apiForm.params : []).map(function (param, index) {
                return h(
                  'div',
                  { key: index, style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('input', {
                    className: 'dsh-cy-api-input',
                    style: { flex: '2 1 140px' },
                    placeholder: t('paramName'),
                    value: param.name,
                    spellCheck: false,
                    onChange: function (event) {
                      patchParam(index, { name: event.target.value })
                    },
                  }),
                  h('input', {
                    className: 'dsh-cy-api-input',
                    style: { flex: '1 1 90px' },
                    placeholder: t('paramType'),
                    value: param.type,
                    spellCheck: false,
                    onChange: function (event) {
                      patchParam(index, { type: event.target.value })
                    },
                  }),
                  h(
                    'label',
                    { className: 'dsh-cy-api-checkbox', style: { flex: 'none' } },
                    h('input', {
                      type: 'checkbox',
                      checked: param.required === true,
                      onChange: function (event) {
                        patchParam(index, { required: event.target.checked })
                      },
                    }),
                    t('paramRequired'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-cy-api-btn dsh-cy-api-btn-sm dsh-cy-api-btn-danger',
                      onClick: function () {
                        removeParam(index)
                      },
                    },
                    t('deleteParam'),
                  ),
                )
              }),
              h(
                'div',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-cy-api-btn dsh-cy-api-btn-sm',
                    onClick: addParam,
                  },
                  t('addParam'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-cy-api-form-actions' },
            h(
              'button',
              {
                className: 'dsh-cy-api-btn',
                disabled: apiBusy,
                onClick: function () {
                  setApiForm(null)
                },
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                className: 'dsh-cy-api-btn dsh-cy-api-btn-primary',
                disabled: apiBusy,
                onClick: saveApiForm,
              },
              t('saveApi'),
            ),
          ),
        )
      }

      function dataPanel() {
        var apis = Array.isArray(data.apis) ? data.apis : []
        return h(
          'div',
          { className: 'dsh-cy-api-card', style: { gap: '16px' } },
          h(
            'div',
            { className: 'dsh-cy-api-card-head' },
            h(
              'div',
              { className: 'dsh-cy-api-card-title' },
              t('apiListTitle'),
              h('span', { className: 'dsh-cy-api-chip' }, t('apiCount').replace('{n}', String(apis.length))),
            ),
            apiForm === null
              ? h(
                  'button',
                  {
                    className: 'dsh-cy-api-btn dsh-cy-api-btn-sm',
                    disabled: apiBusy,
                    onClick: function () {
                      setConfirmDeleteId('')
                      setApiForm(blankApiForm())
                    },
                  },
                  t('addApi'),
                )
              : null,
          ),
          h('span', { className: 'dsh-cy-api-hint' }, t('apiListHint')),

          apis.length === 0 && apiForm === null
            ? h('div', { className: 'dsh-cy-api-hint' }, t('noApis'))
            : h(
                'div',
                { className: 'dsh-cy-api-api-list' },
                apis.map(function (api) {
                  var isConfirming = confirmDeleteId === api.id
                  var isTesting = testingId === api.id
                  var resultBlock = null
                  if (isTesting && apiTestResult !== null) {
                    var r = apiTestResult
                    resultBlock = h(
                      'div',
                      { style: { marginTop: '6px' } },
                      h(
                        'div',
                        { className: 'dsh-cy-api-meta' },
                        typeof r.status === 'number' ? h('span', null, t('statusText') + ' ' + r.status) : null,
                        typeof r.durationMs === 'number' ? h('span', null, t('duration') + ' ' + r.durationMs + 'ms') : null,
                      ),
                      h(
                        'div',
                        {
                          className: r.ok ? 'dsh-cy-api-notice' : 'dsh-cy-api-error',
                          style: { marginTop: '6px' },
                        },
                        (r.ok ? '✓ ' : '✗ ') + (r.message || ''),
                      ),
                      responseBodyView(r.responsePreview),
                    )
                  }
                  return h(
                    'div',
                    { key: api.id },
                    h(
                      'div',
                      { className: 'dsh-cy-api-api-item' },
                      h(
                        'div',
                        { className: 'dsh-cy-api-api-main' },
                        h(
                          'span',
                          { className: 'dsh-cy-api-api-name' },
                          api.name,
                          h(
                            'span',
                            {
                              className:
                                'dsh-cy-api-chip' + (api.enabled ? '' : ' dsh-cy-api-chip-off'),
                            },
                            api.enabled ? '✓' : '○',
                          ),
                        ),
                        h(
                          'code',
                          { className: 'dsh-cy-api-code' },
                          'ActionName=' + api.actionName + (api.controllerName !== '' ? ' · Controller=' + api.controllerName : ''),
                        ),
                        (Array.isArray(api.params) && api.params.length > 0)
                          ? h(
                              'div',
                              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                              api.params.map(function (param, at) {
                                return h(
                                  'span',
                                  { key: at, className: 'dsh-cy-api-chip' },
                                  (param.required ? '*' : '') + param.name + '：' + (param.type || 'string'),
                                )
                              }),
                            )
                          : h('span', { className: 'dsh-cy-api-hint' }, t('noParams')),
                        api.description !== ''
                          ? h('span', { className: 'dsh-cy-api-hint' }, api.description)
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'dsh-cy-api-api-actions' },
                        h(
                          'button',
                          {
                            className: 'dsh-cy-api-btn dsh-cy-api-btn-sm',
                            disabled: apiBusy || apiTestBusy,
                            onClick: function () {
                              openApiTest(api)
                            },
                          },
                          isTesting && apiTestBusy ? t('testingApi') : t('testApi'),
                        ),
                        h(
                          'button',
                          {
                            className: 'dsh-cy-api-btn dsh-cy-api-btn-sm',
                            disabled: apiBusy,
                            onClick: function () {
                              setConfirmDeleteId('')
                              setApiForm({
                                id: api.id,
                                name: api.name,
                                appCode: api.appCode || '',
                                actionName: api.actionName,
                                controllerName: api.controllerName,
                                description: api.description,
                                enabled: api.enabled !== false,
                                params: (Array.isArray(api.params) ? api.params : []).map(function (p) {
                                  return { name: p.name, type: p.type || 'string', required: p.required === true }
                                }),
                              })
                            },
                          },
                          t('editApi'),
                        ),
                        isConfirming
                          ? h(
                              'button',
                              {
                                className: 'dsh-cy-api-btn dsh-cy-api-btn-sm dsh-cy-api-btn-danger',
                                disabled: apiBusy,
                                onClick: function () {
                                  deleteApi(api.id)
                                },
                              },
                              t('confirmDeleteApi'),
                            )
                          : h(
                              'button',
                              {
                                className: 'dsh-cy-api-btn dsh-cy-api-btn-sm dsh-cy-api-btn-danger',
                                disabled: apiBusy,
                                onClick: function () {
                                  setApiForm(null)
                                  setConfirmDeleteId(api.id)
                                },
                              },
                              t('deleteApi'),
                            ),
                      ),
                    ),
                    isTesting
                      ? h(
                          'div',
                          { className: 'dsh-cy-api-api-form' },
                          h('div', { className: 'dsh-cy-api-card-title' }, t('testApiTitle')),
                          h('span', { className: 'dsh-cy-api-hint' }, t('testApiHint')),
                          (Array.isArray(api.params) ? api.params : []).map(function (p, index) {
                            return h(
                              'div',
                              { className: 'dsh-cy-api-field', key: index },
                              h(
                                'span',
                                { className: 'dsh-cy-api-label' },
                                p.name,
                                p.required ? h('span', { className: 'dsh-cy-api-chip' }, '*必填') : null,
                              ),
                              h('input', {
                                className: 'dsh-cy-api-input',
                                value: typeof testArgs[p.name] === 'string' ? testArgs[p.name] : '',
                                placeholder: p.type || t('testArgValue'),
                                spellCheck: false,
                                onChange: function (event) {
                                  var next = Object.assign({}, testArgs)
                                  next[p.name] = event.target.value
                                  setTestArgs(next)
                                },
                              }),
                            )
                          }),
                          h(
                            'div',
                            { className: 'dsh-cy-api-form-actions' },
                            h(
                              'button',
                              {
                                className: 'dsh-cy-api-btn dsh-cy-api-btn-primary',
                                disabled: apiTestBusy,
                                onClick: function () {
                                  runApiTest(api.id)
                                },
                              },
                              apiTestBusy ? t('testingApi') : t('sendTest'),
                            ),
                          ),
                          resultBlock,
                        )
                      : null,
                  )
                }),
              ),

          // 保留：宿主侧如何读这份唯一连接凭据
          h('div', { className: 'dsh-cy-api-call-row' },
            h('span', { className: 'dsh-cy-api-call-label' }, t('hostApi')),
            h('code', { className: 'dsh-cy-api-code' }, "import { readConnection, resolveCredentials } from 'dsh-cy-api/index.js'"),
          ),
          h('div', { className: 'dsh-cy-api-call-row' },
            h('span', { className: 'dsh-cy-api-call-label' }, t('httpApi')),
            h('code', { className: 'dsh-cy-api-code' }, 'GET /dsh-cy-api/api/connection'),
          ),

          connection === null ? h('div', { className: 'dsh-cy-api-hint' }, t('notConfigured')) : null,

          h(
            'div',
            { className: 'dsh-cy-api-call-row' },
            h('span', { className: 'dsh-cy-api-call-label' }, t('currentData') + ' · ' + t('returnShape')),
            h('pre', { className: 'dsh-cy-api-pre' }, readback(data)),
          ),
        )
      }

      // --- 独立编辑页：新增 / 编辑接口的全屏页面，不在列表里展开 ---
      function editorPage() {
        var isAdd = apiForm === null || apiForm.id === ''
        return h(
          'div',
          { className: 'dsh-cy-api-page' },
          h(Styles, null),
          h(
            'div',
            { className: 'dsh-cy-api-inner' },
            h(
              'div',
              { className: 'dsh-cy-api-head' },
              h(
                'div',
                { className: 'dsh-cy-api-heading' },
                h(
                  'h1',
                  { className: 'dsh-cy-api-title' },
                  isAdd ? t('addApi') : t('editApi'),
                  h('span', { className: 'dsh-cy-api-badge dsh-cy-api-badge-muted' }, t('globalBadge')),
                ),
                h('p', { className: 'dsh-cy-api-intro' }, t('editorHint')),
              ),
              h(
                'div',
                { className: 'dsh-cy-api-actions' },
                h(
                  'button',
                  {
                    className: 'dsh-cy-api-btn',
                    disabled: apiBusy,
                    onClick: function () {
                      setApiForm(null)
                    },
                  },
                  t('back'),
                ),
              ),
            ),
            error !== '' ? h('div', { className: 'dsh-cy-api-error' }, error) : null,
            notice !== '' ? h('div', { className: 'dsh-cy-api-notice' }, notice) : null,
            apiFormField(),
          ),
        )
      }

      var statusBadge =
        connection !== null
          ? h('span', { className: 'dsh-cy-api-badge dsh-cy-api-badge-ok' }, t('configured'))
          : h('span', { className: 'dsh-cy-api-badge dsh-cy-api-badge-muted' }, t('empty'))

      // 新增 / 编辑接口时，整个面板切换成独立编辑页；保存后自动回到数据调用页。
      if (apiForm !== null) return editorPage()

      var activeTab = tab === 'data' ? 'data' : tab === 'update' ? 'update' : 'connection'

      return h(
        'div',
        { className: 'dsh-cy-api-page' },
        h(Styles, null),
        h(
          'div',
          { className: 'dsh-cy-api-inner' },

          // --- 页头 ---
          h(
            'div',
            { className: 'dsh-cy-api-head' },
            h(
              'div',
              { className: 'dsh-cy-api-heading' },
              h(
                'h1',
                { className: 'dsh-cy-api-title' },
                t('title'),
                data.version !== ''
                  ? h('span', { className: 'dsh-cy-api-badge' }, t('versionPrefix') + data.version)
                  : null,
                h('span', { className: 'dsh-cy-api-badge dsh-cy-api-badge-muted' }, t('globalBadge')),
                h('span', { className: 'dsh-cy-api-badge dsh-cy-api-badge-muted' }, t('fixedBadge')),
                statusBadge,
              ),
              h('p', { className: 'dsh-cy-api-intro' }, t('intro')),
            ),
            h(
              'div',
              { className: 'dsh-cy-api-actions' },
              h(
                'button',
                {
                  className: 'dsh-cy-api-btn',
                  disabled: loading,
                  onClick: function () {
                    load()
                  },
                },
                t('refresh'),
              ),
            ),
          ),

          error !== '' ? h('div', { className: 'dsh-cy-api-error' }, error) : null,
          notice !== '' ? h('div', { className: 'dsh-cy-api-notice' }, notice) : null,
          loading && connection === null ? h('div', { className: 'dsh-cy-api-hint' }, t('loading')) : null,

          // --- 顶部导航：标签按钮切换页面 ---
          h(
            'div',
            {
              className: 'dsh-cy-api-tabs',
              role: 'tablist',
              'aria-label': t('tabsLabel'),
              onKeyDown: onTabsKeyDown,
            },
            TABS.map(function (item) {
              var active = activeTab === item.id
              return h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  id: 'dsh-cy-api-tab-' + item.id,
                  'aria-selected': active ? 'true' : 'false',
                  'aria-controls': 'dsh-cy-api-panel-' + item.id,
                  tabIndex: active ? 0 : -1,
                  className: 'dsh-cy-api-tab' + (active ? ' dsh-cy-api-tab-active' : ''),
                  onClick: function () {
                    selectTab(item.id)
                  },
                },
                t(item.labelKey),
              )
            }),
          ),

          // --- 当前页签的内容 ---
          h(
            'div',
            {
              className: 'dsh-cy-api-tabpanel',
              role: 'tabpanel',
              id: 'dsh-cy-api-panel-' + activeTab,
              'aria-labelledby': 'dsh-cy-api-tab-' + activeTab,
              tabIndex: 0,
            },
            activeTab === 'update'
              ? updatePanel()
              : activeTab === 'data'
                ? dataPanel()
                : connectionPanel(),
          ),
        ),
      )
    }

    function CyApiPanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 64 64',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M24 17 L10 32 L24 47' }),
        h('path', { d: 'M40 17 L54 32 L40 47' }),
        h('path', { d: 'M26 32 H38' }),
        h('path', { d: 'M33 26 L39 32 L33 38' }),
      )
    }

    var inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT)
      }, 'dsh-cy-api: dictionaries')
      var t = ctx.locale.bind(NS)

      // Global page: the main panel is root-scoped and keyed by PANEL_ID.
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          CyApiPage,
        )
      })

      // The sidebar entry that opens it. Same id addresses the main panel.
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: function () {
              return t('panel')
            },
            locale: NS,
          },
          CyApiPanelIcon,
        )
      })
    }

    return { inject: inject, apply: apply }
  },
})
