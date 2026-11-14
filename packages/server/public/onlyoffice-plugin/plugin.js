/* EAB OnlyOffice 插件：先做连接、上下文和只读结构读取，写操作留给内容层工具。 */
(() => {
  'use strict'

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const queryParams = new URLSearchParams(window.location.search)
  const rawToken = hashParams.get('token') || queryParams.get('token') || ''
  // OnlyOffice 会追加 ?lang=...；即使拼到 hash 里，也只取第一个 ? 前的 token。
  let token = rawToken.split('?')[0]
  const statusEl = document.getElementById('status')
  const statusTextEl = statusEl ? statusEl.querySelector('span') : null
  const docTitleEl = document.getElementById('doc-title')
  const metaEl = document.getElementById('meta')
  const logEl = document.getElementById('log')
  const phaseEl = document.getElementById('phase')
  const saveButton = document.getElementById('save')
  const readButton = document.getElementById('read')
  const refreshButton = document.getElementById('refresh')
  const reopenButton = document.getElementById('reopen')
  const locateInput = document.getElementById('locate-query')
  const locateButton = document.getElementById('locate')
  const highlightButton = document.getElementById('highlight')
  const trackToggleButton = document.getElementById('track-toggle')
  const revisionsReadButton = document.getElementById('revisions-read')
  const revisionsAcceptButton = document.getElementById('revisions-accept')
  const revisionsRejectButton = document.getElementById('revisions-reject')
  const reviewSummaryEl = document.getElementById('review-summary')
  const reviewSection = document.getElementById('review-section')
  const cellSection = document.getElementById('cell-section')
  const cellSummaryEl = document.getElementById('cell-summary')
  const cellReplaceInput = document.getElementById('cell-replace-value')
  const cellReplaceButton = document.getElementById('cell-replace')
  const slideSection = document.getElementById('slide-section')
  const slideSummaryEl = document.getElementById('slide-summary')
  const slideReadButton = document.getElementById('slide-read')

  let context = null
  let busy = false
  let lastRecoverableStatus = 0
  let trackRevisionsOn = false
  let documentType = 'word'
  let selectedCellAddress = ''
  // 保存成功后当前编辑器仍挂在旧 version 上，再点保存会被服务端按冲突拒绝。
  // 保存成功后交给顶层页面刷新为查看态并重新进入编辑；这里先锁住按钮避免重复提交。
  let documentSaved = false
  // 插件通过 Api 写入单元格时，OnlyOffice 的协同会话可能尚未登记修改；
  // 记下本地脏标记，保存遇到 no_changes 时短暂等待后重试。
  let documentDirty = false

  function setStatus(state, text) {
    if (!statusEl || !statusTextEl) return
    statusEl.dataset.state = state
    statusTextEl.textContent = text
  }

  function setPhase(text) {
    if (phaseEl) phaseEl.textContent = text
  }

  function syncHighlightEnabled() {
    if (highlightButton) highlightButton.disabled = !(context && context.canEdit)
  }

  function syncSaveEnabled() {
    if (saveButton) saveButton.disabled = !(context && context.canEdit) || documentSaved
  }

  function syncCellReplaceEnabled() {
    if (!cellReplaceButton) return
    cellReplaceButton.disabled = !(
      documentType === 'cell' &&
      context &&
      context.canEdit &&
      selectedCellAddress &&
      cellReplaceInput &&
      cellReplaceInput.value.trim()
    )
  }

  function applyEditorMode() {
    const isCell = documentType === 'cell'
    const isSlide = documentType === 'slide'
    if (reviewSection) reviewSection.hidden = isCell || isSlide
    if (cellSection) cellSection.hidden = !isCell
    if (slideSection) slideSection.hidden = !isSlide
    if (highlightButton) highlightButton.hidden = isCell || isSlide
    if (readButton) {
      readButton.textContent = isCell ? '读取工作表' : isSlide ? '读取幻灯片' : '读取文档结构'
    }
    if (locateInput) {
      locateInput.placeholder = isCell
        ? '查找单元格值并选中…'
        : isSlide
          ? '查找幻灯片文本并选中…'
          : '定位文本并选中…'
      locateInput.disabled = !context
    }
    if (locateButton) locateButton.textContent = isCell || isSlide ? '查找并选中' : '定位'
    if (cellReplaceInput) {
      cellReplaceInput.hidden = !isCell
      cellReplaceInput.disabled = !(context && context.canEdit)
    }
    if (cellReplaceButton) cellReplaceButton.hidden = !isCell
    if (cellSummaryEl && isCell && context) cellSummaryEl.textContent = '未读取'
    if (slideSummaryEl && isSlide && context) slideSummaryEl.textContent = '未读取'
    if (slideReadButton) slideReadButton.disabled = !context
    syncCellReplaceEnabled()
  }

  function renderTrackState() {
    if (!trackToggleButton) return
    trackToggleButton.setAttribute('aria-pressed', trackRevisionsOn ? 'true' : 'false')
    trackToggleButton.textContent = trackRevisionsOn ? '修订已开启' : '开启修订'
  }

  function syncReviewEnabled() {
    const canEdit = Boolean(context && context.canEdit)
    if (trackToggleButton) {
      trackToggleButton.disabled = !canEdit
      trackToggleButton.title = canEdit
        ? '开启后新的文本修改会写入修订标记；关闭后不再新增修订'
        : '仅编辑模式可用；只读模式不能开启修订'
    }
    if (revisionsAcceptButton) revisionsAcceptButton.disabled = !canEdit
    if (revisionsRejectButton) revisionsRejectButton.disabled = !canEdit
    if (revisionsReadButton) revisionsReadButton.disabled = !context
    if (!context && reviewSummaryEl) reviewSummaryEl.textContent = '未读取'
  }

  function setReviewSummary(label) {
    if (reviewSummaryEl) reviewSummaryEl.textContent = label
  }

  function sdkReady() {
    return Boolean(
      window.Asc && window.Asc.plugin && typeof window.Asc.plugin.callCommand === 'function',
    )
  }

  function runReviewCommand(source, phase, timeoutMs, done) {
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能处理修订。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    let command
    try {
      command = new Function(source)
    } catch (error) {
      addLog('修订参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    if (trackToggleButton) trackToggleButton.disabled = true
    if (revisionsReadButton) revisionsReadButton.disabled = true
    if (revisionsAcceptButton) revisionsAcceptButton.disabled = true
    if (revisionsRejectButton) revisionsRejectButton.disabled = true
    setPhase(phase)
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      syncReviewEnabled()
      setPhase('ERROR')
      addLog('编辑器未返回修订结果', '命令已发送，但 5 秒内没有收到 OnlyOffice 回调。', 'error')
    }, timeoutMs || 5000)
    window.Asc.plugin.callCommand(command, false, false, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      syncReviewEnabled()
      done(result)
    })
  }

  function nowLabel() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }

  function addLog(title, detail, kind) {
    if (!logEl) return
    const empty = logEl.querySelector('.empty')
    if (empty) empty.remove()
    const entry = document.createElement('div')
    entry.className = `entry${kind === 'error' ? ' error' : ''}`
    const heading = document.createElement('b')
    heading.textContent = title
    const time = document.createElement('time')
    time.textContent = nowLabel()
    entry.append(heading, time)
    if (detail) {
      const body = document.createElement('p')
      body.textContent = detail
      entry.append(body)
    }
    logEl.prepend(entry)
    while (logEl.children.length > 18) logEl.lastElementChild.remove()
  }

  function renderMeta(items) {
    if (!metaEl) return
    metaEl.replaceChildren()
    for (const item of items) {
      const chip = document.createElement('span')
      chip.className = `chip${item.hot ? ' hot' : ''}`
      chip.textContent = item.label
      metaEl.append(chip)
    }
  }

  async function loadContext() {
    if (busy) return
    if (!token) {
      setStatus('error', '未绑定')
      if (docTitleEl) docTitleEl.textContent = '缺少插件令牌'
      addLog('插件未绑定文档', '刷新 EAB 预览后重新打开文档。', 'error')
      return
    }
    busy = true
    documentSaved = false
    documentDirty = false
    setStatus('loading', '连接中')
    setPhase('CONTEXT')
    setReviewSummary('未读取')
    lastRecoverableStatus = 0
    if (reopenButton) reopenButton.hidden = true
    try {
      const response = await fetch(
        `/api/workspace/office/plugin/context?token=${encodeURIComponent(token)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || !payload.ok) {
        const requestError = new Error((payload && payload.message) || `HTTP ${response.status}`)
        requestError.status = response.status
        throw requestError
      }
      context = payload.data
      documentType =
        context.documentType === 'cell'
          ? 'cell'
          : context.documentType === 'slide'
            ? 'slide'
            : 'word'
      lastRecoverableStatus = 0
      if (docTitleEl) docTitleEl.textContent = context.name || '未命名文档'
      renderMeta([
        { label: context.canEdit ? '可编辑' : '只读', hot: Boolean(context.canEdit) },
        { label: context.previewKind === 'office' ? 'OnlyOffice' : String(context.previewKind || '未知') },
        { label: `${context.agentOps ? context.agentOps.length : 0} 项 Agent 操作` },
      ])
      applyEditorMode()
      setStatus('ready', '已连接')
      setPhase('READY')
      addLog('已连接 EAB', `${context.name || '文档'} · ${context.mode || 'view'} 模式`)
      if (reopenButton) reopenButton.hidden = true
      if (readButton) readButton.disabled = false
      if (locateInput) locateInput.disabled = false
      if (locateButton) locateButton.disabled = false
      if (highlightButton) syncHighlightEnabled()
      if (saveButton) syncSaveEnabled()
      syncReviewEnabled()
      renderTrackState()
    } catch (error) {
      context = null
      syncReviewEnabled()
      const status = Number(error && error.status) || 0
      lastRecoverableStatus = status === 403 || status === 409 ? status : 0
      if (status === 403) {
        setStatus('error', '令牌已过期')
        setPhase('RECOVER')
        addLog(
          '插件令牌已过期',
          '插件令牌只有 10 分钟有效期。点“重新打开预览”让 EAB 关闭当前编辑器并签发新令牌；未保存的修改会丢失，请先保存。',
          'error',
        )
      } else if (status === 409) {
        setStatus('error', '版本已更新')
        setPhase('RECOVER')
        addLog(
          '云端文档已更新',
          '当前编辑器仍是打开时的旧版本。点“重新打开预览”加载最新内容；不要在这个旧版本上继续编辑。',
          'error',
        )
      } else {
        setStatus('error', '连接失败')
        setPhase('ERROR')
        addLog('连接 EAB 失败', String(error && error.message ? error.message : error), 'error')
      }
      if (reopenButton) reopenButton.hidden = lastRecoverableStatus === 0
      if (readButton) readButton.disabled = true
      if (slideReadButton) slideReadButton.disabled = true
      if (locateInput) locateInput.disabled = true
      if (locateButton) locateButton.disabled = true
      if (highlightButton) highlightButton.disabled = true
      if (saveButton) saveButton.disabled = true
    } finally {
      busy = false
    }
  }

  function readPresentation() {
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能读取幻灯片。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    if (readButton) readButton.disabled = true
    if (slideReadButton) slideReadButton.disabled = true
    setPhase('SLIDES')
    let settled = false
    const finish = function () {
      if (readButton) readButton.disabled = false
      if (slideReadButton) slideReadButton.disabled = !context
    }
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      finish()
      setPhase('ERROR')
      addLog('幻灯片读取未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    const source =
      'var presentation=Api.GetPresentation();' +
      'var slides=presentation.GetAllSlides()||[];' +
      'var total=slides.length;var shapesTotal=0;var textShapes=0;var preview=[];' +
      'function textOf(shape){try{' +
      'var content=shape&&shape.GetContent?shape.GetContent():null;if(!content)return "";' +
      'if(typeof content.GetText==="function")return String(content.GetText()||"");' +
      'var n=content.GetElementsCount?Number(content.GetElementsCount()||0):0;var parts=[];' +
      'for(var i=0;i<n;i++){try{var el=content.GetElement(i);' +
      'if(el&&typeof el.GetText==="function")parts.push(String(el.GetText()||""));}catch(e){}}' +
      'return parts.join("\\n");' +
      '}catch(e){return "";}}' +
      'for(var s=0;s<total&&s<20;s++){' +
      'var shapes=slides[s].GetAllShapes?slides[s].GetAllShapes():[];shapesTotal+=shapes.length;' +
      'var texts=[];' +
      'for(var j=0;j<shapes.length;j++){var text=textOf(shapes[j]).replace(/\\s+/g," ").trim();' +
      'if(text){textShapes++;texts.push(text.slice(0,100));}}' +
      'preview.push({slide:s+1,shapes:shapes.length,texts:texts.slice(0,4),more:Math.max(0,texts.length-4)});}' +
      'return JSON.stringify({ok:true,slides:total,shapes:shapesTotal,textShapes:textShapes,preview:preview});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      finish()
      setPhase('ERROR')
      addLog('幻灯片读取参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    window.Asc.plugin.callCommand(command, false, false, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
      let values = result || {}
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch {
          values = { ok: false, raw: values }
        }
      }
      if (!values.ok) {
        setPhase('ERROR')
        if (slideSummaryEl) slideSummaryEl.textContent = '读取失败'
        addLog('幻灯片读取失败', String(values.message || values.raw || '编辑器没有返回数据。'), 'error')
        return
      }
      const slideCount = Number(values.slides) || 0
      const shapeCount = Number(values.shapes) || 0
      const textShapeCount = Number(values.textShapes) || 0
      const preview = Array.isArray(values.preview) ? values.preview : []
      const lines = preview
        .map(function (item) {
          const texts = Array.isArray(item.texts) ? item.texts : []
          return `第 ${item.slide} 页 · ${item.shapes || 0} 个形状：${texts.join(' / ') || '无文本'}` +
            (item.more ? ` 等 ${item.more} 段` : '')
        })
        .join('\n')
      if (slideSummaryEl) {
        slideSummaryEl.textContent = `${slideCount} 页 · ${shapeCount} 个形状 · ${textShapeCount} 个文本形状`
      }
      setPhase('READY')
      addLog(
        '幻灯片已读取',
        `${slideCount} 页 · ${shapeCount} 个形状 · ${textShapeCount} 个文本形状` +
          (lines ? `\n${lines}` : ''),
      )
    })
  }

  function locateSlideText() {
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能定位幻灯片文本。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    const query = locateInput ? locateInput.value.trim() : ''
    if (!query) {
      addLog('请输入查找内容', '在输入框中填入要查找的幻灯片文本，再点“查找并选中”。')
      if (locateInput) locateInput.focus()
      return
    }
    if (locateButton) locateButton.disabled = true
    setPhase('SLIDE FIND')
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('幻灯片查找未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    const source =
      'var q=' +
      JSON.stringify(query) +
      ';var presentation=Api.GetPresentation();var slides=presentation.GetAllSlides()||[];' +
      'function textOf(shape){try{' +
      'var content=shape&&shape.GetContent?shape.GetContent():null;if(!content)return "";' +
      'if(typeof content.GetText==="function")return String(content.GetText()||"");' +
      'var n=content.GetElementsCount?Number(content.GetElementsCount()||0):0;var parts=[];' +
      'for(var i=0;i<n;i++){try{var el=content.GetElement(i);' +
      'if(el&&typeof el.GetText==="function")parts.push(String(el.GetText()||""));}catch(e){}}' +
      'return parts.join("\\n");' +
      '}catch(e){return "";}}' +
      'for(var s=0;s<slides.length;s++){var shapes=slides[s].GetAllShapes?slides[s].GetAllShapes():[];' +
      'for(var j=0;j<shapes.length;j++){var text=textOf(shapes[j]);' +
      'if(text.indexOf(q)>=0){var navigated=false;var selected=false;var slide=slides[s];' +
      'try{if(typeof presentation.GoToSlide==="function"){presentation.GoToSlide(s+1);navigated=true;}' +
      'else if(typeof Api.GoToSlide==="function"){Api.GoToSlide(s+1);navigated=true;}' +
      'else if(slide&&typeof slide.Select==="function"){slide.Select();navigated=true;}}catch(e){}' +
      'try{if(typeof shapes[j].Select==="function"){shapes[j].Select(true);selected=true;}}catch(e){}' +
      'return JSON.stringify({ok:true,found:1,slide:s+1,shape:j+1,navigated:navigated,selected:selected,' +
      'text:text.replace(/\\s+/g," ").slice(0,200)});}}}' +
      'return JSON.stringify({ok:true,found:0,query:q});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('幻灯片查找参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    window.Asc.plugin.callCommand(command, false, false, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (locateButton) locateButton.disabled = false
      let values = result || {}
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch {
          values = { ok: false, raw: values }
        }
      }
      if (!values.ok || !values.found) {
        setPhase('READY')
        addLog('未找到幻灯片文本', `“${query}”没有匹配。`, 'error')
        return
      }
      if (slideSummaryEl) {
        slideSummaryEl.textContent = `已选中第 ${values.slide} 页 · 形状 ${values.shape}`
      }
      setPhase('READY')
      addLog(
        '已定位幻灯片文本',
        `第 ${values.slide} 页 · 形状 ${values.shape}` +
          (values.navigated ? ' · 已跳转' : ' · 未能跳转') +
          (values.selected ? ' · 已选中形状' : ' · 未能选中') +
          (values.text ? `；${values.text}` : ''),
      )
    })
  }

  function readWorksheet() {
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能读取工作表。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    if (readButton) readButton.disabled = true
    setPhase('SHEET')
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (readButton) readButton.disabled = false
      setPhase('ERROR')
      addLog('工作表读取未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    const source =
      'var sheet=Api.GetActiveSheet();' +
      'var name=String(sheet.GetName?sheet.GetName():"未知工作表");' +
      'var range=sheet.GetRange("A1:F12");var values=range.GetValue()||[];' +
      'var rows=values.length,cols=0,nonEmpty=0;' +
      'for(var r=0;r<rows;r++){var row=values[r]||[];if(row.length>cols)cols=row.length;' +
      'for(var c=0;c<row.length;c++){if(String(row[c]||"").trim())nonEmpty++;}}' +
      'return JSON.stringify({ok:true,name:name,address:"A1:F12",rows:rows,columns:cols,nonEmpty:nonEmpty,values:values});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      if (readButton) readButton.disabled = false
      setPhase('ERROR')
      addLog('工作表读取参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    window.Asc.plugin.callCommand(command, false, false, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (readButton) readButton.disabled = false
      let values = result || {}
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch {
          values = { ok: false, raw: values }
        }
      }
      if (!values.ok) {
        setPhase('ERROR')
        addLog('工作表读取失败', String(values.message || values.raw || '编辑器没有返回数据。'), 'error')
        return
      }
      const rows = Array.isArray(values.values) ? values.values : []
      const preview = rows.slice(0, 3).map(function (row) {
        return (Array.isArray(row) ? row : []).slice(0, 6).map(function (cell) {
          return String(cell === null || cell === undefined ? '' : cell)
        }).join(' | ')
      }).filter(Boolean).join('\n')
      if (cellSummaryEl) cellSummaryEl.textContent = `${values.name || '工作表'} · ${values.rows || 0}×${values.columns || 0}`
      setPhase('READY')
      addLog(
        '工作表已读取',
        `${values.name || '工作表'} · ${values.address || 'A1:F12'} · 非空 ${values.nonEmpty || 0} 格` +
          (preview ? `\n${preview}` : ''),
      )
    })
  }

  function locateCell() {
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能查找单元格。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    const query = locateInput ? locateInput.value.trim() : ''
    if (!query) {
      addLog('请输入查找内容', '在输入框中填入要查找的单元格值，再点“查找并选中”。')
      if (locateInput) locateInput.focus()
      return
    }
    if (locateButton) locateButton.disabled = true
    setPhase('CELL FIND')
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('单元格查找未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    const source =
      'var q=' +
      JSON.stringify(query) +
      ';var sheet=Api.GetActiveSheet();var found=null;' +
      'for(var r=1;r<=20&&!found;r++){for(var c=1;c<=8;c++){' +
      'var addr=String.fromCharCode(64+c)+r;var cell=sheet.GetRange(addr);' +
      'var value=cell.GetValue();var text=String(value===null||value===undefined?"":value);' +
      'if(text.indexOf(q)>=0){found={address:addr,value:text};cell.Select();break;}}}' +
      'return JSON.stringify(found?{ok:true,found:1,address:found.address,value:found.value.slice(0,120)}:' +
      '{ok:true,found:0,query:q});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('单元格查找参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    window.Asc.plugin.callCommand(command, false, false, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (locateButton) locateButton.disabled = false
      let values = result || {}
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch {
          values = { ok: false, raw: values }
        }
      }
      if (!values.ok || !values.found) {
        selectedCellAddress = ''
        syncCellReplaceEnabled()
        setPhase('READY')
        addLog('未找到单元格', `“${query}”在前 20×8 区域内没有匹配。`, 'error')
        return
      }
      selectedCellAddress = String(values.address || '')
      if (cellSummaryEl) cellSummaryEl.textContent = `已选中 ${selectedCellAddress}`
      syncCellReplaceEnabled()
      setPhase('READY')
      addLog(
        '已选中单元格',
        `${selectedCellAddress} · ${String(values.value || '').slice(0, 120)}`,
      )
    })
  }

  function replaceSelectedCell() {
    if (!context || !context.canEdit) {
      addLog('只读模式不能替换', '右上角切换到“编辑”后再操作。', 'error')
      return
    }
    if (!selectedCellAddress) {
      addLog('请先查找并选中单元格', '先输入查找内容并点“查找并选中”，再替换。', 'error')
      return
    }
    const replacement = cellReplaceInput ? cellReplaceInput.value : ''
    if (!replacement) {
      addLog('请输入替换内容', '在“替换选中的值…”中输入新值。', 'error')
      if (cellReplaceInput) cellReplaceInput.focus()
      return
    }
    if (!sdkReady()) {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能替换。', 'error')
      return
    }
    if (cellReplaceButton) cellReplaceButton.disabled = true
    setPhase('CELL REPLACE')
    const address = selectedCellAddress
    const source =
      'var sheet=Api.GetActiveSheet();var range=sheet.GetRange(' +
      JSON.stringify(address) +
      ');range.SetValue(' +
      JSON.stringify(replacement) +
      ');return JSON.stringify({ok:true,address:' +
      JSON.stringify(address) +
      ',value:String(range.GetValue()||"")});'
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      syncCellReplaceEnabled()
      setPhase('ERROR')
      addLog('替换未返回', '命令已发送，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      syncCellReplaceEnabled()
      setPhase('ERROR')
      addLog('替换参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    window.Asc.plugin.callCommand(command, false, true, function (result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      syncCellReplaceEnabled()
      let values = result || {}
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch {
          values = { ok: false, raw: values }
        }
      }
      if (!values.ok) {
        setPhase('ERROR')
        addLog('替换失败', String(values.message || values.raw || '编辑器没有返回成功结果。'), 'error')
        return
      }
      if (cellSummaryEl) cellSummaryEl.textContent = `已替换 ${values.address || address}`
      documentDirty = true
      setPhase('READY')
      addLog(
        '单元格已替换',
        `${values.address || address} → ${String(values.value || '').slice(0, 120)}；保存或关闭预览后回写云空间。`,
      )
    })
  }

  function requestReopenPreview() {
    if (window.top === window) {
      addLog('请重新打开预览', '当前插件不在 EAB 编辑器内，请回到 EAB 关闭并重新打开这份文档。', 'error')
      return
    }
    if (reopenButton) {
      reopenButton.disabled = true
      reopenButton.textContent = '正在请求…'
    }
    setStatus('loading', '等待重开')
    setPhase('REOPEN')
    addLog('已请求重新打开预览', 'EAB 将关闭当前编辑器、重新签发插件令牌，然后加载云端最新版本。')
    try {
      window.top.postMessage({ type: 'eab:onlyoffice:reopen' }, '*')
    } catch (error) {
      addLog('请求重新打开失败', String(error && error.message ? error.message : error), 'error')
    }
    setTimeout(function () {
      if (reopenButton) {
        reopenButton.disabled = false
        reopenButton.textContent = '重新打开预览'
      }
      if (lastRecoverableStatus) {
        setStatus('error', lastRecoverableStatus === 403 ? '令牌已过期' : '版本已更新')
        setPhase('RECOVER')
      }
    }, 2500)
  }

  function readDocumentStructure() {
    if (documentType === 'cell') {
      readWorksheet()
      return
    }
    if (documentType === 'slide') {
      readPresentation()
      return
    }
    if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.callCommand !== 'function') {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能调用文档 API。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    if (readButton) readButton.disabled = true
    setPhase('DOC API')
    var settled = false
    var timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (readButton) readButton.disabled = false
      setPhase('ERROR')
      addLog('文档 API 未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    window.Asc.plugin.callCommand(
      function () {
        var doc = Api.GetDocument()
        var count = doc.GetElementsCount()
        var first = ''
        if (count > 0) {
          try {
            first = String(doc.GetElement(0).GetText() || '')
          } catch (error) {
            first = ''
          }
        }
        return { elements: count, firstText: first.slice(0, 160) }
      },
      false,
      false,
      function (result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (readButton) readButton.disabled = false
        setPhase('READY')
        var values = result || {}
        addLog(
          '文档结构已读取',
          `顶层元素 ${values.elements === undefined ? '未知' : values.elements} 个` +
            (values.firstText ? `；首段：${values.firstText}` : ''),
        )
      },
    )
  }

  function locateText() {
    if (documentType === 'cell') {
      locateCell()
      return
    }
    if (documentType === 'slide') {
      locateSlideText()
      return
    }
    if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.callCommand !== 'function') {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能定位。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    const query = locateInput ? locateInput.value.trim() : ''
    if (!query) {
      addLog('请输入定位文本', '在输入框中填入要查找的文字，再点“定位”。')
      if (locateInput) locateInput.focus()
      return
    }
    if (locateButton) locateButton.disabled = true
    setPhase('LOCATE')
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('定位未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    // 查询文本用 JSON 字面量嵌入函数源码，避免把插件页变量带进编辑器上下文。
    const source =
      'var q=' +
      JSON.stringify(query) +
      ';var doc=Api.GetDocument();var ranges=doc.Search(q,true);' +
      'if(!ranges||!ranges.length)return JSON.stringify({found:0,query:q});' +
      'var first=ranges[0];first.Select();' +
      'return JSON.stringify({found:ranges.length,query:q,page:first.GetStartPage()+1,text:String(first.GetText()||"").slice(0,120)});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('定位参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    try {
      window.Asc.plugin.callCommand(command, false, false, function (result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (locateButton) locateButton.disabled = false
        let values = result || {}
        if (typeof values === 'string') {
          try {
            values = JSON.parse(values)
          } catch {
            values = { found: 0, raw: values }
          }
        }
        if (!values.found) {
          setPhase('READY')
          addLog('未找到定位文本', `“${query}”没有匹配。`, 'error')
          return
        }
        setPhase('READY')
        addLog(
          '已定位并选中文本',
          `第 ${values.page || '?'} 页 · 命中 ${values.found} 处` +
            (values.text ? `；内容：${values.text}` : ''),
        )
      })
    } catch (error) {
      clearTimeout(timer)
      settled = true
      if (locateButton) locateButton.disabled = false
      setPhase('ERROR')
      addLog('定位调用失败', String(error && error.message ? error.message : error), 'error')
    }
  }

  function highlightText() {
    if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.callCommand !== 'function') {
      addLog('插件 SDK 未就绪', 'OnlyOffice 的 plugins.js 没有加载，暂时不能高亮。', 'error')
      setStatus('error', 'SDK 未就绪')
      return
    }
    if (!context || !context.canEdit) {
      setPhase('READY')
      addLog('只读模式不能高亮', '右上角切换到“编辑”后再使用高亮；高亮会修改文档格式。', 'error')
      return
    }
    const query = locateInput ? locateInput.value.trim() : ''
    if (!query) {
      addLog('请输入高亮文本', '在输入框中填入要查找的文字，再点“高亮全部命中”。')
      if (locateInput) locateInput.focus()
      return
    }
    if (locateButton) locateButton.disabled = true
    if (highlightButton) highlightButton.disabled = true
    setPhase('HIGHLIGHT')
    let settled = false
    const finish = function () {
      if (locateButton) locateButton.disabled = false
      syncHighlightEnabled()
    }
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      finish()
      setPhase('ERROR')
      addLog('高亮未返回', '已发送 callCommand，但 5 秒内没有收到编辑器回调。', 'error')
    }, 5000)
    const source =
      'var q=' +
      JSON.stringify(query) +
      ';var doc=Api.GetDocument();var ranges=doc.Search(q,true);' +
      'if(!ranges||!ranges.length)return JSON.stringify({found:0,query:q});' +
      'var pages=[];var highlighted=0;var errors=0;' +
      'for(var i=0;i<ranges.length;i++){try{ranges[i].SetHighlight("yellow");highlighted++;' +
      'var p=ranges[i].GetStartPage()+1;if(pages.indexOf(p)<0)pages.push(p);}catch(e){errors++;}}' +
      'if(highlighted>0)ranges[0].Select();' +
      'return JSON.stringify({found:ranges.length,highlighted:highlighted,errors:errors,pages:pages,' +
      'text:String(ranges[0].GetText()||"").slice(0,120)});'
    let command
    try {
      command = new Function(source)
    } catch (error) {
      clearTimeout(timer)
      settled = true
      finish()
      setPhase('ERROR')
      addLog('高亮参数无效', String(error && error.message ? error.message : error), 'error')
      return
    }
    try {
      window.Asc.plugin.callCommand(command, false, false, function (result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        finish()
        let values = result || {}
        if (typeof values === 'string') {
          try {
            values = JSON.parse(values)
          } catch {
            values = { found: 0, raw: values }
          }
        }
        if (!values.found) {
          setPhase('READY')
          addLog('未找到高亮文本', `“${query}”没有匹配。`, 'error')
          return
        }
        if (!values.highlighted) {
          setPhase('ERROR')
          addLog('高亮没有应用', '编辑器返回了命中范围，但没有任何一段被标记。', 'error')
          return
        }
        setPhase('READY')
        const pages = Array.isArray(values.pages) && values.pages.length
          ? `第 ${values.pages.join('、')} 页 · `
          : ''
        addLog(
          '已高亮全部命中',
          `${pages}命中 ${values.found} 处，已标记 ${values.highlighted} 处` +
            (values.errors ? `；${values.errors} 处未能标记` : '') +
            '。点击“保存到云空间”可立即回写；关闭预览时 OnlyOffice 也会触发保存回调。',
        )
      })
    } catch (error) {
      clearTimeout(timer)
      settled = true
      finish()
      setPhase('ERROR')
      addLog('高亮调用失败', String(error && error.message ? error.message : error), 'error')
    }
  }

  function toggleTrackRevisions() {
    if (!context || !context.canEdit) {
      addLog('只读模式不能开启修订', '右上角切换到“编辑”后再操作。', 'error')
      return
    }
    const next = !trackRevisionsOn
    const source =
      'var doc=Api.GetDocument();' +
      'if(typeof doc.SetTrackRevisions!=="function")return JSON.stringify({ok:false,unsupported:true});' +
      'try{var ret=doc.SetTrackRevisions(' +
      (next ? 'true' : 'false') +
      ');return JSON.stringify({ok:true,ret:ret===true});}' +
      'catch(error){return JSON.stringify({ok:false,message:String(error&&error.message?error.message:error)});}'
    runReviewCommand(source, next ? 'TRACK ON' : 'TRACK OFF', 5000, function (result) {
      let values = result
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch (error) {
          values = null
        }
      }
      if (!values || values.ok !== true) {
        setPhase('ERROR')
        addLog(
          '修订开关未生效',
          values && values.unsupported
            ? '当前编辑器没有 ApiDocument.SetTrackRevisions；需要人工在 OnlyOffice 编辑器的“审阅”中开启修订。'
            : String((values && values.message) || '编辑器没有返回成功结果。'),
          'error',
        )
        return
      }
      trackRevisionsOn = next
      renderTrackState()
      setPhase('READY')
      addLog(
        next ? '修订已开启' : '修订已关闭',
        next
          ? '之后由 Agent 或插件写入的文本修改会显示为插入/删除修订；保存前可读取或接受/拒绝。'
          : '之后不会再新增修订；已有修订仍然保留，需要时点“接受全部”或“拒绝全部”。',
      )
    })
  }

  function readRevisions(done) {
    if (!context) {
      addLog('尚未连接文档', '先刷新上下文或重新打开预览。', 'error')
      return
    }
    const source =
      'var doc=Api.GetDocument();' +
      'if(typeof doc.GetReviewReport!=="function")return JSON.stringify({ok:false,unsupported:true});' +
      'var report=doc.GetReviewReport()||{};' +
      'var groups=[];' +
      'if(Array.isArray(report)){' +
      'for(var i=0;i<report.length;i++){var g=report[i]||{};' +
      'groups.push({author:String(g.author||g.Author||"未知作者"),list:g.reviews||g.Reviews||[]});}' +
      '}else{' +
      'for(var name in report){if(!Object.prototype.hasOwnProperty.call(report,name))continue;' +
      'var list=report[name];if(!Array.isArray(list))continue;groups.push({author:String(name),list:list});}' +
      '}' +
      'var total=0,authors=[],sample=[];' +
      'for(var gi=0;gi<groups.length;gi++){' +
      'var g=groups[gi]||{};var list=g.list||[];total+=list.length;' +
      'authors.push({author:String(g.author||"未知作者"),count:list.length});' +
      'for(var j=0;j<list.length&&sample.length<8;j++){var r=list[j]||{};' +
      'sample.push({author:String(g.author||g.Author||"未知作者"),type:String(r.Type||r.type||"未知"),' +
      'date:String(r.Date||r.date||""),value:String(r.Value||r.value||"").slice(0,80)});}}' +
      'return JSON.stringify({ok:true,total:total,authors:authors,sample:sample});'
    runReviewCommand(source, 'REVISIONS', 5000, function (result) {
      let values = result
      if (typeof values === 'string') {
        try {
          values = JSON.parse(values)
        } catch (error) {
          values = null
        }
      }
      if (!values || values.ok !== true) {
        setPhase('ERROR')
        setReviewSummary('读取失败')
        addLog(
          '修订读取失败',
          values && values.unsupported
            ? '当前编辑器没有 ApiDocument.GetReviewReport；请在编辑器的“审阅”面板查看修订。'
            : String((values && values.message) || '编辑器没有返回修订报告。'),
          'error',
        )
        return
      }
      const total = Number(values.total) || 0
      const authors = Array.isArray(values.authors) ? values.authors : []
      const sample = Array.isArray(values.sample) ? values.sample : []
      setPhase('READY')
      setReviewSummary(total > 0 ? `${total} 处 · ${authors.length} 位作者` : '无修订')
      const detail =
        total > 0
          ? `${authors.map((author) => `${author.author} ${author.count} 处`).join('；')}。` +
            (sample.length
              ? `\n${sample
                  .map((item) => `${item.author} · ${item.type}${item.value ? `：${item.value}` : ''}`)
                  .join('\n')}`
              : '')
          : '当前文档没有插入/删除修订。'
      addLog(total > 0 ? '修订已读取' : '没有修订', detail)
      if (typeof done === 'function') done(total)
    })
  }

  function resolveAllRevisions(accept) {
    if (!context || !context.canEdit) {
      addLog('只读模式不能处理修订', '右上角切换到“编辑”后再操作。', 'error')
      return
    }
    if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.executeMethod !== 'function') {
      addLog('插件 SDK 未就绪', '不能调用接受/拒绝修订；请在编辑器“审阅”面板人工处理。', 'error')
      return
    }
    const method = accept ? 'AcceptReviewChanges' : 'RejectReviewChanges'
    const label = accept ? '接受全部修订' : '拒绝全部修订'
    if (trackToggleButton) trackToggleButton.disabled = true
    if (revisionsReadButton) revisionsReadButton.disabled = true
    if (revisionsAcceptButton) revisionsAcceptButton.disabled = true
    if (revisionsRejectButton) revisionsRejectButton.disabled = true
    setPhase('REVIEW')
    addLog(`正在${label}`, '已向 OnlyOffice 发送请求；稍后自动重新读取修订报告核对。')
    try {
      // 官方文档示例：executeMethod("AcceptReviewChanges", [true])，不依赖回调。
      window.Asc.plugin.executeMethod(method, [true])
      setTimeout(function () {
        syncReviewEnabled()
        readRevisions(function (remaining) {
          if (remaining === 0) {
            setPhase('READY')
            addLog(`已${label}`, '修订报告已归零；如需继续记录修改，请重新开启修订。')
            return
          }
          setPhase('READY')
          addLog(
            `${label}请求已发送，仍有修订`,
            `当前修订报告还有 ${remaining} 处；可能是编辑器尚未处理完，或部分修订不在可接受范围。请再点“读取修订”确认。`,
            'error',
          )
        })
      }, 1200)
    } catch (error) {
      syncReviewEnabled()
      setPhase('ERROR')
      addLog(
        `${label}调用失败`,
        String(error && error.message ? error.message : error) +
          '；可在 OnlyOffice 编辑器的“审阅”面板人工处理。',
        'error',
      )
    }
  }

  /**
   * 通知顶层 EAB 页面保存已完成。插件在 OnlyOffice 的跨域 iframe 里，不能直接
   * 操作 chat.js 的预览状态；顶层收到后抬高 refresh-guard，再切回查看态。
   */
  function notifySavedToParent(data) {
    const fileId = context && context.fileId ? String(context.fileId) : ''
    if (!fileId) return
    try {
      window.top.postMessage(
        {
          type: 'eab:onlyoffice:saved',
          fileId,
          documentType,
          updatedAt: Number(data.updatedAt) || 0,
          size: Number(data.size) || 0,
        },
        '*',
      )
    } catch {
      // 顶层页面不可用时保持当前编辑器；日志已提示用户手动刷新。
    }
  }

  async function saveDocument() {
    if (!context || !context.canEdit) {
      setPhase('READY')
      addLog('只读模式不能保存', '右上角切换到“编辑”后再保存。', 'error')
      return
    }
    if (!token) {
      addLog('缺少插件令牌', '刷新 EAB 预览后重新打开文档。', 'error')
      return
    }
    if (saveButton) saveButton.disabled = true
    setPhase('SAVE')
    const delay = function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms)
      })
    }
    async function postForceSave() {
      const controller = new AbortController()
      const timer = setTimeout(function () {
        controller.abort()
      }, 10000)
      try {
        const response = await fetch('/api/workspace/office/plugin/force-save', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || !payload.ok) {
          const requestError = new Error((payload && payload.message) || `HTTP ${response.status}`)
          requestError.status = response.status
          throw requestError
        }
        return payload.data || {}
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      let attempt = 0
      while (attempt < 3) {
        // 插件替换是 Api 侧写入，OnlyOffice 需要一点时间把这次修改登记到
        // 协同会话；立即 forcesave 会得到 error=4（no changes）。
        if (documentDirty) await delay(attempt === 0 ? 900 : 1200)
        const data = await postForceSave()
        if (data.state === 'no_changes' && documentDirty && attempt < 2) {
          attempt += 1
          setPhase('SYNC')
          addLog('等待编辑器登记修改', `第 ${attempt + 1} 次确认保存…`)
          continue
        }
        if (data.state === 'no_changes') {
          setPhase('READY')
          addLog('没有需要保存的修改', data.message || '编辑器内容与云空间一致。')
          return
        }
        if (data.state === 'saved') {
          documentDirty = false
          documentSaved = true
          if (saveButton) saveButton.disabled = true
          setPhase('READY')
          addLog(
            '已保存到云空间',
            `版本 ${data.updatedAt || '未知'} · ${data.size || 0} 字节；正在切换到查看态，如需继续编辑请重新进入编辑。`,
          )
          notifySavedToParent(data)
          return
        }
        setPhase('READY')
        addLog(
          '保存请求已发送',
          `${data.message || '等待 OnlyOffice 回调'}；稍后可再点一次“保存到云空间”确认结果。`,
        )
        return
      }
    } catch (error) {
      const status = Number(error && error.status) || 0
      if (status === 403 || status === 409) {
        context = null
        lastRecoverableStatus = status
        setStatus('error', status === 403 ? '令牌已过期' : '版本已更新')
        setPhase('RECOVER')
        addLog(
          status === 403 ? '保存失败：插件令牌已过期' : '保存失败：云端已有新版本',
          '这个编辑器不能安全回写。点“重新打开预览”加载云端最新版本后再继续编辑。',
          'error',
        )
        if (reopenButton) reopenButton.hidden = false
      } else {
        setPhase('ERROR')
        const message = error && error.name === 'AbortError'
          ? '保存请求超时，编辑器可能仍在处理；请稍后重试。'
          : String(error && error.message ? error.message : error)
        addLog('保存到云空间失败', message, 'error')
      }
    } finally {
      if (saveButton) syncSaveEnabled()
    }
  }

  if (refreshButton) refreshButton.addEventListener('click', loadContext)
  if (reopenButton) reopenButton.addEventListener('click', requestReopenPreview)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return
    if (!lastRecoverableStatus || context || !token) return
    addLog('重新校验上下文', '插件页恢复可见，正在确认令牌和文档版本。')
    loadContext()
  })
  if (saveButton) saveButton.addEventListener('click', saveDocument)
  if (readButton) readButton.addEventListener('click', readDocumentStructure)
  if (slideReadButton) slideReadButton.addEventListener('click', readPresentation)
  if (trackToggleButton) trackToggleButton.addEventListener('click', toggleTrackRevisions)
  if (revisionsReadButton) revisionsReadButton.addEventListener('click', readRevisions)
  if (revisionsAcceptButton) revisionsAcceptButton.addEventListener('click', function () { resolveAllRevisions(true) })
  if (revisionsRejectButton) revisionsRejectButton.addEventListener('click', function () { resolveAllRevisions(false) })
  if (locateButton) locateButton.addEventListener('click', locateText)
  if (highlightButton) highlightButton.addEventListener('click', highlightText)
  if (cellReplaceButton) cellReplaceButton.addEventListener('click', replaceSelectedCell)
  if (cellReplaceInput) {
    cellReplaceInput.addEventListener('input', syncCellReplaceEnabled)
    cellReplaceInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        replaceSelectedCell()
      }
    })
  }
  if (locateInput) {
    locateInput.addEventListener('input', function () {
      if (documentType !== 'cell') return
      selectedCellAddress = ''
      syncCellReplaceEnabled()
    })
    locateInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        locateText()
      }
    })
  }

  // 先做一次独立握手，避免 SDK 初始化消息延迟时面板一直停在“连接中”。
  // init 回调里只在尚未拿到上下文时再请求一次，刷新按钮仍然强制重取。
  loadContext()

  // OnlyOffice 会调用这个入口；如果 SDK 没加载，页面仍然保持可读的错误状态。
  if (window.Asc && window.Asc.plugin) {
    window.Asc.plugin.init = function () {
      addLog('OnlyOffice 插件已启动', '正在校验文档绑定。')
      if (!context) loadContext()
    }
  } else {
    setStatus('error', 'SDK 未加载')
    addLog('OnlyOffice 插件 SDK 未加载', '检查文档服务器到 onlyoffice.github.io 的网络，或改用本地 SDK。', 'error')
  }
})()
