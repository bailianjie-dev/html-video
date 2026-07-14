/**
 * Tiny i18n for the studio. No build step, no framework.
 *
 * Usage:
 *   import { t, setLocale, getLocale, AVAILABLE_LOCALES } from './i18n.js';
 *   t('toolbar.export_mp4')
 *   setLocale('zh')
 *
 * Locale resolution order:
 *   1. localStorage hv.studio.locale
 *   2. navigator.language prefix ("zh-CN" → "zh")
 *   3. DEFAULT_LOCALE = "zh"
 *
 * Strings missing in the active locale fall back to en, then the key.
 */

export const DEFAULT_LOCALE = 'zh';
export const AVAILABLE_LOCALES = ['en', 'zh'];

const DICT = {
  en: {
    'app.empty_pick_create': 'Pick or create a project',
    'app.empty_subtitle':
      'Each project = one HTML video. Choose a template to see the visual baseline, chat with your agent to drive the content, edit per-frame text in the middle column, see the result on the right.',
    'app.no_project': 'no project',

    'sidebar.projects': 'Projects',
    'sidebar.new': '+ New',
    'sidebar.collapse': 'Collapse sidebar',
    'sidebar.empty_list': 'no projects yet',
    'sidebar.menu.rename': '✎ Rename',
    'sidebar.menu.delete': '🗑 Delete',
    'sidebar.rename_prompt': 'New project name',
    'sidebar.delete_confirm': 'Delete "{name}"? This cannot be undone.',

    'toolbar.template': 'Template',
    'toolbar.template_pick': 'Optional · Pick template',
    'toolbar.agent': 'Agent',
    'toolbar.model': 'Model',
    'toolbar.agent_none': '— none —',
    'toolbar.agent_ready': '● ready',
    'toolbar.agent_install': '○ install',
    'toolbar.export_mp4': '导出 MP4',
    'toolbar.export_html': '导出 HTML',
    'toolbar.export_html_title_ready': '下载当前预览为独立 HTML 相册',
    'toolbar.export_html_title_disabled': '请先生成相册',

    'composer.placeholder.no_project': 'Pick a project first…',
    'composer.placeholder.detecting_agents': 'Describe the video while we check for agents…',
    'composer.placeholder.no_agent': 'Configure AI Assistant to enable chat…',
    'composer.placeholder.focus':
      'Edit only this frame (click ✕ on the chip above to release)…',
    'composer.placeholder.no_template':
      'Describe a video, or paste an article link / GitHub repo to build one from it.',
    'composer.placeholder.with_template': 'Describe the video — content, names, data… or paste an article link / GitHub repo.',
    'composer.hint': 'Cmd / Ctrl + Enter · drag / paste files · drop a design.md / frame.md to lock brand + motion',
    'composer.send': 'Send',
    'composer.attach': 'Attach file',
    'composer.focus_chip': 'Editing only frame {order} {fid}',
    'composer.focus_clear': 'Clear focus',

    'chat.empty.title': 'Send a message to start',
    'chat.empty.body':
      'Tell the agent what you want — a single brand card, a multi-frame teaser, a data poster — and it will scaffold the HTML.',
    'chat.summary.form_submitted': '📋 Form submitted',
    'chat.summary.confirm_generate': '✓ Generate',
    'chat.summary.confirm_edit': '✏️ Edit',
    'chat.thinking': 'agent thinking',
    'chat.still_generating': '⏳ This project is still generating in the background — its result will appear here when done (reload preview to refresh).',
    'chat.placeholder.gen_html': '📄 *generating HTML…*',
    'chat.placeholder.plan_graph': '🧭 *planning storyboard…*',
    'chat.empty_reply':
      '⚠️ The agent returned an empty reply. Try rephrasing your request — e.g. tell it the brand / topic / 1-2 concrete details, or which kind of frame you want first.',

    'preview.placeholder.pick_project': 'Pick a project first.',
    'preview.placeholder.pick_template':
      'Send a chat to generate the first HTML.<br>Or pick a template up top for a quick start.',
    'preview.edit_text_on': '✓ Done editing',
    'preview.edit_text_off': '✎ Edit text',
    'preview.edit_text_title': 'Click any text in the preview to edit',
    'preview.edit_text_done_title': 'Finish editing',
    'preview.reload': '↻ Reload preview',
    'preview.no_hv_text':
      'This frame has no editable text (HTML missing data-hv-text).',

    'frames.label': 'Frames',
    'frames.view_graph': 'View graph',
    'frames.enhance': '⚡ Remotion',
    'frames.enhance_hint': 'Render this data frame natively with Remotion (numbers roll, bars grow)',
    'frames.enhanced_revert': '⚡ Remotion ✓ (revert)',
    'frames.enhancing': '⚡ {pct}%…',
    'enhance.done': '⚡ Frame rendered with Remotion',
    'enhance.failed': '⚡ Remotion failed: {message}',

    'text_pane.title': 'Frame text',
    'text_pane.no_project': 'No project.',
    'text_pane.empty_with_frames':
      'No editable text on this frame. Switch to another frame, or click ✎ Edit text on the canvas.',
    'text_pane.empty_no_frames':
      'No editable text yet. Send a chat to generate the first version of the HTML, then per-frame text fields appear here.',
    'text_pane.edit_page': 'Edit this page',
    'text_pane.editing_page': 'Editing page {n}',
    'text_pane.edit_page_title': 'Edit text on the selected page only',
    'text_pane.edit_page_hint':
      'Select a page on the left, then click “Edit this page” to open the editor.',
    'text_pane.page_title': 'Page {n} text',
    'text_pane.empty_page': 'No editable text on this page.',
    'text_pane.locate': 'Locate',
    'text_pane.locate_title': 'Highlight this text in the preview',
    'text_pane.locate_tip':
      'Click Locate or focus a field to highlight it in the preview. You can also click text in the preview to jump here.',
    'text_pane.section_colors': 'Theme',
    'text_pane.section_images': 'Images',
    'text_pane.section_cta': 'CTA',
    'text_pane.section_text': 'Text',
    'text_pane.primary_color': 'Primary color',
    'text_pane.brand_color': 'Brand color',
    'text_pane.accent_color': 'Accent color',
    'text_pane.image_label': 'Image {n}',
    'text_pane.image_placeholder': 'Image URL',
    'text_pane.image_upload': 'Upload',
    'text_pane.image_uploading': 'Uploading…',
    'text_pane.image_upload_error': 'Image upload failed',
    'text_pane.cta_label': 'CTA {n}',
    'text_pane.cta_placeholder': 'CTA copy',
    'text_pane.cta_href_placeholder': 'Link URL (optional)',
    'text_pane.placeholder_empty': '(empty)',
    'text_pane.done': 'Done',
    'text_pane.done_title': 'Finish editing and maximize preview',
    'text_pane.expand': 'Expand editor',
    'text_pane.collapse': 'Collapse panel',
    'text_pane.save_state.idle': '—',
    'text_pane.save_state.typing': 'typing…',
    'text_pane.save_state.saving': 'saving…',
    'text_pane.save_state.saved': 'saved',
    'text_pane.save_state.error': 'error',

    'export.starting': '⏵ Starting MP4 export…',
    'export.button_running': '⏵ {pct}% · {stage}',
    'export.done_seconds': '✓ MP4 exported · {seconds}',
    'export.done_no_seconds': '✓ MP4 exported',
    'export.failed': '⚠️ Export failed: {message}',
    'export.stream_interrupted': 'Export stream interrupted: {message}',
    'export.failed_short': 'Export failed: {message}',
    'export.title': '🎬 MP4 ready',
    'export.reveal': 'Reveal in Finder',
    'export.copy_path': 'Copy path',
    'export.copied': 'Path copied',
    'export.copy_failed': 'Copy failed: {message}',
    'export.reveal_failed': 'Open failed: {message}',

    'soundtrack.title': '🎵 Add background music & narration',
    'soundtrack.summary_sub': 'AI music + voiceover, mixed into your export',
    'soundtrack.optional': 'optional',
    'soundtrack.hint': 'Background music + narration, mixed into the MP4 on export.',
    'soundtrack.music_label': 'Background music',
    'soundtrack.music_placeholder': 'Pick a style above, or describe your own — genre, mood, tempo',
    'soundtrack.preset_energetic': 'Energetic',
    'soundtrack.preset_calm': 'Calm',
    'soundtrack.preset_tech': 'Tech',
    'soundtrack.preset_narrative': 'Narrative',
    'soundtrack.preset_minimal': 'Minimal',
    'soundtrack.preset_epic': 'Epic',
    'soundtrack.narration_label': 'Narration / voiceover',
    'soundtrack.step_write': 'Write the script (text)',
    'soundtrack.step_voice': 'Synthesize the voice (audio)',
    'soundtrack.editing_frame': '· editing frame {n}/{total}',
    'soundtrack.draft_frame': '✨ Draft this frame',
    'soundtrack.draft_all': '✨ Draft all frames',
    'soundtrack.gen_music': '🎵 Generate music',
    'soundtrack.gen_narration': '🎙 Synthesize voiceover',
    'soundtrack.empty_music': 'Pick or describe a music style first.',
    'soundtrack.empty_narration': 'Add narration text first (✨ to draft it).',
    'soundtrack.frame_word': 'Frame',
    'soundtrack.total_word': 'Total',
    'soundtrack.drafting': 'Drafting…',
    'soundtrack.draft_need_frames': 'Generate the video first',
    'soundtrack.draft_failed': '⚠️ Draft failed: {message}',
    'soundtrack.narration_placeholder': 'One line per frame — click ✨ to draft from the video (leave empty for none)',
    'soundtrack.voice_label': 'Voice',
    'soundtrack.voice_male_warm': 'Male · Warm',
    'soundtrack.voice_male_pro': 'Male · Professional',
    'soundtrack.voice_male_deep': 'Male · Deep',
    'soundtrack.voice_female_anchor': 'Female · Anchor',
    'soundtrack.voice_female_mature': 'Female · Mature',
    'soundtrack.voice_female_sweet': 'Female · Sweet',
    'soundtrack.fit_durations': '⇄ Fit timing to narration',
    'soundtrack.fit_hint': 'Re-pace each frame by how much narration it has',
    'soundtrack.fitting': 'Fitting…',
    'soundtrack.fitted': '✓ Frame timing fit to narration · {sec}s total',
    'soundtrack.fit_failed': 'Could not fit timing',
    'soundtrack.music_volume': 'Music volume',
    'soundtrack.narration_volume': 'Narration volume',
    'soundtrack.generate': 'Generate soundtrack',
    'soundtrack.generating': 'Generating…',
    'soundtrack.clear': 'Clear',
    'soundtrack.starting': '⏵ Generating soundtrack…',
    'soundtrack.progress_music': '⏵ Generating background music…',
    'soundtrack.progress_narration': '⏵ Generating narration…',
    'soundtrack.done': '✓ Soundtrack ready — it will be mixed in on export',
    'soundtrack.failed': '⚠️ Soundtrack failed: {message}',
    'soundtrack.music_ready': 'Music',
    'soundtrack.narration_ready': 'Narration',
    'soundtrack.empty': 'Enter a music prompt and/or narration text first.',

    'graph.title': 'Content graph',
    'graph.download': '⬇ Download JSON',
    'graph.close': '✕',
    'graph.empty': '(no graph for this project)',
    'graph.error': 'error loading graph: {message}',

    'gallery.title': 'Pick a template',
    'gallery.close': '✕',

    'modal.new.title': 'New project',
    'modal.new.name_label': 'Name',
    'modal.new.name_placeholder': 'e.g. nexu-io launch teaser',
    'modal.new.intent_label': 'Intent (optional)',
    'modal.new.intent_placeholder': 'A one-line description of what this video is about',
    'modal.new.cancel': 'Cancel',
    'modal.new.create': 'Create',
    'modal.new.name_required': 'Name is required',
    'modal.new.created': 'Created "{name}"',
    'modal.new.failed': 'Failed to create project',

    'language.label': 'Language',

    'settings.title': 'Settings',
    'settings.tab.agent': 'Agent',
    'settings.tab.audio': 'Audio',
    'settings.tab.language': 'Language',
    'settings.tab.about': 'About',

    'settings.audio.title': 'Audio · MiniMax',
    'settings.audio.subtitle': 'API key for soundtrack generation (background music + narration).',
    'settings.audio.loading': 'Checking…',
    'settings.audio.api_key': 'API key',
    'settings.audio.api_key_placeholder': 'Paste your MiniMax API key',
    'settings.audio.region': 'API region',
    'settings.audio.region_intl': '🌐 International · api.minimax.io',
    'settings.audio.region_cn': '🇨🇳 China · api.minimaxi.com',
    'settings.audio.base_url': 'Base URL',
    'settings.audio.save': 'Save',
    'settings.audio.clear': 'Clear',
    'settings.audio.configured': '✓ Configured · {key} · from {source}',
    'settings.audio.not_configured': 'No MiniMax key configured yet.',
    'settings.audio.source_config': 'Settings',
    'settings.audio.source_env': 'environment',
    'settings.audio.saving': 'Saving…',
    'settings.audio.saved': '✓ Saved',
    'settings.audio.save_failed': 'Save failed: {message}',
    'settings.audio.need_key': 'Enter an API key first.',
    'settings.audio.hint': 'Stored locally in .html-video/media-config.json. Pick the region that matches your key — an api.minimax.io (International) key will NOT work against api.minimaxi.com (China), and vice-versa. The old api.minimaxi.chat host is retired.',

    'settings.agent.title': 'Agent',
    'settings.agent.subtitle': 'Pick the runtime that turns your chat into HTML.',
    'settings.agent.mode.local': 'Local CLI',
    'settings.agent.mode.byok': 'BYOK (API)',
    'settings.agent.detected': 'Detected agents ({count})',
    'settings.agent.test': 'Test',
    'settings.agent.testing': 'Testing…',
    'settings.agent.test_ok': 'OK · {ms}ms · {bytes}B',
    'settings.agent.test_fail': 'Failed: {message}',
    'settings.agent.empty_reply': 'Failed: agent returned an empty reply',
    'settings.agent.use': 'Use',
    'settings.agent.in_use': 'In use',
    'settings.agent.unavailable': 'Not installed',
    'agent.sign_in': 'Sign in',
    'agent.signing_in': 'Signing in…',
    'agent.signed_in': '✓ Signed in to AMR',
    'agent.sign_in_failed': 'Sign-in failed',
    'agent.recommended': 'Recommended · one login, many models',
    'settings.agent.byok.intro': 'Use your own Anthropic / OpenRouter API key. Reads from environment:',
    'settings.agent.byok.env_key': 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    'settings.agent.byok.env_base': 'ANTHROPIC_BASE_URL (optional, defaults to api.anthropic.com)',
    'settings.agent.rescan': '↻ Rescan',
    'settings.agent.rescanned': 'Rescanned',

    'settings.language.title': 'Language',
    'settings.language.subtitle': 'Studio interface language. Re-renders instantly.',
    'settings.language.en': 'English',
    'settings.language.zh': '中文',
    'settings.language.en_sub': 'EN',
    'settings.language.zh_sub': 'ZH-CN',

    'settings.about.title': 'About',
    'settings.about.subtitle': 'html-video — open-source HTML→Video meta-layer for coding agents.',
    'settings.about.version': 'Version',
    'settings.about.repo': 'Repo',
    'settings.about.discord': 'Discord',
    'settings.about.license': 'License',
    'settings.about.related': 'Related',

    'toolbar.settings': 'Settings',

    'tpl_preview.cancel': 'Cancel',
    'tpl_preview.use': 'Use this template',
    'tpl_preview.replace_confirm': 'Replace current template with "{name}"? Existing preview content stays put — the agent can rebuild on next chat.',
    'tpl_preview.applied': 'Template: {name}',
    'tpl_preview.fps_dur': '{fps}fps · {duration}s · {aspect}',
    'tpl_preview.source_skill': 'Adapted from',
    'tpl_preview.source_origin': 'Design lineage',
    'tpl_preview.source_license': 'License',
  },

  zh: {
    'app.empty_pick_create': '挑一个项目或新建',
    'app.empty_subtitle':
      '每个项目都是一本电子相册。你可以继续调整文案、风格、页数，并导出 HTML 或 MP4。',
    'app.no_project': '未选项目',

    'sidebar.projects': '项目',
    'sidebar.new': '+ 新建',
    'sidebar.collapse': '收起侧栏',
    'sidebar.empty_list': '还没有项目',
    'sidebar.menu.rename': '✎ 重命名',
    'sidebar.menu.delete': '🗑 删除',
    'sidebar.rename_prompt': '新项目名',
    'sidebar.delete_confirm': '删除 "{name}"？此操作不可撤销。',

    'toolbar.template': '模板',
    'toolbar.template_pick': '可选 · 挑模板',
    'toolbar.agent': 'AI助手',
    'toolbar.model': '模型',
    'toolbar.agent_none': '— 无 —',
    'toolbar.agent_ready': '● 就绪',
    'toolbar.agent_install': '○ 待装',
    'toolbar.export_mp4': '导出 MP4',
    'toolbar.export_html': '导出 HTML',
    'toolbar.export_html_title_ready': '下载当前预览为独立 HTML 相册',
    'toolbar.export_html_title_disabled': '请先生成相册',

    'composer.placeholder.no_project': '先选一个项目…',
    'composer.placeholder.detecting_agents': '描述想调整的内容（正在准备 AI助手）…',
    'composer.placeholder.no_agent': '配置 AI助手 后即可聊天…',
    'composer.placeholder.focus': '只修改这一帧的内容（点掉上方芯片可恢复整片）…',
    'composer.placeholder.no_template': '描述电子相册主题、公司信息、产品亮点或调整要求。',
    'composer.placeholder.with_template': '描述想调整的内容，例如文案、页数、风格、图片使用方式。',
    'composer.hint': 'Ctrl + Enter 发送 · 可拖拽或粘贴图片素材',
    'composer.send': '发送',
    'composer.attach': '附加文件',
    'composer.focus_chip': '仅修改第 {order} 帧 {fid}',
    'composer.focus_clear': '清除',

    'chat.empty.title': '发条消息开始',
    'chat.empty.body':
      '告诉 AI助手你想调整什么，例如文案更简洁、增加客户案例、换成科技风格。',
    'chat.summary.form_submitted': '📋 提交了表单',
    'chat.summary.confirm_generate': '✓ 确认生成',
    'chat.summary.confirm_edit': '✏️ 改一下',
    'chat.thinking': 'AI助手思考中',
    'chat.still_generating': '⏳ 这个相册仍在生成中，完成后会自动显示结果，也可以点刷新预览查看。',
    'chat.placeholder.gen_html': '📄 *正在生成 HTML…*',
    'chat.placeholder.plan_graph': '🧭 *规划故事板…*',
    'chat.empty_reply':
      '⚠️ AI助手没有返回内容。可以补充公司名称、产品亮点、目标客户或想调整的页面。',

    'preview.placeholder.pick_project': '先选一个项目。',
    'preview.placeholder.pick_template':
      '先输入主题生成第一版电子相册。<br>生成后可在这里预览和调整。',
    'preview.edit_text_on': '✓ 完成编辑',
    'preview.edit_text_off': '✎ 编辑文字',
    'preview.edit_text_title': '点画面里的文字直接修改',
    'preview.edit_text_done_title': '完成编辑',
    'preview.reload': '↻ 刷新预览',
    'preview.no_hv_text': '当前帧没有可编辑的文字（HTML 缺 data-hv-text 标签）。',

    'frames.label': '分镜',
    'frames.view_graph': '看图谱',
    'frames.enhance': '⚡ Remotion',
    'frames.enhance_hint': '用原生 Remotion 渲染这个数据帧（数字滚动、柱子生长）',
    'frames.enhanced_revert': '⚡ Remotion ✓（还原）',
    'frames.enhancing': '⚡ {pct}%…',
    'enhance.done': '⚡ 该帧已用 Remotion 渲染',
    'enhance.failed': '⚡ Remotion 失败：{message}',

    'text_pane.title': '帧文字',
    'text_pane.no_project': '无项目。',
    'text_pane.empty_with_frames':
      '当前帧没有可编辑文字。切到别的帧，或在画面里点 ✎ 编辑文字。',
    'text_pane.empty_no_frames':
      '还没有可编辑的字段。发一条消息生成第一版 HTML，逐帧字段会出现在这里。',
    'text_pane.edit_page': '编辑本页',
    'text_pane.editing_page': '编辑中 · 第 {n} 页',
    'text_pane.edit_page_title': '展开编辑栏，只修改当前选中页的文字',
    'text_pane.edit_page_hint':
      '先在左侧选择某一页，再点「编辑本页」展开编辑栏。',
    'text_pane.page_title': '第 {n} 页文字',
    'text_pane.empty_page': '本页没有可编辑文字。',
    'text_pane.locate': '定位',
    'text_pane.locate_title': '在预览中高亮这段文字',
    'text_pane.locate_tip':
      '点击「定位」或点进输入框，预览会高亮对应文案；也可直接点预览里的文字，跳到右侧字段。',
    'text_pane.section_colors': '主题',
    'text_pane.section_images': '图片',
    'text_pane.section_cta': '行动按钮',
    'text_pane.section_text': '文字',
    'text_pane.primary_color': '主色',
    'text_pane.brand_color': '品牌色',
    'text_pane.accent_color': '强调色',
    'text_pane.image_label': '图片 {n}',
    'text_pane.image_placeholder': '图片 URL',
    'text_pane.image_upload': '上传',
    'text_pane.image_uploading': '上传中…',
    'text_pane.image_upload_error': '图片上传失败',
    'text_pane.cta_label': '行动按钮 {n}',
    'text_pane.cta_placeholder': '按钮文案',
    'text_pane.cta_href_placeholder': '链接 URL（可选）',
    'text_pane.placeholder_empty': '（空）',
    'text_pane.done': '完成',
    'text_pane.done_title': '完成编辑并放大预览',
    'text_pane.expand': '展开编辑栏',
    'text_pane.collapse': '收起面板',
    'text_pane.save_state.idle': '—',
    'text_pane.save_state.typing': '输入中…',
    'text_pane.save_state.saving': '保存中…',
    'text_pane.save_state.saved': '已保存',
    'text_pane.save_state.error': '错误',

    'export.starting': '⏵ 开始导出 MP4…',
    'export.button_running': '⏵ {pct}% · {stage}',
    'export.done_seconds': '✓ MP4 已导出 · {seconds}',
    'export.done_no_seconds': '✓ MP4 已导出',
    'export.failed': '⚠️ 导出失败：{message}',
    'export.stream_interrupted': '导出流中断：{message}',
    'export.failed_short': '导出失败：{message}',
    'export.title': '🎬 MP4 已就绪',
    'export.reveal': '在 Finder 中显示',
    'export.copy_path': '复制路径',
    'export.copied': '已复制路径',
    'export.copy_failed': '复制失败：{message}',
    'export.reveal_failed': '打开失败：{message}',

    'soundtrack.title': '🎵 添加背景音乐和配音',
    'soundtrack.summary_sub': 'AI 配乐 + 旁白，导出时自动混入',
    'soundtrack.optional': '可选',
    'soundtrack.hint': '背景音乐 + 旁白，导出时混入 MP4。',
    'soundtrack.music_label': '背景音乐',
    'soundtrack.music_placeholder': '选上面的风格，或自己描述 —— 风格、情绪、节奏',
    'soundtrack.preset_energetic': '动感',
    'soundtrack.preset_calm': '舒缓',
    'soundtrack.preset_tech': '科技',
    'soundtrack.preset_narrative': '叙事',
    'soundtrack.preset_minimal': '极简',
    'soundtrack.preset_epic': '史诗',
    'soundtrack.narration_label': '旁白 / 配音',
    'soundtrack.step_write': '第一步 · 写旁白文字',
    'soundtrack.step_voice': '第二步 · 合成配音（音频）',
    'soundtrack.editing_frame': '· 正在编辑第 {n}/{total} 帧',
    'soundtrack.draft_frame': '✨ AI 起草本页',
    'soundtrack.draft_all': '✨ AI 起草全部',
    'soundtrack.gen_music': '🎵 生成配乐',
    'soundtrack.gen_narration': '🎙 合成配音',
    'soundtrack.empty_music': '请先选或描述一个音乐风格。',
    'soundtrack.empty_narration': '请先填旁白文字（点 ✨ 可让 AI 起草）。',
    'soundtrack.frame_word': '画面',
    'soundtrack.total_word': '总时长',
    'soundtrack.drafting': '生成中…',
    'soundtrack.draft_need_frames': '请先生成视频',
    'soundtrack.draft_failed': '⚠️ 生成失败：{message}',
    'soundtrack.narration_placeholder': '每帧一句——点 ✨ 根据视频生成（留空则不加）',
    'soundtrack.voice_label': '音色',
    'soundtrack.voice_male_warm': '男声 · 温暖',
    'soundtrack.voice_male_pro': '男声 · 专业',
    'soundtrack.voice_male_deep': '男声 · 低沉',
    'soundtrack.voice_female_anchor': '女声 · 播音',
    'soundtrack.voice_female_mature': '女声 · 御姐',
    'soundtrack.voice_female_sweet': '女声 · 甜美',
    'soundtrack.fit_durations': '⇄ 时长适配配音',
    'soundtrack.fit_hint': '按每帧旁白长短重新分配各帧时长',
    'soundtrack.fitting': '适配中…',
    'soundtrack.fitted': '✓ 帧时长已适配配音 · 共 {sec}s',
    'soundtrack.fit_failed': '适配失败',
    'soundtrack.music_volume': '音乐音量',
    'soundtrack.narration_volume': '旁白音量',
    'soundtrack.generate': '生成配乐',
    'soundtrack.generating': '生成中…',
    'soundtrack.clear': '清除',
    'soundtrack.starting': '⏵ 正在生成配乐…',
    'soundtrack.progress_music': '⏵ 正在生成背景音乐…',
    'soundtrack.progress_narration': '⏵ 正在生成旁白…',
    'soundtrack.done': '✓ 配乐就绪 —— 导出时会自动混入',
    'soundtrack.failed': '⚠️ 配乐失败：{message}',
    'soundtrack.music_ready': '音乐',
    'soundtrack.narration_ready': '旁白',
    'soundtrack.empty': '请先填写音乐提示词或旁白文字。',

    'graph.title': '内容图谱',
    'graph.download': '⬇ 下载 JSON',
    'graph.close': '✕',
    'graph.empty': '（项目没有图谱）',
    'graph.error': '加载图谱失败：{message}',

    'gallery.title': '挑一个模板',
    'gallery.close': '✕',

    'modal.new.title': '新建项目',
    'modal.new.name_label': '名称',
    'modal.new.name_placeholder': '例如：nexu-io 发布预告',
    'modal.new.intent_label': '意图（可选）',
    'modal.new.intent_placeholder': '一句话说说这个视频在讲什么',
    'modal.new.cancel': '取消',
    'modal.new.create': '创建',
    'modal.new.name_required': '名称不能空',
    'modal.new.created': '已创建 "{name}"',
    'modal.new.failed': '创建项目失败',

    'language.label': '语言',

    'settings.title': '设置',
    'settings.tab.agent': 'Agent',
    'settings.tab.audio': '音频',
    'settings.tab.language': '界面语言',
    'settings.tab.about': '关于',

    'settings.audio.title': '音频 · MiniMax',
    'settings.audio.subtitle': '配乐生成（背景音乐 + 旁白）所需的 API key。',
    'settings.audio.loading': '检查中…',
    'settings.audio.api_key': 'API key',
    'settings.audio.api_key_placeholder': '粘贴你的 MiniMax API key',
    'settings.audio.region': 'API 区域',
    'settings.audio.region_intl': '🌐 国际 · api.minimax.io',
    'settings.audio.region_cn': '🇨🇳 国内 · api.minimaxi.com',
    'settings.audio.base_url': 'Base URL',
    'settings.audio.save': '保存',
    'settings.audio.clear': '清除',
    'settings.audio.configured': '✓ 已配置 · {key} · 来自{source}',
    'settings.audio.not_configured': '尚未配置 MiniMax key。',
    'settings.audio.source_config': '设置',
    'settings.audio.source_env': '环境变量',
    'settings.audio.saving': '保存中…',
    'settings.audio.saved': '✓ 已保存',
    'settings.audio.save_failed': '保存失败：{message}',
    'settings.audio.need_key': '请先填写 API key。',
    'settings.audio.hint': '保存在本地 .html-video/media-config.json。请按你的 key 选对区域——国际版 api.minimax.io 的 key 在国内版 api.minimaxi.com 上无法使用，反之亦然；旧的 api.minimaxi.chat 域名已停用。',

    'settings.agent.title': 'Agent',
    'settings.agent.subtitle': '选一个运行时把你的对话翻成 HTML。',
    'settings.agent.mode.local': '本机 CLI',
    'settings.agent.mode.byok': 'BYOK (API)',
    'settings.agent.detected': '已检测到的 agent（{count}）',
    'settings.agent.test': '测试',
    'settings.agent.testing': '测试中…',
    'settings.agent.test_ok': '通过 · {ms}ms · {bytes}B',
    'settings.agent.test_fail': '失败：{message}',
    'settings.agent.empty_reply': '失败：agent 返回为空',
    'settings.agent.use': '使用',
    'settings.agent.in_use': '当前',
    'settings.agent.unavailable': '未安装',
    'agent.sign_in': '登录',
    'agent.signing_in': '登录中…',
    'agent.signed_in': '✓ 已登录 AMR',
    'agent.sign_in_failed': '登录失败',
    'agent.recommended': '推荐 · 一次登录，多种模型',
    'settings.agent.byok.intro': '直连 Anthropic / OpenRouter API。从环境变量读：',
    'settings.agent.byok.env_key': 'ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN',
    'settings.agent.byok.env_base': 'ANTHROPIC_BASE_URL（可选，默认 api.anthropic.com）',
    'settings.agent.rescan': '↻ 重新扫描',
    'settings.agent.rescanned': '已重新扫描',

    'settings.language.title': '界面语言',
    'settings.language.subtitle': 'Studio 界面语言，切换立即生效。',
    'settings.language.en': 'English',
    'settings.language.zh': '中文',
    'settings.language.en_sub': 'EN',
    'settings.language.zh_sub': 'ZH-CN',

    'settings.about.title': '关于',
    'settings.about.subtitle': 'html-video — 开源的 HTML→视频 meta-layer，为 coding agent 设计。',
    'settings.about.version': '版本',
    'settings.about.repo': '代码仓库',
    'settings.about.discord': 'Discord',
    'settings.about.license': '许可',
    'settings.about.related': '相关项目',

    'toolbar.settings': '设置',

    'tpl_preview.cancel': '取消',
    'tpl_preview.use': '使用此模板',
    'tpl_preview.replace_confirm': '把当前模板替换为 "{name}"？现有预览不会被覆盖，下一轮 chat 时 agent 会按新模板重写。',
    'tpl_preview.applied': '已切换模板：{name}',
    'tpl_preview.fps_dur': '{fps}fps · {duration}秒 · {aspect}',
    'tpl_preview.source_skill': '改编自',
    'tpl_preview.source_origin': '设计渊源',
    'tpl_preview.source_license': '许可证',
  },
};

const STORAGE_KEY = 'hv.studio.locale';
let _locale = resolveInitialLocale();

function resolveInitialLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && AVAILABLE_LOCALES.includes(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  // This product is currently enterprise-facing in Chinese by default.
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return _locale;
}

export function setLocale(loc) {
  if (!AVAILABLE_LOCALES.includes(loc)) return;
  _locale = loc;
  try { localStorage.setItem(STORAGE_KEY, loc); } catch {}
  // Notify listeners (the studio app re-renders).
  document.dispatchEvent(new CustomEvent('hv-locale-change', { detail: { locale: loc } }));
}

/**
 * Apply i18n to static DOM elements. Markers:
 *   data-i18n="key"          → textContent
 *   data-i18n-attr="placeholder:key,title:key2"  → set those attrs
 *   data-i18n-html="key"     → innerHTML (caution: only for trusted keys)
 *
 * Call once after DOMContentLoaded and also on every locale change.
 */
export function applyDomI18n(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  r.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  r.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const pairs = (el.dataset.i18nAttr || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}

document.addEventListener('hv-locale-change', () => applyDomI18n());
document.addEventListener('DOMContentLoaded', () => applyDomI18n());

/**
 * Translate a key. `params` is a plain object whose keys substitute
 * `{key}` placeholders in the resolved string.
 */
export function t(key, params) {
  const dict = DICT[_locale] ?? DICT[DEFAULT_LOCALE];
  let s = dict[key];
  if (s === undefined) {
    // Fall back to English, then to the key itself.
    s = DICT[DEFAULT_LOCALE][key] ?? key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
