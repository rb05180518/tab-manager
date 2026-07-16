# 实施计划:四项功能改造

## 需求总览
1. **不再接管新标签页** — 新开 tab 恢复 Chrome 默认;点击工具栏图标才打开 Tab Out
2. **顶部搜索框** — 扁平列表式跨域名搜索打开的标签页
3. **仪表盘内自定义分组** — 可命名分组卡片,拖拽标签页进分组(仅本插件内,不碰浏览器标签栏)
4. **所有删除/关闭操作二次确认** — 弹出确认对话框

---

## 1. 不再接管新标签页

### `manifest.json`
- 删除 `"chrome_url_overrides": { "newtab": "index.html" }` 整行
- 保留 `action`(工具栏图标)。这样:新开 tab = Chrome 默认页;点击图标 = 触发 action

### `background.js`
新增/改写:监听 `chrome.action.onClicked`,打开或聚焦 Tab Out 页面:
- 先用 `chrome.tabs.query` 查找已存在的 `chrome-extension://<id>/index.html` 标签页
- 找到 → `chrome.tabs.update(active:true)` + `chrome.windows.update(focused:true)` 聚焦它
- 没找到 → `chrome.tabs.create({ url: 'index.html' })` 新开一个
- 这样避免重复打开多个 Tab Out 页(顺带也降低原来 dupe banner 的作用,但 banner 逻辑保留兼容)

### 文档更新
- `README.md` / `AGENTS.md`:把"打开一个新标签页就能看到"改为"点击工具栏的 Tab Out 图标打开"

---

## 2. 顶部搜索框(扁平列表)

### `index.html`
在 `<header>` 下方、`tabOutDupeBanner` 上方插入搜索区:
```html
<div class="search-bar" id="searchBar">
  <svg class="search-icon">...放大镜图标...</svg>
  <input type="text" id="tabSearch" placeholder="搜索打开的标签页..." autocomplete="off">
  <button id="searchClear" style="display:none">✕</button>
</div>
<div class="search-results" id="searchResults" style="display:none"></div>
```

### `style.css`
- `.search-bar`:复用 `.archive-search` 的视觉语言(1px `--warm-gray` 边框、`--card-bg` 背景、`--accent-amber` 聚焦),但更大更显眼:`padding: 12px 16px`、`border-radius: 8px`、`font-size: 14px`,左侧放大镜图标
- `.search-results`:扁平列表容器,每项 `.search-result-item` 用 flex,内含 favicon + 标题 + 域名 + 跳转/关闭/稍后查看按钮(复用 `.chip-action` 样式)
- 空结果提示 `.search-empty`

### `app.js`
- 新增 `renderSearchResults(query)`:在所有 `getRealTabs()` 中按 title/url 模糊匹配,去重后渲染到 `#searchResults`,每项带 favicon、`data-action="focus-tab"`、关闭按钮、稍后查看按钮
- 输入框监听 `input` 事件(防抖 ~120ms):有 query → 隐藏域名分组区(`#openTabsSection` `display:none`)、显示结果;清空 → 恢复正常视图
- Esc 或点 ✕ 清空搜索
- 搜索项的关闭/稍后查看复用已有的 `close-single-tab` / `defer-single-tab` 事件分支(带新增的二次确认)

---

## 3. 仪表盘内自定义分组(拖拽)

**设计**:在 `chrome.storage.local` 的 `tabGroups` 键存自定义分组数据:
```js
[{ id: "g1", name: "我的工作", color: "amber", tabUrls: ["https://...", ...] }, ...]
```
分组卡片按 `tabUrls` 从 `getRealTabs()` 中拉取实际标签页显示。

### 新增 UI
- **"新建分组"按钮**:放在 `#openTabsSection` 的 section-header 旁边(`section-count` 那一行末尾),点击弹出一个轻量内联输入框输入分组名
- **分组区 `#customGroupsSection`**:在域名卡片上方独立渲染,只在有分组时显示。每个分组是一张大卡片,含:名称(可编辑)、标签页 chips 列表、"关闭全部分组"按钮、删除分组按钮

### 拖拽实现(HTML5 Drag and Drop API)
- **拖源**:`.page-chip`(每个标签页 chip)加 `draggable="true"`。`dragstart` 时把 tab url 写进 `dataTransfer`,同时给被拖元素加 `.dragging` 类(用现有 `.closing` 的 opacity/scale 风格做半透明)
- **放置目标**:每个自定义分组卡片。`dragover` 加 `.drag-over` 类(`--accent-amber` 虚线边框 + `--shadow` 提示可放置)、`dragleave` 移除、`drop` 时把 url 加入该分组的 `tabUrls` 并从原域名分组视觉移除
- **拖出**:分组内的 chip 也能拖到另一个分组或"未分组区"——drop 到分组外则从该分组移除
- 存储用 `saveTabGroups()` 统一封装,改后重渲染

### `style.css` 新增
- `.dragging`:opacity 0.4 + scale 0.95
- `.drag-over`:2px dashed `--accent-amber` 边框、`background: rgba(200,113,58,0.04)`、轻微 `box-shadow`
- 分组卡片 `.custom-group-card`:比域名卡稍大,顶部彩色条颜色由分组 `color` 决定(amber/sage/slate/rose 四选一)
- `.group-tab-list`:分组内标签页的 flex 列容器,复用 `.mission-pages` 样式

### 标签页在分组与域名视图的关系
- 进入自定义分组的标签页,在域名视图中**仍然显示但加一个"已在分组"的淡化标记**(避免数据割裂)。点击关闭/稍后查看逻辑不变。这样实现简单且不会让标签页"消失"导致困惑
- (如你希望进组后从域名视图隐藏,可在确认实现时调整——默认先保留显示)

---

## 4. 所有删除/关闭操作二次确认

### `index.html` — 新增确认对话框
```html
<div class="confirm-overlay" id="confirmOverlay" style="display:none">
  <div class="confirm-dialog">
    <div class="confirm-message" id="confirmMessage"></div>
    <div class="confirm-actions">
      <button id="confirmCancel">取消</button>
      <button id="confirmOk" class="confirm-danger">确认</button>
    </div>
  </div>
</div>
```

### `app.js` — 新增确认机制
```js
let _confirmResolve = null;
function confirmAction(message) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmOverlay').style.display = 'flex';
  });
}
// 确认/取消按钮 resolve(true/false) 并关闭
```

### 需要加二次确认的操作(覆盖范围)
| 操作 | 确认文案 |
|---|---|
| 关闭单个标签页 `close-single-tab` | "关闭这个标签页?" |
| 稍后查看(会关闭原标签) `defer-single-tab` | "保存并关闭这个标签页?" |
| 关闭某域名所有标签页 `close-domain-tabs` | "关闭「{域名}」下的全部 N 个标签页?" |
| 关闭重复 `dedup-keep-one` | "关闭 N 个重复标签页(每个保留一份)?" |
| 关闭全部打开的标签页 `close-all-open-tabs` | "关闭所有 N 个打开的标签页?" |
| 关闭多余 Tab Out `close-tabout-dupes` | "关闭多余的 Tab Out 标签页?" |
| 稍后查看项的忽略 `dismiss-deferred` | "忽略这个已保存的标签页?" |
| 删除自定义分组 | "删除分组「{名}」?(不会关闭里面的标签页)" |
| 关闭分组内全部标签页 | "关闭分组「{名}」下的全部 N 个标签页?" |

**注意**:`check-deferred`(勾选完成/归档)和单纯聚焦/跳转**不加**确认——它们是可逆/非破坏性操作。

### `style.css` — 对话框样式
- `.confirm-overlay`:固定全屏遮罩 `rgba(26,22,19,0.4)` + 居中,点击空白=取消
- `.confirm-dialog`:`--card-bg` 背景、圆角 12px、padding 24px、`box-shadow` 加深
- `.confirm-danger`:确认按钮用 `--status-abandoned` 背景、白字;取消按钮用普通 `.action-btn` 风格
- 键盘:Esc=取消、Enter=确认

---

## 实施顺序
1. manifest + background(需求1,最小改动,先让新 tab 正常)
2. 确认对话框基础设施(需求4,其他改动复用它)
3. 搜索框(需求2)
4. 自定义分组 + 拖拽(需求3,最复杂)
5. 文档更新

## 不做的事
- 不改 `background.js` 的 badge 计数逻辑(仍正常工作)
- 不动已有的 confetti/音效/动画
- 不碰域名友好名映射表(已汉化)
- 不加新的 Chrome 权限(分组是纯本地存储,无需 tabGroups 权限)
